import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { captureForegroundProcess } from "../shared/captured-process.ts";

const backupToken = Symbol("Plan delivery backup");
export interface PlanDeliveryBackup {
    readonly [backupToken]: true;
}
interface RetainedBackup {
    root: string;
    documents: Map<string, Uint8Array>;
}
const backups = new WeakMap<PlanDeliveryBackup, RetainedBackup>();
function retainedPath(cwd: string, path: string): string {
    const root = resolve(cwd, "docs/plans");
    const absolute = resolve(cwd, path);
    const child = relative(root, absolute).replaceAll("\\", "/");
    if (!child || child === ".." || child.startsWith("../") || isAbsolute(child) || !child.endsWith(".md"))
        throw new Error("Delivery backup must identify a retained Plan document.");
    return absolute;
}
async function git(cwd: string, args: string[]) {
    return await captureForegroundProcess("git", { cwd, args });
}

/** Preserve unpublished legacy bytes before Git installs sealed delivery copies. */
export async function preserveUnpublishedPlanCopies(cwd: string, paths: string[]): Promise<PlanDeliveryBackup> {
    const backup: PlanDeliveryBackup = Object.freeze({ [backupToken]: true as const });
    const state: RetainedBackup = { root: resolve(cwd), documents: new Map() };
    backups.set(backup, state);
    try {
        for (const path of paths) {
            const absolute = retainedPath(cwd, path);
            const bytes = await readFile(absolute).catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
                throw error;
            });
            if (!bytes) continue;
            const changed = await git(cwd, ["diff", "--quiet", "--", path]);
            const tracked = await git(cwd, ["ls-files", "--error-unmatch", path]);
            if (changed.code === 0 && tracked.code === 0) continue;
            state.documents.set(path, bytes);
            if (tracked.code === 0) {
                const restored = await git(cwd, ["restore", "--worktree", "--", path]);
                if (!restored.success) throw new Error(new TextDecoder().decode(restored.stderr));
            } else await rm(absolute);
        }
        return backup;
    } catch (error) {
        await restoreUnpublishedPlanCopies(cwd, backup);
        throw error;
    }
}

export async function restoreUnpublishedPlanCopies(cwd: string, backup: PlanDeliveryBackup): Promise<void> {
    const state = backups.get(backup);
    if (!state || state.root !== resolve(cwd)) throw new Error("Plan delivery backup belongs to another checkout.");
    let failure: Error | undefined;
    for (const [path, bytes] of state.documents) {
        try {
            const absolute = retainedPath(cwd, path);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, bytes);
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
        }
    }
    if (failure) throw failure;
}
