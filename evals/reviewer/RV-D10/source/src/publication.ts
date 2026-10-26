import { saveAttempt } from "./attempts.ts";
import { git, gitResult } from "./git.ts";
import type { PublicationAttempt, PublicationRequest } from "./model.ts";

function fetchTarget(workspace: string, remote: string, targetRef: string): string {
    git(workspace, ["fetch", "--no-tags", remote, targetRef]);
    return git(workspace, ["rev-parse", "FETCH_HEAD^{commit}"]);
}

function prepare(workspace: string, candidate: string, target: string): string {
    git(workspace, ["checkout", "--detach", candidate]);
    git(workspace, ["merge", "--no-edit", "--no-ff", target]);
    const commit = git(workspace, ["rev-parse", "HEAD"]);
    git(workspace, ["merge-base", "--is-ancestor", target, commit]);
    git(workspace, ["merge-base", "--is-ancestor", candidate, commit]);
    return commit;
}

async function send(workspace: string, path: string, attempt: PublicationAttempt): Promise<PublicationAttempt> {
    await saveAttempt(path, attempt);
    const result = gitResult(workspace, [
        "push",
        `--force-with-lease=${attempt.targetRef}:${attempt.expectedTarget}`,
        attempt.remote,
        `${attempt.preparedCommit}:${attempt.targetRef}`,
    ]);
    const saved: PublicationAttempt = {
        ...attempt,
        status: result.code === 0 ? "published" : "pending",
        error: result.code === 0 ? null : result.stderr || "Git push failed",
    };
    await saveAttempt(path, saved);
    return saved;
}

export async function publishValidated(
    workspace: string,
    path: string,
    request: PublicationRequest,
): Promise<PublicationAttempt> {
    const candidate = git(workspace, ["rev-parse", `${request.candidate}^{commit}`]);
    const target = fetchTarget(workspace, request.remote, request.targetRef);
    const preparedCommit = prepare(workspace, candidate, target);
    return send(workspace, path, {
        ...request,
        candidate,
        preparedCommit,
        expectedTarget: target,
        status: "pending",
        error: null,
    });
}
