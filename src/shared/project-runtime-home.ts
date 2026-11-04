/** Home-owned ordinary runtime. A durable inventory separates copying, publication, and retirement. */
import {
    gitWorktreeListEvidence,
    gitIndexEvidence,
    observeGitEvidence,
    reusedGitRead,
    rememberGitRead,
} from "./git-evidence-cache.ts";
import { readLockFileSnapshot, lockFileSnapshotMatches, type LockFileSnapshot } from "./lock-file-snapshot.ts";
import { DatabaseSync } from "./sqlite.ts";
import { isLockHolderGone } from "./process-liveness.ts";
import { getRunWieldRuntimeDir } from "../constants.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { realpathSync, type Stats } from "node:fs";
import { admitProjectIdentity, inspectProjectIdentity, type ProjectIdentity } from "./project-identity.ts";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout.ts";
import { openNativeFileLock, type NativeFileLock } from "./native-file-lock.ts";
import { ensurePrivateDir, syncParentDirectory } from "./private-json-file.ts";
import { isRunWieldOwnedRuntimePath, LEGACY_PROJECT_RUNTIME_HAZARD_PATHS } from "./runwield-owned-paths.ts";
import { inspectWorktreeRegistryAtPath } from "./worktree-registry.js";
import { recoverLegacyRuntimeFiles } from "./project-runtime-recovery.ts";
import {
    ProjectRuntimeEntryRefusedError,
    type ProjectRuntimeLayout,
    type ProjectRuntimeReadInspection,
    type ProjectRuntimeMigrationReadyResult,
    type ProjectRuntimeMigrationBlockedReason,
} from "./project-runtime-layout.ts";

interface RuntimeMapping {
    source: string;
    destination: string;
    repository: boolean;
}
interface RuntimeFile {
    source: string;
    destination: string;
    digest: string;
    mode: number;
    link?: string;
    retired: boolean;
    lock: boolean;
    publishedDigest?: string;
}
interface RuntimeTransfer {
    version: 2;
    projectId: string;
    repositoryId: string;
    owner: string;
    phase: "copying" | "verified" | "published";
    roots: string[];
    mappings: RuntimeMapping[];
    files: RuntimeFile[];
}
interface HomeMarker {
    version: 2;
    projectId: string;
    repositoryId: string;
    owner: string;
    roots: string[];
}
interface OldJournalOperation {
    action: string;
    source: string;
    destination?: string;
    completed: boolean;
    proof?: LockFileSnapshot;
}
interface OldJournal {
    version: number;
    primaryCheckoutRoot: string;
    selectedCheckoutRoots: string[];
    operations: OldJournalOperation[];
    adoptedSelectedCheckoutRoots?: string[];
}

function ownerKey(identity: ProjectIdentity): string {
    return createHash("sha256")
        .update(`${identity.personalOwner.kind}\0${identity.personalOwner.identity}`)
        .digest("hex");
}
function projectHome(identity: ProjectIdentity): string {
    return join(identity.executionAccountHome, ".wld", "projects", identity.projectId);
}
function refuse(reason: ProjectRuntimeMigrationBlockedReason, paths: string[], message: string): never {
    throw new ProjectRuntimeEntryRefusedError({
        kind: "blocked",
        reason,
        paths,
        message,
        ...(reason === "tracked_secret"
            ? { securityAction: { rotateCapabilities: true, removeFromRepositoryHistory: true, message } }
            : {}),
    });
}
function inside(root: string, path: string): boolean {
    const sub = relative(root, path);
    return !isAbsolute(sub) && sub !== ".." && !sub.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
async function info(path: string): Promise<Stats | null> {
    try {
        return await fs.lstat(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}
function git(root: string, args: string[]): string {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.error || result.status !== 0)
        throw new Error(result.error?.message || result.stderr || "Git evidence unavailable");
    return result.stdout.trim();
}
export function homeProjectRuntimeLayout(identity: ProjectIdentity): ProjectRuntimeLayout {
    const primaryRoot = resolvePrimaryCheckoutRoot(identity.checkoutRoot);
    const home = projectHome(identity);
    const owner = ownerKey(identity);
    const internal = join(home, "internal", "legacy", identity.repositoryId, owner);
    const execution = join(home, "execution", identity.repositoryId, owner);
    const checkout = join(execution, "checkouts", identity.checkoutId);
    const locks = join(home, "execution-locks", identity.repositoryId, owner);
    return {
        primary: {
            checkoutRoot: primaryRoot,
            internalRoot: internal,
            layoutMarkerPath: join(internal, "layout.json"),
            layoutMigrationJournalPath: join(internal, "layout-migration.json"),
            layoutMigrationLockPath: join(locks, "runtime-adoption.lock"),
            controllerPlansDir: join(internal, "controller", "plans"),
            worktreeRegistryPath: join(execution, "worktrees.json"),
            worktreeRegistryLockPath: join(locks, "worktrees.lock"),
            worktreeRegistryMigrationIssuesPath: join(execution, "worktree-registry-migration-issues.json"),
            publicationStagingRoot: join(execution, "plan-staging"),
            deliveryEvidenceRoot: join(execution, "delivery-evidence"),
            projectSecretStorePath: join(home, "internal", owner, "collaboration-secrets.json"),
            fallbackWorktreesRoot: join(execution, "worktrees"),
            debugRoot: join(execution, "debug"),
            workRecordIndexDatabasePath: join(home, "internal", owner, "work-records.sqlite3"),
        },
        selected: {
            checkoutRoot: identity.checkoutRoot,
            internalRoot: checkout,
            planLocksDir: join(checkout, "plan-locks"),
            planCatalogLockPath: join(checkout, "plan-locks", "catalog.lock"),
            transitionJournalsDir: join(checkout, "plan-transitions"),
            planBackupsDir: join(checkout, "plan-backups"),
            workRecordSupersessionLockPath: join(checkout, "work-record-supersession.lock"),
            workRecordSupersessionRecoveryLockPath: join(checkout, "work-record-supersession-recovery.lock"),
        },
    };
}
async function checkoutRoots(identity: ProjectIdentity): Promise<string[]> {
    const primary = resolvePrimaryCheckoutRoot(identity.checkoutRoot);
    if (!(await info(join(primary, ".git")))) return [identity.checkoutRoot];
    const evidence = await observeGitEvidence(`home-worktree-list\0${primary}`, await gitWorktreeListEvidence(primary));
    let records = reusedGitRead<string>(evidence);
    if (records === undefined) {
        try {
            records = git(primary, ["worktree", "list", "--porcelain", "-z"]);
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
            records = git(primary, ["worktree", "list", "--porcelain", "-z"]);
        }
        await rememberGitRead(evidence, records);
    }
    const roots = [
        ...new Set([
            primary,
            identity.checkoutRoot,
            ...records
                .split("\0")
                .filter((s) => s.startsWith("worktree "))
                .map((s) => s.slice(9)),
        ]),
    ].sort();
    // Git retains prunable registrations after a checkout disappears. Recovery owns
    // those attempts; absence supplies no source tree to admit or migrate.
    const present: string[] = [];
    for (const root of roots) {
        const stat = await info(root);
        if (stat) present.push(await fs.realpath(root));
    }
    return present;
}
async function assertSafePath(path: string, stop: string): Promise<void> {
    for (let current = path; ; current = dirname(current)) {
        const stat = await info(current);
        if (stat?.isSymbolicLink()) refuse("symlink", [current], "Runtime authority uses a symbolic link.");
        if (current === stop || !inside(stop, current)) break;
    }
}
async function validateHomeAuthorities(
    identity: ProjectIdentity,
    layout: ProjectRuntimeLayout,
    transfer: RuntimeTransfer | null,
): Promise<void> {
    const payloadLinks = new Map(
        transfer?.files.filter((file) => file.link !== undefined).map((file) => [file.destination, file]),
    );
    if (transfer?.phase === "copying") {
        for (const file of transfer.files.filter((file) => file.link !== undefined)) {
            const stage = `${file.destination}.runtime-copy`;
            if (!payloadLinks.has(stage)) payloadLinks.set(stage, file);
        }
    }
    async function walk(path: string, repositories = false): Promise<void> {
        const payload = payloadLinks.get(path);
        await assertSafePath(payload ? dirname(path) : path, projectHome(identity));
        const stat = await info(path);
        if (stat?.isSymbolicLink() && payload && (await fileDigest(path, payload.link)) === payload.digest) return;
        if (!stat) return;
        if (stat.isDirectory()) {
            if (repositories && (await info(join(path, ".git")))) return;
            for (const name of await fs.readdir(path))
                await walk(join(path, name), repositories || name === "worktrees" || name === "plan-staging");
        } else if (!stat.isFile())
            refuse("malformed_migration_evidence", [path], "Home authority has an unsupported file type.");
    }
    await walk(layout.primary.internalRoot);
    await walk(dirname(layout.primary.projectSecretStorePath));
    await walk(dirname(layout.primary.worktreeRegistryPath));
    await walk(dirname(layout.primary.worktreeRegistryLockPath));
}
async function assertUntracked(roots: string[]): Promise<void> {
    for (const root of roots) {
        if (!(await info(join(root, ".git")))) continue;
        const evidence = await observeGitEvidence(`home-runtime-index\0${root}`, await gitIndexEvidence(root));
        let tracked = reusedGitRead<string>(evidence);
        if (tracked === undefined) {
            tracked = git(root, ["ls-files", "-z", "--", ".wld"]);
            await rememberGitRead(evidence, tracked);
        }
        const paths = tracked.split("\0").filter(isRunWieldOwnedRuntimePath);
        if (paths.length) {
            const secret = paths.some((path) => path.includes("collaboration-secrets.json"));
            refuse(
                secret ? "tracked_secret" : "tracked_runtime",
                paths.map((path) => join(root, path)),
                secret
                    ? "A collaboration secret is tracked. Untrack it, remove it from history, and rotate the capability."
                    : "Runtime files are tracked or staged. Untrack them before adoption.",
            );
        }
    }
}
async function sourceMappings(identity: ProjectIdentity, identities: ProjectIdentity[]): Promise<RuntimeMapping[]> {
    const mappings: RuntimeMapping[] = [];
    const primary = homeProjectRuntimeLayout(identity).primary;
    for (const selectedIdentity of identities) {
        const root = selectedIdentity.checkoutRoot;
        if (
            selectedIdentity.projectId !== identity.projectId ||
            selectedIdentity.repositoryId !== identity.repositoryId
        )
            refuse(
                "invalid_registered_checkout",
                [root],
                "Checkout identity does not match the repository runtime owner.",
            );
        const selected = homeProjectRuntimeLayout(selectedIdentity).selected;
        const named: Record<string, string> = {
            controller: dirname(primary.controllerPlansDir),
            "worktrees.json": primary.worktreeRegistryPath,
            "worktree-registry-migration-issues.json": primary.worktreeRegistryMigrationIssuesPath,
            "plan-staging": primary.publicationStagingRoot,
            "delivery-evidence": primary.deliveryEvidenceRoot,
            "collaboration-secrets.json": primary.projectSecretStorePath,
            worktrees: primary.fallbackWorktreesRoot,
            debug: root === primary.checkoutRoot ? primary.debugRoot : join(selected.internalRoot, "debug"),
            "work-records.sqlite3": primary.workRecordIndexDatabasePath,
            "work-records.sqlite3-wal": `${primary.workRecordIndexDatabasePath}-wal`,
            "work-records.sqlite3-shm": `${primary.workRecordIndexDatabasePath}-shm`,
            "plan-locks": selected.planLocksDir,
            "plan-transitions": selected.transitionJournalsDir,
            "plan-backups": selected.planBackupsDir,
            "execution-setup.json": join(selected.internalRoot, "execution-setup.json"),
            "worktree-project-context.json": join(selected.internalRoot, "worktree-project-context.json"),
            "project-context-publication.json": join(selected.internalRoot, "project-context-publication.json"),
        };
        for (const base of [getRunWieldRuntimeDir(root), join(getRunWieldRuntimeDir(root), "internal")]) {
            await assertSafePath(base, root);
            for (const name of ["worktrees", "plan-staging"]) {
                mappings.push({ source: join(base, name), destination: named[name], repository: true });
            }
            if (!(await info(base))) continue;
            for (const entry of await fs.readdir(base, { withFileTypes: true })) {
                if (["worktrees", "plan-staging"].includes(entry.name)) continue;
                if (
                    base === getRunWieldRuntimeDir(root) &&
                    !LEGACY_PROJECT_RUNTIME_HAZARD_PATHS.includes(`.wld/${entry.name}`)
                )
                    continue;
                const source = join(base, entry.name);
                const destination =
                    named[entry.name] ??
                    join(
                        primary.internalRoot,
                        "legacy-recovery",
                        selectedIdentity.checkoutId,
                        base.endsWith("internal") ? "internal" : "flat",
                        entry.name,
                    );
                mappings.push({
                    source,
                    destination,
                    repository: entry.name === "worktrees" || entry.name === "plan-staging",
                });
            }
        }
    }
    return mappings;
}
async function readMarker(layout: ProjectRuntimeLayout, identity: ProjectIdentity): Promise<HomeMarker | null> {
    await assertSafePath(layout.primary.layoutMarkerPath, projectHome(identity));
    if (!(await info(layout.primary.layoutMarkerPath))) return null;
    let marker: HomeMarker;
    try {
        marker = JSON.parse(await fs.readFile(layout.primary.layoutMarkerPath, "utf8"));
    } catch {
        return refuse(
            "malformed_migration_evidence",
            [layout.primary.layoutMarkerPath],
            "Home runtime marker is unreadable.",
        );
    }
    if (marker.version > 2)
        refuse("newer_layout", [layout.primary.layoutMarkerPath], "Home runtime requires a newer RunWield version.");
    if (
        marker.version !== 2 ||
        marker.projectId !== identity.projectId ||
        marker.repositoryId !== identity.repositoryId ||
        marker.owner !== ownerKey(identity) ||
        !Array.isArray(marker.roots) ||
        marker.roots.some((root) => typeof root !== "string" || !isAbsolute(root))
    )
        refuse(
            "malformed_migration_evidence",
            [layout.primary.layoutMarkerPath],
            "Home runtime marker has conflicting ownership.",
        );
    return marker;
}
async function validateLegacyEvidence(
    mappings: RuntimeMapping[],
    roots: string[],
    transfer: RuntimeTransfer | null,
): Promise<void> {
    for (const mapping of mappings) {
        const name = mapping.source.split(/[\\/]/).at(-1);
        if (name === "worktrees.json") {
            const registry = await inspectWorktreeRegistryAtPath(mapping.source);
            if (registry.readError || registry.integrityIssues.length)
                refuse(
                    "malformed_registry",
                    [mapping.source],
                    registry.readError?.message ?? registry.integrityIssues[0].message,
                );
            for (const entry of registry.entries) {
                await assertSafePath(entry.path, entry.path);
                const existing = await info(entry.path);
                const original = existing ? await fs.realpath(entry.path) : entry.path;
                const moved =
                    transfer && transfer.roots.includes(original) ? relocated(original, transfer.mappings) : original;
                if (
                    existing &&
                    !roots.includes(original) &&
                    !(moved !== original && roots.includes(canonicalRuntimeReference(moved)))
                )
                    refuse(
                        "invalid_registered_checkout",
                        [entry.path],
                        "Legacy attempt does not name a registered checkout.",
                    );
            }
        }
        if (name !== "layout.json" && name !== "layout-migration.json") continue;
        let saved: OldJournal;
        try {
            saved = JSON.parse(await fs.readFile(mapping.source, "utf8"));
        } catch {
            return refuse("malformed_migration_evidence", [mapping.source], "Legacy migration evidence is unreadable.");
        }
        if (saved.version > 1) refuse("newer_layout", [mapping.source], "Legacy runtime requires a newer version.");
        if (saved.version !== 1 || !roots.includes(saved.primaryCheckoutRoot))
            refuse("malformed_migration_evidence", [mapping.source], "Legacy migration ownership is invalid.");
        if (
            name === "layout.json" &&
            (!Array.isArray(saved.adoptedSelectedCheckoutRoots) ||
                saved.adoptedSelectedCheckoutRoots.some((root) => typeof root !== "string" || !isAbsolute(root)))
        )
            refuse("malformed_migration_evidence", [mapping.source], "Legacy marker checkout roots are invalid.");
        if (name === "layout-migration.json") {
            if (
                !Array.isArray(saved.operations) ||
                !Array.isArray(saved.selectedCheckoutRoots) ||
                saved.selectedCheckoutRoots.some((root) => !roots.includes(root))
            )
                refuse("malformed_migration_evidence", [mapping.source], "Legacy migration roots are invalid.");
            for (const op of saved.operations) {
                if (
                    !["rename", "retire", "reconcile"].includes(op.action) ||
                    typeof op.source !== "string" ||
                    !roots.some(
                        (root) =>
                            inside(join(getRunWieldRuntimeDir(root), "internal"), op.source) ||
                            LEGACY_PROJECT_RUNTIME_HAZARD_PATHS.some((name) =>
                                inside(join(getRunWieldRuntimeDir(root), name.replace(/^\.wld\//, "")), op.source),
                            ),
                    ) ||
                    (op.destination &&
                        !roots.some((root) => inside(join(getRunWieldRuntimeDir(root), "internal"), op.destination!)))
                )
                    refuse(
                        "malformed_migration_evidence",
                        [mapping.source],
                        "Legacy migration operation escapes its recorded runtime sources.",
                    );
                if (op.action === "retire" && !op.completed) {
                    const snapshot = await readLockFileSnapshot(op.source);
                    if (snapshot && (!op.proof || !lockFileSnapshotMatches(snapshot, op.proof)))
                        refuse(
                            "active_legacy_writer",
                            [op.source],
                            "Legacy lock changed after its retirement proof was recorded.",
                        );
                }
            }
        }
    }
}

function isRuntimeLock(mapping: RuntimeMapping, path: string): boolean {
    if (mapping.repository || !path.endsWith(".lock")) return false;
    const name = basename(mapping.source);
    if (name === "controller") return inside(join(mapping.source, "plans"), path) && path.endsWith(".json.lock");
    if (name === "plan-locks") return path !== mapping.source;
    return (
        path === mapping.source &&
        [
            "worktrees.lock",
            "layout-migration.lock",
            "work-record-supersession.lock",
            "work-record-supersession-recovery.lock",
            "local-publication.lock",
        ].includes(name)
    );
}
async function inventory(
    mapping: RuntimeMapping,
    result: RuntimeFile[],
    path = mapping.source,
    repository = false,
): Promise<void> {
    const stat = await info(path);
    if (!stat) return;
    const destination = join(mapping.destination, relative(mapping.source, path));
    if (stat.isSymbolicLink()) {
        if (!repository) refuse("symlink", [path], "Runtime authority uses a symbolic link.");
        const link = await fs.readlink(path);
        result.push({
            source: path,
            destination,
            digest: hash(link),
            mode: stat.mode & 0o777,
            link,
            retired: false,
            lock: isRuntimeLock(mapping, path),
        });
    } else if (stat.isDirectory()) {
        if (isRuntimeLock(mapping, path) && Date.now() - stat.mtimeMs < 30_000)
            refuse("active_legacy_writer", [path], "A legacy publication writer is active. Retry after it settles.");
        const inRepository = repository || (mapping.repository && Boolean(await info(join(path, ".git"))));
        for (const entry of await fs.readdir(path)) {
            // Checkout-owned runtime is inventoried separately, never carried as a second authority with code.
            if (
                inRepository &&
                entry === "internal" &&
                path.endsWith(`${process.platform === "win32" ? "\\" : "/"}.wld`)
            )
                continue;
            await inventory(mapping, result, join(path, entry), inRepository);
        }
    } else if (stat.isFile()) {
        result.push({
            source: path,
            destination,
            digest: hash(await fs.readFile(path)),
            mode: repository ? stat.mode & 0o777 : 0o600,
            retired: false,
            lock: isRuntimeLock(mapping, path),
        });
    } else refuse("malformed_migration_evidence", [path], "Runtime contains an unsupported filesystem object.");
}
function hash(bytes: string | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
async function fileDigest(path: string, link?: string): Promise<string> {
    return hash(link === undefined ? await fs.readFile(path) : await fs.readlink(path));
}
async function save(path: string, value: RuntimeTransfer | HomeMarker): Promise<void> {
    ensurePrivateDir(dirname(path));
    const temp = `${path}.transfer-tmp`;
    const file = await fs.open(temp, "w", 0o600);
    try {
        await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        await file.sync();
    } finally {
        await file.close();
    }
    await fs.rename(temp, path);
    syncParentDirectory(path);
}
async function readTransfer(
    layout: ProjectRuntimeLayout,
    identity: ProjectIdentity,
    mappings: RuntimeMapping[],
): Promise<RuntimeTransfer | null> {
    const path = layout.primary.layoutMigrationJournalPath;
    await assertSafePath(path, projectHome(identity));
    if (!(await info(path))) return null;
    const journal: RuntimeTransfer = JSON.parse(await fs.readFile(path, "utf8"));
    if (
        journal.version !== 2 ||
        journal.projectId !== identity.projectId ||
        journal.repositoryId !== identity.repositoryId ||
        journal.owner !== ownerKey(identity) ||
        !["copying", "verified", "published"].includes(journal.phase) ||
        !Array.isArray(journal.files) ||
        !Array.isArray(journal.mappings) ||
        !Array.isArray(journal.roots)
    )
        refuse("malformed_migration_evidence", [path], "Home transfer journal has invalid ownership or format.");
    const actualRoots = await checkoutRoots(identity);
    for (const root of journal.roots) {
        if (typeof root !== "string" || !isAbsolute(root))
            refuse("malformed_migration_evidence", [path], "Transfer contains a noncanonical checkout root.");
        const oldFallback = mappings.some(
            (mapping) => mapping.repository && inside(canonicalRuntimeReference(mapping.source), root),
        );
        if (!actualRoots.includes(root) && !oldFallback)
            refuse("malformed_migration_evidence", [root], "Transfer root is no longer a registered checkout.");
    }
    for (const mapping of journal.mappings) {
        if (
            typeof mapping.source !== "string" ||
            typeof mapping.destination !== "string" ||
            !journal.roots.some(
                (root) =>
                    inside(join(getRunWieldRuntimeDir(root), "internal"), mapping.source) ||
                    LEGACY_PROJECT_RUNTIME_HAZARD_PATHS.some(
                        (name) => mapping.source === join(getRunWieldRuntimeDir(root), name.replace(/^\.wld\//, "")),
                    ),
            ) ||
            !inside(projectHome(identity), mapping.destination)
        )
            refuse("malformed_migration_evidence", [path], "Transfer mapping escapes its runtime owner.");
        const observed = mappings.find((candidate) => candidate.source === mapping.source);
        if (observed && observed.destination !== mapping.destination)
            refuse(
                "malformed_migration_evidence",
                [path],
                "Transfer destination conflicts with the current runtime layout.",
            );
    }
    for (const file of journal.files) {
        const mapping = journal.mappings
            .filter((candidate) => inside(candidate.source, file.source))
            .sort((a, b) => b.source.length - a.source.length)[0];
        if (
            !mapping ||
            file.destination !== join(mapping.destination, relative(mapping.source, file.source)) ||
            (file.link !== undefined && (typeof file.link !== "string" || !mapping.repository)) ||
            !/^[a-f0-9]{64}$/.test(file.digest) ||
            !Number.isInteger(file.mode) ||
            typeof file.retired !== "boolean"
        )
            refuse("malformed_migration_evidence", [path], "Transfer inventory contains an invalid path or digest.");
    }
    return journal;
}

/** Pure inspection reads no locks and never finishes a transfer. */
export async function inspectHomeProjectRuntime(identity: ProjectIdentity): Promise<ProjectRuntimeReadInspection> {
    const layout = homeProjectRuntimeLayout(identity);
    try {
        await assertSafePath(projectHome(identity), identity.executionAccountHome);
        const roots = await checkoutRoots(identity);
        await assertUntracked(roots);
        const marker = await readMarker(layout, identity);
        // An unbound linked checkout is pending until deliberate entry admits it.
        const identities: ProjectIdentity[] = [];
        for (const root of roots) {
            const known =
                root === identity.checkoutRoot
                    ? { kind: "existing" as const, identity }
                    : inspectProjectIdentity(root, {
                          context: {
                              personalOwner: identity.personalOwner,
                              executionAccountHome: identity.executionAccountHome,
                          },
                      });
            if (known.kind !== "existing") return { kind: "pending", layout };
            identities.push(known.identity);
        }
        const mappings = await sourceMappings(identity, identities);
        const journal = await readTransfer(layout, identity, mappings);
        await validateHomeAuthorities(identity, layout, journal);
        await validateLegacyEvidence(mappings, roots, journal);
        const files: RuntimeFile[] = [];
        for (const mapping of mappings) await inventory(mapping, files);
        const currentRegistry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
        if (
            currentRegistry.readError ||
            currentRegistry.integrityIssues.some((issue) =>
                ["malformed_registry", "unsupported_schema_version"].includes(issue.kind),
            )
        )
            refuse(
                "malformed_registry",
                [layout.primary.worktreeRegistryPath],
                currentRegistry.readError?.message ?? currentRegistry.integrityIssues[0].message,
            );
        const pending =
            Boolean(journal) ||
            (!marker && files.length > 0) ||
            Boolean(marker && !marker.roots.includes(identity.checkoutRoot));
        return {
            kind: pending ? "pending" : marker ? "ready" : "fresh",
            layout,
            ...(marker ? { adoptedSelectedCheckoutRoots: marker.roots } : {}),
        };
    } catch (error) {
        if (error instanceof ProjectRuntimeEntryRefusedError)
            return { kind: "blocked", reason: error.reason, paths: error.paths, message: error.message };
        throw error;
    }
}

async function holdSourceLocks(files: RuntimeFile[]): Promise<NativeFileLock[]> {
    const locks: NativeFileLock[] = [];
    try {
        for (const file of files.filter((file) => file.lock)) {
            if (!(await info(file.source))) continue;
            if (file.source.endsWith("worktrees.lock") || file.source.endsWith("layout-migration.lock")) {
                const snapshot = await fs.readFile(file.source, "utf8");
                if (!(await isLockHolderGone(snapshot)))
                    refuse(
                        "active_legacy_writer",
                        [file.source],
                        "A legacy registry or migration writer is active. Retry after it settles.",
                    );
            }
            const lock = openNativeFileLock(file.source, false);
            locks.push(lock);
            if (!lock.tryLockSync(true))
                refuse(
                    "active_legacy_writer",
                    [file.source],
                    "A legacy runtime writer is active. Retry after it settles.",
                );
        }
        return locks;
    } catch (error) {
        for (const lock of locks.reverse()) lock.close();
        throw error;
    }
}
async function copyFile(file: RuntimeFile, home: string): Promise<void> {
    if (file.lock) return; // Native ownership is acquired afresh; lock bytes never transfer.
    await assertSafePath(file.link === undefined ? file.destination : dirname(file.destination), home);
    const source = await info(file.source);
    const destination = await info(file.destination);
    if (!source && destination && (await fileDigest(file.destination, file.link)) === file.digest) return;
    if (!source || (await fileDigest(file.source, file.link)) !== file.digest)
        refuse(
            "authority_conflict",
            [file.source],
            "Runtime source changed after inventory. Both copies were retained.",
        );
    if (destination) {
        if ((await fileDigest(file.destination, file.link)) !== file.digest)
            refuse(
                "authority_conflict",
                [file.source, file.destination],
                "Runtime destination differs from the recorded source. Both copies were retained.",
            );
        if (file.link === undefined) {
            await fs.chmod(file.destination, file.mode);
            if (process.platform !== "win32" && ((await fs.stat(file.destination)).mode & 0o777) !== file.mode)
                refuse("authority_conflict", [file.destination], "Destination permissions could not be verified.");
        }
        return;
    }
    ensurePrivateDir(dirname(file.destination));
    const stage = `${file.destination}.runtime-copy`;
    if (await info(stage)) await fs.rm(stage);
    if (file.link !== undefined) await fs.symlink(file.link, stage);
    else {
        await fs.copyFile(file.source, stage);
        await fs.chmod(stage, file.mode);
        if (process.platform !== "win32" && ((await fs.stat(stage)).mode & 0o777) !== file.mode)
            refuse("authority_conflict", [stage], "Destination permissions could not be verified.");
        const fd = await fs.open(stage, "r");
        try {
            await fd.sync();
        } finally {
            await fd.close();
        }
    }
    if ((await fileDigest(stage, file.link)) !== file.digest)
        refuse(
            "authority_conflict",
            [file.source, stage],
            "Copied runtime bytes failed verification. The source was retained.",
        );
    await fs.rename(stage, file.destination);
    syncParentDirectory(file.destination);
}
function canonicalRuntimeReference(path: string): string {
    let ancestor = path;
    const suffix: string[] = [];
    while (true) {
        try {
            return join(realpathSync(ancestor), ...suffix);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            const parent = dirname(ancestor);
            if (parent === ancestor) throw error;
            suffix.unshift(basename(ancestor));
            ancestor = parent;
        }
    }
}
function relocated(path: string, mappings: RuntimeMapping[]): string {
    const canonical = canonicalRuntimeReference(path);
    const mapping = mappings
        .filter((entry) => entry.repository)
        .map((entry) => ({ ...entry, source: canonicalRuntimeReference(entry.source) }))
        .filter((entry) => inside(entry.source, canonical))
        .sort((a, b) => b.source.length - a.source.length)[0];
    return mapping ? join(mapping.destination, relative(mapping.source, canonical)) : path;
}
async function repairRepositories(journal: RuntimeTransfer, primary: string): Promise<void> {
    for (const mapping of journal.mappings.filter((entry) => entry.repository)) {
        if (!(await info(mapping.destination))) continue;
        for (const entry of await fs.readdir(mapping.destination)) {
            const root = join(mapping.destination, entry);
            const gitInfo = await info(join(root, ".git"));
            if (!gitInfo) continue;
            if (gitInfo.isFile()) git(primary, ["worktree", "repair", root]);
            git(root, ["rev-parse", "--verify", "HEAD"]);
        }
    }
}
async function relocateRegistry(layout: ProjectRuntimeLayout, journal: RuntimeTransfer): Promise<void> {
    if (!(await info(layout.primary.worktreeRegistryPath))) return;
    const registry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
    // Existing home authority may need registry recovery. Mapping paths preserves
    // every attempt; uniqueness remains the registry action boundary's decision.
    if (
        registry.readError ||
        registry.integrityIssues.some(
            (issue) => !["duplicate_worktree_id", "duplicate_live_attempt"].includes(issue.kind),
        )
    )
        refuse("malformed_registry", [layout.primary.worktreeRegistryPath], "Copied registry could not be validated.");
    let changed = false;
    for (const entry of registry.entries) {
        const move = (path: string) => {
            const next = relocated(path, journal.mappings);
            if (next !== path) changed = true;
            return next;
        };
        entry.path = move(entry.path);
        if (entry.publication) {
            entry.publication.executionCwd = move(entry.publication.executionCwd);
            entry.publication.publicationRoot = move(entry.publication.publicationRoot);
            if (entry.publication.failure?.repairRoot)
                entry.publication.failure.repairRoot = move(entry.publication.failure.repairRoot);
            if (entry.publication.revalidation)
                entry.publication.revalidation.archiveRoot = move(entry.publication.revalidation.archiveRoot);
        }
    }
    if (changed) {
        const path = layout.primary.worktreeRegistryPath;
        const contents = `${JSON.stringify({ version: 2, entries: registry.entries }, null, 2)}\n`;
        // Persist the exact authorized rewrite before changing destination bytes.
        for (const file of journal.files.filter((file) => file.destination === path))
            file.publishedDigest = hash(contents);
        await save(layout.primary.layoutMigrationJournalPath, journal);
        const fd = await fs.open(`${path}.runtime-mapping`, "w", 0o600);
        try {
            await fd.writeFile(contents);
            await fd.sync();
        } finally {
            await fd.close();
        }
        await fs.rename(`${path}.runtime-mapping`, path);
        syncParentDirectory(path);
    }
}
async function removeEmptyTree(path: string): Promise<void> {
    const stat = await info(path);
    if (!stat?.isDirectory()) return;
    for (const entry of await fs.readdir(path)) await removeEmptyTree(join(path, entry));
    if ((await fs.readdir(path)).length === 0) {
        await fs.rmdir(path);
        syncParentDirectory(path);
    }
}
export async function enterHomeProjectRuntime(identity: ProjectIdentity): Promise<ProjectRuntimeMigrationReadyResult> {
    if (identity.personalOwner.kind !== "execution-account")
        throw new Error("Managed remote cannot adopt ordinary home runtime");
    const layout = homeProjectRuntimeLayout(identity);
    await assertSafePath(projectHome(identity), identity.executionAccountHome);
    await assertSafePath(layout.primary.layoutMigrationLockPath, projectHome(identity));
    ensurePrivateDir(dirname(layout.primary.layoutMigrationLockPath));
    const migrationLock = openNativeFileLock(layout.primary.layoutMigrationLockPath);
    await migrationLock.lock(true);
    let sourceLocks: NativeFileLock[] = [];
    let registryLock: NativeFileLock | undefined;
    const indexes: DatabaseSync[] = [];
    try {
        const roots = await checkoutRoots(identity);
        const identities: ProjectIdentity[] = [];
        for (const root of roots) {
            const admission = await admitProjectIdentity(root, {
                context: { personalOwner: identity.personalOwner, executionAccountHome: identity.executionAccountHome },
            });
            if (admission.kind !== "existing")
                refuse("invalid_registered_checkout", [root], "Linked checkout identity could not be admitted.");
            identities.push(admission.identity);
        }
        await assertUntracked(roots);
        let mappings = await sourceMappings(identity, identities);
        for (const mapping of mappings.filter((entry) => entry.source.endsWith("work-records.sqlite3"))) {
            const database = new DatabaseSync(mapping.source);
            indexes.push(database);
            try {
                const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
                if (checkpoint && Number(checkpoint.busy) !== 0) throw new Error("SQLite checkpoint is busy");
                database.exec("BEGIN EXCLUSIVE");
            } catch (error) {
                refuse("active_legacy_writer", [mapping.source], `Work Record index is in use: ${String(error)}`);
            }
        }
        mappings = await sourceMappings(identity, identities);
        const marker = await readMarker(layout, identity);
        let journal = await readTransfer(layout, identity, mappings);
        await validateHomeAuthorities(identity, layout, journal);
        ensurePrivateDir(dirname(layout.primary.worktreeRegistryPath));
        await validateLegacyEvidence(mappings, roots, journal);
        if (!journal) {
            const files: RuntimeFile[] = [];
            for (const mapping of mappings) await inventory(mapping, files);
            sourceLocks = await holdSourceLocks(files);
            if (files.length) {
                registryLock = openNativeFileLock(layout.primary.worktreeRegistryLockPath);
                await registryLock.lock(true);
            }
            // Returning old controller/registry input preserves the already-adopted decisions.
            if (marker) {
                // Recovery takes the source and destination controller locks together.
                for (const lock of sourceLocks.reverse()) lock.close();
                sourceLocks = [];
                for (const mapping of mappings.filter(
                    (m) =>
                        m.destination === dirname(layout.primary.controllerPlansDir) ||
                        m.destination === layout.primary.worktreeRegistryPath,
                )) {
                    await recoverLegacyRuntimeFiles({
                        ...mapping,
                        archiveRoot: join(layout.primary.internalRoot, "legacy-recovery"),
                        controller: mapping.destination === dirname(layout.primary.controllerPlansDir),
                        registry: mapping.destination === layout.primary.worktreeRegistryPath,
                    });
                }
                files.length = 0;
                for (const mapping of mappings) await inventory(mapping, files);
                sourceLocks = await holdSourceLocks(files);
            }
            const registry = await inspectWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
            const references = registry.entries
                .flatMap((entry) => [
                    entry.path,
                    entry.publication?.executionCwd,
                    entry.publication?.publicationRoot,
                    entry.publication?.failure?.repairRoot,
                    entry.publication?.revalidation?.archiveRoot,
                ])
                .filter((path): path is string => Boolean(path));
            const relocating = references.some((path) => relocated(path, mappings) !== path);
            if (!files.length && !relocating && marker && roots.every((root) => marker.roots.includes(root))) {
                for (const root of roots) await removeEmptyTree(join(getRunWieldRuntimeDir(root), "internal"));
                return { kind: "ready", layout, migrated: false, adoptedSelectedCheckoutRoots: marker.roots };
            }
            journal = {
                version: 2,
                projectId: identity.projectId,
                repositoryId: identity.repositoryId,
                owner: ownerKey(identity),
                phase: "copying",
                roots,
                mappings,
                files,
            };
            await save(layout.primary.layoutMigrationJournalPath, journal);
        } else sourceLocks = await holdSourceLocks(journal.files);
        if (!registryLock) {
            registryLock = openNativeFileLock(layout.primary.worktreeRegistryLockPath);
            await registryLock.lock(true);
        }
        if (journal.phase === "copying") {
            for (const file of journal.files) await copyFile(file, projectHome(identity));
            journal.phase = "verified";
            await save(layout.primary.layoutMigrationJournalPath, journal);
        }
        if (journal.phase === "verified") {
            for (const file of journal.files.filter((file) => !file.lock)) {
                await assertSafePath(
                    file.link === undefined ? file.destination : dirname(file.destination),
                    projectHome(identity),
                );
                const digest = await fileDigest(file.destination, file.link);
                // A journaled registry rewrite may have stopped on either side of its atomic rename.
                const originalRegistry =
                    file.destination === layout.primary.worktreeRegistryPath && digest === file.digest;
                if (digest !== (file.publishedDigest ?? file.digest) && !originalRegistry)
                    refuse(
                        "authority_conflict",
                        [file.source, file.destination],
                        "Runtime destination changed after verification. Both copies were retained.",
                    );
                file.publishedDigest ??= file.digest;
            }
            await repairRepositories(journal, layout.primary.checkoutRoot);
            await relocateRegistry(layout, journal);
            journal.phase = "published";
            await save(layout.primary.layoutMigrationJournalPath, journal);
        }
        for (const index of indexes.splice(0)) index.close();
        if (process.platform === "win32") {
            for (const lock of sourceLocks.reverse()) lock.close();
            sourceLocks = [];
        }
        for (const file of journal.files) {
            if (file.retired) continue;
            if (!file.lock) {
                await assertSafePath(
                    file.link === undefined ? file.destination : dirname(file.destination),
                    projectHome(identity),
                );
                const destination = await info(file.destination);
                if (
                    !destination ||
                    !file.publishedDigest ||
                    (await fileDigest(file.destination, file.link)) !== file.publishedDigest ||
                    (file.link === undefined &&
                        process.platform !== "win32" &&
                        (destination.mode & 0o777) !== file.mode)
                )
                    refuse(
                        "authority_conflict",
                        [file.source, file.destination],
                        "Published runtime destination changed before retirement. The source was retained.",
                    );
            }
            if (await info(file.source)) {
                if ((await fileDigest(file.source, file.link)) !== file.digest)
                    refuse(
                        "authority_conflict",
                        [file.source],
                        "Runtime source changed before retirement. It was retained.",
                    );
                await fs.rm(file.source);
                syncParentDirectory(file.source);
            }
            file.retired = true;
            await save(layout.primary.layoutMigrationJournalPath, journal);
        }
        for (const mapping of journal.mappings) await removeEmptyTree(mapping.source);
        for (const root of journal.roots) await removeEmptyTree(join(getRunWieldRuntimeDir(root), "internal"));
        await save(layout.primary.layoutMarkerPath, {
            version: 2,
            projectId: identity.projectId,
            repositoryId: identity.repositoryId,
            owner: ownerKey(identity),
            roots: [...new Set([...(marker?.roots ?? []), ...roots])],
        });
        await fs.rm(layout.primary.layoutMigrationJournalPath);
        syncParentDirectory(layout.primary.layoutMigrationJournalPath);
        return {
            kind: "ready",
            layout,
            migrated: true,
            adoptedSelectedCheckoutRoots: [...new Set([...(marker?.roots ?? []), ...roots])],
        };
    } finally {
        for (const lock of sourceLocks.reverse()) lock.close();
        registryLock?.close();
        for (const index of indexes) index.close();
        migrationLock.close();
    }
}
