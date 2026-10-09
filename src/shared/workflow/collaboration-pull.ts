import { isEpicPlan } from "../project-plan.ts";
/** @module shared/workflow/collaboration-pull */

import { AGENTS, CLI_BIN, normalizePlanClassification } from "../../constants.js";
import { redactSecrets } from "../collaboration/capabilities.ts";

import type { PlanFrontMatter } from "../../plan-store.js";
import type { DecryptedReviewCommentPayload } from "../collaboration/protocol.js";

export interface PullReviewComment {
    id: string;
    createdAt: string;
    resolved: boolean;
    readable: boolean;
    displayName?: string;
    body?: string;
    type?: string;
    originalText?: string;
    anchor?: DecryptedReviewCommentPayload["anchor"];
    error?: string;
}

export interface PullPlanMetadata {
    classification?: string;
    type?: string;
    title?: string;
    summary?: PlanFrontMatter["summary"];
    status?: PlanFrontMatter["status"];
    affectedPaths?: PlanFrontMatter["affectedPaths"] | string;
}

export interface PullRemoteRevision {
    serverUrl: string;
    spaceId: string;
    status?: string;
    revision: number;
}

export interface PullRevisionRequest {
    planName: string;
    planPath?: string;
    title?: string;
    attrs: PullPlanMetadata;
    remote: PullRemoteRevision;
    comments: PullReviewComment[];
    unreadableCommentCount?: number;
    action?: string;
}

export interface PullPlanningOutcome {
    outcome?: string;
}

export function selectPullPlanningAgent(attrs: PullPlanMetadata = {}) {
    return isEpicPlan({
            classification: String(attrs.classification || ""),
            type: typeof attrs.type === "string" ? attrs.type : undefined,
        })
        ? AGENTS.ARCHITECT
        : AGENTS.PLANNER;
}

export function formatPullCommentsForPrompt(comments: PullReviewComment[]): string {
    if (!comments.length) return "No comments were returned for the latest remote revision.";
    return comments.map((comment, index) => {
        if (!comment.readable) {
            return [
                `Comment ${index + 1} (${comment.id}) — unreadable`,
                `Created: ${comment.createdAt}`,
                `Resolved: ${comment.resolved ? "yes" : "no"}`,
                `Error: ${comment.error || "Unable to decrypt comment payload."}`,
            ].join("\n");
        }
        const type = comment.type === "global_comment" ? "global" : "inline";
        const lines = [
            `Comment ${index + 1} (${comment.id}) — ${type}`,
            `Author: ${comment.displayName || "Anonymous reviewer"}`,
            `Created: ${comment.createdAt}`,
            `Resolved: ${comment.resolved ? "yes" : "no"}`,
            `Feedback: ${comment.body || "(empty)"}`,
        ];
        if (comment.originalText) lines.push(`Selected text: ${comment.originalText}`);
        if (comment.anchor) lines.push(`Anchor: ${JSON.stringify(comment.anchor)}`);
        return lines.join("\n");
    }).join("\n\n");
}

function formatListValue(value: PullPlanMetadata["affectedPaths"]): string {
    if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "(none)";
    if (typeof value === "string" && value.trim()) return value;
    return "(none)";
}

export function buildPullRevisionRequest(context: PullRevisionRequest): string {
    const title = String(context.title || context.attrs.title || context.attrs.summary || context.planName);
    const summary = context.attrs.summary ? String(context.attrs.summary) : "(not provided)";
    const localStatus = context.attrs.status ? String(context.attrs.status) : "draft";
    const classification = normalizePlanClassification(context.attrs.classification || "PLANNED_CHANGE");
    const text = [
        "## Collaborative Planning Pull Revision Request",
        "",
        `Local Plan: ${context.planName}`,
        context.planPath ? `Plan path: ${context.planPath}` : undefined,
        context.action ? `Local pull action: ${context.action}` : undefined,
        "",
        "## Decrypted Plan Metadata",
        "",
        `Title: ${title}`,
        `Summary: ${summary}`,
        `Status: ${localStatus}`,
        `Classification: ${classification}`,
        `Affected paths: ${formatListValue(context.attrs.affectedPaths)}`,
        "",
        "## Remote Revision Context",
        "",
        `Remote Shared Space: ${context.remote.serverUrl} (space ${context.remote.spaceId})`,
        `Remote status: ${context.remote.status || "open"}`,
        `Pulled revision: ${context.remote.revision}`,
        "",
        "The latest remote Plan revision and reviewer comments have been decrypted locally and the local Plan file has been synchronized through the collaboration pull bypass.",
        "Revise this Plan to incorporate the review feedback. Stay inside the collaborative planning workflow: do not execute implementation work from this pull context. After the local Plan revision is accepted, the maintainer should publish it with `wld plans push <plan>`.",
        "",
        "## Review Comments",
        "",
        formatPullCommentsForPrompt(context.comments),
        context.unreadableCommentCount
            ? `\nUnreadable/tampered comments: ${context.unreadableCommentCount}`
            : undefined,
    ].filter((line) => line !== undefined).join("\n");
    return redactSecrets(text);
}

export function summarizePullPlanningOutcome(
    outcome: PullPlanningOutcome | null | undefined,
    planName: string,
): string {
    if (outcome && typeof outcome === "object" && "outcome" in outcome) {
        const value = String(outcome.outcome || "unknown");
        return `Planning agent finished with outcome "${value}". Review the local revision, then publish with: ${CLI_BIN} plans push ${planName}`;
    }
    return `Planning agent was launched. Review the local revision, then publish with: ${CLI_BIN} plans push ${planName}`;
}
