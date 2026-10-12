import { captureForegroundProcess } from "../captured-process.ts";
import { fetchPR, submitPRReview } from "@plannotator/shared/pr-provider.ts";
import type { PRReviewFileComment, PRReviewFileLevelComment, PRRuntime } from "@plannotator/shared/pr-types.ts";
import type { CodeReviewAnnotation } from "../../ui/review/code-review.ts";
import type { PRReviewTarget } from "./review-target.ts";
import { git } from "./git.ts";

export function createPRRuntime(cwd: string): PRRuntime {
    async function run(cmd: string, args: string[], input?: string) {
        try {
            const result = await captureForegroundProcess(cmd, { cwd, args, stdinText: input });
            return {
                stdout: new TextDecoder().decode(result.stdout),
                stderr: new TextDecoder().decode(result.stderr),
                exitCode: result.code,
            };
        } catch (error) {
            return { stdout: "", stderr: String(error), exitCode: 127 };
        }
    }
    return { runCommand: run, runCommandWithInput: run };
}
export function mapReviewAnnotations(feedback: string, annotations: CodeReviewAnnotation[]) {
    const fileComments: PRReviewFileComment[] = [];
    const fileLevelComments: PRReviewFileLevelComment[] = [];
    const body = [feedback];
    for (const annotation of annotations) {
        const path = annotation.file || annotation.path || annotation.filePath;
        const text = annotation.text || annotation.comment || "";
        const line = typeof annotation.lineEnd === "number" ? annotation.lineEnd : annotation.line;
        const start = typeof annotation.lineStart === "number" ? annotation.lineStart : line;
        const side = annotation.side === "old" ? "LEFT" : "RIGHT";
        if (annotation.scope === "general" || !path) body.push(text);
        else if (annotation.scope === "file" || typeof line !== "number") fileLevelComments.push({ path, body: text });
        else {
            fileComments.push({
                path,
                line,
                side,
                body: text,
                ...(typeof start === "number" && start < line ? { start_line: start, start_side: side } : {}),
            });
        }
    }
    return { body: body.filter(Boolean).join("\n\n"), fileComments, fileLevelComments };
}
interface PostReviewOptions {
    action: "comment" | "approve";
    feedback: string;
    annotations: CodeReviewAnnotation[];
    signal?: AbortSignal;
}
export async function postForgeReview(target: PRReviewTarget, options: PostReviewOptions) {
    options.signal?.throwIfAborted();
    const { metadata } = await fetchPR(target.runtime, target.ref);
    if (metadata.headSha !== target.metadata.headSha) {
        return {
            status: "refused" as const,
            message: "The PR head changed. Review the refreshed diff before posting.",
        };
    }
    if (
        target.worktree &&
        ((await git(target.worktree.path, ["status", "--porcelain"])) ||
            (await git(target.worktree.path, ["rev-parse", "HEAD"])) !== metadata.headSha)
    )
        return { status: "refused" as const, message: "Push the Engineer changes before posting to the PR." };
    const mapped = mapReviewAnnotations(options.feedback, options.annotations);
    options.signal?.throwIfAborted();
    const result = await submitPRReview(
        target.runtime,
        target.ref,
        metadata.headSha,
        options.action,
        mapped.body,
        mapped.fileComments,
        mapped.fileLevelComments,
    );
    if (result.status === "partial") {
        return {
            ...result,
            message: `Review partially posted. ${result.failedFileComments
                .map((failure) => `${failure.comment.path}: ${failure.comment.body}: ${failure.error}`)
                .join("\n")} ${result.approvalError || ""}`,
        };
    }
    return { status: "posted" as const, message: options.action === "approve" ? "PR approved." : "Comments posted." };
}
