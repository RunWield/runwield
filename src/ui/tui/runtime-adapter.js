import { createTuiDisplayConsumer } from "./runtime-display.js";
import { deliveryReportText } from "./delivery-report-text.ts";
/**
 * @module ui/tui/runtime-adapter
 * Renders one SessionRuntime event stream into the terminal UI.
 */

import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { normalizeAgentInternalName } from "../../shared/session/agents.js";
import { formatImageAttachmentMarker } from "../../shared/session/image-attachments.ts";
import { createTuiInteractionAdapter } from "./runtime-interaction-adapter.js";
import { setTerminalTitleForName } from "./terminal-title.ts";
import { presentTutorialEvent } from "./tutorial-guidance.ts";

/**
 * @typedef {Object} TuiRuntimeAdapterRegistration
 * @property {() => void} dispose
 * @property {(options?: { discard?: boolean }) => void} resumeTutorialPresentation
 */

/** @type {WeakMap<import('../../shared/session/session-runtime.ts').SessionRuntime, Map<string, TuiRuntimeAdapterRegistration>>} */
const activeAdapters = new WeakMap();

/**
 * @typedef {Object} TuiRuntimeAdapterOptions
 * @property {import('../../shared/session/session-runtime.ts').SessionRuntime} runtime
 * @property {string} sessionId
 * @property {import('./types.js').UiAPI} uiAPI
 * @property {import('../../shared/browser-port.ts').BrowserPort} browser
 * @property {typeof import('./system-notifications.ts').notifyRunWieldEventQuietly} notifyRunWieldEvent
 * @property {(replacement: { oldSessionId: string, newSessionId: string }) => void} [onSessionReplaced]
 * @property {boolean} [pauseTutorialPresentation]
 * @property {(sessionId: string, workRecordFailed?: boolean, workRecordPlanName?: string) => void} [onSessionComplete]
 */

/**
 * @param {import('../../shared/session/session-runtime-events.js').RuntimeQueuedMessage} message
 * @returns {string}
 */
export function formatQueuedMessageText(message) {
    if (message.images.length === 0) return message.text;
    const markers = message.images.map(formatImageAttachmentMarker).join("\n");
    if (!message.text.trim()) return markers;
    return `${message.text}\n\n${markers}`;
}

/**
 * @param {TuiRuntimeAdapterOptions} options
 * @returns {TuiRuntimeAdapterRegistration}
 */
export function attachTuiRuntimeAdapter({
    runtime,
    sessionId,
    uiAPI,
    browser,
    notifyRunWieldEvent,
    onSessionReplaced,
    pauseTutorialPresentation = false,
    onSessionComplete,
}) {
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
    /** @type {Set<string>} */
    const seenProjectedEventIds = new Set();
    let tutorialPresentation = Promise.resolve();
    let tutorialPresentationPaused = pauseTutorialPresentation;
    /** @type {import('../../shared/session/session-runtime-events.js').SessionRuntimeEvent[]} */
    const bufferedTutorialEvents = [];
    /**
     * @param {import('../../shared/session/session-runtime-events.js').SessionRuntimeEvent} event
     * @param {string} [tutorialSessionId]
     */
    const queueTutorialPresentation = (event, tutorialSessionId = sessionId) => {
        // Capture settlement now: an older idle event waiting behind Tutorial
        // presentation must not consume a later publication's completion.
        const settlementGeneration = completionPending && !event._meta?.replay &&
                event.type === RuntimeEventTypes.BUSY_CHANGED && !event.busy
            ? completionGeneration
            : null;
        tutorialPresentation = tutorialPresentation
            .then(async () => {
                await presentTutorialEvent({ runtime, sessionId: tutorialSessionId, uiAPI, event });
                if (
                    !disposed && completionPending && settlementGeneration === completionGeneration
                ) {
                    completionPending = false;
                    onSessionComplete?.(tutorialSessionId, completionWorkRecordFailed, completionWorkRecordPlanName);
                }
            })
            .catch((error) => console.error(`[RunWield] tutorial_presentation_failed ${error}`));
    };
    const shouldCacheValidationReport = () => {
        if (validationSessionActive) return true;
        return currentRoutingIntent === "PLANNED_CHANGE" || currentRoutingIntent === "FEATURE" ||
            currentRoutingIntent === "PROJECT" || currentRoutingIntent === "QUICK_FIX";
    };
    const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.eventId) {
            if (seenProjectedEventIds.has(event.eventId)) return;
            seenProjectedEventIds.add(event.eventId);
        }
        const value = /** @type {any} */ (event);
        switch (event.type) {
            case RuntimeEventTypes.SESSION_REPLACED:
                onSessionReplaced?.({ oldSessionId: value.oldSessionId, newSessionId: value.newSessionId });
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
                const message =
                    /** @type {import('../../shared/session/session-runtime-events.js').RuntimeQueuedMessage} */ (
                        value.message
                    );
                if (value.status === "queued") {
                    uiAPI.appendQueuedMessage?.(message.id, formatQueuedMessageText(message));
                    break;
                }
                uiAPI.removeQueuedMessage?.(message.id);
                break;
            }
            case RuntimeEventTypes.ASSISTANT_TEXT_DELTA: {
                if (value.workflowMessage === "task_completed" && shouldCacheValidationReport()) {
                    uiAPI.updateValidationReport?.("engineer", {
                        agentName: value.agentName,
                        markdown: value.delta,
                    });
                    hiddenValidationReportCached ||= !validationSessionActive;
                }
                if (value.workflowMessage === "review_complete" && shouldCacheValidationReport()) {
                    uiAPI.updateValidationReport?.("reviewer", {
                        agentName: value.agentName,
                        markdown: value.delta,
                        approved: value.approved,
                    });
                    hiddenValidationReportCached ||= !validationSessionActive;
                }
                if (value.workflowMessage === "review_report_update") {
                    if (shouldCacheValidationReport()) {
                        uiAPI.updateValidationReport?.("reviewer", {
                            agentName: value.agentName,
                            markdown: value.delta,
                            approved: value.approved,
                        });
                        hiddenValidationReportCached ||= !validationSessionActive;
                    }
                    break;
                }
                if (value.messageKind === "review_result" && uiAPI.appendReviewResult) {
                    uiAPI.appendReviewResult(
                        value.agentName,
                        value.delta,
                        value.approved,
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
                if (value.validationProgress) {
                    hiddenValidationReportCached = false;
                    const completed = value.validationProgress.stage === "terminal" &&
                        value.validationProgress.outcome === "verified";
                    validationSessionActive = !completed;
                    terminalValidationPanelVisible = value.validationProgress.outcome === "failed";
                    if (completed) {
                        uiAPI.clearValidationPanel?.();
                        if (!event._meta?.replay && value.validationProgress.kind === "workflow") {
                            completionGeneration += 1;
                            completionPending = true;
                            completionWorkRecordFailed = value.validationProgress.workRecordFailed === true;
                            completionWorkRecordPlanName = value.validationProgress.workRecordPlanName || "";
                        }
                    } else {
                        completionPending = false;
                        uiAPI.updateValidationProgress?.(value.validationProgress);
                    }
                }
                uiAPI.appendSystemMessage(
                    value.validationProgress?.deliveryReport
                        ? deliveryReportText(value.validationProgress.deliveryReport, sessionId)
                        : value.message,
                    value.level === "error",
                    value.header,
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
                if (!value.messageAlreadyReported) uiAPI.appendSystemMessage(value.message, true);
                break;
            case RuntimeEventTypes.CANCELLATION:
                if (value.message) uiAPI.appendSystemMessage(value.message, false, "RunWield");
                break;
            case RuntimeEventTypes.BUSY_CHANGED:
                uiAPI.setBusy?.(value.busy);
                break;
            case RuntimeEventTypes.AGENT_CHANGED: {
                let nextRootAgentName = "";
                try {
                    nextRootAgentName = value.agentName ? normalizeAgentInternalName(value.agentName) : "";
                } catch (_error) {
                    nextRootAgentName = "";
                }
                if (value.rootHandoff && nextRootAgentName && nextRootAgentName !== currentRootAgentName) {
                    uiAPI.appendSystemMessage(
                        `Agent switched to ${value.displayName || value.agentName}`,
                        false,
                        "RunWield",
                    );
                    currentRootAgentName = nextRootAgentName;
                } else if (!currentRootAgentName && nextRootAgentName && !value.rootHandoff) {
                    currentRootAgentName = nextRootAgentName;
                }
                uiAPI.setAgentBusyLines?.(
                    Array.isArray(value.busyLines) && value.busyLines.length > 0 ? value.busyLines : undefined,
                );
                uiAPI.requestRender();
                break;
            }
            case RuntimeEventTypes.KEYBOARD_HELP:
                uiAPI.showKeyboardHelp?.({
                    title: value.title,
                    items: value.items,
                });
                break;
            case RuntimeEventTypes.INPUT_STATE_CHANGED:
                if (value.enabled) uiAPI.enableInput?.();
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
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED:
                currentRoutingIntent = value.workflowContext?.routingIntent || null;
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.USAGE:
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED:
                uiAPI.setManagedSyncStatus?.({
                    status: value.status,
                    localGeneration: value.localGeneration,
                    latestGeneration: value.latestGeneration,
                    owningSurfaceKind: value.owningSurfaceKind,
                    message: value.message,
                });
                break;
            case RuntimeEventTypes.SESSION_RENAMED:
                setTerminalTitleForName(value.name);
                uiAPI.requestRender();
                break;
            case RuntimeEventTypes.ATTENTION_REQUESTED: {
                if (value.notificationSurface && !["tui", "test"].includes(value.notificationSurface)) break;
                notifyRunWieldEvent(value.reason, {
                    sessionName: value.sessionName,
                    agentName: value.agentName,
                });
                break;
            }
        }
        if (tutorialPresentationPaused) bufferedTutorialEvents.push(event);
        else {
            const tutorialSessionId = event.type === RuntimeEventTypes.SESSION_REPLACED
                ? value.newSessionId
                : sessionId;
            queueTutorialPresentation(event, tutorialSessionId);
        }
    });

    for (const message of initialSnapshot?.queuedMessages || []) {
        uiAPI.appendQueuedMessage?.(message.id, formatQueuedMessageText(message));
    }

    const registration = {
        /** @param {{ discard?: boolean }} [options] */
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
