/**
 * @module shared/git
 * Shared Git repository detection and non-Git execution consent helpers.
 */

export interface GitPromptState {
    branch: string;
    dirty: boolean;
}

export type GitRepositoryState = "work_tree" | "git_missing" | "not_git" | "bare_or_unsupported" | "error";

export interface GitRepositoryProbe {
    state: GitRepositoryState;
    ok: boolean;
    cwd: string;
    message?: string;
}

export interface GitRepositoryRequiredDetails {
    cwd: string;
    operation: string;
    state?: GitRepositoryState;
}

interface NamedGitError {
    name?: string;
}

export class GitRepositoryRequiredError extends Error {
    declare cwd: string;
    declare operation: string;
    declare state: GitRepositoryState;

    constructor(message: string, details: GitRepositoryRequiredDetails) {
        super(message);
        this.name = "GitRepositoryRequiredError";
        this.cwd = details.cwd;
        this.operation = details.operation;
        this.state = details.state || "error";
    }
}

function decodeBytes(value: Uint8Array): string {
    return new TextDecoder().decode(value).trim();
}

export async function probeGitRepository(cwd: string): Promise<GitRepositoryProbe> {
    try {
        const command = new Deno.Command("git", {
            args: ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"],
            cwd,
            stdout: "piped",
            stderr: "piped",
        });
        const output = await command.output();
        const stdout = decodeBytes(output.stdout);
        const stderr = decodeBytes(output.stderr);
        if (output.code !== 0) {
            return {
                state: "not_git",
                ok: false,
                cwd,
                message: stderr || stdout || "This directory is not a Git work tree.",
            };
        }
        const [insideWorkTree = "", bare = ""] = stdout.split("\n").map((line) => line.trim());
        if (insideWorkTree === "true" && bare !== "true") {
            return { state: "work_tree", ok: true, cwd };
        }
        return {
            state: "bare_or_unsupported",
            ok: false,
            cwd,
            message: "RunWield requires a non-bare Git work tree for this operation.",
        };
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return { state: "git_missing", ok: false, cwd, message: "The git executable was not found." };
        }
        return {
            state: "error",
            ok: false,
            cwd,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
    return (await probeGitRepository(cwd)).ok;
}

async function readGitOutput(cwd: string, args: string[]): Promise<string | null> {
    try {
        const command = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
        const output = await command.output();
        if (output.code !== 0) return null;
        return decodeBytes(output.stdout);
    } catch {
        return null;
    }
}

export async function readGitPromptState(cwd: string): Promise<GitPromptState | null> {
    const probe = await probeGitRepository(cwd);
    if (!probe.ok) return null;

    const branch = await readGitOutput(cwd, ["branch", "--show-current"]);
    const head = branch && branch.trim() ? branch.trim() : await readGitOutput(cwd, ["rev-parse", "--short", "HEAD"]);
    if (!head || !head.trim()) return null;

    const status = await readGitOutput(cwd, ["status", "--porcelain"]);
    if (status === null) return null;

    return { branch: head.trim(), dirty: status.trim().length > 0 };
}

export function formatGitPromptState(state: GitPromptState): string {
    return [
        `- Git Branch: ${state.branch}`,
        `- Git Work tree: ${state.dirty ? "dirty" : "clean"}`,
    ].join("\n");
}

export function buildGitRequiredMessage(operation: string, probe: GitRepositoryProbe): string {
    const reason = probe.state === "git_missing"
        ? "Git was not found."
        : probe.state === "bare_or_unsupported"
        ? "This directory is not a supported Git work tree."
        : "This directory is not a Git work tree.";
    return `${operation} requires a Git repository. ${reason} RunWield uses Git for worktree isolation, diffs, baseline recovery, and merge-back for this operation.`;
}

export async function assertGitRepository(cwd: string, operation: string): Promise<void> {
    const probe = await probeGitRepository(cwd);
    if (probe.ok) return;
    throw new GitRepositoryRequiredError(buildGitRequiredMessage(operation, probe), {
        cwd,
        operation,
        state: probe.state,
    });
}

export function isGitRepositoryRequiredError<Value>(error: Value): boolean {
    return error instanceof GitRepositoryRequiredError ||
        Boolean(
            error && typeof error === "object" && (error as NamedGitError).name === "GitRepositoryRequiredError",
        );
}

export function formatGitRequiredMessage<Value>(error: Value): string {
    if (isGitRepositoryRequiredError(error)) return error instanceof Error ? error.message : String(error);
    return error instanceof Error ? error.message : String(error);
}
