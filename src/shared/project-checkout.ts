/**
 * Project checkout locations and action-owned relocation repair.
 * Path resolution is read-only. Runtime entry calls prepareProjectCheckout only
 * after checking runtime authority; passive readers must never call preparation.
 */
import { readFileSync as fsReadFileSync, realpathSync, statSync as fsStatSync, type Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { captureForegroundProcess } from "./captured-process.ts";

async function git(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args });
    const output = new TextDecoder();
    if (result.code !== 0) throw new Error(output.decode(result.stderr).trim());
    return output.decode(result.stdout);
}

export async function findExistingProjectPath(path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined;
    try {
        return await realpath(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
            return undefined;
        throw error;
    }
}

/** Repair initialized submodule back-pointers during action entry, without checking out files. */
async function repairSubmoduleWorktreePaths(checkoutRoot: string): Promise<void> {
    if (!(await findExistingProjectPath(join(checkoutRoot, ".gitmodules")))) return;
    if (!(await findExistingProjectPath(join(checkoutRoot, ".git")))) return;
    const gitDir = await realpath((await git(checkoutRoot, ["rev-parse", "--absolute-git-dir"])).trim());
    const modulesRoot = join(gitDir, "modules");
    if (!(await findExistingProjectPath(modulesRoot))) return;
    const index = await git(checkoutRoot, ["ls-files", "--stage", "-z"]);
    for (const entry of index.split("\0")) {
        const match = /^160000 [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        const submodulePath = resolve(checkoutRoot, match[1]);
        const gitFile = join(submodulePath, ".git");
        const info = await lstat(gitFile).catch((error) => {
            if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
                return undefined;
            throw error;
        });
        // Uninitialized submodules and independent repositories need no link repair.
        if (!info?.isFile()) continue;
        const pointer = /^gitdir: (.+)\r?\n?$/.exec(await readFile(gitFile, "utf8"));
        if (!pointer) continue;
        const submoduleGitDir = await findExistingProjectPath(resolve(submodulePath, pointer[1].trim()));
        if (!submoduleGitDir) continue;
        const withinModules = relative(modulesRoot, submoduleGitDir);
        if (
            !withinModules ||
            isAbsolute(withinModules) ||
            withinModules === ".." ||
            withinModules.startsWith(`..${sep}`)
        )
            continue;
        const config = join(submoduleGitDir, "config");
        const savedPath = (await git(checkoutRoot, ["config", "--file", config, "--get", "core.worktree"])).trim();
        const currentPath = await realpath(submodulePath);
        const savedRoot = await findExistingProjectPath(resolve(submoduleGitDir, savedPath));
        if (savedRoot !== currentPath) {
            if (savedRoot) throw new Error(`Submodule Git metadata points to another existing checkout: ${savedRoot}`);
            // The index gitlink and forward .git pointer identify this checkout's
            // own module metadata. Only repair its missing reverse locator.
            await git(checkoutRoot, [
                "config",
                "--file",
                config,
                "core.worktree",
                relative(submoduleGitDir, currentPath),
            ]);
        }
        await repairSubmoduleWorktreePaths(currentPath);
    }
}

/** Canonicalize aliases; retain an absolute locator for a checkout that is absent. */
export function resolveProjectRoot(projectRoot: string): string {
    try {
        return realpathSync(projectRoot);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolve(projectRoot);
        throw error;
    }
}

/** Repair checkout metadata without changing branches, the index, or working files. */
export async function prepareProjectCheckout(checkoutRoot: string): Promise<void> {
    await repairSubmoduleWorktreePaths(resolveProjectRoot(checkoutRoot));
}

function isGitEntry(path: string): boolean {
    try {
        const stat = fsStatSync(path);
        return stat.isDirectory() || stat.isFile();
    } catch {
        return false;
    }
}

/**
 * Resolve the primary checkout root for a linked Git worktree.
 *
 * This is synchronous and filesystem-only because settings path resolution is
 * synchronous. Non-worktree roots are returned unchanged.
 */
export function resolvePrimaryCheckoutRoot(root: string): string {
    const gitPath = join(root, ".git");
    let gitStat: Stats;
    try {
        gitStat = fsStatSync(gitPath);
    } catch {
        return root;
    }
    if (!gitStat.isFile()) return root;

    let text = "";
    try {
        text = fsReadFileSync(gitPath, "utf8").trim();
    } catch {
        return root;
    }
    const match = /^gitdir:\s*(.+)$/i.exec(text);
    if (!match) return root;

    const rawGitDir = match[1].trim();
    const gitDir = resolve(root, rawGitDir);
    const primaryRoot = dirname(dirname(dirname(gitDir)));
    if (!isGitEntry(join(primaryRoot, ".git"))) return root;
    return primaryRoot;
}
