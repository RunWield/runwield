/** Stable Core identity. Inspection never writes; admission owns all identity mutations. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    closeSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getHomeDir } from "../constants.js";
import { encodeCwdForSessionDir } from "./project-directory-key.ts";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout.ts";
import { openNativeFileLock, type NativeFileLock } from "./native-file-lock.ts";
import { ensurePrivateDir, syncParentDirectory, writeJsonAtomically } from "./private-json-file.ts";
import { remoteProjectOwner } from "./remote/personal-resources.ts";

export interface ProjectPersonalOwner {
    kind: "execution-account" | "managed-remote";
    /** Explicit laptop account identity for managed launches; account home for ordinary launches. */
    identity: string;
}
export interface ProjectLaunchContext {
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
}
export interface ProjectIdentity {
    projectId: string;
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
    repositoryId: string;
    checkoutId: string;
    cwd: string;
    checkoutRoot: string;
}
export interface ProjectIdentityCandidate {
    projectId: string;
    displayName: string;
    remote: string;
}
export interface ProjectIdentityPending {
    kind: "pending";
    candidates: ProjectIdentityCandidate[];
}
export interface ProjectIdentityInvalid {
    kind: "invalid";
    message: string;
}
export interface ProjectIdentityExisting {
    kind: "existing";
    identity: ProjectIdentity;
}
export interface ProjectIdentityFresh {
    kind: "fresh";
}
export interface ProjectIdentityCanceled {
    kind: "canceled";
}
export type ProjectIdentityInspection =
    ProjectIdentityExisting | ProjectIdentityFresh | ProjectIdentityPending | ProjectIdentityInvalid;
export type ProjectIdentityAdmission = ProjectIdentityInspection | ProjectIdentityCanceled;
export interface ProjectCloneChoice {
    kind: "link" | "new" | "cancel";
    /** Exact candidate evidence shown to the person; admission revalidates it. */
    candidates: ProjectIdentityCandidate[];
    projectId?: string;
}
export interface ProjectIdentityOptions {
    context?: ProjectLaunchContext;
    choice?: ProjectCloneChoice;
}
interface IdentityMarker {
    format: "runwield-project";
    version: 1;
    projectId: string;
    repositoryId: string;
    checkoutId: string;
}
interface RepositoryBinding {
    repositoryId: string;
    remote: string | null;
    decision: "new" | "linked";
    checkouts: CheckoutBinding[];
}
interface CheckoutBinding {
    checkoutId: string;
    root: string;
    historicalRoots?: string[];
}
export interface ProjectStorageLocator {
    repositoryId: string;
    checkoutId: string;
    root: string;
    sessionProjectId: string;
    sessionStoreEstablished: boolean;
    sessionDirectory: string;
    attachedRoot: string;
    attachedDirectory: string;
    /** Verified checkout locations, projected separately from the unchanged storage paths. */
    historicalRoots?: string[];
}
interface ProjectRecord {
    version: 1;
    projectId: string;
    displayName: string;
    personalOwner: ProjectPersonalOwner;
    repositories: RepositoryBinding[];
    storageLocators?: ProjectStorageLocator[];
}
interface IdentityEvidence {
    cwd: string;
    root: string;
    common?: string;
    admin?: string;
    marker: IdentityMarker | null;
    projectId: string | null;
    repositoryId: string | null;
    checkoutId: string | null;
    remote: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireId(value: string, label: string): string {
    if (typeof value !== "string" || !uuid.test(value)) throw new Error(`Invalid ${label}`);
    return value;
}
function missing(error: Error): boolean {
    return "code" in error && error.code === "ENOENT";
}
function regularFile(path: string): boolean {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error(`Identity evidence must be a regular file: ${path}`);
        return true;
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
}
function git(cwd: string, args: string[], absent = false, input?: Uint8Array): string | null {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000, input });
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout.trim();
    if (absent && result.status === 1) return null;
    throw new Error(`Cannot read Project Git identity: ${result.stderr.trim() || result.status}`);
}
interface GitIdentityConfig {
    projectId: string | null;
    repositoryId: string | null;
    remote: string | null;
}
// Cache only Git's parsing of exact bytes. Every access still checks the current file,
// checkout binding, launch owner, and home record; no identity decision is retained.
const parsedIdentityConfigs = new Map<string, GitIdentityConfig>();
function identityConfig(cwd: string, file: string): GitIdentityConfig {
    if (!regularFile(file)) throw new Error(`Missing Project Git config: ${file}`);
    const content = readFileSync(file);
    const key = `${process.env.PATH}\0${content.toString("base64")}`;
    const cached = parsedIdentityConfigs.get(key);
    if (cached) return cached;
    const output = git(
        cwd,
        [
            "config",
            "--file",
            "-",
            "--no-includes",
            "--null",
            "--get-regexp",
            "^(runwield\\.(projectid|repositoryid)|remote\\.origin\\.url)$",
        ],
        true,
        content,
    );
    const values = new Map<string, string[]>();
    for (const entry of output?.split("\0") ?? []) {
        if (!entry) continue;
        const delimiter = entry.indexOf("\n");
        const key = delimiter < 0 ? entry : entry.slice(0, delimiter);
        const value = delimiter < 0 ? "" : entry.slice(delimiter + 1).trim();
        const matches = values.get(key) ?? [];
        matches.push(value);
        values.set(key, matches);
    }
    for (const key of ["runwield.projectid", "runwield.repositoryid"]) {
        const matches = values.get(key) ?? [];
        if (matches.length > 1 || matches[0]?.includes("\n"))
            throw new Error(`Multiple values for identity key ${key} in ${file}`);
    }
    const parsed = {
        projectId: values.get("runwield.projectid")?.[0] ?? null,
        repositoryId: values.get("runwield.repositoryid")?.[0] ?? null,
        remote: values.get("remote.origin.url")?.at(-1) ?? null,
    };
    if (parsedIdentityConfigs.size >= 128) parsedIdentityConfigs.clear();
    parsedIdentityConfigs.set(key, parsed);
    return parsed;
}
function markerAt(path: string): IdentityMarker | null {
    if (!regularFile(path)) return null;
    const marker: IdentityMarker = JSON.parse(readFileSync(path, "utf8"));
    if (
        !marker ||
        marker.format !== "runwield-project" ||
        marker.version !== 1 ||
        Object.keys(marker).sort().join() !== "checkoutId,format,projectId,repositoryId,version"
    ) {
        throw new Error(`Unrecognized Project marker: ${path}`);
    }
    requireId(marker.projectId, `Project ID in ${path}`);
    requireId(marker.repositoryId, `repository ID in ${path}`);
    requireId(marker.checkoutId, `checkout ID in ${path}`);
    return marker;
}
function hasGitDirectory(path: string): boolean {
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return true;
    for (let ancestor = path; ; ancestor = dirname(ancestor)) {
        for (const name of [".git", "HEAD"]) {
            try {
                // HEAD also keeps bare repositories on Git's authoritative probe path.
                lstatSync(join(ancestor, name));
                return true;
            } catch (error) {
                if (!(error instanceof Error && missing(error))) throw error;
            }
        }
        if (dirname(ancestor) === ancestor) return false;
    }
}
function evidence(path: string): IdentityEvidence {
    const cwd = realpathSync(path);
    if (!lstatSync(cwd).isDirectory()) throw new Error("Project root must be a directory");
    // A non-repository exit is distinguished from other Git failures by filesystem evidence.
    const probe = hasGitDirectory(cwd)
        ? spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"], {
              encoding: "utf8",
              timeout: 10000,
          })
        : { status: 1, stdout: "", stderr: "not a git repository", error: undefined };
    if (probe.error) throw probe.error;
    if (probe.status !== 0 && !probe.stderr.includes("not a git repository"))
        throw new Error(`Cannot inspect Project Git directory: ${probe.stderr}`);
    const directories = probe.stdout.trim().split("\n");
    // Newlines in a checkout path make the combined response ambiguous; ask each path separately then.
    const combined = probe.status === 0 && directories.length === 3;
    let root =
        probe.status === 0
            ? realpathSync(combined ? directories[0] : git(cwd, ["rev-parse", "--show-toplevel"])!)
            : cwd;
    if (probe.status !== 0) {
        for (let ancestor = cwd; ; ancestor = dirname(ancestor)) {
            if (regularFile(join(ancestor, ".wld-project.json"))) {
                root = ancestor;
                break;
            }
            if (dirname(ancestor) === ancestor) break;
        }
    }
    const marker = markerAt(join(root, ".wld-project.json"));
    if (probe.status !== 0)
        return {
            cwd,
            root,
            marker,
            projectId: marker?.projectId ?? null,
            repositoryId: marker?.repositoryId ?? null,
            checkoutId: marker?.checkoutId ?? null,
            remote: null,
        };
    const common = realpathSync(resolve(cwd, combined ? directories[1] : git(cwd, ["rev-parse", "--git-common-dir"])!));
    const admin = realpathSync(resolve(cwd, combined ? directories[2] : git(cwd, ["rev-parse", "--git-dir"])!));
    const file = join(common, "config");
    const { projectId, repositoryId, remote } = identityConfig(cwd, file);
    const checkoutPath = join(admin, "runwield-checkout-id");
    const checkoutId = regularFile(checkoutPath)
        ? requireId(readFileSync(checkoutPath, "utf8").trim(), "checkout ID")
        : null;
    if (projectId !== null) requireId(projectId, "Git Project ID");
    if (repositoryId !== null) requireId(repositoryId, "Git repository ID");
    if (
        marker &&
        ((projectId && projectId !== marker.projectId) ||
            (repositoryId && repositoryId !== marker.repositoryId) ||
            (checkoutId && checkoutId !== marker.checkoutId))
    )
        throw new Error("Project marker conflicts with Git identity; both were preserved");
    if (!projectId && repositoryId) throw new Error("Git repository binding has no Project ID");
    return {
        cwd,
        root,
        common,
        admin,
        marker,
        projectId: projectId ?? marker?.projectId ?? null,
        repositoryId: repositoryId ?? marker?.repositoryId ?? null,
        checkoutId: checkoutId ?? marker?.checkoutId ?? null,
        remote,
    };
}
export function projectLaunchContext(): ProjectLaunchContext {
    const executionAccountHome = getHomeDir();
    return {
        executionAccountHome,
        personalOwner: remoteProjectOwner() ?? { kind: "execution-account", identity: executionAccountHome },
    };
}
function contextFor(options: ProjectIdentityOptions): ProjectLaunchContext {
    const context = options.context ?? projectLaunchContext();
    if (
        !isAbsolute(context.executionAccountHome) ||
        !context.personalOwner.identity ||
        !["execution-account", "managed-remote"].includes(context.personalOwner.kind)
    )
        throw new Error("Explicit Project owner and execution account home are required");
    if (
        context.personalOwner.kind === "execution-account" &&
        context.personalOwner.identity !== context.executionAccountHome
    )
        throw new Error("Ordinary Project owner must be the execution account");
    return context;
}
function checkIdentityDirectories(home: string, ...segments: string[]): string {
    let path = home;
    for (const segment of segments) {
        path = join(path, segment);
        try {
            const stat = lstatSync(path);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error(`Identity storage must be a directory, not a link: ${path}`);
        } catch (error) {
            if (!(error instanceof Error && missing(error))) throw error;
        }
    }
    return path;
}
function recordPath(home: string, id: string): string {
    return join(checkIdentityDirectories(home, ".wld", "projects", requireId(id, "Project ID")), "project.wld.json");
}
function readRecord(path: string, id: string): ProjectRecord | null {
    if (!regularFile(path)) return null;
    const record: ProjectRecord = JSON.parse(readFileSync(path, "utf8"));
    if (
        !record ||
        record.version !== 1 ||
        record.projectId !== id ||
        typeof record.displayName !== "string" ||
        !record.personalOwner ||
        typeof record.personalOwner.identity !== "string" ||
        !Array.isArray(record.repositories)
    )
        throw new Error(`Invalid Project record: ${path}`);
    for (const repository of record.repositories) {
        requireId(repository.repositoryId, "stored repository ID");
        if (
            (repository.remote !== null && typeof repository.remote !== "string") ||
            !["new", "linked"].includes(repository.decision) ||
            !Array.isArray(repository.checkouts)
        )
            throw new Error(`Invalid repository binding: ${path}`);
        for (const checkout of repository.checkouts) {
            requireId(checkout.checkoutId, "stored checkout ID");
            if (typeof checkout.root !== "string") throw new Error(`Invalid checkout binding: ${path}`);
            if (
                checkout.historicalRoots &&
                (!Array.isArray(checkout.historicalRoots) ||
                    checkout.historicalRoots.some((root) => typeof root !== "string" || !isAbsolute(root)))
            )
                throw new Error(`Invalid historical checkout binding: ${path}`);
        }
    }
    for (const locator of record.storageLocators ?? []) {
        const repository = record.repositories.find((item) => item.repositoryId === locator.repositoryId);
        if (
            !repository?.checkouts.some((item) => item.checkoutId === locator.checkoutId) ||
            !isAbsolute(locator.root) ||
            !locator.sessionProjectId ||
            locator.sessionDirectory !==
                join(dirname(dirname(dirname(path))), "sessions", encodeCwdForSessionDir(locator.root)) ||
            !isAbsolute(locator.attachedRoot) ||
            locator.attachedDirectory !==
                join(
                    dirname(dirname(dirname(path))),
                    "attached",
                    encodeCwdForSessionDir(locator.attachedRoot),
                    "workflows",
                )
        )
            throw new Error(`Invalid Project storage locator: ${path}`);
    }
    return record;
}
/** Read only committed bindings for this owner and this admitted repository/checkout. */
export function inspectProjectStorage(path: string, options: ProjectIdentityOptions = {}): ProjectStorageLocator[] {
    const context = contextFor(options);
    if (context.personalOwner.kind !== "execution-account") return [];
    let e: IdentityEvidence;
    try {
        e = evidence(path);
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    if (!e.projectId || !e.repositoryId || !e.checkoutId) return [];
    const record = readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
    if (
        !record ||
        record.personalOwner.kind !== context.personalOwner.kind ||
        record.personalOwner.identity !== context.personalOwner.identity
    )
        return [];
    const repository = record.repositories.find((item) => item.repositoryId === e.repositoryId);
    // The committed checkout ID verifies a move without making a passive read rewrite its saved root.
    if (!repository?.checkouts.some((item) => item.checkoutId === e.checkoutId)) return [];
    return (record.storageLocators ?? [])
        .toSorted(
            (a, b) =>
                Number(b.checkoutId === e.checkoutId && b.repositoryId === e.repositoryId) -
                Number(a.checkoutId === e.checkoutId && a.repositoryId === e.repositoryId),
        )
        .map((locator) => {
            const checkout = record.repositories
                .find((item) => item.repositoryId === locator.repositoryId)!
                .checkouts.find((item) => item.checkoutId === locator.checkoutId)!;
            return {
                ...locator,
                historicalRoots: [
                    ...new Set([
                        locator.root,
                        locator.attachedRoot,
                        checkout.root,
                        ...(locator.repositoryId === e.repositoryId && locator.checkoutId === e.checkoutId
                            ? [e.root]
                            : []),
                        ...(checkout.historicalRoots ?? []),
                    ]),
                ],
            };
        });
}

/** Current, verified checkout roots for a legacy Session ID; never infer membership from a remote or basename. */
export function inspectSessionProjectRoots(sessionProjectId: string): string[] {
    const context = projectLaunchContext();
    if (context.personalOwner.kind !== "execution-account") return [];
    const directory = checkIdentityDirectories(context.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    const roots: string[] = [];
    for (const id of names.filter((name) => uuid.test(name))) {
        const record = readRecord(recordPath(context.executionAccountHome, id), id);
        if (
            !record ||
            (record.projectId !== sessionProjectId &&
                !record.storageLocators?.some((item) => item.sessionProjectId === sessionProjectId))
        )
            continue;
        if (
            record.personalOwner.kind !== context.personalOwner.kind ||
            record.personalOwner.identity !== context.personalOwner.identity
        )
            continue;
        for (const repository of record.repositories)
            for (const checkout of repository.checkouts) {
                try {
                    const bindings = inspectProjectStorage(checkout.root);
                    if (
                        bindings.length &&
                        (record.projectId === sessionProjectId ||
                            bindings.some((item) => item.sessionProjectId === sessionProjectId))
                    )
                        roots.push(checkout.root);
                } catch {
                    /* Missing and retargeted checkouts grant no current-root authority. */
                }
            }
    }
    return [...new Set(roots)];
}

/** Publish that an admitted locator now has a store before any Session is created there. */
export function establishProjectSessionStorage(root: string, sessionProjectId: string, directory: string): void {
    const context = projectLaunchContext();
    if (context.personalOwner.kind !== "execution-account") return;
    const e = evidence(root);
    if (!e.projectId) return;
    const path = recordPath(context.executionAccountHome, e.projectId);
    const before = readRecord(path, e.projectId);
    const locator = before?.storageLocators?.find(
        (item) => item.sessionProjectId === sessionProjectId && item.sessionDirectory === directory,
    );
    if (!locator || locator.sessionStoreEstablished) return;
    const lock = openNativeFileLock(join(dirname(path), "identity.lock"));
    try {
        lock.lockSync(true);
        const record = readRecord(path, e.projectId);
        const saved = record?.storageLocators?.find(
            (item) => item.sessionProjectId === sessionProjectId && item.sessionDirectory === directory,
        );
        if (!record || !saved) throw new Error("Project storage binding changed during Session creation");
        saved.sessionStoreEstablished = true;
        writeJsonAtomically(path, record);
    } finally {
        lock.close();
    }
}

/** A path claimed by another admitted Project cannot authorize legacy storage access. */
export function isProjectStorageRootClaimed(root: string, options: ProjectIdentityOptions = {}): boolean {
    const context = contextFor(options);
    try {
        realpathSync(root);
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
    if (context.personalOwner.kind !== "execution-account") return false;
    const directory = checkIdentityDirectories(context.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
    const current = evidence(root);
    for (const id of names.filter((name) => uuid.test(name))) {
        const record = readRecord(recordPath(context.executionAccountHome, id), id);
        // Git worktrees share repository authority before every checkout has been admitted.
        if (id === current.projectId && record?.repositories.some((item) => item.repositoryId === current.repositoryId))
            continue;
        if (
            record?.personalOwner.kind === context.personalOwner.kind &&
            record.personalOwner.identity === context.personalOwner.identity &&
            record.storageLocators?.some((item) => item.root === root || item.attachedRoot === root)
        )
            return true;
    }
    return false;
}

export function assertUnclaimedSessionRoot(root: string, options: ProjectIdentityOptions = {}): void {
    if (isProjectStorageRootClaimed(root, options))
        throw new Error("Session storage belongs to another Project identity");
}

function storageLocator(e: IdentityEvidence, home: string, root: string): ProjectStorageLocator {
    assertUnclaimedSessionRoot(root, {
        context: { executionAccountHome: home, personalOwner: { kind: "execution-account", identity: home } },
    });
    const sessionDirectory = checkIdentityDirectories(home, ".wld", "sessions", encodeCwdForSessionDir(root));
    const file = join(sessionDirectory, ".runwield", "project.json");
    const sessionStoreEstablished = regularFile(file);
    let sessionProjectId = `local-${createHash("sha256").update(root).digest("hex").slice(0, 32)}`;
    if (sessionStoreEstablished) {
        const project: import("./session/file-session-store-types.ts").FileSessionProject = JSON.parse(
            readFileSync(file, "utf8"),
        );
        if (project.remote || !project.projectId || project.currentRoot !== root)
            throw new Error(`Legacy Session locator does not match recorded checkout: ${file}`);
        sessionProjectId = project.projectId;
    }
    return {
        repositoryId: e.repositoryId!,
        checkoutId: e.checkoutId!,
        root,
        sessionProjectId,
        sessionDirectory,
        sessionStoreEstablished,
        attachedRoot: resolvePrimaryCheckoutRoot(root),
        attachedDirectory: join(
            home,
            ".wld",
            "attached",
            encodeCwdForSessionDir(resolvePrimaryCheckoutRoot(root)),
            "workflows",
        ),
    };
}

class SessionStorageBusy extends Error {
    constructor(readonly lockPath: string) {
        super("Session storage is settling");
    }
}

/** Try sorted original writer locks, then take the identity record lock. Contention unwinds
 * checkout admission before waiting, because an in-flight Session can itself enter Project runtime.
 * No native lock file is replaced or relocated.
 */
async function settleStorageLocators(locators: ProjectStorageLocator[]): Promise<NativeFileLock[]> {
    const storage = await import("./session/file-session-storage.ts");
    const paths = [
        ...new Set(
            locators.flatMap((locator) =>
                storage
                    .listManifests(locator.sessionDirectory, true)
                    // A successor transcript carries its original Project's recovery descriptor.
                    // It does not create another bundle or writer lock in this checkout's store.
                    .filter((item) => item.manifest.projectId === locator.sessionProjectId)
                    .map((item) => storage.lockPath(locator.sessionDirectory, item.manifest.runwieldSessionId)),
            ),
        ),
    ].sort();
    const locks: NativeFileLock[] = [];
    try {
        for (const path of paths) {
            const lock = openNativeFileLock(path);
            locks.push(lock);
            if (!lock.tryLockSync(true)) throw new SessionStorageBusy(path);
        }
        return locks;
    } catch (error) {
        for (const lock of locks.reverse()) lock.close();
        throw error;
    }
}

function candidatesFor(e: IdentityEvidence, context: ProjectLaunchContext): ProjectIdentityCandidate[] {
    if (!e.remote || context.personalOwner.kind === "managed-remote") return [];
    const directory = checkIdentityDirectories(context.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    const candidates: ProjectIdentityCandidate[] = [];
    for (const id of names.filter((name) => uuid.test(name)).sort()) {
        const record = readRecord(recordPath(context.executionAccountHome, id), id);
        if (
            record?.personalOwner.kind === context.personalOwner.kind &&
            record.personalOwner.identity === context.personalOwner.identity &&
            record.repositories.some((repo) => repo.remote === e.remote)
        )
            candidates.push({ projectId: id, displayName: record.displayName, remote: e.remote });
    }
    return candidates;
}
function identity(e: IdentityEvidence, context: ProjectLaunchContext): ProjectIdentity {
    return {
        projectId: e.projectId!,
        repositoryId: e.repositoryId!,
        checkoutId: e.checkoutId!,
        cwd: e.cwd,
        checkoutRoot: e.root,
        ...context,
    };
}
/** Pure lookup, including malformed evidence. Does not probe or create writer locks. */
export function inspectProjectIdentity(path: string, options: ProjectIdentityOptions = {}): ProjectIdentityInspection {
    try {
        const context = contextFor(options);
        const e = evidence(path);
        if (e.projectId) {
            if (context.personalOwner.kind === "execution-account")
                readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
            if (!e.repositoryId || !e.checkoutId) return { kind: "fresh" };
            return { kind: "existing", identity: identity(e, context) };
        }
        const candidates = candidatesFor(e, context);
        return candidates.length ? { kind: "pending", candidates } : { kind: "fresh" };
    } catch (error) {
        return { kind: "invalid", message: String(error) };
    }
}
function writeLocalIdentity(path: string, text: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
        writeFileSync(fd, text);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, path);
    syncParentDirectory(path);
}
function putConfig(e: IdentityEvidence, key: string, value: string): void {
    git(e.cwd, ["config", "--file", join(e.common!, "config"), "--no-includes", "--replace-all", key, value]);
}
/** Deliberate entry. Pending and canceled choices never commit identity or an answer. */
export async function admitProjectIdentity(
    path: string,
    options: ProjectIdentityOptions = {},
): Promise<ProjectIdentityAdmission> {
    try {
        const context = contextFor(options);
        let e = evidence(path);
        const candidates = e.projectId ? [] : candidatesFor(e, context);
        if (options.choice?.kind === "cancel") return { kind: "canceled" };
        if (candidates.length && !options.choice) return { kind: "pending", candidates };
        let lockPath: string;
        if (e.common) lockPath = join(e.common, ".runwield-project.lock");
        else {
            const locks = checkIdentityDirectories(context.executionAccountHome, ".wld", "project-identity-locks");
            ensurePrivateDir(locks);
            lockPath = join(locks, `${createHash("sha256").update(e.root).digest("hex")}.lock`);
        }
        regularFile(lockPath);
        const lock = openNativeFileLock(lockPath);
        await lock.lock(true);
        try {
            e = evidence(path);
            if (
                e.projectId &&
                ((options.choice?.kind === "link" && options.choice.projectId !== e.projectId) ||
                    (options.choice?.kind === "new" &&
                        options.choice.candidates.some((candidate) => candidate.projectId === e.projectId)))
            )
                return {
                    kind: "invalid",
                    message: `Clone choice conflicts with the committed Project ${e.projectId}; identity was preserved`,
                };
            const currentCandidates = e.projectId ? [] : candidatesFor(e, context);
            if (!e.projectId && currentCandidates.length && !options.choice)
                return { kind: "pending", candidates: currentCandidates };
            if (
                !e.projectId &&
                options.choice &&
                JSON.stringify(options.choice.candidates) !== JSON.stringify(currentCandidates)
            )
                return { kind: "pending", candidates: currentCandidates };
            const selected =
                options.choice?.kind === "link"
                    ? currentCandidates.find((candidate) => candidate.projectId === options.choice?.projectId)
                    : undefined;
            if (!e.projectId && options.choice?.kind === "link" && !selected)
                return { kind: "invalid", message: "Selected clone-link candidate is no longer available" };
            const needsBinding = !e.projectId || !e.repositoryId || !e.checkoutId || e.marker !== null;
            e.projectId ??= selected?.projectId ?? randomUUID();
            e.repositoryId ??= randomUUID();
            e.checkoutId ??= randomUUID();
            // Validate home evidence before committing repository authority. Managed remote context is only a binding,
            // never permission to write a laptop-owned record through a mount or into the remote account's registry.
            if (context.personalOwner.kind === "execution-account")
                readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
            if (e.common && needsBinding) {
                putConfig(e, "runwield.projectId", e.projectId);
                putConfig(e, "runwield.repositoryId", e.repositoryId);
                const configPath = join(e.common, "config");
                const configFd = openSync(configPath, "r+");
                try {
                    fsyncSync(configFd);
                } finally {
                    closeSync(configFd);
                }
                syncParentDirectory(configPath);
                const checkoutPath = join(e.admin!, "runwield-checkout-id");
                if (!regularFile(checkoutPath)) {
                    writeLocalIdentity(checkoutPath, `${e.checkoutId}\n`);
                }
                const committed = evidence(path);
                if (
                    committed.projectId !== e.projectId ||
                    committed.repositoryId !== e.repositoryId ||
                    committed.checkoutId !== e.checkoutId
                )
                    throw new Error("Git identity verification failed");
                if (e.marker) {
                    unlinkSync(join(e.root, ".wld-project.json"));
                    syncParentDirectory(join(e.root, ".wld-project.json"));
                }
            } else if (!e.common && !e.marker) {
                const marker: IdentityMarker = {
                    format: "runwield-project",
                    version: 1,
                    projectId: e.projectId,
                    repositoryId: e.repositoryId,
                    checkoutId: e.checkoutId,
                };
                writeLocalIdentity(join(e.root, ".wld-project.json"), `${JSON.stringify(marker)}\n`);
            }
            if (context.personalOwner.kind === "execution-account") {
                const file = recordPath(context.executionAccountHome, e.projectId);
                ensurePrivateDir(dirname(file));
                const previousRecord = readRecord(file, e.projectId);
                const previousCheckout = previousRecord?.repositories
                    .find((repo) => repo.repositoryId === e.repositoryId)
                    ?.checkouts.find((item) => item.checkoutId === e.checkoutId);
                const previousLocators = previousRecord?.storageLocators ?? [];
                const ownLocators = previousLocators.filter(
                    (item) => item.repositoryId === e.repositoryId && item.checkoutId === e.checkoutId,
                );
                const additions = ownLocators.length
                    ? ownLocators
                          .filter(
                              (item) =>
                                  !item.sessionStoreEstablished &&
                                  regularFile(join(item.sessionDirectory, ".runwield", "project.json")),
                          )
                          .map((item) => ({ ...item, sessionStoreEstablished: true }))
                    : [storageLocator(e, context.executionAccountHome, previousCheckout?.root ?? e.root)];
                if (previousCheckout && previousCheckout.root !== e.root && !ownLocators.length) {
                    const current = storageLocator(e, context.executionAccountHome, e.root);
                    if (regularFile(join(current.sessionDirectory, ".runwield", "project.json")))
                        additions.push(current);
                }
                // A new worktree does not change an existing checkout's binding. Its caller may
                // already own that checkout's Session writer while preparing the worktree.
                const affectedLocators = [
                    ...additions,
                    ...(previousCheckout && previousCheckout.root !== e.root ? ownLocators : []),
                    ...(selected ? previousLocators : []),
                ];
                const settledLocks = await settleStorageLocators(affectedLocators);
                const recordLock = openNativeFileLock(join(dirname(file), "identity.lock"));
                try {
                    await recordLock.lock(true);
                    const verified = evidence(path);
                    if (
                        verified.projectId !== e.projectId ||
                        verified.repositoryId !== e.repositoryId ||
                        verified.checkoutId !== e.checkoutId ||
                        verified.root !== e.root
                    )
                        throw new Error("Project identity changed during storage admission; retry entry");
                    const record = readRecord(file, e.projectId) ?? {
                        version: 1,
                        projectId: e.projectId,
                        displayName: basename(e.root),
                        personalOwner: context.personalOwner,
                        repositories: [],
                    };
                    if (
                        record.personalOwner.kind !== context.personalOwner.kind ||
                        record.personalOwner.identity !== context.personalOwner.identity
                    )
                        throw new Error("Project record belongs to a different personal owner");
                    const before = JSON.stringify(record);
                    let repository = record.repositories.find((repo) => repo.repositoryId === e.repositoryId);
                    if (!repository) {
                        repository = {
                            repositoryId: e.repositoryId,
                            remote: e.remote,
                            decision: selected || previousRecord ? "linked" : "new",
                            checkouts: [],
                        };
                        record.repositories.push(repository);
                    }
                    record.storageLocators ??= [];
                    for (const locator of additions) {
                        const index = record.storageLocators.findIndex(
                            (item) =>
                                item.sessionDirectory === locator.sessionDirectory &&
                                item.repositoryId === locator.repositoryId,
                        );
                        if (index < 0) record.storageLocators.push(locator);
                        else record.storageLocators[index] = locator;
                    }
                    repository.remote = e.remote;
                    const checkout = repository.checkouts.find((item) => item.checkoutId === e.checkoutId);
                    if (checkout) {
                        if (checkout.root !== e.root)
                            checkout.historicalRoots = [
                                ...new Set([...(checkout.historicalRoots ?? []), checkout.root]),
                            ];
                        checkout.root = e.root;
                    } else repository.checkouts.push({ checkoutId: e.checkoutId, root: e.root });
                    if (JSON.stringify(record) !== before || !regularFile(file)) writeJsonAtomically(file, record);
                } finally {
                    recordLock.close();
                    for (const held of settledLocks.reverse()) held.close();
                }
            }
            return { kind: "existing", identity: identity(e, context) };
        } finally {
            lock.close();
        }
    } catch (error) {
        if (error instanceof SessionStorageBusy) {
            // All identity locks have been released by this point. Wait only on the original writer.
            const writer = openNativeFileLock(error.lockPath, false);
            try {
                await writer.lock(true);
            } finally {
                writer.close();
            }
            return admitProjectIdentity(path, options);
        }
        return { kind: "invalid", message: String(error) };
    }
}
export class ProjectIdentityEntryRequired extends Error {
    constructor(readonly result: ProjectIdentityAdmission) {
        super(
            result.kind === "invalid"
                ? result.message
                : result.kind === "pending"
                  ? `Project clone-link choice required: ${result.candidates.map((candidate) => `${candidate.displayName} (${candidate.projectId})`).join(", ")}`
                  : "Project identity entry canceled",
        );
        this.name = "ProjectIdentityEntryRequired";
    }
}
