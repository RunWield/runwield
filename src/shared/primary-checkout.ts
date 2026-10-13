import { readFileSync as fsReadFileSync, type Stats, statSync as fsStatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
