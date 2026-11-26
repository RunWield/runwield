import { RuntimeEventTypes } from "./events.ts";

import type { RuntimeAssistantTextDeltaEvent, RuntimeEventDraft, RuntimeSystemStatusEvent } from "./events.ts";
import type { HostedSession } from "./hosted-session.ts";

type AssistantMessageOptions = Partial<
    Pick<RuntimeAssistantTextDeltaEvent, "messageKind" | "workflowMessage" | "toolCallId" | "approved">
>;

type SystemStatusOptions = Partial<Pick<RuntimeSystemStatusEvent, "level" | "header" | "validationProgress">>;

/**
 * Publish a semantic event draft through a Hosted Session's Runtime-installed
 * internal sink. SessionRuntime validates before fanout and isolates consumer
 * listener failures; producer and contract failures propagate here.
 */
export function emitHostedSessionRuntimeEvent(hostedSession: HostedSession | undefined, event: RuntimeEventDraft) {
    hostedSession?.publishRuntimeEvent?.(event);
    const sink = hostedSession?.getEventSink?.();
    if (!sink) return false;
    if (typeof sink === "function") {
        sink(event);
        return true;
    }
    if (typeof sink === "object" && "emit" in sink && typeof sink.emit === "function") {
        sink.emit(event);
        return true;
    }
    return false;
}

/**
 * Publish a user-visible status without coupling the producer to an adapter.
 * SessionRuntime owns the installed event sink and fans the event out to its
 * registered listeners.
 */
export function emitSystemStatus(
    hostedSession: HostedSession | undefined,
    message: string,
    options: SystemStatusOptions = {},
) {
    return emitHostedSessionRuntimeEvent(hostedSession, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        messageId: crypto.randomUUID(),
        message: String(message),
        level: options.level || "info",
        ...(options.header ? { header: options.header } : {}),
        ...(options.validationProgress ? { validationProgress: options.validationProgress } : {}),
    });
}

/**
 * Publish a complete synthetic assistant message as one semantic delta. This
 * is used for workflow-owned messages such as completion and review results;
 * adapters decide how to render or encode it.
 */
export function emitAssistantMessage(
    hostedSession: HostedSession | undefined,
    agentName: string,
    text: string,
    options: AssistantMessageOptions = {},
) {
    return emitHostedSessionRuntimeEvent(hostedSession, {
        type: RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        messageId: crypto.randomUUID(),
        delta: String(text),
        agentName,
        messageKind: options.messageKind || "assistant",
        ...(options.workflowMessage ? { workflowMessage: options.workflowMessage } : {}),
        ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
        ...(options.approved === undefined ? {} : { approved: options.approved }),
    });
}
