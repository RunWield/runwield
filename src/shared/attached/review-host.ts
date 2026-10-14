import { applyAttachedCodeReviewDecision } from "./code-review-decision.ts";
/** Process-local browser hosting; the coordinator owns every durable review decision. */
import { type BrowserPort, SYSTEM_BROWSER_PORT } from "../browser-port.ts";
import { preparePlanReviewPayload } from "../../ui/review/plan-review.ts";
import { type ReviewSurface, startCodeReviewSurface, startPlanReviewSurface } from "../../ui/review/review-launcher.ts";
import type { ReviewDecision } from "../../ui/workspace/routes/api/review-handlers.js";
import { applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import type { AttachedWorkflowView } from "./operations.ts";

export interface HostedAttachedReview {
    url: string;
    round: number;
    guidance: string;
}

interface HostedRound {
    type: "plan" | "code";
    stale?: boolean;
    actionId: string;
    review: HostedAttachedReview;
    surface: ReviewSurface<ReviewDecision>;
}

const hosted = new Map<string, HostedRound>();
const opening = new Map<string, Promise<HostedAttachedReview | null>>();

/** Hosting and restoring never infer a user decision from the lifetime of a process. */
export async function ensureReviewHosted(
    projectRoot: string,
    workflow: AttachedWorkflowView,
    browser: BrowserPort = SYSTEM_BROWSER_PORT,
): Promise<HostedAttachedReview | null> {
    if (workflow.nextAction.kind === "code_review") return await ensureCodeReviewHosted(projectRoot, workflow, browser);
    if (workflow.recovery || workflow.review?.status !== "pending") return null;
    const pending = opening.get(workflow.workflowId);
    if (pending) return await pending;
    const existing = hosted.get(workflow.workflowId);
    if (workflow.state === "awaiting_review" && existing?.actionId === workflow.review.actionId && !existing.stale) {
        return existing.review;
    }
    const task = (async () => {
        const opened = await openAttachedReviewRound(projectRoot, workflow.workflowId);
        if (opened.kind !== "opened") {
            hosted.delete(workflow.workflowId);
            // A reload can be inside this server; let its response finish before shutdown waits for it.
            void existing?.surface.stop();
            return null;
        }
        const basis = opened.basis;
        const payload = await preparePlanReviewPayload(basis.planPath, basis.triageMeta ?? undefined);
        if (payload.planRevision !== basis.review.planRevision) {
            throw new Error("The Plan changed while opening. Retry status.");
        }
        const surface = await startPlanReviewSurface<ReviewDecision>({
            cwd: basis.documentRoot,
            plan: payload.planWithFm,
            planPath: basis.planPath,
            agentLabel: "Claude",
            surfaceId: workflow.workflowId,
            browser,
            onReviewOpen: async () => {
                if (hosted.get(workflow.workflowId)?.stale) {
                    const review = await ensureReviewHosted(projectRoot, workflow, browser);
                    if (!review) {
                        return new Response("The Plan advanced in Core. Return to Claude for its current position.", {
                            status: 409,
                        });
                    }
                }
            },
            onDecision: async (decision) => {
                try {
                    await applyAttachedReviewDecision(projectRoot, workflow.workflowId, basis, decision);
                } catch (error) {
                    const live = hosted.get(workflow.workflowId);
                    if (live) live.stale = true;
                    throw error;
                }
            },
        });
        const review: HostedAttachedReview = {
            url: surface.url,
            round: basis.review.round,
            guidance:
                "The browser review is open. Poll status for the durable outcome. Follow Planner instructions after feedback or cancellation; on plan_ready call start_execution immediately and dispatch the host worker.",
        };
        hosted.set(workflow.workflowId, { type: "plan", actionId: basis.review.actionId, review, surface });
        return review;
    })();
    opening.set(workflow.workflowId, task);
    try {
        return await task;
    } finally {
        opening.delete(workflow.workflowId);
    }
}

/** Used when the host transport closes, as well as by acceptance checks. */
export async function stopHostedAttachedReviews(): Promise<void> {
    await Promise.allSettled(opening.values());
    const surfaces = Array.from(hosted.values());
    hosted.clear();
    await Promise.all(surfaces.map(({ surface }) => surface.stop()));
}

async function ensureCodeReviewHosted(
    projectRoot: string,
    workflow: AttachedWorkflowView,
    browser: BrowserPort,
): Promise<HostedAttachedReview | null> {
    const action = workflow.nextAction;
    if (workflow.recovery || action.kind !== "code_review") return null;
    const existing = hosted.get(workflow.workflowId);
    if (existing?.actionId === action.actionId && !existing.stale) return existing.review;
    const pending = opening.get(workflow.workflowId);
    if (pending) return await pending;
    const task = (async () => {
        const meta = action.request.interaction._meta;
        const surface = await startCodeReviewSurface<ReviewDecision>({
            rawPatch: String(meta?.diffText || ""),
            gitRef: String(meta?.targetBranch || ""),
            agentCwd: String(meta?.executionCwd || ""),
            targetBranch: String(meta?.targetBranch || ""),
            planName: workflow.plan?.planName,
            planTitle: String(meta?.planTitle || ""),
            planContent: String(meta?.planContent || ""),
            agentLabel: "Claude",
            agentTurnOwner: "host",
            browser,
            surfaceId: `attached-code:${workflow.workflowId}`,
            onDecision: async (decision) => {
                try {
                    await applyAttachedCodeReviewDecision(projectRoot, workflow.workflowId, action.actionId, decision);
                } catch (error) {
                    const live = hosted.get(workflow.workflowId);
                    if (live) live.stale = true;
                    throw error;
                }
            },
        });
        const review = {
            url: surface.url,
            round: 1,
            guidance:
                "Code review is open. Poll status for feedback or approval. Closing Claude leaves the workflow resumable.",
        };
        if (existing?.type === "plan") await existing.surface.stop();
        hosted.set(workflow.workflowId, { type: "code", actionId: action.actionId, review, surface });
        return review;
    })();
    opening.set(workflow.workflowId, task);
    try {
        return await task;
    } finally {
        opening.delete(workflow.workflowId);
    }
}
