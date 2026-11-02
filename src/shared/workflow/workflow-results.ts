/**
 * @module shared/workflow/workflow-results
 * Helpers for extracting human-readable text and legacy test outcomes from
 * agent message streams. Production workflow transitions should prefer
 * Workflow Tool Events; transcript-derived tool results are display, audit, or
 * compatibility data only.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ImageAttachment } from "../session/types.js";
import type { TriageMeta } from "../../tools/plan-written.ts";
import type { ReviewAdvisory, ReviewFinding } from "./review-outcome.ts";

/** Legacy message content is inspected without changing the existing field checks. */
interface RawTextBlock {
    type?: string;
    text?: unknown;
    content?: unknown;
    contentText?: unknown;
}

interface RawTaskCompletedDetails {
    message?: unknown;
}

interface RawMessageDetails {
    details?: unknown;
}

interface RawMessageContent {
    content?: unknown;
}

interface RawImageBlock {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
}

export interface WorkflowResultDetails {
    outcome?: JsonValue;
    approved?: JsonValue;
    feedback?: JsonValue;
    findings?: JsonValue;
    advisories?: JsonValue;
    planName?: JsonValue;
    triageMeta?: JsonValue;
    message?: JsonValue;
}

export type ReviewOutcome = "approved" | "feedback";

export interface ReviewOutcomeResult {
    outcome: ReviewOutcome;
    approved: boolean;
    feedback: string;
    findings: ReviewFinding[];
    advisories: ReviewAdvisory[];
}

export type PlanOutcome =
    | "approved_execute"
    | "approved_decompose"
    | "saved"
    | "feedback"
    | "conversation"
    | "canceled"
    | "repair_required"
    | "no_call";

export interface PlanOutcomeResult {
    outcome: PlanOutcome;
    planName?: string;
    triageMeta?: TriageMeta;
    feedback?: string;
    images?: ImageAttachment[];
}

export interface WorkflowTaskCompletedReport {
    completed: boolean;
    message: string;
}

function extractText(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";

    if (Array.isArray(value)) {
        return value.map(extractText).filter(Boolean).join("\n").trim();
    }

    const block = value as RawTextBlock;
    if (typeof block.text === "string") return block.text.trim();
    if (typeof block.contentText === "string") return block.contentText.trim();
    if (block.type === "tool_result") return extractText(block.content);
    return "";
}

function extractTaskCompletedMessage(details: unknown): string | null {
    if (!details || typeof details !== "object") return null;
    const message = (details as RawTaskCompletedDetails).message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * Read the latest task_completed report message from a message stream.
 */
export function readLatestTaskCompletedMessage(messages: AgentMessage[], fromIndex?: number): string | null {
    const start = fromIndex != null && fromIndex <= messages.length ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "task_completed"
        ) {
            return extractTaskCompletedMessage((msg as RawMessageDetails).details);
        }
    }
    return null;
}

/**
 * Extract the last text output from the agent's assistant messages.
 * Scans messages in reverse, checking all content blocks to handle cases where
 * tool_use blocks appear alongside text.
 * Falls back to the latest task_completed message because execution agents often
 * report their summary through the terminal tool call instead of a final text
 * response.
 */
export function extractAssistantOutput(messages: AgentMessage[]): string | null {
    let taskCompletedMessage: string | null = null;

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];

        if (
            !taskCompletedMessage &&
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "task_completed"
        ) {
            taskCompletedMessage = extractTaskCompletedMessage((msg as RawMessageDetails).details);
        }

        if (!("role" in msg) || msg.role !== "assistant") continue;

        const text = extractText((msg as RawMessageContent).content);
        if (text) {
            return text;
        }
    }

    return taskCompletedMessage;
}

/**
 * Pi tool-result details are JSON values. Only plain records can contain the
 * compatibility fields read by this module.
 */
function readWorkflowResultDetails(details: JsonValue | undefined): WorkflowResultDetails | null {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    return details as WorkflowResultDetails;
}

/**
 * Read the latest review_complete tool result from a message stream.
 *
 * Returns null when no review_complete call is found (for example, the session
 * was interrupted, or the agent finished via text output instead of the tool).
 *
 * When `fromIndex` is provided, only messages at or after that index are searched,
 * preventing stale outcomes from earlier turns from being picked up.
 */
export function readLatestReviewOutcome(messages: AgentMessage[], fromIndex?: number): ReviewOutcomeResult | null {
    const start = fromIndex != null && fromIndex <= messages.length ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "review_complete"
        ) {
            const details = readWorkflowResultDetails(msg.details);
            const outcome = details?.outcome;
            if (details && (outcome === "approved" || outcome === "feedback")) {
                return {
                    outcome: outcome,
                    approved: details.approved === true,
                    feedback: typeof details.feedback === "string" ? details.feedback : "",
                    findings: Array.isArray(details.findings) ? (details.findings as ReviewFinding[]) : [],
                    advisories: Array.isArray(details.advisories) ? (details.advisories as ReviewAdvisory[]) : [],
                };
            }
        }
    }
    return null;
}

/**
 * Read the latest plan_written tool result's outcome from a message stream.
 *
 * When `fromIndex` is provided, only messages at or after that index are searched,
 * preventing stale outcomes from earlier turns from being picked up.
 */
export function readLatestPlanOutcome(messages: AgentMessage[], fromIndex?: number): PlanOutcomeResult | null {
    const start = fromIndex != null ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (msg && "role" in msg && msg.role === "toolResult" && "toolName" in msg && msg.toolName === "plan_written") {
            const details = readWorkflowResultDetails(msg.details);
            const outcome = details?.outcome;
            if (outcome) {
                const images = readToolResultImages((msg as RawMessageContent).content);
                return {
                    outcome: outcome as PlanOutcome,
                    planName: details.planName as string | undefined,
                    triageMeta: details.triageMeta as TriageMeta | undefined,
                    feedback: typeof details.feedback === "string" ? details.feedback : undefined,
                    ...(images.length > 0 && { images }),
                };
            }
        }
    }
    return null;
}

function readToolResultImages(content: unknown): ImageAttachment[] {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const image = block as RawImageBlock;
        if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
            return [];
        }
        return [{ base64: image.data, mimeType: image.mimeType }];
    });
}

/**
 * Read the latest task_completed tool result's outcome from a message stream.
 *
 * When `fromIndex` is provided, only messages at or after that index are searched,
 * preventing stale completions from earlier root turns from advancing workflow state.
 * If the returned message stream is shorter than `fromIndex`, treat it as a fresh
 * or sliced transcript and search it from the beginning.
 */
export function readLatestTaskCompletedOutcome(messages: AgentMessage[], fromIndex?: number): boolean {
    return readLatestTaskCompletedReport(messages, fromIndex).completed;
}

/**
 * Read the latest task_completed tool result including its report text.
 *
 * Semantic repair needs the report itself, not just the completion signal: the
 * next Reviewer round independently verifies the repair agent's per-item
 * dispositions, so the claims must survive the dispatch.
 */
export function readLatestTaskCompletedReport(
    messages: AgentMessage[],
    fromIndex?: number,
): WorkflowTaskCompletedReport {
    const start = fromIndex != null && fromIndex <= messages.length ? fromIndex : 0;
    for (let i = messages.length - 1; i >= start; i--) {
        const msg = messages[i];
        if (
            msg &&
            "role" in msg &&
            msg.role === "toolResult" &&
            "toolName" in msg &&
            msg.toolName === "task_completed"
        ) {
            const details = readWorkflowResultDetails(msg.details);
            if (details?.outcome === "task_completed") {
                return {
                    completed: true,
                    message: typeof details.message === "string" ? details.message : "",
                };
            }
        }
    }
    return { completed: false, message: "" };
}
