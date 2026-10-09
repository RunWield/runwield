import {
    PROJECT_INTERNAL_RUNTIME_DIR_NAME,
    PROJECT_SECRET_STORE_RELATIVE_PATH,
    RUNWIELD_DIR_NAME,
} from "../constants.js";
import { isRunWieldOwnedRuntimePath } from "./runwield-owned-paths.ts";
import { recordedProjectContextPaths } from "./worktree-project-context.ts";

interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export class RunWieldRuntimeGitSafetyError extends Error {
    mergeFailureKind = "runwield_runtime_tracked";
    blockingPaths: string[];

    constructor(message: string, paths: string[]) {
        super(paths.length > 0 ? `${message} ${runtimeRemovalWarning(paths)} Paths: ${paths.join(", ")}` : message);
        this.name = "RunWieldRuntimeGitSafetyError";
        this.blockingPaths = paths;
    }
}

const CURRENT_PROJECT_SECRET_STORE_PATH =
    `${RUNWIELD_DIR_NAME}/${PROJECT_INTERNAL_RUNTIME_DIR_NAME}/collaboration-secrets.json`;

function isCollaborationSecretPath(path: string): boolean {
    return path === PROJECT_SECRET_STORE_RELATIVE_PATH || path.startsWith(`${PROJECT_SECRET_STORE_RELATIVE_PATH}.`) ||
        path === CURRENT_PROJECT_SECRET_STORE_PATH || path.startsWith(`${CURRENT_PROJECT_SECRET_STORE_PATH}.`);
}

function runtimeRemovalWarning(paths: string[]): string {
    if (!paths.some(isCollaborationSecretPath)) return "";
    return "A collaboration secret was committed or staged. Treat it as exposed, remove it from Git history, and rotate any related capability secret before retrying.";
}

async function runGitResult(cwd: string, args: string[]): Promise<CommandResult> {
    const output = await new Deno.Command("git", {
        cwd,
        args,
        env: { GIT_LITERAL_PATHSPECS: "1" },
        stdout: "piped",
        stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
    };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runGitResult(cwd, args);
    if (result.code === 0) return result.stdout;
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim());
}

function parseNulPaths(output: string): string[] {
    return output.split("\0").filter((path) => path.length > 0);
}

async function treeRuntimePaths(cwd: string, ref: string): Promise<string[]> {
    const result = await runGitResult(cwd, ["ls-tree", "-rz", "--name-only", "-r", ref]);
    if (result.code !== 0) {
        throw new RunWieldRuntimeGitSafetyError(
            `RunWield could not inspect ${ref} for Project Runtime State.`,
            [],
        );
    }
    return parseNulPaths(result.stdout).filter(isRunWieldOwnedRuntimePath).sort();
}

async function indexRuntimePaths(cwd: string): Promise<string[]> {
    const cached = await runGit(cwd, ["ls-files", "-z", "--cached"]);
    // The caller also inspects HEAD: staged deletions are present there, while
    // additions and rename destinations are present in this index listing.
    // A third `diff --cached` cannot add a path outside that union.
    return [...new Set(parseNulPaths(cached).filter(isRunWieldOwnedRuntimePath))].sort();
}

export async function assertNoTrackedOrIndexedRuntimePaths(cwd: string): Promise<void> {
    const headPaths = await treeRuntimePaths(cwd, "HEAD");
    const indexPaths = await indexRuntimePaths(cwd);
    const paths = [...new Set([...headPaths, ...indexPaths])].sort();
    if (paths.length > 0) {
        throw new RunWieldRuntimeGitSafetyError(
            "RunWield runtime paths are tracked or staged by Git. Remove them from Git before retrying.",
            paths,
        );
    }
}

export async function assertNoRuntimePathsInNewHistory(
    cwd: string,
    baseRef: string | null,
    candidateRef: string,
): Promise<void> {
    if (baseRef) {
        const baseTreePaths = await treeRuntimePaths(cwd, baseRef);
        if (baseTreePaths.length > 0) {
            throw new RunWieldRuntimeGitSafetyError(
                "The publication target already tracks RunWield runtime paths. Remove them from Git before retrying.",
                baseTreePaths,
            );
        }
    }

    const revListArgs = baseRef ? ["rev-list", "--topo-order", candidateRef, "--not", baseRef] : [
        "rev-list",
        "--topo-order",
        candidateRef,
    ];
    const commits = (await runGit(cwd, revListArgs))
        .split("\n")
        .filter((commit) => commit.length > 0);
    const paths = new Set<string>();
    for (const commit of commits) {
        for (const path of await treeRuntimePaths(cwd, commit)) paths.add(path);
    }
    const sorted = [...paths].sort();
    if (sorted.length > 0) {
        throw new RunWieldRuntimeGitSafetyError(
            "The publication candidate contains RunWield runtime paths in commits that are not on the target. Remove them from Git before retrying.",
            sorted,
        );
    }
}

export async function gitStatusPaths(cwd: string): Promise<string[]> {
    const output = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const fields = parseNulPaths(output);
    const paths: string[] = [];
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field.length < 4) continue;
        paths.push(field.slice(3));
        const status = field.slice(0, 2);
        if (status.includes("R") || status.includes("C")) {
            const originalPath = fields[index + 1];
            if (originalPath) paths.push(originalPath);
            index++;
        }
    }
    return paths;
}

export async function stageGitChangesExcludingRuntime(cwd: string): Promise<void> {
    // Only recorded versionable setup paths may override broad user ignore rules.
    const contextPaths = await recordedProjectContextPaths(cwd);
    if (contextPaths.length > 0) await runGit(cwd, ["add", "-f", "--", ...contextPaths]);
    const tracked = parseNulPaths(await runGit(cwd, ["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"]))
        .filter((path) => !isRunWieldOwnedRuntimePath(path));
    const untracked = parseNulPaths(await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .filter((path) => !isRunWieldOwnedRuntimePath(path));
    const indexed = tracked.length > 0
        ? new Set(parseNulPaths(await runGit(cwd, ["ls-files", "--cached", "-z", "--", ...tracked])))
        : new Set<string>();
    const trackedUpdates = tracked.filter((path) => indexed.has(path));
    if (trackedUpdates.length > 0) await runGit(cwd, ["add", "-u", "--", ...trackedUpdates]);
    if (untracked.length > 0) await runGit(cwd, ["add", "--", ...untracked]);
}
