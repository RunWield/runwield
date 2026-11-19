import { captureForegroundProcess } from "./captured-process.ts";

export interface PublicationUpstream {
    remote: string;
    branch: string;
    url: string;
}

async function git(cwd: string, args: string[]) {
    const result = await captureForegroundProcess("git", { cwd, args });
    return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout).trim(),
        stderr: new TextDecoder().decode(result.stderr).trim(),
    };
}

/**
 * Publication authority: the target branch's configured remote, otherwise origin.
 * A dot remote explicitly selects local publication. No remote means local-only.
 * This read does not fetch, change refs, or use branch.<name>.merge: publication
 * delivers to the named target branch on the selected remote.
 */
export async function resolvePublicationUpstream(
    cwd: string,
    targetBranch: string,
): Promise<PublicationUpstream | null> {
    const configured = await git(cwd, ["config", "--get", `branch.${targetBranch}.remote`]);
    if (configured.code !== 0 && configured.code !== 1) {
        throw new Error(`Cannot determine publication remote: ${configured.stderr || configured.stdout}`);
    }
    const remote = configured.code === 0 && configured.stdout ? configured.stdout : "origin";
    if (remote === ".") return null;
    const url = await git(cwd, ["remote", "get-url", remote]);
    if (url.code !== 0 || !url.stdout) {
        // Only the absence of the default remote establishes local-only mode.
        // A broken explicit remote is not evidence that the local branch is the target.
        if (configured.code === 0) throw new Error(`Publication remote ${remote} is unavailable.`);
        const remotes = await git(cwd, ["remote"]);
        if (remotes.code !== 0 || remotes.stdout.split("\n").includes(remote)) {
            throw new Error(`Cannot determine publication remote ${remote}.`);
        }
        return null;
    }
    return { remote, branch: targetBranch, url: url.stdout };
}
