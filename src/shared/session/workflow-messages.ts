/**
 * @module shared/session/workflow-messages
 * Semantic messages produced by workflow tools.
 */

import { emitAssistantMessage } from "./session-runtime-events.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "./hosted-session.ts";

interface TaskCompletedMessageFields {
    message?: unknown;
}

export interface ManualQaChecklistMessage {
    agentName: string;
    text: string;
    toolCallId?: string;
}

export interface ManualQaChecklist extends Omit<ManualQaChecklistMessage, "agentName"> {
    agentName?: string;
    name?: string;
    classification?: string;
}

interface ManualQaChecklistData {
    agentName?: unknown;
    text?: unknown;
    toolCallId?: string;
}

interface ManualQaChecklistEntry {
    customType?: unknown;
    data?: ManualQaChecklistData;
}

export const MANUAL_QA_CHECKLIST_CUSTOM_TYPE = "runwield.manual_qa_checklist";

export function extractTaskCompletedMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            return extractTaskCompletedMessage(JSON.parse(value));
        } catch {
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const record: TaskCompletedMessageFields = value;
    return typeof record.message === "string" ? record.message : "";
}

export function formatTaskCompletedMarkdown(message: unknown): string {
    const text = typeof message === "string" ? message.trim() : "";
    return text ? `**Task completed.**\n\n${text}` : "**Task completed.**";
}

export function emitTaskCompletedMessage(
    hostedSession: HostedSession,
    agentName: string,
    message: unknown,
    toolCallId?: string,
) {
    emitAssistantMessage(hostedSession, agentName || "RunWield", formatTaskCompletedMarkdown(message), {
        messageKind: "workflow",
        workflowMessage: "task_completed",
        toolCallId,
    });
}

/**
 * Persist a workflow-owned Manual QA checklist that was produced by a transient
 * AgentSession. Transient sessions emit live Runtime events but do not write to
 * the root Pi transcript, so store the visible checklist as RunWield metadata
 * for `/resume` replay.
 */
export function recordManualQaChecklistMessage(
    sessionManager: SessionManager | undefined | null,
    checklist: ManualQaChecklist,
) {
    if (!sessionManager?.appendCustomEntry) return;
    const text = typeof checklist.text === "string" ? checklist.text.trim() : "";
    if (!text) return;
    sessionManager.appendCustomEntry(MANUAL_QA_CHECKLIST_CUSTOM_TYPE, {
        agentName: checklist.agentName || "Operator",
        text,
        ...(checklist.toolCallId ? { toolCallId: checklist.toolCallId } : {}),
        ...(checklist.name ? { name: checklist.name } : {}),
        ...(checklist.classification ? { classification: checklist.classification } : {}),
    });
}

export function readManualQaChecklistMessage(entry: unknown): ManualQaChecklistMessage | null {
    if (!entry || typeof entry !== "object") return null;
    const customType = (entry as ManualQaChecklistEntry).customType;
    if (customType !== MANUAL_QA_CHECKLIST_CUSTOM_TYPE) return null;
    const data = (entry as ManualQaChecklistEntry).data;
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) return null;
    return {
        agentName: typeof data?.agentName === "string" && data.agentName.trim() ? data.agentName.trim() : "Operator",
        text,
        ...(data?.toolCallId ? { toolCallId: data.toolCallId } : {}),
    };
}

export function emitReviewResultMessage(
    hostedSession: HostedSession,
    agentName: string,
    message: unknown,
    approved: boolean,
    toolCallId?: string,
) {
    const markdown = typeof message === "string" && message.trim() ? message.trim() : "Review complete.";
    emitAssistantMessage(hostedSession, agentName || "Reviewer", markdown, {
        messageKind: "review_result",
        approved,
        workflowMessage: "review_complete",
        toolCallId,
    });
}
