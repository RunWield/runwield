import { applyAttachedCodeReviewDecision } from "./code-review-decision.ts";
/** Process-local browser hosting; the coordinator owns every durable review decision. */
import { type BrowserPort, SYSTEM_BROWSER_PORT } from "../browser-port.ts";
import { preparePlanReviewPayload } from "../../ui/review/plan-review.ts";
import {
    type ReviewConversationEvent,
    type ReviewConversation,
    type ReviewSurface,
    startCodeReviewSurface,
    startPlanReviewSurface,
} from "../../ui/review/review-launcher.ts";
import type { ReviewDecision } from "../../ui/workspace/routes/api/review-handlers.js";
import { readStatus, applyAttachedReviewDecision, openAttachedReviewRound } from "./coordinator.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "./record-store.ts";
import type { AttachedChatReply, AttachedWorkflowView } from "./operations.ts";

export interface HostedAttachedReview {
    url: string;
    round: number;
    guidance: string;
}

interface TransientAttachedReply {
    events: ReviewConversationEvent[];
    revision: number;
    delivered: boolean;
}

interface HostedRound {
    type: "plan" | "code";
    stale?: boolean;
    actionId: string;
    review: HostedAttachedReview;
    surface: ReviewSurface<ReviewDecision>;
    conversation: ReviewConversation;
    transientReply?: TransientAttachedReply;
}

const hosted = new Map<string, HostedRound>();
const opening = new Map<string, Promise<HostedAttachedReview | null>>();

/** This object belongs to the browser host, never to a serialized validation interaction. */
async function conversationFor(
    projectRoot: string,
    workflow: AttachedWorkflowView,
    type: "plan" | "code",
): Promise<ReviewConversation> {
    const prior = hosted.get(workflow.workflowId);
    const conversation: ReviewConversation =
        prior?.type === type
            ? prior.conversation
            : {
                  id: `attached-${type}:${workflow.workflowId}`,
                  agentLabel: "Claude",
                  revision: 0,
                  events: [],
                  turns: [],
              };
    let sourceRevision = 0;
    const sourceKey =
        type === "plan"
            ? workflow.review?.actionId
            : workflow.nextAction.kind === "code_review"
              ? workflow.nextAction.actionId
              : undefined;
    conversation.completed = false;
    conversation.events = [];
    const sync = async () => {
        const loaded = await loadAttachedWorkflowRecord(locateAttachedWorkflows(projectRoot), workflow.workflowId);
        const record = loaded.status === "found" ? loaded.record : null;
        const key = type === "plan" ? record?.review?.actionId : record?.validation?.actionId;
        const chat = type === "plan" ? record?.review?.chat : record?.validation?.chat;
        conversation.turns =
            key === sourceKey
                ? (chat?.turns ?? []).map(({ turnId, message, reply }) => ({ turnId, message, reply }))
                : [];
        conversation.pending =
            conversation.turns.some((turn) => turn.reply === undefined) ||
            (type === "plan"
                ? record?.review?.status === "revising"
                : record?.state === "validating" &&
                  (Boolean(record.validation?.resume) || record.validation?.request?.kind !== "decision"));
        // Round closure purges text. A revision after a change is signaled only when the revised artifact is ready.
        if (key === sourceKey) {
            const revision = chat?.revision ?? sourceRevision;
            conversation.revision += Math.max(0, revision - sourceRevision);
            sourceRevision = revision;
            conversation.events = (chat?.turns ?? []).flatMap((turn) =>
                turn.reply === undefined
                    ? []
                    : [
                          {
                              type: "assistant_text_delta" as const,
                              delta: turn.reply,
                              messageId: turn.turnId,
                              agentName: "Claude",
                          },
                      ],
            );
        } else {
            conversation.events = [];
        }
        const live = hosted.get(workflow.workflowId);
        if (live?.transientReply) {
            if (live.transientReply.delivered) {
                delete live.transientReply;
            } else {
                conversation.events = live.transientReply.events;
                if (conversation.revision > live.transientReply.revision) live.transientReply.delivered = true;
            }
        }
    };
    await sync();
    conversation.refresh = async () => {
        const status = await readStatus({ projectRoot, workflowId: workflow.workflowId });
        if (!status.ok) return;
        const action = status.workflow.nextAction;
        const key =
            action.kind === "review"
                ? status.workflow.review?.actionId
                : action.kind === "code_review"
                  ? action.actionId
                  : undefined;
        if (key && key !== sourceKey) {
            await ensureReviewHosted(projectRoot, status.workflow);
            return;
        }
        await sync();
        if (status.workflow.state === "closed" || status.workflow.state === "plan_ready") {
            if (!conversation.completed) conversation.revision += 1;
            conversation.completed = true;
            conversation.pending = false;
            conversation.turns = [];
            conversation.events = [];
        }
    };
    return conversation;
}

/** Hosting and restoring never infer a user decision from the lifetime of a process. */
export async function ensureReviewHosted(
    projectRoot: string,
    workflow: AttachedWorkflowView,
    browser: BrowserPort = SYSTEM_BROWSER_PORT,
    reply?: AttachedChatReply,
): Promise<HostedAttachedReview | null> {
    const live = hosted.get(workflow.workflowId);
    if (live && reply) {
        live.transientReply = {
            events: [
                ...live.conversation.events.map((event) => ({ ...event, delta: "" })),
                { type: "assistant_text_delta", delta: reply.text, messageId: reply.turnId, agentName: "Claude" },
            ],
            revision: live.conversation.revision,
            delivered: false,
        };
    }
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
        const conversation = await conversationFor(projectRoot, workflow, "plan");
        const surface = await startPlanReviewSurface<ReviewDecision>({
            reviewConversation: conversation,
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
        hosted.set(workflow.workflowId, {
            ...existing,
            type: "plan",
            actionId: basis.review.actionId,
            review,
            surface,
            conversation,
        });
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
        const conversation = await conversationFor(projectRoot, workflow, "code");
        const surface = await startCodeReviewSurface<ReviewDecision>({
            reviewConversation: conversation,
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
        hosted.set(workflow.workflowId, {
            ...existing,
            type: "code",
            actionId: action.actionId,
            review,
            surface,
            conversation,
        });
        return review;
    })();
    opening.set(workflow.workflowId, task);
    try {
        return await task;
    } finally {
        opening.delete(workflow.workflowId);
    }
}
