/**
 * Reuse a Git read while the files Git answers it from are unchanged.
 *
 * Project Runtime Entry asks Git the same two questions on every entry: which
 * worktrees are attached, and whether the index tracks a runtime path. Their
 * answers come only from repository metadata files, so a stat fingerprint of
 * those files is the evidence. Git replaces the index and HEAD by renaming a
 * lock file, so every write changes the inode as well as the timestamps.
 *
 * Results are never retained across a change to that evidence, and nothing is
 * retained when the evidence cannot be named: unrecognized Git layouts, Git
 * environment overrides, failed commands, or files changed within the
 * timestamp-resolution window. RunWield-owned runtime files are not evidence
 * here; callers keep checking them on every entry.
 */
import { join, resolve } from "@std/path";

/** Files changed this recently may change again without a visible timestamp difference. */
const RACY_WINDOW_MS = 100;
const MAX_ENTRIES = 256;
const GIT_LOCATION_OVERRIDES = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY"];

interface GitDirectories {
    dotGit: string;
    gitDir: string;
    commonDir: string;
}

/** One observation of a read's evidence, taken before running Git. */
export interface GitEvidenceObservation {
    key: string;
    paths: string[];
    fingerprint: string | null;
}

interface RememberedGitRead {
    fingerprint: string;
    value: string;
}

const remembered = new Map<string, RememberedGitRead>();

function hasGitLocationOverride(): boolean {
    return GIT_LOCATION_OVERRIDES.some((name) => Deno.env.get(name) !== undefined);
}

async function resolveGitDirectories(checkoutRoot: string): Promise<GitDirectories | null> {
    const dotGit = join(checkoutRoot, ".git");
    let gitDir: string;
    try {
        const info = await Deno.lstat(dotGit);
        if (info.isDirectory) {
            gitDir = dotGit;
        } else if (info.isFile) {
            const pointer = /^gitdir: (.+)$/m.exec(await Deno.readTextFile(dotGit));
            if (!pointer) return null;
            gitDir = resolve(checkoutRoot, pointer[1].trim());
        } else {
            return null;
        }
    } catch {
        return null;
    }
    let commonDir = gitDir;
    try {
        commonDir = resolve(gitDir, (await Deno.readTextFile(join(gitDir, "commondir"))).trim());
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) return null;
    }
    return { dotGit, gitDir, commonDir };
}

/** Files `git worktree list` reads for the repository that owns `checkoutRoot`. */
export async function gitWorktreeListEvidence(checkoutRoot: string): Promise<string[] | null> {
    const dirs = await resolveGitDirectories(checkoutRoot);
    if (!dirs) return null;
    const worktreesDir = join(dirs.commonDir, "worktrees");
    const paths = [dirs.dotGit, join(dirs.commonDir, "HEAD"), join(dirs.commonDir, "config"), worktreesDir];
    try {
        const ids: string[] = [];
        for await (const entry of Deno.readDir(worktreesDir)) ids.push(entry.name);
        for (const id of ids.sort()) {
            for (const file of ["gitdir", "HEAD", "locked", "commondir"]) paths.push(join(worktreesDir, id, file));
        }
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) return null;
    }
    return paths;
}

/** Files `git ls-files` reads for the checkout at `checkoutRoot`. */
export async function gitIndexEvidence(checkoutRoot: string): Promise<string[] | null> {
    const dirs = await resolveGitDirectories(checkoutRoot);
    if (!dirs) return null;
    return [
        dirs.dotGit,
        join(dirs.gitDir, "index"),
        join(dirs.gitDir, "config.worktree"),
        join(dirs.commonDir, "config"),
    ];
}

async function fingerprint(paths: string[]): Promise<string | null> {
    const now = Date.now();
    const parts: string[] = [];
    for (const path of paths) {
        let info: Deno.FileInfo;
        try {
            info = await Deno.lstat(path);
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) return null;
            parts.push(`${path}\0absent`);
            continue;
        }
        if (info.isDirectory) {
            // Lock files churn directory timestamps on every Git write. Entries
            // that matter are evidence paths themselves, so a directory only
            // contributes its identity.
            parts.push(`${path}\0dir:${info.dev}:${info.ino}`);
            continue;
        }
        // lstat describes a symlink, not the target Git reads. Unknown file kinds
        // cannot supply evidence that a Git answer is still current.
        if (!info.isFile) return null;
        const mtime = info.mtime?.getTime();
        const ctime = info.ctime?.getTime();
        if (mtime === undefined || now - mtime < RACY_WINDOW_MS) return null;
        if (ctime !== undefined && now - ctime < RACY_WINDOW_MS) return null;
        parts.push(`${path}\0${info.dev}:${info.ino}:${info.size}:${info.mode}:${mtime}:${ctime}`);
    }
    return parts.join("\n");
}

/** Observe evidence before running Git; `paths: null` means the read cannot be reused. */
export async function observeGitEvidence(key: string, paths: string[] | null): Promise<GitEvidenceObservation> {
    if (!paths || hasGitLocationOverride()) return { key, paths: [], fingerprint: null };
    return { key, paths, fingerprint: await fingerprint(paths) };
}

/** The remembered result for unchanged evidence, if any. */
export function reusedGitRead<T>(observation: GitEvidenceObservation): T | undefined {
    if (!observation.fingerprint) return undefined;
    const entry = remembered.get(observation.key);
    if (!entry || entry.fingerprint !== observation.fingerprint) return undefined;
    return JSON.parse(entry.value) as T;
}

/** Remember a successful result only if its evidence did not change while Git ran. */
export async function rememberGitRead<T>(observation: GitEvidenceObservation, value: T): Promise<void> {
    if (!observation.fingerprint) {
        remembered.delete(observation.key);
        return;
    }
    if (await fingerprint(observation.paths) !== observation.fingerprint) {
        remembered.delete(observation.key);
        return;
    }
    if (remembered.size >= MAX_ENTRIES && !remembered.has(observation.key)) remembered.clear();
    remembered.set(observation.key, { fingerprint: observation.fingerprint, value: JSON.stringify(value) });
}
