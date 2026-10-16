import { recoverWindowsRename } from "./native-file-replace-windows.ts";
import { platform } from "node:process";
import fsPromises from "node:fs/promises";
import { open as fsOpen } from "node:fs/promises";
import { type NativeFileLock, openNativeFileLock } from "./native-file-lock.ts";
import { type Stats } from "node:fs";
import { lstat as fsLstat, mkdir as fsMkdir, readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
/** Recover writes made through the old layout after ownership moved to internal/. */
import { dirname, join } from "node:path";
import type { ControllerRecord } from "./workflow/controller-registry.ts";
import { inspectWorktreeRegistryAtPath, type WorktreeRegistryEntry } from "./worktree-registry.js";

export interface RuntimeRecoveryPaths {
    source: string;
    destination: string;
    archiveRoot: string;
    controller: boolean;
    registry?: boolean;
}

/** The adopted registry owns known attempts; only distinct old attempts may be imported. */
export async function inspectReturningRegistry(source: string, destination: string) {
    const legacy = await inspectWorktreeRegistryAtPath(source);
    const current = await inspectWorktreeRegistryAtPath(destination);
    for (const inspected of [legacy, current]) {
        if (inspected.readError) throw inspected.readError;
        if (inspected.integrityIssues.length) throw new Error(inspected.integrityIssues[0].message);
    }
    const additions: WorktreeRegistryEntry[] = [];
    for (const entry of legacy.entries) {
        if (current.entries.some((saved) => saved.id === entry.id)) continue;
        const collision = current.entries.find(
            (saved) =>
                saved.path === entry.path ||
                saved.branch === entry.branch ||
                (saved.status !== "abandoned" &&
                    entry.status !== "abandoned" &&
                    ((saved.planId && saved.planId === entry.planId) || saved.planName === entry.planName)),
        );
        if (collision) {
            throw new Error(`Two saved attempts refer to Plan ${entry.planName}. Both copies have been kept.`);
        }
        additions.push(entry);
    }
    return { entries: [...current.entries, ...additions], additions };
}

async function info(path: string): Promise<Stats | null> {
    try {
        return await fsLstat(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

/** Lock inodes stay in place: an older process may still have an open handle. */
export async function hasRecoverableRuntimeFiles(path: string): Promise<boolean> {
    const stat = await info(path);
    if (!stat) return false;
    if (!stat.isDirectory()) return !path.endsWith(".lock");
    for await (const entry of await fsReaddir(path, { withFileTypes: true })) {
        if (await hasRecoverableRuntimeFiles(join(path, entry.name))) return true;
    }
    return false;
}

async function syncDirectory(path: string): Promise<void> {
    // Match runtime layout publication: Windows does not support directory fsync.
    if (platform === "win32") return;
    const directory = await fsOpen(path, "r");
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

async function writeAtomic(path: string, bytes: Uint8Array, onlyIfMissing = false): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await fsOpen(temporary, "wx", 0o600);
    try {
        await file.writeFile(bytes);
        await file.sync();
    } finally {
        await file.close();
    }
    try {
        if (onlyIfMissing) {
            try {
                // Atomic no-replace publication; never overwrite a concurrent writer.
                await fsPromises.link(temporary, path);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
        } else {
            try {
                await fsPromises.rename(temporary, path);
            } catch (error) {
                if (!(error instanceof Error && recoverWindowsRename(error, temporary, path))) throw error;
            }
        }
        await syncDirectory(dirname(path));
    } finally {
        await fsPromises.rm(temporary).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }
}

async function digest(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function preserve(path: string, bytes: Uint8Array, archiveRoot: string): Promise<void> {
    const pathKey = await digest(new TextEncoder().encode(path));
    const versionKey = await digest(bytes);
    const directory = join(archiveRoot, pathKey, versionKey);
    await writeAtomic(join(directory, "contents"), bytes);
    await writeAtomic(join(directory, "source-path.txt"), new TextEncoder().encode(path));
}

function parseController(bytes: Uint8Array): ControllerRecord | null {
    try {
        const record: ControllerRecord = JSON.parse(new TextDecoder().decode(bytes));
        return record?.version === 1 &&
            Number.isInteger(record.revision) &&
            record.state &&
            typeof record.planName === "string"
            ? record
            : null;
    } catch {
        return null;
    }
}

/**
 * The adopted controller owns decisions, counters, document location and publication.
 * Old copies cannot overwrite them. Completion prose is recoverable information,
 * not permission to skip validation; import it only if the current report is absent.
 */
function recoverCompletionReport(currentBytes: Uint8Array, legacyBytes: Uint8Array): Uint8Array {
    const current = parseController(currentBytes);
    const legacy = parseController(legacyBytes);
    if (
        !current ||
        !legacy ||
        current.planId !== legacy.planId ||
        current.planName !== legacy.planName ||
        Object.hasOwn(current.state, "executionReport") ||
        !legacy.state.executionReport
    )
        return currentBytes;
    const recovered: ControllerRecord = {
        ...current,
        revision: current.revision + 1,
        state: { ...current.state, executionReport: legacy.state.executionReport },
    };
    return new TextEncoder().encode(`${JSON.stringify(recovered, null, 2)}\n`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Called under the migration lock, with verified, bounded, non-symlink paths. */
export async function recoverLegacyRuntimeFiles(paths: RuntimeRecoveryPaths): Promise<void> {
    const stat = await info(paths.source);
    if (!stat || paths.source.endsWith(".lock")) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("Runtime recovery encountered an unsafe filesystem path.");
    }
    const destinationStat = await info(paths.destination);
    if (destinationStat?.isSymbolicLink()) throw new Error("Runtime recovery encountered a symbolic link.");
    if (stat.isDirectory()) {
        for await (const entry of await fsReaddir(paths.source, { withFileTypes: true })) {
            await recoverLegacyRuntimeFiles({
                ...paths,
                source: join(paths.source, entry.name),
                destination: join(paths.destination, entry.name),
            });
        }
        return;
    }
    const locks: NativeFileLock[] = [];
    try {
        if (paths.controller && paths.source.endsWith(".json")) {
            for (const path of [paths.source, paths.destination]) {
                await fsMkdir(dirname(path), { recursive: true, mode: 0o700 });
                const lock = openNativeFileLock(`${path}.lock`);
                locks.push(lock);
                await lock.lock(true);
            }
        }
        const legacy = await fsReadFile(paths.source);
        // The original is durable before either authority is touched. Replaying
        // after a crash uses the same content-addressed backup, not another copy.
        await preserve(paths.source, legacy, paths.archiveRoot);
        if (paths.registry) {
            const recovered = await inspectReturningRegistry(paths.source, paths.destination);
            if (recovered.additions.length || !(await info(paths.destination))) {
                if (await info(paths.destination)) {
                    await preserve(paths.destination, await fsReadFile(paths.destination), paths.archiveRoot);
                }
                await writeAtomic(
                    paths.destination,
                    new TextEncoder().encode(
                        `${JSON.stringify({ version: 2, entries: recovered.entries }, null, 2)}\n`,
                    ),
                );
            }
        } else if (!(await info(paths.destination))) {
            await writeAtomic(paths.destination, legacy, true);
        } else if (paths.controller) {
            const current = await fsReadFile(paths.destination);
            const recovered = recoverCompletionReport(current, legacy);
            if (!equalBytes(current, recovered)) {
                await preserve(paths.destination, current, paths.archiveRoot);
                await writeAtomic(paths.destination, recovered);
            }
        }
        // A writer without a controller inode lock must not lose a new write.
        if (equalBytes(await fsReadFile(paths.source), legacy)) {
            await fsPromises.rm(paths.source);
            await syncDirectory(dirname(paths.source));
        }
    } finally {
        for (const lock of locks.reverse()) lock.close();
    }
}
