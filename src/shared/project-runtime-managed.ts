import { projects, type ProjectIdentity } from "@runwield/projects";
import {
    inspectWorktreeRegistryAtPath,
    withWorktreeRegistryLockAtPath,
    type WorktreeRegistryEntry,
} from "./worktree-registry.ts";
import { readLockFileSnapshot, isLockHolderGone } from "@runwield/resources/locks";
/** Staged personal-runtime transfer. The verified launcher binds both hosts before exchanging bytes. */
import { createHash } from "node:crypto";
import { join, dirname, relative, isAbsolute } from "node:path";
import fs from "node:fs/promises";
import { getRunWieldRuntimeDir, WORKTREE_REGISTRY_LOCK_FILE } from "../constants.ts";
import { ensurePrivateDir, writeJsonAtomically, syncParentDirectory } from "./private-json-file.ts";
import { openNativeFileLock, type NativeFileLock } from "./native-file-lock.ts";
import { DatabaseSync } from "./sqlite.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { isRunWieldOwnedRuntimePath } from "./runwield-owned-paths.ts";

const personalNames = [
    "controller",
    "collaboration-secrets.json",
    "work-records.sqlite3",
    "work-records.sqlite3-wal",
    "work-records.sqlite3-shm",
    "plan-locks",
    "plan-backups",
    "work-record-supersession.lock",
    "work-record-supersession-recovery.lock",
] as const;
export interface ManagedRuntimeFile {
    checkoutId: string;
    layout: "flat" | "internal";
    name: string;
    digest: string;
    bytes: string;
}
export interface ManagedRuntimeAttempt {
    checkoutId: string;
    layout: "flat" | "internal";
    entry: WorktreeRegistryEntry;
}
interface SourceRegistry {
    checkoutId: string;
    checkoutRoot: string;
    layout: "flat" | "internal";
    source: string;
    entries: WorktreeRegistryEntry[];
}
export interface ManagedRuntimeTransfer {
    version: 1;
    projectId: string;
    repositoryId: string;
    personalOwner: string;
    transferId: string;
    files: ManagedRuntimeFile[];
    attempts: ManagedRuntimeAttempt[];
}
interface SourceFile extends ManagedRuntimeFile {
    source: string;
    checkoutRoot: string;
}
interface SourceTransfer {
    transfer: ManagedRuntimeTransfer;
    files: SourceFile[];
    registries: SourceRegistry[];
    destinationCommitted: boolean;
    retired: boolean;
}
export function managedRuntimeDigest(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
export function validateManagedRuntimeFile(file: ManagedRuntimeFile): void {
    if (
        !/^[a-f0-9-]{36}$/.test(file.checkoutId) ||
        !["flat", "internal"].includes(file.layout) ||
        !personalNames.some((name) => file.name === name || file.name.startsWith(`${name}/`)) ||
        file.name.includes("\\") ||
        file.name.includes("\0") ||
        file.name.split("/").some((part) => part === ".." || part === "." || !part) ||
        !/^[a-f0-9]{64}$/.test(file.digest) ||
        typeof file.bytes !== "string" ||
        managedRuntimeDigest(Buffer.from(file.bytes, "base64")) !== file.digest
    )
        throw new Error("Invalid staged personal runtime file.");
}
export function validateManagedRuntimeTransfer(transfer: ManagedRuntimeTransfer): void {
    if (
        transfer.version !== 1 ||
        !/^[a-f0-9-]{36}$/.test(transfer.projectId) ||
        !/^[a-f0-9-]{36}$/.test(transfer.repositoryId) ||
        typeof transfer.personalOwner !== "string" ||
        !transfer.personalOwner ||
        !Array.isArray(transfer.files) ||
        !Array.isArray(transfer.attempts)
    )
        throw new Error("Invalid personal runtime transfer.");
    for (const file of transfer.files) validateManagedRuntimeFile(file);
    for (const attempt of transfer.attempts) {
        if (
            !/^[a-f0-9-]{36}$/.test(attempt.checkoutId) ||
            !["flat", "internal"].includes(attempt.layout) ||
            !attempt.entry ||
            typeof attempt.entry.id !== "string" ||
            typeof attempt.entry.planName !== "string" ||
            typeof attempt.entry.path !== "string" ||
            typeof attempt.entry.branch !== "string" ||
            typeof attempt.entry.baseCommit !== "string"
        )
            throw new Error("Invalid retained execution identity.");
    }

    const { transferId: _id, ...input } = transfer;
    if (
        managedRuntimeDigest(JSON.stringify(input)) !== transfer.transferId ||
        new Set(transfer.files.map((file) => `${file.checkoutId}/${file.layout}/${file.name}`)).size !==
            transfer.files.length
    )
        throw new Error("Personal runtime transfer digest changed.");
}
export async function assertManagedRuntimePath(path: string, root: string): Promise<void> {
    const suffix = relative(root, path);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../"))
        throw new Error("Runtime transfer leaves its owner.");
    for (let cursor = path; ; cursor = dirname(cursor)) {
        const stat = await fs.lstat(cursor).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error("Personal runtime transfer contains a symbolic link.");
        if (cursor === root) break;
    }
}
async function readSourceFile(
    source: string,
    root: string,
    fields: Omit<ManagedRuntimeFile, "digest" | "bytes"> & { checkoutRoot: string },
    files: SourceFile[],
): Promise<void> {
    await assertManagedRuntimePath(source, root);
    const stat = await fs.lstat(source).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    if (!stat) return;
    if (stat.isDirectory()) {
        for (const name of (await fs.readdir(source)).sort())
            await readSourceFile(join(source, name), root, { ...fields, name: `${fields.name}/${name}` }, files);
    } else if (stat.isFile()) {
        const bytes = await fs.readFile(source);
        files.push({ ...fields, source, digest: managedRuntimeDigest(bytes), bytes: bytes.toString("base64") });
    } else throw new Error("Unsupported personal runtime file.");
}
async function git(root: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd: root, args });
    if (!result.success) throw new Error("Runtime transfer cannot verify repository evidence.");
    return new TextDecoder().decode(result.stdout);
}
function journalPath(identity: ProjectIdentity): string {
    return join(
        identity.executionAccountHome,
        ".wld",
        "projects",
        identity.projectId,
        "execution",
        identity.repositoryId,
        managedRuntimeDigest(`${identity.personalOwner.kind}\0${identity.personalOwner.identity}`),
        "personal-transfer.json",
    );
}
async function lockSources(files: SourceFile[]): Promise<NativeFileLock[]> {
    const locks: NativeFileLock[] = [];
    try {
        for (const file of files
            .filter((entry) => entry.name.endsWith(".lock"))
            .sort((a, b) => a.source.localeCompare(b.source))) {
            const snapshot = await readLockFileSnapshot(file.source);
            if (snapshot?.text.trim() && !(await isLockHolderGone(snapshot.text)))
                throw new Error("A legacy personal runtime writer is active.");
            const lock = openNativeFileLock(file.source, false);
            locks.push(lock);
            if (!lock.tryLockSync(true)) throw new Error("Personal runtime writer is active; transfer will retry.");
        }
        return locks;
    } catch (error) {
        for (const lock of locks.reverse()) lock.close();
        throw error;
    }
}
async function validateSourceLocation(identity: ProjectIdentity, file: SourceFile): Promise<void> {
    validateManagedRuntimeFile(file);
    const admitted = projects.checkout.inspect(file.checkoutRoot, {
        context: { executionAccountHome: identity.executionAccountHome, personalOwner: identity.personalOwner },
    });
    if (
        admitted.kind !== "existing" ||
        admitted.identity.checkoutId !== file.checkoutId ||
        admitted.identity.repositoryId !== identity.repositoryId ||
        admitted.identity.projectId !== identity.projectId
    )
        throw new Error("Personal runtime source checkout changed.");
    const runtime = getRunWieldRuntimeDir(file.checkoutRoot);
    const base = file.layout === "flat" ? runtime : join(runtime, "internal");
    if (file.source !== join(base, file.name)) throw new Error("Personal runtime source location changed.");
    await assertManagedRuntimePath(
        file.source,
        runtime.startsWith(`${file.checkoutRoot}/`) ? file.checkoutRoot : identity.executionAccountHome,
    );
}
async function withRegistrySources<T>(registries: SourceRegistry[], run: () => Promise<T>): Promise<T> {
    const [first, ...rest] = registries;
    if (!first) return await run();
    return await withWorktreeRegistryLockAtPath(join(dirname(first.source), WORKTREE_REGISTRY_LOCK_FILE), () =>
        withRegistrySources(rest, run),
    );
}
async function readRegistrySource(registry: SourceRegistry): Promise<WorktreeRegistryEntry[]> {
    const base =
        registry.layout === "flat"
            ? getRunWieldRuntimeDir(registry.checkoutRoot)
            : join(getRunWieldRuntimeDir(registry.checkoutRoot), "internal");
    if (registry.source !== join(base, "worktrees.json")) throw new Error("Retained registry source location changed.");
    await assertManagedRuntimePath(registry.source, base);

    const inspected = await inspectWorktreeRegistryAtPath(registry.source);
    if (inspected.readError || inspected.integrityIssues.length)
        throw new Error("Retained execution registry needs recovery before adoption.");
    return inspected.entries;
}
async function registrySourcesMatch(registries: SourceRegistry[]): Promise<boolean> {
    for (const registry of registries)
        if (JSON.stringify(await readRegistrySource(registry)) !== JSON.stringify(registry.entries)) return false;
    return true;
}
/** Source staging never deletes or activates personal bytes. */
export async function stageManagedPersonalRuntime(identity: ProjectIdentity): Promise<ManagedRuntimeTransfer> {
    if (identity.personalOwner.kind !== "managed-remote")
        throw new Error("Personal transfer requires managed ownership.");
    const path = journalPath(identity);
    await assertManagedRuntimePath(path, identity.executionAccountHome);
    ensurePrivateDir(dirname(path));
    const lock = openNativeFileLock(`${path}.lock`);
    await lock.lock(true);
    const databases: DatabaseSync[] = [];
    let sourceLocks: NativeFileLock[] = [];
    try {
        let prior: SourceTransfer | undefined;
        try {
            prior = JSON.parse(await fs.readFile(path, "utf8"));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (prior && !prior.retired) {
            validateManagedRuntimeTransfer(prior.transfer);
            if (
                prior.transfer.projectId !== identity.projectId ||
                prior.transfer.repositoryId !== identity.repositoryId ||
                prior.transfer.personalOwner !== identity.personalOwner.identity
            )
                throw new Error("Staged runtime owner changed.");
            if (prior.destinationCommitted) return prior.transfer;
            let same = true;
            for (const file of prior.files) {
                await validateSourceLocation(identity, file);
                const bytes = await fs.readFile(file.source).catch((error) => {
                    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
                    throw error;
                });
                if (!bytes || managedRuntimeDigest(bytes) !== file.digest) same = false;
            }
            if (
                same &&
                (await withRegistrySources(prior.registries || [], () => registrySourcesMatch(prior.registries || [])))
            )
                return prior.transfer;
        }
        const primary = projects.checkout.primaryRoot(identity.checkoutRoot);
        const hasGit = await fs
            .stat(join(primary, ".git"))
            .then(() => true)
            .catch(() => false);
        const roots = hasGit
            ? (await git(primary, ["worktree", "list", "--porcelain", "-z"]))
                  .split("\0")
                  .filter((line) => line.startsWith("worktree "))
                  .map((line) => line.slice(9))
            : [identity.checkoutRoot];
        const files: SourceFile[] = [];
        const registries: SourceRegistry[] = [];
        for (const root of roots) {
            const admitted = await projects.checkout.admit(root, {
                context: { executionAccountHome: identity.executionAccountHome, personalOwner: identity.personalOwner },
            });
            if (
                admitted.kind !== "existing" ||
                admitted.identity.projectId !== identity.projectId ||
                admitted.identity.repositoryId !== identity.repositoryId
            )
                throw new Error("Runtime transfer checkout identity changed.");
            const tracked = hasGit
                ? (await git(root, ["ls-files", "-z", "--", ".wld"])).split("\0").filter(isRunWieldOwnedRuntimePath)
                : [];
            if (tracked.length) throw new Error("Tracked runtime must be recovered before personal transfer.");
            for (const layout of ["flat", "internal"] as const) {
                const base =
                    layout === "flat" ? getRunWieldRuntimeDir(root) : join(getRunWieldRuntimeDir(root), "internal");
                await assertManagedRuntimePath(
                    base,
                    getRunWieldRuntimeDir(root).startsWith(`${root}/`) ? root : identity.executionAccountHome,
                );
                const registryPath = join(base, "worktrees.json");
                await assertManagedRuntimePath(registryPath, base);
                if (
                    await fs
                        .stat(registryPath)
                        .then(() => true)
                        .catch(() => false)
                )
                    registries.push({
                        checkoutId: admitted.identity.checkoutId,
                        checkoutRoot: root,
                        layout,
                        source: registryPath,
                        entries: [],
                    });
                const databasePath = join(base, "work-records.sqlite3");
                await assertManagedRuntimePath(databasePath, base);
                if (
                    await fs
                        .stat(databasePath)
                        .then(() => true)
                        .catch(() => false)
                ) {
                    const database = new DatabaseSync(databasePath);
                    databases.push(database);
                    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
                    if (checkpoint && Number(checkpoint.busy) !== 0)
                        throw new Error("Work Record index writer is active.");
                    database.exec("BEGIN EXCLUSIVE");
                    const integrity = database.prepare("PRAGMA integrity_check").get();
                    if (!integrity || Object.values(integrity)[0] !== "ok")
                        throw new Error("Work Record index is corrupt.");
                }
                for (const name of personalNames.filter(
                    (name) => name !== "work-records.sqlite3-wal" && name !== "work-records.sqlite3-shm",
                ))
                    await readSourceFile(
                        join(base, name),
                        base,
                        { checkoutId: admitted.identity.checkoutId, checkoutRoot: root, layout, name },
                        files,
                    );
            }
        }
        return await withRegistrySources(registries, async () => {
            sourceLocks = await lockSources(files);
            for (const file of files)
                if (managedRuntimeDigest(await fs.readFile(file.source)) !== file.digest)
                    throw new Error("Personal runtime changed during staging; transfer will retry.");
            for (const registry of registries) registry.entries = await readRegistrySource(registry);
            const input = {
                version: 1 as const,
                projectId: identity.projectId,
                repositoryId: identity.repositoryId,
                personalOwner: identity.personalOwner.identity,
                attempts: registries.flatMap((registry) =>
                    registry.entries.map((entry) => ({
                        checkoutId: registry.checkoutId,
                        layout: registry.layout,
                        entry,
                    })),
                ),
                files: files.map(({ source: _source, checkoutRoot: _root, ...file }) => file),
            };
            const transfer = { ...input, transferId: managedRuntimeDigest(JSON.stringify(input)) };
            validateManagedRuntimeTransfer(transfer);
            writeJsonAtomically(path, { transfer, files, registries, destinationCommitted: false, retired: false });
            return transfer;
        });
    } finally {
        for (const database of databases.reverse()) {
            try {
                database.exec("ROLLBACK");
            } finally {
                database.close();
            }
        }
        for (const sourceLock of sourceLocks.reverse()) sourceLock.close();
        lock.close();
    }
}
async function removeEmptyDirectories(path: string): Promise<void> {
    const stat = await fs.lstat(path).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    if (!stat?.isDirectory()) return;
    for (const entry of await fs.readdir(path)) await removeEmptyDirectories(join(path, entry));
    if ((await fs.readdir(path)).length === 0) {
        await fs.rmdir(path);
        syncParentDirectory(path);
    }
}
/** Retire only the exact staged generation after the laptop durably verified every destination byte. */
export async function retireManagedPersonalRuntime(identity: ProjectIdentity, transferId: string): Promise<void> {
    const path = journalPath(identity);
    await assertManagedRuntimePath(path, identity.executionAccountHome);
    const lock = openNativeFileLock(`${path}.lock`);
    await lock.lock(true);
    let locks: NativeFileLock[] = [];
    const databases: DatabaseSync[] = [];
    try {
        const journal: SourceTransfer = JSON.parse(await fs.readFile(path, "utf8"));
        validateManagedRuntimeTransfer(journal.transfer);
        if (
            journal.transfer.transferId !== transferId ||
            journal.transfer.projectId !== identity.projectId ||
            journal.transfer.repositoryId !== identity.repositoryId ||
            journal.transfer.personalOwner !== identity.personalOwner.identity
        )
            throw new Error("Personal runtime retirement belongs to another owner or generation.");
        if (journal.retired) return;
        await withRegistrySources(journal.registries || [], async () => {
            if (!(await registrySourcesMatch(journal.registries || [])))
                throw new Error("Retained execution changed before retirement; preserve the staged generation.");
            const present: SourceFile[] = [];
            for (const file of journal.files) {
                await validateSourceLocation(identity, file);
                if (
                    file.name === "work-records.sqlite3" &&
                    (await fs
                        .stat(file.source)
                        .then(() => true)
                        .catch(() => false))
                ) {
                    const database = new DatabaseSync(file.source);
                    databases.push(database);
                    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
                    if (checkpoint && Number(checkpoint.busy) !== 0)
                        throw new Error("Work Record index writer is active.");
                    database.exec("BEGIN EXCLUSIVE");
                }
                const bytes = await fs.readFile(file.source).catch((error) => {
                    if (
                        error instanceof Error &&
                        "code" in error &&
                        error.code === "ENOENT" &&
                        journal.destinationCommitted
                    )
                        return null;
                    throw error;
                });
                if (!bytes) continue;
                if (managedRuntimeDigest(bytes) !== file.digest)
                    throw new Error("Personal runtime changed before retirement; staged copies remain recoverable.");
                present.push(file);
            }
            locks = await lockSources(present);
            journal.destinationCommitted = true;
            writeJsonAtomically(path, journal);
            for (const file of present) {
                const bytes = await fs.readFile(file.source);
                if (managedRuntimeDigest(bytes) !== file.digest)
                    throw new Error("Personal runtime changed while retiring.");
                if (file.name === "work-records.sqlite3") {
                    for (const suffix of ["-wal", "-shm"]) {
                        const sidecar = `${file.source}${suffix}`;
                        await assertManagedRuntimePath(sidecar, dirname(file.source));
                        await fs.unlink(sidecar).catch((error) => {
                            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                        });
                    }
                }
                await fs.unlink(file.source);
                syncParentDirectory(file.source);
            }
            for (const file of journal.files) {
                const base =
                    file.layout === "flat"
                        ? getRunWieldRuntimeDir(file.checkoutRoot)
                        : join(getRunWieldRuntimeDir(file.checkoutRoot), "internal");
                await removeEmptyDirectories(join(base, file.name.split("/")[0]));
            }
            journal.retired = true;
            writeJsonAtomically(path, journal);
        });
    } finally {
        for (const database of databases.reverse()) {
            try {
                database.exec("ROLLBACK");
            } finally {
                database.close();
            }
        }
        for (const sourceLock of locks.reverse()) sourceLock.close();
        lock.close();
    }
}
