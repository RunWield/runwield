import { rename } from "node:fs/promises";
import { captureForegroundProcess } from "../captured-process.ts";
import { lstat as fsLstat, mkdir as fsMkdir, readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function git(root: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd: root, args });
    if (result.code !== 0) throw new Error("Could not check the saved checkout. Its files were kept.");
    return new TextDecoder().decode(result.stdout).trim();
}

export function publicationSavedFilesPath(executionCwd: string): string {
    return join(`${executionCwd}.saved`, "files");
}

export async function existingPublicationSavedFiles(executionCwd: string): Promise<string | undefined> {
    const path = publicationSavedFilesPath(executionCwd);
    try {
        return (await fsLstat(path)).isDirectory() ? path : undefined;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

/** Called only after publication is proven. Preserve bytes; never infer that an
 * unregistered checkout is clean from its committed branch history. */
export async function preserveUnregisteredPublicationFiles(
    projectRoot: string,
    executionCwd: string,
): Promise<string | undefined> {
    const source = await fsRealpath(executionCwd);
    if (source === await fsRealpath(projectRoot)) return undefined;
    if (!(await fsLstat(executionCwd)).isDirectory()) return undefined;
    const registered = await git(projectRoot, ["worktree", "list", "--porcelain"]);
    for (const line of registered.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const path = line.slice("worktree ".length);
        const canonical = await fsRealpath(path).catch(() => path);
        if (canonical === source) return undefined;
    }
    const markerPath = join(executionCwd, ".git");
    const markerStat = await fsLstat(markerPath).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    if (markerStat) {
        if (!markerStat.isFile()) return undefined;
        const marker = (await fsReadFile(markerPath, "utf8")).trim();
        if (!marker.startsWith("gitdir: ")) return undefined;
        const admin = resolve(executionCwd, marker.slice("gitdir: ".length));
        const common = await git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        const adminParent = await fsRealpath(dirname(admin)).catch(() => dirname(admin));
        const expectedParent = await fsRealpath(join(common, "worktrees")).catch(() => join(common, "worktrees"));
        if (adminParent !== expectedParent) return undefined;
        try {
            await fsLstat(admin);
            return undefined;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
    }
    const saved = publicationSavedFilesPath(executionCwd);
    // Reserve the container without following an existing symlink or replacing
    // a previous saved directory. Rename keeps ignored and untracked files too.
    await fsMkdir(dirname(saved)).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    });
    if (!(await fsLstat(dirname(saved))).isDirectory()) {
        throw new Error("The folder for saved files is not available. No files were moved.");
    }
    try {
        await fsLstat(saved);
        throw new Error("A saved copy already exists. Both copies were kept.");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(executionCwd, saved);
    return saved;
}
