import process from "node:process";
import { AGENTS } from "../../constants.js";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { getAgentDisplayName } from "../session/agents.js";
import { formatCodeReviewAnnotations, runCodeReview } from "../../ui/review/code-review.ts";
import {
    type ReviewConversation,
    type StandaloneReviewPayload,
    stopActiveReviewSurfaces,
} from "../../ui/review/review-launcher.ts";
import type { BrowserPort } from "../browser-port.ts";
import { buildGuidedReviewPolicy, recommendGuidedReview } from "../workflow/guided-review.js";
import { ensureReviewWorktree, settleReviewWorktree } from "./review-worktree.ts";
import { postForgeReview } from "./forge-review.ts";
import { refreshPRTarget, type ReviewTarget } from "./review-target.ts";
import { type ApprovalPublicationState, approveAndCommit } from "./review-commit.ts";
import { checkAuth } from "@plannotator/shared/pr-provider.ts";
import { git } from "./git.ts";
interface StandaloneReviewOptions {
    browser: BrowserPort;
    print(text: string): void;
}
export async function runStandaloneReview(
    target: ReviewTarget,
    { browser, print }: StandaloneReviewOptions,
): Promise<void> {
    const runtime = createSessionRuntime({ ownerProcessKind: "workspace" });
    let sessionId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    const conversation: ReviewConversation = {
        id: crypto.randomUUID(),
        agentLabel: getAgentDisplayName(AGENTS.ENGINEER),
        revision: 0,
        events: [],
        onExit: interruptReview,
    };
    const controller = new AbortController();
    function interruptReview() {
        controller.abort();
        if (sessionId) void runtime.cancelSession(sessionId);
    }
    const signals: NodeJS.Signals[] = [];
    let resultMessage = "";
    const approvalState: ApprovalPublicationState = {};
    try {
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
            try {
                process.on(signal, interruptReview);
                signals.push(signal);
            } catch {
                // Windows and some hosts do not support every signal.
            }
        }
        while (!controller.signal.aborted) {
            const cwd = target.worktree?.path || target.projectRoot;
            const diffText = await target.computeDiff(cwd);
            const payload: StandaloneReviewPayload = {
                mode: target.mode,
                headRef: target.worktree || target.mode === "uncommitted" ? undefined : target.gitRef,
                reviewContext: target.reviewContext,
                resultMessage,
            };
            if (target.mode === "pr") {
                const clean =
                    !target.worktree ||
                    (!(await git(cwd, ["status", "--porcelain"])) &&
                        (await git(cwd, ["rev-parse", "HEAD"])) === target.metadata.headSha);
                const cli = target.ref.platform === "github" ? "gh" : "glab";
                let unavailableReason = "";
                try {
                    await checkAuth(target.runtime, target.ref);
                } catch {
                    unavailableReason = `Install ${cli} and run ${cli} auth login.`;
                }
                payload.forge = {
                    platform: target.ref.platform,
                    label: target.ref.platform === "github" ? "GitHub" : "GitLab",
                    available: !unavailableReason,
                    unavailableReason: unavailableReason || undefined,
                    postEnabled: clean && !unavailableReason,
                    postDisabledReason: clean
                        ? undefined
                        : target.recoveryReason || "Push the Engineer changes and refresh the PR before posting.",
                };
            }
            if (target.mode === "uncommitted") {
                const enabled = Boolean(await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => ""));
                payload.commit = { enabled, disabledReason: enabled ? undefined : "Detached HEAD cannot be pushed." };
            }
            const decision = await runCodeReview({
                planName: "Standalone Code Review",
                gitRef:
                    target.worktree || target.mode === "uncommitted"
                        ? `Working tree (${target.gitRef})`
                        : target.gitRef,
                planTitle:
                    target.mode === "pr"
                        ? target.metadata.title
                        : target.mode === "branch"
                          ? `${target.branch} vs ${target.baseLabel}`
                          : "Uncommitted changes",
                diffText,
                executionCwd: cwd,
                browser,
                standaloneReview: payload,
                reviewConversation: conversation,
                agentLabel: conversation.agentLabel,
                signal: controller.signal,
                guidedReview: buildGuidedReviewPolicy("auto", recommendGuidedReview({ diffText })),
                onSurfaceReady: ({ url, opened }) => {
                    if (opened || conversation.revision === 0) print(`Code Review: ${url}`);
                },
            });
            if (decision.canceled || (decision.exit && !decision.reviewAction)) break;
            if (decision.reviewAction) {
                try {
                    if (
                        target.mode === "pr" &&
                        ["post_comments", "approve_pr"].includes(String(decision.reviewAction))
                    ) {
                        const result = await postForgeReview(target, {
                            action: decision.reviewAction === "approve_pr" ? "approve" : "comment",
                            feedback: decision.feedback,
                            annotations: decision.annotations,
                            signal: controller.signal,
                        });
                        resultMessage = result.message;
                        print(resultMessage);
                        if (result.status === "posted" || result.status === "partial") {
                            conversation.completed = true;
                            break;
                        }
                        await refreshPRTarget(target);
                        if (target.recoveryReason) resultMessage += ` ${target.recoveryReason}`;
                    } else if (target.mode === "uncommitted" && decision.reviewAction === "approve_commit") {
                        const result = await approveAndCommit(cwd, controller.signal, approvalState);
                        resultMessage = result.message;
                        print(resultMessage);
                        if (result.ok) {
                            conversation.completed = true;
                            break;
                        }
                    } else resultMessage = "This action is not available for this review source.";
                } catch (error) {
                    resultMessage = String(error);
                    print(resultMessage);
                }
                continue;
            }
            if (!decision.conversationTurn) break;
            try {
                const worktree = await ensureReviewWorktree(target);
                if (!sessionId) {
                    print(`Engineer workspace: ${worktree.path} (${worktree.branch})`);
                    sessionId = await runtime.createPromptReadySession({
                        cwd: worktree.path,
                        agentName: AGENTS.ENGINEER,
                    });
                    print(`Engineer Session: ${sessionId}`);
                    unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
                        if (event.type === "assistant_text_delta") {
                            conversation.events.push({
                                type: "assistant_text_delta",
                                delta: event.delta,
                                messageId: event.messageId,
                                agentName: event.agentName,
                            });
                        }
                    });
                }
                const context = `Standalone Code Review of ${target.mode}: ${target.gitRef}, base ${target.baseLabel}. ${
                    target.reviewContext || ""
                }\nThe user directs commits and pushes. Work in ${worktree.path}.`;
                try {
                    const result = await runtime.promptSession(sessionId, {
                        initialRequest: `${context}\n\n${decision.feedback}\n\n${formatCodeReviewAnnotations(
                            decision.annotations,
                        )}`,
                        initialImages: decision.images?.flatMap((image) =>
                            "base64" in image ? [{ base64: image.base64, mimeType: image.mimeType }] : [],
                        ),
                        signal: controller.signal,
                        emitInitialEvents: false,
                    });
                    resultMessage = result.ok
                        ? ""
                        : result.error || "Engineer turn failed. Send another message to retry.";
                } catch (error) {
                    resultMessage = String(error);
                }
                if (target.mode === "pr") await refreshPRTarget(target);
            } catch (error) {
                resultMessage = String(error);
                print(resultMessage);
            }
        }
    } finally {
        if (conversation.completed) {
            conversation.resultMessage = resultMessage;
            // Keep the result available until the browser receives it. A closed tab must not hold cleanup forever.
            for (let i = 0; i < 50 && !conversation.completionDelivered && !controller.signal.aborted; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        controller.abort();
        try {
            unsubscribe?.();
            if (sessionId) {
                await runtime.closeSession(sessionId);
                print(`Resume Engineer: wld resume ${sessionId}`);
            }
        } finally {
            try {
                await stopActiveReviewSurfaces();
            } finally {
                try {
                    print((await settleReviewWorktree(target.worktree)).message);
                } finally {
                    for (const signal of signals) process.removeListener(signal, interruptReview);
                }
            }
        }
    }
}
