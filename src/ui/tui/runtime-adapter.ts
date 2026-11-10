import { createTuiDisplayConsumer } from "./runtime-display.ts";
import { deliveryReportText } from "./delivery-report-text.ts";
/**
 * @module ui/tui/runtime-adapter
 * Renders one SessionRuntime event stream into the terminal UI.
 */

import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { normalizeAgentInternalName } from "../../shared/session/agents.ts";
import { formatImageAttachmentMarker } from "../../shared/session/image-attachments.ts";
import { createTuiInteractionAdapter } from "./runtime-interaction-adapter.ts";
import { setTerminalTitleForName } from "./terminal-title.ts";
import { presentTutorialEvent } from "./tutorial-guidance.ts";

import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type {
    RuntimeAssistantTextDeltaEvent,
    RuntimeQueuedMessage,
    SessionRuntimeEvent,
    RuntimeSessionReplacedEvent,
} from "../../shared/session/session-runtime-events.js";
import type { UiAPI } from "./api.ts";
import type { BrowserPort } from "../../shared/browser-port.ts";
import type { notifyRunWieldEventQuietly } from "./system-notifications.ts";

export interface ResumeTutorialPresentationOptions {
    discard?: boolean;
}

export interface TuiRuntimeAdapterRegistration {
    dispose: () => void;
    resumeTutorialPresentation: (options?: ResumeTutorialPresentationOptions) => void;
}

export type TuiSessionReplacement = Pick<RuntimeSessionReplacedEvent, "oldSessionId" | "newSessionId">;

export interface TuiRuntimeAdapterOptions {
    runtime: SessionRuntime;
    sessionId: string;
    uiAPI: UiAPI;
    browser: BrowserPort;
    notifyRunWieldEvent: typeof notifyRunWieldEventQuietly;
    onSessionReplaced?: (replacement: TuiSessionReplacement) => void;
    pauseTutorialPresentation?: boolean;
    onSessionComplete?: (sessionId: string, workRecordFailed?: boolean, workRecordPlanName?: string) => void;
}

type RuntimeReviewResultPresenter = (
    agentName: RuntimeAssistantTextDeltaEvent["agentName"],
    markdown: RuntimeAssistantTextDeltaEvent["delta"],
    approved: RuntimeAssistantTextDeltaEvent["approved"],
) => void;

const activeAdapters = new WeakMap<SessionRuntime, Map<string, TuiRuntimeAdapterRegistration>>();

export function formatQueuedMessageText(message: RuntimeQueuedMessage): string {
    if (message.images.length === 0) return message.text;
    const markers = message.images.map(formatImageAttachmentMarker).join("\n");
    if (!message.text.trim()) return markers;
    return `${message.text}\n\n${markers}`;
}

export function attachTuiRuntimeAdapter({
    runtime,
    sessionId,
    uiAPI,
    browser,
    notifyRunWieldEvent,
    onSessionReplaced,
    pauseTutorialPresentation = false,
    onSessionComplete,
}: TuiRuntimeAdapterOptions): TuiRuntimeAdapterRegistration {
    let registrations = activeAdapters.get(runtime);
    if (!registrations) {
        registrations = new Map();
        activeAdapters.set(runtime, registrations);
    }
    if (registrations.has(sessionId)) {
        throw new Error(`A TUI Runtime adapter is already attached to session ${sessionId}`);
    }

    const display = createTuiDisplayConsumer(uiAPI);
    const interactionAdapter = createTuiInteractionAdapter(uiAPI, { browser });
    runtime.setInteractionAdapter(sessionId, interactionAdapter);

    const initialSnapshot = runtime.getSessionSnapshot(sessionId);
    let currentRootAgentName = initialSnapshot?.activeAgent
        ? normalizeAgentInternalName(String(initialSnapshot.activeAgent))
        : "";
    let currentRoutingIntent = initialSnapshot?.workflowContext?.routingIntent || null;
    let validationSessionActive = false;
    let terminalValidationPanelVisible = false;
    let hiddenValidationReportCached = false;
    let completionPending = false;
    let completionWorkRecordFailed = false;
    let completionWorkRecordPlanName = "";
    let completionGeneration = 0;
    let disposed = false;

    const seenProjectedEventIds = new Set<string>();
    let tutorialPresentation = Promise.resolve();
    let tutorialPresentationPaused = pauseTutorialPresentation;

    const bufferedTutorialEvents: SessionRuntimeEvent[] = [];

    const queueTutorialPresentation = (event: SessionRuntimeEvent, tutorialSessionId = sessionId) => {
        // Capture settlement now: an older idle event waiting behind Tutorial
        // presentation must not consume a later publication's completion.
        const settlementGeneration =
            completionPending && !event._meta?.replay && event.type === RuntimeEventTypes.BUSY_CHANGED && !event.busy
                ? completionGeneration
                : null;
        tutorialPresentation = tutorialPresentation
            .then(async () => {
                await presentTutorialEvent({ runtime, sessionId: tutorialSessionId, uiAPI, event });
                if (!disposed && completionPending && settlementGeneration === completionGeneration) {
                    completionPending = false;
                    onSessionComplete?.(tutorialSessionId, completionWorkRecordFailed, completionWorkRecordPlanName);
                }
            })
            .catch((error) => console.error(`[RunWield] tutorial_presentation_failed ${error}`));
    };
    const shouldCacheValidationReport = () => {
        if (validationSessionActive) return true;
        return (
            currentRoutingIntent === "PLANNED_CHANGE" ||
            currentRoutingIntent === "FEATURE" ||
            currentRoutingIntent === "PROJECT" ||
            currentRoutingIntent === "QUICK_FIX"
        );
    };
    const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.eventId) {
            if (seenProjectedEventIds.has(event.eventId)) return;
            seenProjectedEventIds.add(event.eventId);
        }
        switch (event.type) {
            case RuntimeEventTypes.SESSION_REPLACED:
                onSessionReplaced?.({ oldSessionId: event.oldSessionId, newSessionId: event.newSessionId });
                break;
            case RuntimeEventTypes.USER_MESSAGE:
                completionPending = false;
                if (terminalValidationPanelVisible) {
                    uiAPI.clearValidationPanel?.();
                    terminalValidationPanelVisible = false;
                    validationSessionActive = false;
                    hiddenValidationReportCached = false;
                } else if (!validationSessionActive && hiddenValidationReportCached) {
                    uiAPI.clearValidationPanel?.();
                    hiddenValidationReportCached = false;
                }
                display.consume(event);
                break;
            case RuntimeEventTypes.QUEUED_MESSAGE_CHANGED: {
                const message = event.message;
                if (event.status === "queued") {
                    uiAPI.appendQueuedMessage?.(message.id, formatQueuedMessageText(message));
                    break;
                }
                uiAPI.removeQueuedMessage?.(message.id);
                break;
            }
            case RuntimeEventTypes.ASSISTANT_TEXT_DELTA: {
                if (event.workflowMessage === "task_completed" && shouldCacheValidationReport()) {
                    uiAPI.updateValidationReport?.("engineer", {
                        agentName: event.agentName,
                        markdown: event.delta,
                    });
                    hiddenValidationReportCached ||= !validationSessionActive;
                }
                if (event.workflowMessage === "review_complete" && shouldCacheValidationReport()) {
                    uiAPI.updateValidationReport?.("reviewer", {
                        agentName: event.agentName,
                        markdown: event.delta,
                        approved: event.approved,
                    });
                    hiddenValidationReportCached ||= !validationSessionActive;
                }
                if (event.workflowMessage === "review_report_update") {
                    if (shouldCacheValidationReport()) {
                        uiAPI.updateValidationReport?.("reviewer", {
                            agentName: event.agentName,
                            markdown: event.delta,
                            approved: event.approved,
                        });
                        hiddenValidationReportCached ||= !validationSessionActive;
                    }
                    break;
                }
                if (event.messageKind === "review_result" && uiAPI.appendReviewResult) {
                    // Preserve the JS adapter's forwarding of optional approval; the legacy UiAPI requires boolean.
                    (uiAPI.appendReviewResult as RuntimeReviewResultPresenter)(
                        event.agentName,
                        event.delta,
                        event.approved,
                    );
                    break;
                }
                display.consume(event);
                break;
            }
            case RuntimeEventTypes.ASSISTANT_THINKING_DELTA:
            case RuntimeEventTypes.ASSISTANT_THINKING_END:
            case RuntimeEventTypes.TOOL_START:
            case RuntimeEventTypes.TOOL_UPDATE:
            case RuntimeEventTypes.TOOL_END:
                display.consume(event);
                break;
            case RuntimeEventTypes.SYSTEM_STATUS:
                if (event.validationProgress) {
                    hiddenValidationReportCached = false;
                    const completed =
                        event.validationProgress.stage === "terminal" &&
                        event.validationProgress.outcome === "verified";
                    validationSessionActive = !completed;
                    terminalValidationPanelVisible = event.validationProgress.outcome === "failed";
                    if (completed) {
                        // Older transcripts have completion events but no saved sidebar progress.
                        uiAPI.updateValidationProgress?.(event.validationProgress);
                        uiAPI.clearValidationPanel?.(true);
                        if (!event._meta?.replay && event.validationProgress.kind === "workflow") {
                            completionGeneration += 1;
                            completionPending = true;
                            completionWorkRecordFailed = event.validationProgress.workRecordFailed === true;
                            completionWorkRecordPlanName = event.validationProgress.workRecordPlanName || "";
                        }
                    } else {
                        completionPending = false;
                        uiAPI.updateValidationProgress?.(event.validationProgress);
                    }
                }
                uiAPI.appendSystemMessage(
                    event.validationProgress?.deliveryReport
                        ? deliveryReportText(event.validationProgress.deliveryReport, sessionId)
                        : event.message,
                    event.level === "error",
                    event.header,
                );
                break;
            case RuntimeEventTypes.TERMINAL_ERROR:
                completionPending = false;
                if (validationSessionActive || terminalValidationPanelVisible || hiddenValidationReportCached) {
                    uiAPI.clearValidationPanel?.();
                    validationSessionActive = false;
                    terminalValidationPanelVisible = false;
                    hiddenValidationReportCached = false;
                }
                if (!event.messageAlreadyReported) uiAPI.appendSystemMessage(event.message, true);
                break;
            case RuntimeEventTypes.CANCELLATION:
                if (event.message) uiAPI.appendSystemMessage(event.message, false, "RunWield");
                break;
            case RuntimeEventTypes.BUSY_CHANGED:
                uiAPI.setBusy?.(event.busy);
                break;
            case RuntimeEventTypes.AGENT_CHANGED: {
                let nextRootAgentName = "";
                try {
                    nextRootAgentName = event.agentName ? normalizeAgentInternalName(event.agentName) : "";
                } catch (_error) {
                    nextRootAgentName = "";
                }
                if (event.rootHandoff && nextRootAgentName && nextRootAgentName !== currentRootAgentName) {
                    uiAPI.appendSystemMessage(
                        `Agent switched to ${event.displayName || event.agentName}`,
                        false,
                        "RunWield",
                    );
                    currentRootAgentName = nextRootAgentName;
                } else if (!currentRootAgentName && nextRootAgentName && !event.rootHandoff) {
                    currentRootAgentName = nextRootAgentName;
                }
                uiAPI.setAgentBusyLines?.(
                    Array.isArray(event.busyLines) && event.busyLines.length > 0 ? event.busyLines : undefined,
                );
                uiAPI.requestRender();
                break;
            }
            case RuntimeEventTypes.KEYBOARD_HELP:
                uiAPI.showKeyboardHelp?.({
                    title: event.title,
                    items: event.items,
                });
                break;
            case RuntimeEventTypes.INPUT_STATE_CHANGED:
                if (event.enabled) uiAPI.enableInput?.();
                else uiAPI.disableInput?.();
                break;
            case RuntimeEventTypes.MESSAGES_CLEARED:
                completionPending = false;
                terminalValidationPanelVisible = false;
                validationSessionActive = false;
                hiddenValidationReportCached = false;
                uiAPI.clearMessages?.();
                break;
            case RuntimeEventTypes.TURN_END:
                display.consume(event);
                break;
            case RuntimeEventTypes.MODEL_CHANGED:
            case RuntimeEventTypes.THINKING_LEVEL_CHANGED:
            case RuntimeEventTypes.INTERACTION_REQUESTED:
            case RuntimeEventTypes.INTERACTION_RESOLVED:
            case RuntimeEventTypes.INTERACTION_CANCELED:
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED:
                currentRoutingIntent = event.workflowContext?.routingIntent || null;
                if (!event.workflowContext?.validationProgress) uiAPI.clearValidationPanel?.();
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.USAGE:
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED:
                uiAPI.setManagedSyncStatus?.({
                    status: event.status,
                    localGeneration: event.localGeneration,
                    latestGeneration: event.latestGeneration,
                    owningSurfaceKind: event.owningSurfaceKind,
                    message: event.message,
                });
                break;
            case RuntimeEventTypes.SESSION_RENAMED:
                setTerminalTitleForName(event.name);
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.ATTENTION_REQUESTED: {
                if (event.notificationSurface && !["tui", "test"].includes(event.notificationSurface)) break;
                notifyRunWieldEvent(event.reason, {
                    sessionName: event.sessionName,
                    agentName: event.agentName,
                });
                break;
            }
        }
        if (tutorialPresentationPaused) bufferedTutorialEvents.push(event);
        else {
            const tutorialSessionId =
                event.type === RuntimeEventTypes.SESSION_REPLACED ? event.newSessionId : sessionId;
            queueTutorialPresentation(event, tutorialSessionId);
        }
    });

    for (const message of initialSnapshot?.queuedMessages || []) {
        uiAPI.appendQueuedMessage?.(message.id, formatQueuedMessageText(message));
    }

    const registration: TuiRuntimeAdapterRegistration = {
        resumeTutorialPresentation(options = {}) {
            if (!tutorialPresentationPaused) return;
            tutorialPresentationPaused = false;
            const buffered = bufferedTutorialEvents.splice(0);
            if (options.discard) return;
            for (const event of buffered) queueTutorialPresentation(event);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe();
            display.dispose();
            if (registrations.get(sessionId) !== registration) return;
            registrations.delete(sessionId);
            interactionAdapter.cancelAll?.();
            runtime.setInteractionAdapter(sessionId, null);
        },
    };
    registrations.set(sessionId, registration);
    return registration;
}
