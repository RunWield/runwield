import fsPromises, { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { info, syncDirectory, writeAtomic, preserve, equalBytes } from "./runtime-recovery-files.ts";
import { inspectWorktreeRegistryAtPath, type WorktreeRegistryEntry } from "./worktree-registry.js";
export interface RuntimeRecoveryPaths {
    source: string;
    destination: string;
    archiveRoot: string;
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
                new TextEncoder().encode(`${JSON.stringify({ version: 2, entries: recovered.entries }, null, 2)}\n`),
            );
        }
    } else if (!(await info(paths.destination))) {
        await writeAtomic(paths.destination, legacy, true);
    }
    // A writer without a controller inode lock must not lose a new write.
    if (equalBytes(await fsReadFile(paths.source), legacy)) {
        await fsPromises.rm(paths.source);
        await syncDirectory(dirname(paths.source));
    }
}
