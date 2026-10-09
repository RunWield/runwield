import { submitWorkflowAction } from "../browser/workflow-action.ts";
import { mergePlanAssociations } from "../../../shared/session/plan-association.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animateSidebarUpdate } from "../../design-system/components/react/sidebar-motion.ts";

// New Session chat structure is adapted from OpenChamber's ChatContainer/ChatInput UI.
// OpenChamber is MIT licensed: Copyright (c) 2025 Bohdan Triapitsyn.
import {
    RunWieldButton,
    RunWieldLink,
    RunWieldPanelToggle,
    RunWieldThinkingDots,
} from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { SessionList } from "../components/SessionList.jsx";
import { deriveSessionAvailability } from "../components/SessionActivationStatus.tsx";
import {
    displayAgentName,
    mergeSessionTimelineItems,
    reduceSessionEvents,
    SessionTimeline,
} from "../components/SessionTimeline.jsx";
import {
    buildSessionSidebarProjection,
    defaultSessionSidebarTab,
    SESSION_SIDEBAR_TABS,
    sessionArtifactKindLabel,
    sessionSidebarFields,
} from "../../../shared/session/session-sidebar.ts";
import { createSessionTabNotificationController } from "../browser/session-tab-notifications.ts";
import { WorkspaceHeaderActionsPortal } from "../react/WorkspaceHeaderActionsPortal.tsx";
import { loadSessionDrafts, readSessionDraft, saveSessionDraft } from "../browser/session-drafts.ts";
import { sessionAgentSelection, sessionCommandSuggestions, sessionModelLabel } from "../browser/session-commands.ts";
import { RunWieldMascot } from "../../design-system/components/react/RunWieldMascot.tsx";
import { mascotPose } from "../../mascot/mascot.ts";
import { WorkflowSidebar } from "../react/WorkflowSidebar.tsx";

export const SESSION_PAGE_SIZE = 30;
const TIMELINE_PAGE_LIMIT = 200;
const POLL_INTERVAL_MS = 1500;
const AVAILABILITY_REFRESH_INTERVAL_MS = 5000;

/** @param {string} projectId @param {string} sessionId */
export function sessionDraftKey(projectId, sessionId) {
    return `runwield:owner:project:${projectId}:session:${sessionId}:draft`;
}

/** @param {string} projectId @param {string} sessionId */
export function sessionRequestKey(projectId, sessionId) {
    return `runwield:owner:project:${projectId}:session:${sessionId}:request`;
}

/** @param {string} projectId @param {string} sessionId */
export function sessionAttachmentsKey(projectId, sessionId) {
    return `runwield:owner:project:${projectId}:session:${sessionId}:image-attachments`;
}

/** @param {string} projectId */
export function newSessionDraftInstanceStorageKey(projectId) {
    return `runwield:owner:project:${projectId}:session:new:draft-instance`;
}

/** @param {string} projectId */
function getNewSessionDraftInstanceId(projectId) {
    if (typeof sessionStorage === "undefined") return "";
    const key = newSessionDraftInstanceStorageKey(projectId);
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const next = `new:${crypto.randomUUID()}`;
    sessionStorage.setItem(key, next);
    return next;
}

/**
 * @typedef {Object} SessionImageAttachmentDraft
 * @property {string} id
 * @property {string} name
 * @property {string} mimeType
 * @property {string} base64
 */

/**
 * @typedef {Object} SessionImageRequest
 * @property {string} base64
 * @property {string} mimeType
 */

/**
 * @typedef {Object} WorkspaceQueuedMessage
 * @property {string} id
 * @property {string} text
 * @property {SessionImageRequest[]} images
 * @property {string} queuedAt
 */

/** @param {unknown} value */
function asRecord(value) {
    return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : {};
}

/** @param {string} name */
function ownerCookie(name) {
    return document.cookie.split("; ").find((value) => value.startsWith(`${name}=`))?.split("=").slice(1).join("=") ||
        "";
}

/** @param {string} url @param {RequestInit} [options] */
async function ownerFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("x-runwield-csrf", decodeURIComponent(ownerCookie("rw_owner_csrf")));
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
        const error = new Error(payload.error || `Request failed with ${response.status}`);
        Reflect.set(error, "status", response.status);
        Reflect.set(error, "payload", payload);
        throw error;
    }
    return payload;
}

/**
 * Open the current Workspace review, or wait for its operation to publish it.
 * @param {string} projectId
 * @param {string} sessionId
 * @param {number} generation
 * @param {() => boolean} [isCurrent]
 */
export async function requestWorkspacePlanReview(projectId, sessionId, generation, isCurrent = () => true) {
    try {
        const result = await ownerFetch(
            `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
                encodeURIComponent(sessionId)
            }/plan-review`,
            {
                method: "POST",
                body: JSON.stringify({
                    requestId: crypto.randomUUID(),
                    expectedGeneration: generation,
                }),
            },
        );
        if (result.kind === "busy" || result.kind === "no_reference") return result.message;
        if (result.url) {
            workspaceNavigate(result.url);
            return;
        }
        if (!result.operationId) {
            return result.message || "Plan review is not available.";
        }
        // The review surface is published by the existing interaction, not by a second turn.
        while (isCurrent()) {
            const live = await ownerFetch(
                `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/live`,
            );
            const current = live.operation;
            const reviewUrl = current?.liveInteraction?.request?.type === "plan_review"
                ? current.liveInteraction.request.reviewUrl
                : "";
            if (reviewUrl) {
                workspaceNavigate(reviewUrl);
                return;
            }
            if (current?.operationId !== result.operationId || current.status !== "running") {
                const settled = await ownerFetch(
                    `/api/owner/session-operations/${encodeURIComponent(result.operationId)}`,
                );
                if (settled.status !== "running") {
                    return settled.error || "Plan review finished without opening a review surface.";
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    } catch (error) {
        return errorMessage(error);
    }
}

/** @param {string} key */
function readStored(key) {
    try {
        return JSON.parse(readSessionDraft(key) || "null");
    } catch {
        return null;
    }
}

/** @param {unknown} error */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/** @param {string} href @param {"push" | "replace"} [history] */
function workspaceNavigate(href, history = "push", onComplete) {
    const event = new CustomEvent("runwield:workspace-navigate", {
        cancelable: true,
        detail: { href, history, onComplete },
    });
    if (document.dispatchEvent(event)) {
        if (history === "replace") globalThis.location.replace(href);
        else globalThis.location.assign(href);
    }
}

/** @param {SessionImageAttachmentDraft} image */
export function serializeSessionImageForRequest(image) {
    return { base64: image.base64, mimeType: image.mimeType };
}

/** @param {File} file */
async function readPastedImage(file) {
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) throw new Error("Attach a PNG, JPEG, GIF, or WebP image.");
    if (file.size > 7 * 1024 * 1024) throw new Error("This image is too large. Choose an image smaller than 7 MB.");
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Image paste failed."));
        reader.readAsDataURL(file);
    });
    const marker = ";base64,";
    const markerIndex = dataUrl.indexOf(marker);
    if (markerIndex < 0) throw new Error("Image paste did not include base64 data.");
    return {
        id: crypto.randomUUID(),
        name: file.name || "pasted-image",
        mimeType: file.type,
        base64: dataUrl.slice(markerIndex + marker.length),
    };
}

/**
 * @param {{ status?: string, responseAccepted?: boolean }} input
 * @returns {"idle" | "retry-same-envelope" | "poll-operation" | "manual-resubmit"}
 */
export function draftRecoveryDecision(input) {
    if (input.status === "running" || input.status === "accepted" || input.responseAccepted) return "poll-operation";
    if (input.status === "network-error") return "retry-same-envelope";
    if (input.status === "conflict" || input.status === "unavailable") return "manual-resubmit";
    return "idle";
}

/** @param {{ cancelled: boolean, currentOperationId?: string, polledOperationId: string }} input */
export function shouldApplyOperationPoll(input) {
    return !input.cancelled && input.currentOperationId === input.polledOperationId;
}

/** @param {unknown} events */
export function reduceOperationTransientItems(events) {
    return reduceSessionEvents(
        Array.isArray(events) ? events.filter((event) => !event.eventId && event.type !== "interaction_requested") : [],
        { source: "transient" },
    );
}

export function latestLiveWorkflowInteraction(items) {
    return [...items].reverse().find((item) =>
        item?.source === "transient" && ["interaction", "plan-review", "code-review"].includes(item.kind) &&
        item.interactionId
    ) || null;
}

let operationNotificationController = null;

function getOperationNotificationController() {
    if (!operationNotificationController) {
        operationNotificationController = createSessionTabNotificationController();
    }
    return operationNotificationController;
}

export function disposeOperationBrowserNotifications() {
    operationNotificationController?.dispose();
    operationNotificationController = null;
}

export function observeOperationBrowserNotifications(current, payload, cursorRef) {
    const events = (Array.isArray(payload.events) ? payload.events : [])
        // Tagged events are delivered by the persistent Workspace notification stream.
        .filter((event) =>
            !event.notificationSurface && !event.eventId && event.type === "attention_requested" &&
            event.reason === "agentStopped"
        );
    const key = `${current.scopeKey || ""}:${current.operationId}`;
    if (!cursorRef.current || cursorRef.current.key !== key) {
        cursorRef.current = {
            key,
            seen: new Set(
                current.restored && current.attempts === 0 ? events.map((event) => JSON.stringify(event)) : [],
            ),
        };
    }
    for (const event of events) {
        const identity = JSON.stringify(event);
        if (cursorRef.current.seen.has(identity)) continue;
        cursorRef.current.seen.add(identity);
        getOperationNotificationController().notifyAgentStopped(event, payload.browserNotificationPolicy);
    }
}

export function syncOperationBrowserNotificationLifecycle({ operationId, scopeKey, operationKeyRef, cursorRef }) {
    const nextKey = operationId ? `${scopeKey || ""}:${operationId}` : null;
    const previousKey = operationKeyRef.current;
    if (!nextKey) {
        cursorRef.current = null;
        return;
    }
    if (previousKey && previousKey !== nextKey) disposeOperationBrowserNotifications();
    if (previousKey !== nextKey) cursorRef.current = null;
    operationKeyRef.current = nextKey;
}

/** @param {{ scrollHeight: number, scrollTop: number, clientHeight: number, threshold?: number }} input */
export function isAtLiveScrollEdge(input) {
    const threshold = typeof input.threshold === "number" ? input.threshold : 48;
    return input.scrollHeight - input.scrollTop - input.clientHeight < threshold;
}

/** @param {{ mode: string, state?: string, localOperationActive?: boolean, queuedMessageCount?: number }} input */
export function shouldRefreshSessionAvailability(input) {
    return input.mode === "detail" && input.localOperationActive !== true;
}

/**
 * @typedef {{ model?: string, provider?: string }} SessionModelState
 */

/**
 * @typedef {{ activeModel?: SessionModelState | null, model?: string, provider?: string }} SessionModelSnapshot
 */

/** @typedef {{ planId?: string, planName?: string, triageMeta?: { planId?: string } }} SessionPlanContext */
/** @typedef {{ workflowContext?: SessionPlanContext, activeExecutionWorkflow?: SessionPlanContext, planAssociations?: SessionPlanContext[] }} SessionPlanSnapshot */

/** @param {SessionPlanSnapshot | undefined | null} snapshot */
export function activePlanId(snapshot) {
    for (const context of [snapshot?.activeExecutionWorkflow, snapshot?.workflowContext]) {
        const planId = context?.planId?.trim() || context?.triageMeta?.planId?.trim();
        if (planId) return planId;
        const planName = context?.planName?.trim();
        if (!planName) continue;
        const association = snapshot?.planAssociations?.findLast((item) => item.planName === planName);
        if (association?.planId) return association.planId;
    }
    return "";
}

/**
 * @template {{ snapshot?: Partial<import('../../../shared/session/live-session-connection.ts').LiveSessionInfo> }} Timeline
 * @param {Timeline} timeline
 * @param {import('../../../shared/session/live-session-connection.ts').LiveSessionInfo | null | undefined} sessionInfo
 */
export function mergeLiveSessionInfo(timeline, sessionInfo) {
    if (!sessionInfo) return timeline;
    return {
        ...timeline,
        snapshot: {
            ...timeline.snapshot,
            ...sessionInfo,
            planAssociations: mergePlanAssociations(timeline.snapshot?.planAssociations, sessionInfo.planAssociations),
        },
    };
}

export function activePlanHomeUrl(projectId, runwieldSessionId, snapshot) {
    const planId = activePlanId(snapshot);
    return planId
        ? `/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}?session=${
            encodeURIComponent(runwieldSessionId)
        }`
        : "";
}

export function activePlanProgressApiUrl(projectId, runwieldSessionId, snapshot) {
    const planId = activePlanId(snapshot);
    return planId
        ? `/api/owner/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/progress?session=${
            encodeURIComponent(runwieldSessionId)
        }`
        : "";
}

function PaperAirplaneIcon() {
    return (
        <svg className="rw-session-toolbar-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.5 4.5 20.5 12 3.5 19.5 6 12Zm0 0h7" />
        </svg>
    );
}

function resizeComposerTextArea(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
}

export function SessionComposer({
    id,
    draft,
    disabled,
    controlsDisabled = disabled,
    canSend,
    submitting,
    onDraftChange,
    onSubmit,
    onResizeStart = undefined,
    onResize = undefined,
    onQueue = undefined,
    onStop = undefined,
    sendLabel = "Send",
    steeringMessages = [],
    onPaste,
    onFiles,
    imageAttachments = [],
    onRemoveImage,
    agents = [],
    models = [],
    thinkingLevels = [],
    agentValue,
    mascotAgent = agentValue || "",
    mascotParentAgent = undefined,
    mascotActivity = "idle",
    mascotVisible = false,
    modelValue,
    thinkingValue,
    onAgentChange,
    onModelChange,
    onThinkingChange,
    agentFallback = null,
    modelFallback = null,
    thinkingFallback = null,
    queuedMessages = [],
    commands = [],
    onCommand = undefined,
    onCommandPickerOpen = undefined,
    onCommandPickerCancel = undefined,
}) {
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const composerRef = useRef(null);
    const composerAnimation = useRef(null);
    const previousComposerHeight = useRef(null);
    const focusInputOnExpand = useRef(false);
    const [expanded, setExpanded] = useState(false);
    const hasDraft = Boolean(draft.trim() || imageAttachments.length);
    const canReopenReview = draft.trim() === "/plan-review";
    const showStop = Boolean(onStop) && !hasDraft;
    const primaryLabel = showStop ? "Stop" : submitting ? "Sending" : sendLabel;
    const selectionSummary = [
        agents.find((agent) => agent.name === agentValue)?.displayName || agentValue || "Agent",
        modelValue?.replace("\u001f", "/") || "Project default",
        thinkingValue || "Default thinking",
    ].join(" · ");
    function setComposerExpanded(nextExpanded) {
        if (nextExpanded === expanded) return;
        onResizeStart?.();
        previousComposerHeight.current = composerRef.current?.getBoundingClientRect().height ?? null;
        composerAnimation.current?.cancel();
        setExpanded(nextExpanded);
    }
    function expandComposer() {
        focusInputOnExpand.current = true;
        setComposerExpanded(true);
    }
    useLayoutEffect(() => {
        if (expanded) resizeComposerTextArea(textareaRef.current);
        const composer = composerRef.current;
        const previousHeight = previousComposerHeight.current;
        previousComposerHeight.current = null;
        if (composer && previousHeight !== null && !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const styles = getComputedStyle(composer);
            composerAnimation.current = composer.animate([
                { height: `${previousHeight}px`, overflow: "clip" },
                { height: `${composer.getBoundingClientRect().height}px`, overflow: "clip" },
            ], {
                duration: Number.parseFloat(styles.getPropertyValue("--rw-control-motion-duration")),
                easing: styles.getPropertyValue("--rw-control-motion-ease").trim(),
            });
        }
        onResize?.();
        if (expanded && focusInputOnExpand.current) {
            focusInputOnExpand.current = false;
            textareaRef.current?.focus({ preventScroll: true });
        }
    }, [expanded]);
    useEffect(() => () => composerAnimation.current?.cancel(), []);
    const [commandIndex, setCommandIndex] = useState(0);
    const [dismissedCommandDraft, setDismissedCommandDraft] = useState(null);
    const commandSuggestions = dismissedCommandDraft === draft ? [] : sessionCommandSuggestions(draft, {
        commands,
        agents,
        models,
    });
    const selectedCommandIndex = Math.min(commandIndex, Math.max(0, commandSuggestions.length - 1));
    const commandListId = `${id}-commands`;
    useEffect(() => setCommandIndex(0), [draft]);
    useEffect(() => {
        document.getElementById(`${commandListId}-${selectedCommandIndex}`)?.scrollIntoView({ block: "nearest" });
    }, [commandListId, selectedCommandIndex, draft]);
    async function pickCommand(suggestion) {
        if (suggestion.kind === "command") {
            if (["/agent ", "/model "].includes(suggestion.value)) {
                onCommandPickerOpen?.(suggestion.value.trim().slice(1));
            }
            onDraftChange(suggestion.value);
        } else {
            if (controlsDisabled) return;
            const apply = suggestion.kind === "agent" ? onAgentChange : onModelChange;
            const applied = await apply(suggestion.value);
            if (applied !== false) onDraftChange("");
        }
        textareaRef.current?.focus();
    }
    function submitComposer() {
        if (draft.startsWith("/") && onCommand?.(draft) === true) return;
        onSubmit();
    }
    useEffect(() => resizeComposerTextArea(textareaRef.current), [draft]);
    return (
        <form
            className="session-composer"
            ref={composerRef}
            data-expanded={expanded}
            onFocusCapture={(event) => {
                if (!event.target.classList.contains("session-composer-summary")) setComposerExpanded(true);
            }}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    setComposerExpanded(false);
                    onCommandPickerCancel?.();
                }
            }}
            onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                if (!disabled) onFiles?.(Array.from(event.dataTransfer.files));
            }}
            onSubmit={(event) => {
                event.preventDefault();
                submitComposer();
            }}
        >
            {commandSuggestions.length > 0 && (
                <div
                    className="rw-command-menu"
                    hidden={!expanded}
                    id={commandListId}
                    role="listbox"
                    aria-label="Commands"
                >
                    {commandSuggestions.map((suggestion, index) => (
                        <button
                            key={suggestion.key}
                            id={`${commandListId}-${index}`}
                            type="button"
                            role="option"
                            aria-selected={index === selectedCommandIndex}
                            disabled={controlsDisabled && suggestion.kind !== "command"}
                            tabIndex={-1}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => pickCommand(suggestion)}
                        >
                            <strong>{suggestion.label}</strong>
                            <span>{suggestion.description}</span>
                        </button>
                    ))}
                </div>
            )}
            {queuedMessages.length
                ? (
                    <ol className="session-composer-queue" hidden={!expanded} aria-label="Queued messages">
                        {queuedMessages.map((item) => (
                            <li key={item.id}>
                                <span>{item.text || "Image message"}</span>
                                {Array.isArray(item.images) && item.images.length
                                    ? <small>{item.images.length} image{item.images.length === 1 ? "" : "s"}</small>
                                    : null}
                            </li>
                        ))}
                    </ol>
                )
                : null}
            {steeringMessages.length
                ? (
                    <ul className="session-composer-queue" hidden={!expanded} aria-label="Pending steering messages">
                        {steeringMessages.map((item) => (
                            <li key={item.id}>
                                <span>Steering · {item.text}</span>
                            </li>
                        ))}
                    </ul>
                )
                : null}
            <textarea
                ref={textareaRef}
                hidden={!expanded}
                id={id}
                value={draft}
                rows={2}
                disabled={disabled}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={expanded && commandSuggestions.length > 0}
                aria-controls={commandSuggestions.length ? commandListId : undefined}
                aria-activedescendant={commandSuggestions.length
                    ? `${commandListId}-${selectedCommandIndex}`
                    : undefined}
                onPaste={onPaste}
                onChange={(event) => {
                    setDismissedCommandDraft(null);
                    onDraftChange(event.currentTarget.value);
                    resizeComposerTextArea(event.currentTarget);
                }}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (commandSuggestions.length) {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            setDismissedCommandDraft(draft);
                            onCommandPickerCancel?.();
                            return;
                        }
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            setCommandIndex(
                                (selectedCommandIndex + (event.key === "ArrowDown" ? 1 : -1) +
                                    commandSuggestions.length) % commandSuggestions.length,
                            );
                            return;
                        }
                        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                            event.preventDefault();
                            void pickCommand(commandSuggestions[selectedCommandIndex]);
                            return;
                        }
                    }
                    if (event.key === "Escape" && onStop) {
                        event.preventDefault();
                        onStop();
                    }
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if ((canSend || canReopenReview) && !submitting) submitComposer();
                    }
                }}
                placeholder="Ask RunWield..."
                aria-label="Message"
            />
            {imageAttachments.length
                ? (
                    <ul
                        className="session-image-attachments rw-image-previews"
                        hidden={!expanded}
                        aria-label="Attached images"
                    >
                        {imageAttachments.map((image) => (
                            <li key={image.id}>
                                <img src={`data:${image.mimeType};base64,${image.base64}`} alt={image.name} />
                                <span>{image.name} · {image.mimeType}</span>
                                <button type="button" onClick={() => onRemoveImage?.(image.id)}>Remove</button>
                            </li>
                        ))}
                    </ul>
                )
                : null}
            <div className="session-composer-actions" aria-label="Session settings">
                {mascotVisible && (
                    <RunWieldMascot agentName={mascotAgent} parentAgentName={mascotParentAgent} pose={mascotActivity} />
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                        onFiles?.(Array.from(event.currentTarget.files || []));
                        event.currentTarget.value = "";
                    }}
                />
                <button
                    type="button"
                    className="rw-toolbar-button session-composer-icon-button session-attach-button"
                    aria-label="Attach image"
                    title="Attach image"
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <svg
                        className="rw-session-toolbar-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                    </svg>
                </button>
                <button
                    type="button"
                    className="session-composer-summary"
                    hidden={expanded}
                    aria-label={`${hasDraft ? "Continue draft" : "Write a message"} · ${selectionSummary}`}
                    title={selectionSummary}
                    disabled={disabled}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        expandComposer();
                    }}
                    onFocus={expandComposer}
                    onClick={expandComposer}
                >
                    <span>{selectionSummary}</span>
                </button>
                <select
                    hidden={!expanded}
                    aria-label="Agent"
                    className="rw-toolbar-select"
                    title={`Agent: ${agents.find((agent) => agent.name === agentValue)?.displayName || agentValue}`}
                    value={agentValue}
                    disabled={controlsDisabled || !agents.length}
                    onChange={(event) => onAgentChange(event.currentTarget.value)}
                >
                    {agentFallback}
                    {agents.map((agent) => (
                        <option key={agent.name} value={agent.name}>{agent.displayName || agent.name}</option>
                    ))}
                </select>
                <select
                    hidden={!expanded}
                    aria-label="Model"
                    className="rw-toolbar-select session-model-select"
                    title={`Provider/model: ${modelValue?.replace("\u001f", "/") || "Project default"}`}
                    value={modelValue}
                    disabled={controlsDisabled || !models.length}
                    onChange={(event) => onModelChange(event.currentTarget.value)}
                >
                    {modelFallback}
                    {models.map((model) => (
                        <option key={`${model.provider}/${model.id}`} value={`${model.provider}\u001f${model.id}`}>
                            {sessionModelLabel(model)}
                        </option>
                    ))}
                </select>
                <select
                    hidden={!expanded}
                    aria-label="Thinking"
                    className="rw-toolbar-select"
                    title={`Thinking: ${thinkingValue}`}
                    value={thinkingValue}
                    disabled={controlsDisabled || !thinkingLevels.length}
                    onChange={(event) => onThinkingChange(event.currentTarget.value)}
                >
                    {thinkingFallback}
                    {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
                {onQueue
                    ? (
                        <button
                            type="button"
                            className="rw-toolbar-button session-composer-icon-button session-queue-button"
                            hidden={!expanded}
                            aria-label="Queue"
                            title="Queue follow-up"
                            disabled={!canSend || submitting}
                            onClick={onQueue}
                        >
                            <svg
                                className="rw-session-toolbar-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                aria-hidden="true"
                            >
                                <path strokeLinecap="round" d="M4 6h16M4 12h9M4 18h9m5-5v8m-4-4h8" />
                            </svg>
                        </button>
                    )
                    : null}
                <button
                    type={showStop ? "button" : "submit"}
                    className="rw-toolbar-button session-composer-icon-button session-send-button"
                    disabled={!showStop && ((!canSend && !canReopenReview) || submitting)}
                    onClick={showStop ? onStop : undefined}
                    aria-label={primaryLabel}
                    title={primaryLabel}
                >
                    {showStop
                        ? (
                            <svg
                                className="rw-session-toolbar-icon"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                aria-hidden="true"
                            >
                                <rect x="6" y="6" width="12" height="12" rx="2" />
                            </svg>
                        )
                        : submitting
                        ? <RunWieldThinkingDots label="Sending" showLabel={false} />
                        : <PaperAirplaneIcon />}
                </button>
            </div>
        </form>
    );
}

/** @param {{ projectId: string, mode?: "list" | "detail" | "new", runwieldSessionId?: string, planId?: string, returnHref?: string }} props */
export function SessionSurface({ projectId, mode = "detail", runwieldSessionId = "", planId = "", returnHref = "" }) {
    const [listData, setListData] = useState(/** @type {any} */ (null));
    const [listPage, setListPage] = useState(0);
    const [listError, setListError] = useState("");
    const [loadingList, setLoadingList] = useState(mode === "list");
    const [timeline, setTimeline] = useState(/** @type {any} */ (null));
    const [timelineItems, setTimelineItems] = useState(/** @type {Array<Record<string, any>>} */ ([]));
    const [pendingUserMessages, setPendingUserMessages] = useState(/** @type {Array<Record<string, any>>} */ ([]));
    const [transientItems, setTransientItems] = useState(/** @type {Array<Record<string, any>>} */ ([]));
    const [workflowProgress, setWorkflowProgress] = useState(/** @type {any} */ (null));
    const [workflowProgressError, setWorkflowProgressError] = useState("");
    const [liveValidationProgress, setLiveValidationProgress] = useState(null);
    const [sessionSidebarTab, setSessionSidebarTab] = useState("session");
    const sidebarPlanRef = useRef("");
    const [contextCollapsed, setContextCollapsed] = useState(false);
    const [isNarrowScreen, setIsNarrowScreen] = useState(false);
    useEffect(() => {
        const narrowScreen = globalThis.matchMedia("(max-width: 900px)");
        function syncContextVisibility() {
            setIsNarrowScreen(narrowScreen.matches);
            let savedCollapsed = false;
            try {
                savedCollapsed = localStorage.getItem("runwield:owner:session-context-collapsed") === "true";
            } catch { /* Sidebar state is optional. */ }
            setContextCollapsed(narrowScreen.matches || savedCollapsed);
        }
        syncContextVisibility();
        narrowScreen.addEventListener("change", syncContextVisibility);
        return () => narrowScreen.removeEventListener("change", syncContextVisibility);
    }, []);
    function toggleContext() {
        animateSidebarUpdate(() => {
            setContextCollapsed((current) => {
                const collapsed = !current;
                try {
                    if (!globalThis.matchMedia("(max-width: 900px)").matches) {
                        localStorage.setItem("runwield:owner:session-context-collapsed", String(collapsed));
                    }
                } catch { /* Sidebar state is optional. */ }
                return collapsed;
            });
        });
    }
    const sidebarSessionRef = useRef("");
    const [detailError, setDetailError] = useState("");
    const [loadingDetail, setLoadingDetail] = useState(mode === "detail");
    const [draft, setDraft] = useState("");
    const [loadedDraftKey, setLoadedDraftKey] = useState("");
    const operationNavigationRef = useRef(false);
    const [imageAttachments, setImageAttachments] = useState(/** @type {SessionImageAttachmentDraft[]} */ ([]));
    const [queuedMessages, setQueuedMessages] = useState(/** @type {WorkspaceQueuedMessage[]} */ ([]));
    const [message, setMessage] = useState("");
    const [operation, setOperation] = useState(
        /** @type {{ operationId: string, status: string, observed: number, attempts: number, remote?: boolean } | null} */ (null),
    );
    const [steeringMessages, setSteeringMessages] = useState([]);
    const [pendingConfiguration, setPendingConfiguration] = useState(
        /** @type {Record<string, string> | null} */ (null),
    );
    const [liveThinkingLevel, setLiveThinkingLevel] = useState("");
    useEffect(() => setLiveThinkingLevel(""), [timeline?.snapshot?.activeAgent, timeline?.snapshot?.thinkingLevel]);
    const [sessionOptions, setSessionOptions] = useState(/** @type {any} */ (null));
    const [optionsError, setOptionsError] = useState("");
    const [projects, setProjects] = useState(null);
    const [projectsError, setProjectsError] = useState("");
    const [navigationPending, setNavigationPending] = useState(false);
    const navigationInFlight = useRef(false);
    const [requestUnresolved, setRequestUnresolved] = useState(false);
    const [creationAccepted, setCreationAccepted] = useState(false);
    const loadGeneration = useRef(0);
    const optionsGeneration = useRef(0);
    const surfaceCurrent = useRef(true);
    useEffect(() => {
        surfaceCurrent.current = true;
        return () => {
            surfaceCurrent.current = false;
            loadGeneration.current++;
            optionsGeneration.current++;
        };
    }, []);
    async function loadProjects() {
        const generation = ++loadGeneration.current;
        setProjects(null);
        setProjectsError("");
        try {
            const payload = await ownerFetch("/api/owner/projects");
            if (surfaceCurrent.current && generation === loadGeneration.current) {
                setProjects(Array.isArray(payload.projects) ? payload.projects : []);
            }
        } catch (error) {
            if (surfaceCurrent.current && generation === loadGeneration.current) setProjectsError(errorMessage(error));
        }
    }
    const [selectedAgent, setSelectedAgent] = useState("router");
    const [selectedModelKey, setSelectedModelKey] = useState("");
    const [selectedThinking, setSelectedThinking] = useState("default");
    const [modelExplicitlySelected, setModelExplicitlySelected] = useState(false);
    const [thinkingExplicitlySelected, setThinkingExplicitlySelected] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [attachingImages, setAttachingImages] = useState(false);
    const [loadingEarlier, setLoadingEarlier] = useState(false);
    const timelineLoadRef = useRef(0);
    const timelineRef = useRef(timeline);
    timelineRef.current = timeline;
    const sessionIdentityRef = useRef(runwieldSessionId);
    sessionIdentityRef.current = runwieldSessionId;
    const [interruptedOperation, setInterruptedOperation] = useState(false);
    const [operationStreamFailed, setOperationStreamFailed] = useState(false);
    const operationRef = useRef(operation);
    operationRef.current = operation;
    const notificationCursorRef = useRef(null);
    const notificationOperationKeyRef = useRef(null);
    const queuedDispatchActiveRef = useRef(false);
    const queuedSessionRef = useRef(runwieldSessionId);
    const timelineEndRef = useRef(/** @type {HTMLDivElement | null} */ (null));
    const timelineScrollRef = useRef(/** @type {HTMLDivElement | null} */ (null));
    const historyViewportRef = useRef(null);
    const followingLiveEdgeRef = useRef(true);
    const didPinInitialTimelineRef = useRef(false);
    const [, setFollowingLiveEdge] = useState(true);
    const [latestActivityAvailable, setLatestActivityAvailable] = useState(false);
    const [newSessionStorageId] = useState(() => mode === "new" ? getNewSessionDraftInstanceId(projectId) : "");
    const sessionStorageId = runwieldSessionId || newSessionStorageId;

    const draftKey = sessionStorageId ? sessionDraftKey(projectId, sessionStorageId) : "";
    const requestKey = sessionStorageId ? sessionRequestKey(projectId, sessionStorageId) : "";
    const attachmentsKey = sessionStorageId ? sessionAttachmentsKey(projectId, sessionStorageId) : "";

    const notificationScopeKey = `${projectId}:${runwieldSessionId || sessionStorageId}`;

    useEffect(() => {
        return () => {
            disposeOperationBrowserNotifications();
            notificationCursorRef.current = null;
            notificationOperationKeyRef.current = null;
        };
    }, [notificationScopeKey]);

    useEffect(() => {
        syncOperationBrowserNotificationLifecycle({
            operationId: operation?.operationId,
            scopeKey: notificationScopeKey,
            operationKeyRef: notificationOperationKeyRef,
            cursorRef: notificationCursorRef,
        });
    }, [notificationScopeKey, operation?.operationId]);

    const listGeneration = useRef(0);
    async function loadList(requestedPage = listPage) {
        const generation = ++listGeneration.current;
        setLoadingList(true);
        setListError("");
        try {
            const query = new URLSearchParams({ page: String(requestedPage), pageSize: String(SESSION_PAGE_SIZE) });
            if (planId) query.set("plan", planId);
            const payload = await ownerFetch(
                `/api/owner/projects/${encodeURIComponent(projectId)}/sessions?${query}`,
                { method: "GET" },
            );
            if (generation === listGeneration.current) {
                setListData(payload);
                if (!payload.sessions?.length && requestedPage > 0) setListPage(requestedPage - 1);
            }
        } catch (error) {
            if (generation === listGeneration.current) setListError(errorMessage(error));
        } finally {
            if (generation === listGeneration.current) setLoadingList(false);
        }
    }

    async function loadSessionOptions() {
        const generation = ++optionsGeneration.current;
        setSessionOptions(null);
        setOptionsError("");
        try {
            const payload = await ownerFetch(
                `/api/owner/projects/${encodeURIComponent(projectId)}/session-options`,
                { method: "GET" },
            );
            if (!surfaceCurrent.current || generation !== optionsGeneration.current) return;
            setSessionOptions(payload);
            const defaults = asRecord(payload.defaults);
            const defaultProvider = typeof defaults.provider === "string" ? defaults.provider : "";
            const defaultModel = typeof defaults.model === "string" ? defaults.model : "";
            setSelectedAgent(
                typeof defaults.agentName === "string" && defaults.agentName ? defaults.agentName : "router",
            );
            setSelectedModelKey(defaultModel ? `${defaultProvider}\u001f${defaultModel}` : "");
            setSelectedThinking(
                typeof defaults.thinkingLevel === "string" && defaults.thinkingLevel
                    ? defaults.thinkingLevel
                    : "default",
            );
            setModelExplicitlySelected(false);
            setThinkingExplicitlySelected(false);
        } catch (error) {
            if (surfaceCurrent.current && generation === optionsGeneration.current) {
                setOptionsError(errorMessage(error));
            }
        }
    }

    function selectNewAgent(agentName) {
        const agent = sessionOptions?.agents?.find((item) => item.name === agentName);
        if (!agent) return false;
        const defaults = sessionAgentSelection(agent);
        setSelectedAgent(agentName);
        setSelectedModelKey(defaults.model ? `${defaults.provider}\u001f${defaults.model}` : "");
        setSelectedThinking(defaults.thinkingLevel);
        setModelExplicitlySelected(false);
        setThinkingExplicitlySelected(false);
        return true;
    }

    function selectNewModel(modelKey) {
        setSelectedModelKey(modelKey);
        setModelExplicitlySelected(Boolean(modelKey));
    }

    function selectNewThinking(thinkingLevel) {
        setSelectedThinking(thinkingLevel);
        setThinkingExplicitlySelected(thinkingLevel !== "default");
    }

    const pendingPicker = useRef(null);
    useEffect(() => {
        const pending = pendingPicker.current;
        if (pending && !draft.startsWith(`/${pending.name}`)) {
            pendingPicker.current = null;
            pending.finish("canceled");
        }
    }, [draft]);

    function cancelCommandPicker() {
        const pending = pendingPicker.current;
        pendingPicker.current = null;
        pending?.finish("canceled");
    }

    function openCommandPicker(name, alias) {
        if (pendingPicker.current?.name === name) return;
        if (pendingPicker.current) pendingPicker.current.finish("canceled");
        pendingPicker.current = { name, finish: beginClientCommandMetric(name, "opened", alias) };
    }

    function finishCommandPicker(name, succeeded, selected = true) {
        const pending = pendingPicker.current;
        pendingPicker.current = null;
        if (pending?.name !== name) {
            if (!selected) beginClientCommandMetric(name)("rejected");
            return;
        }
        if (selected) pending.finish.dispatch();
        pending.finish(succeeded ? "succeeded" : selected ? "failed" : "rejected");
    }

    function beginClientCommandMetric(commandName, startPhase = "start", alias) {
        const invocationId = `cmd_${crypto.randomUUID()}`;
        const startedAt = Date.now();
        let dispatched = false;
        const post = (phase, outcome) => {
            if (!projectId) return;
            void ownerFetch(`/api/owner/projects/${encodeURIComponent(projectId)}/command-metrics`, {
                method: "POST",
                body: JSON.stringify({
                    invocationId,
                    command: commandName,
                    alias,
                    kind: "builtin",
                    sessionId: runwieldSessionId || undefined,
                    phase,
                    ...(phase === "finish"
                        ? { outcome, dispatched, durationMs: Math.max(0, Date.now() - startedAt) }
                        : {}),
                }),
            }).catch(() => {});
        };
        post(startPhase);
        const finish = (outcome = "succeeded") => post("finish", outcome);
        finish.dispatch = () => {
            if (dispatched) return;
            dispatched = true;
            post("dispatched");
        };
        return finish;
    }

    function handleComposerCommand(text) {
        const [rawName, ...args] = text.trim().slice(1).split(/\s+/);
        const name = rawName === "models" ? "model" : rawName === "agents" ? "agent" : rawName;
        const command = sessionOptions?.commands?.find((item) => item.name === name);
        if (command?.kind === "prompt") return false;
        if (!command) {
            beginClientCommandMetric(name)("rejected");
            setMessage(`Unknown command: /${name}. Type / to see available commands.`);
            return true;
        }
        const argument = args.join(" ");
        if (name === "plan-review") {
            if (argument || mode === "new") {
                beginClientCommandMetric("plan-review")("rejected");
                setMessage(mode === "new" ? "Open a Session before reviewing a Plan." : "Usage: /plan-review");
                return true;
            }
            const finish = beginClientCommandMetric("plan-review");
            setDraft("");
            finish.dispatch();
            void openPlanReview().then((opened) => finish(opened ? "succeeded" : "failed"));
            return true;
        }
        if (["agent", "model"].includes(name)) {
            if (!argument) {
                openCommandPicker(name, rawName === name ? undefined : rawName);
                setDraft(`/${name} `);
                return true;
            }
            const agent = sessionOptions.agents.find((item) => item.name === argument || item.displayName === argument);
            const model = sessionOptions.models.find((item) => sessionModelLabel(item) === argument);
            if ((name === "agent" && !agent) || (name === "model" && !model)) {
                finishCommandPicker(name, false, false);
                setMessage(`No matching ${name}. Choose an available option from the command picker.`);
                return true;
            }
            const finish = pendingPicker.current?.name === name
                ? pendingPicker.current.finish
                : beginClientCommandMetric(name, "start", rawName === name ? undefined : rawName);
            pendingPicker.current = null;
            finish.dispatch();
            if (mode === "new") {
                if (name === "agent") selectNewAgent(agent.name);
                if (name === "model") selectNewModel(`${model.provider}\u001f${model.id}`);
                setDraft("");
                finish();
            } else {
                const change = name === "agent"
                    ? { agentName: agent.name }
                    : { provider: model.provider, model: model.id };
                void configureSession(change).then((applied) => {
                    if (applied) setDraft("");
                    finish(applied ? "succeeded" : "failed");
                }).catch(() => finish("failed"));
            }
            return true;
        }
        const finish = beginClientCommandMetric(name);
        finish.dispatch();
        const projectPath = `/projects/${encodeURIComponent(projectId)}`;
        const destination = {
            new: `${projectPath}/sessions/new`,
            resume: `${projectPath}/sessions`,
            settings: `${projectPath}/settings`,
            plans: `${projectPath}/plans`,
        }[name];
        if (destination) {
            setDraft("");
            void saveSessionDraft(draftKey, null).then(() => {
                finish();
                workspaceNavigate(destination);
            }).catch(() => finish("failed"));
        } else if (name === "help") {
            setDraft("/");
            finish();
        } else {
            setContextCollapsed(false);
            setSessionSidebarTab("session");
            setDraft("");
            finish();
        }
        return true;
    }

    async function openPlanReview() {
        setMessage("Opening Plan review…");
        const sessionId = runwieldSessionId;
        try {
            // A live review can make the committed timeline unavailable while its
            // writer is active. The live Session still exposes that generation.
            const generation = Number.isInteger(timelineRef.current?.generation)
                ? timelineRef.current.generation
                : (await ownerFetch(
                    `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
                        encodeURIComponent(sessionId)
                    }/live`,
                )).generation;
            if (!Number.isInteger(generation)) {
                setMessage("Wait for this Session to become available.");
                return false;
            }
            const message = await requestWorkspacePlanReview(
                projectId,
                sessionId,
                generation,
                () => sessionIdentityRef.current === sessionId,
            );
            if (message && sessionIdentityRef.current === sessionId) setMessage(message);
            return !message;
        } catch (error) {
            if (sessionIdentityRef.current === sessionId) setMessage(errorMessage(error));
            return false;
        }
    }

    async function fetchTimeline(beforeEventId = "") {
        const existing = timelineRef.current;
        const qs = new URLSearchParams({ limit: String(TIMELINE_PAGE_LIMIT) });
        if (beforeEventId) qs.set("beforeEventId", beforeEventId);
        else if (existing?.nextCursor) qs.set("cursorEventId", existing.nextCursor);
        else qs.set("latest", "true");
        const url = `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
            encodeURIComponent(runwieldSessionId)
        }/timeline`;
        let payload = await ownerFetch(`${url}?${qs}`, { method: "GET" });
        if (beforeEventId || !existing?.nextCursor) return payload;
        const events = [...(payload.cursorReset ? [] : existing.events), ...payload.events];
        // Only catch up new events. Older history is loaded explicitly by the reader.
        while (payload.complete === false) {
            if (!payload.nextCursor || payload.nextCursor === qs.get("cursorEventId")) break;
            qs.set("cursorEventId", payload.nextCursor);
            payload = await ownerFetch(`${url}?${qs}`, { method: "GET" });
            events.push(...payload.events);
        }
        return { ...payload, events, previousCursor: existing.previousCursor };
    }

    function applyTimeline(nextTimeline) {
        const events = Array.isArray(nextTimeline.events)
            ? [...new Map(nextTimeline.events.map((event) => [event.eventId, event])).values()]
            : [];
        const merged = { ...nextTimeline, events };
        timelineRef.current = merged;
        setTimeline(merged);
        if (typeof merged.snapshot?.name === "string") {
            document.dispatchEvent(
                new CustomEvent("runwield:session-named", {
                    detail: { projectId, runwieldSessionId, name: merged.snapshot.name },
                }),
            );
        }
        setTimelineItems(reduceSessionEvents(events, { source: "committed" }));
        setPendingUserMessages((messages) => {
            const committedUserText = new Set(
                events.filter((event) => event.type === "user_message").map((event) => event.text),
            );
            return messages.filter((item) => !committedUserText.has(item.text));
        });
        if (nextTimeline.state !== "active" && !operationRef.current) {
            setTransientItems([]);
            setPendingConfiguration(null);
            setSteeringMessages([]);
            setLiveThinkingLevel("");
        }
    }

    async function loadTimeline() {
        if (!runwieldSessionId) return null;
        const identity = runwieldSessionId;
        const loadId = ++timelineLoadRef.current;
        try {
            const nextTimeline = await fetchTimeline();
            if (sessionIdentityRef.current !== identity || loadId !== timelineLoadRef.current) return null;
            applyTimeline(nextTimeline);
            setDetailError("");
            return nextTimeline;
        } catch (error) {
            if (sessionIdentityRef.current === identity) setDetailError(errorMessage(error));
            return null;
        } finally {
            if (sessionIdentityRef.current === identity) setLoadingDetail(false);
        }
    }

    async function loadEarlierMessages() {
        const cursor = timelineRef.current?.previousCursor;
        if (!cursor || loadingEarlier) return;
        setLoadingEarlier(true);
        const identity = runwieldSessionId;
        const scroller = timelineScrollRef.current;
        const height = scroller?.scrollHeight || 0;
        try {
            const earlier = await fetchTimeline(cursor);
            if (sessionIdentityRef.current !== identity) return;
            const current = timelineRef.current;
            applyTimeline({
                ...current,
                events: [...earlier.events, ...current.events],
                previousCursor: earlier.previousCursor,
            });
            followingLiveEdgeRef.current = false;
            requestAnimationFrame(() => {
                if (scroller) scroller.scrollTop += scroller.scrollHeight - height;
            });
        } catch (error) {
            setMessage(errorMessage(error));
        } finally {
            setLoadingEarlier(false);
        }
    }

    useEffect(() => {
        if (queuedSessionRef.current === runwieldSessionId) return;
        queuedSessionRef.current = runwieldSessionId;
        setQueuedMessages([]);
    }, [runwieldSessionId]);

    useEffect(() => {
        didPinInitialTimelineRef.current = false;
        followingLiveEdgeRef.current = true;
        setFollowingLiveEdge(true);
        setLatestActivityAvailable(false);
        if (mode === "list") loadList(listPage);
        if (mode === "detail") {
            timelineRef.current = null;
            setTimeline(null);
            setLoadingDetail(true);
            loadTimeline();
            loadSessionOptions();
        }
        if (mode === "new") {
            setTimeline(null);
            setTimelineItems([]);
            setPendingUserMessages([]);
            setTransientItems([]);
            setDetailError("");
            setLoadingDetail(false);
            loadSessionOptions();
            loadProjects();
        }
        return () => {
            optionsGeneration.current++;
            loadGeneration.current++;
        };
    }, [mode, projectId, runwieldSessionId, listPage, planId]);

    useEffect(() => {
        if (!draftKey) return;
        let cancelled = false;
        setLoadedDraftKey("");
        void loadSessionDrafts([draftKey, attachmentsKey, requestKey]).then(() => {
            if (cancelled) return;
            const storedDraft = readSessionDraft(draftKey) || "";
            setDraft(storedDraft);
            const storedAttachments = readStored(attachmentsKey);
            setImageAttachments(Array.isArray(storedAttachments) ? storedAttachments : []);
            setOperation(null);
            const storedRequest = asRecord(readStored(requestKey));
            setRequestUnresolved(
                storedRequest.status === "network-error" || storedRequest.status === "pending" ||
                    Boolean(storedRequest.operationId),
            );
            setCreationAccepted(Boolean(storedRequest.responseAccepted));
            if (storedRequest.operationId) {
                setOperation({
                    operationId: String(storedRequest.operationId),
                    status: "running",
                    observed: 0,
                    attempts: 0,
                    restored: true,
                });
                setMessage(
                    "Reconnected.",
                );
            } else if (storedRequest.requestId && storedRequest.status === "network-error") {
                setMessage("The connection was interrupted. Send again to retry your message.");
            }
            setLoadedDraftKey(draftKey);
        });
        return () => {
            cancelled = true;
        };
    }, [draftKey, requestKey, attachmentsKey]);

    useEffect(() => {
        if (!draftKey || loadedDraftKey !== draftKey) return;
        if (draft) saveSessionDraft(draftKey, draft);
        else saveSessionDraft(draftKey, null);
    }, [draft, draftKey, loadedDraftKey]);

    useEffect(() => {
        if (!attachmentsKey || loadedDraftKey !== draftKey) return;
        void saveSessionDraft(attachmentsKey, imageAttachments.length ? JSON.stringify(imageAttachments) : null)
            .then((saved) => {
                if (!saved && imageAttachments.length) {
                    setMessage("Image kept in this tab. Browser storage is unavailable; send before closing it.");
                }
            });
    }, [attachmentsKey, imageAttachments, draftKey, loadedDraftKey]);

    const availability = useMemo(() =>
        deriveSessionAvailability({
            state: timeline?.state,
            activeSurface: timeline?.activeSurface,
            bootstrapRequired: timeline?.bootstrapRequired,
            generation: timeline?.generation,
            snapshot: timeline?.snapshot,
            timelineComplete: timeline?.complete !== false,
            truncated: timeline?.truncated,
            localOperationActive: Boolean(operation && !["completed", "failed", "unknown"].includes(operation.status)),
        }), [listData, timeline, operation]);

    useEffect(() => {
        if (!timeline || !runwieldSessionId) return;
        const planId = activePlanId(timeline.snapshot);
        if (sidebarSessionRef.current !== runwieldSessionId) {
            sidebarSessionRef.current = runwieldSessionId;
            setSessionSidebarTab(defaultSessionSidebarTab(Boolean(planId)));
        } else if (planId && planId !== sidebarPlanRef.current) {
            setSessionSidebarTab("workflow");
        }
        sidebarPlanRef.current = planId;
    }, [timeline, runwieldSessionId]);

    async function createSession() {
        const text = draft;
        if (
            (!text.trim() && !imageAttachments.length) || submitting || attachingImages || navigationPending ||
            !sessionOptions || !projects?.some((project) => project.projectId === projectId && project.enabled) ||
            loadedDraftKey !== draftKey
        ) return;
        scrollToLiveEdge();
        setSubmitting(true);
        setRequestUnresolved(true);
        setMessage("");
        const [selectedProvider, selectedModel] = selectedModelKey ? selectedModelKey.split("\u001f") : ["", ""];
        const existing = asRecord(readStored(requestKey));
        const envelope = existing.requestId && existing.status === "network-error" ? existing : {
            requestId: crypto.randomUUID(),
            text,
            images: imageAttachments.map(serializeSessionImageForRequest),
            agentName: selectedAgent,
            model: modelExplicitlySelected ? selectedModel || "" : "",
            provider: modelExplicitlySelected ? selectedProvider || "" : "",
            thinkingLevel: thinkingExplicitlySelected ? selectedThinking : "default",
            status: "pending",
            createdAt: new Date().toISOString(),
        };
        await saveSessionDraft(requestKey, JSON.stringify(envelope));
        setPendingUserMessages([{
            kind: "message",
            role: "user",
            key: `pending-user:${envelope.requestId}`,
            text: envelope.text,
            images: envelope.images,
            source: "transient",
        }]);
        try {
            const payload = await ownerFetch(`/api/owner/projects/${encodeURIComponent(projectId)}/sessions`, {
                method: "POST",
                body: JSON.stringify({
                    requestId: envelope.requestId,
                    text: envelope.text,
                    images: envelope.images || [],
                    agentName: envelope.agentName,
                    model: envelope.model,
                    provider: envelope.provider,
                    thinkingLevel: envelope.thinkingLevel,
                }),
            });
            if (!surfaceCurrent.current) return;
            setCreationAccepted(true);
            setDraft("");
            setImageAttachments([]);
            const stored = {
                ...envelope,
                status: payload.status || "running",
                operationId: payload.operationId,
                responseAccepted: true,
            };
            await saveSessionDraft(requestKey, JSON.stringify(stored));
            if (!surfaceCurrent.current) return;
            if (payload.runwieldSessionId) {
                await saveSessionDraft(sessionRequestKey(projectId, payload.runwieldSessionId), JSON.stringify(stored));
                await saveSessionDraft(requestKey, null);
                if (!surfaceCurrent.current) return;
                workspaceNavigate(
                    `/projects/${encodeURIComponent(projectId)}/sessions/${
                        encodeURIComponent(payload.runwieldSessionId)
                    }`,
                    "replace",
                );
                return;
            }
            if (payload.operationId) {
                setOperation({
                    operationId: payload.operationId,
                    status: payload.status || "running",
                    observed: 0,
                    attempts: 0,
                });
                setMessage("");
            }
        } catch (error) {
            if (!surfaceCurrent.current) return;
            setPendingUserMessages([]);
            const errorRecord = asRecord(error);
            const status = Number(errorRecord.status || 0);
            await saveSessionDraft(
                requestKey,
                JSON.stringify({
                    ...envelope,
                    status: status === 422 ? "validation-error" : "network-error",
                }),
            );
            setRequestUnresolved(status !== 422);
            setMessage(errorMessage(error));
        } finally {
            if (surfaceCurrent.current) setSubmitting(false);
        }
    }

    async function handleComposerFiles(files) {
        if (!files.length || attachingImages) return;
        setAttachingImages(true);
        try {
            const images = await Promise.all(files.map(readPastedImage));
            const size = [...imageAttachments, ...images].reduce((total, image) => total + image.base64.length, 0);
            if (size > 10 * 1024 * 1024) {
                throw new Error(
                    "These images are too large to send together. Remove an image or choose smaller files.",
                );
            }
            setImageAttachments((current) => [...current, ...images]);
            setMessage(`${files.length} image${files.length === 1 ? "" : "s"} attached.`);
        } catch (error) {
            setMessage(errorMessage(error));
        } finally {
            setAttachingImages(false);
        }
    }

    async function handleComposerPaste(event) {
        const files = new Map();
        for (const file of Array.from(event.clipboardData?.files || [])) {
            if (file.type.startsWith("image/")) files.set(`${file.name}:${file.size}`, file);
        }
        for (const item of Array.from(event.clipboardData?.items || [])) {
            if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
            const file = item.getAsFile();
            if (file) files.set(`${file.name}:${file.size}`, file);
        }
        if (!files.size) return;
        event.preventDefault();
        const pastedText = event.clipboardData.getData("text/plain");
        if (pastedText) {
            const input = event.currentTarget;
            setDraft(draft.slice(0, input.selectionStart) + pastedText + draft.slice(input.selectionEnd));
        }
        await handleComposerFiles([...files.values()]);
    }

    /** @param {string} id */
    function removeImageAttachment(id) {
        setImageAttachments((current) => current.filter((image) => image.id !== id));
    }

    async function configureSession(change) {
        if (!Number.isInteger(timeline?.generation)) return false;
        setMessage("");
        try {
            const result = await ownerFetch(
                `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
                    encodeURIComponent(runwieldSessionId)
                }/configure`,
                {
                    method: "POST",
                    body: JSON.stringify({ expectedGeneration: timeline.generation, ...change }),
                },
            );
            setPendingConfiguration(result.pendingConfiguration || null);
            if (change.agentName) setLiveThinkingLevel("");
            if (change.thinkingLevel) setLiveThinkingLevel(String(change.thinkingLevel));
            setMessage(result.status === "staged" ? "Applies after this response." : "Session settings updated.");
            const currentOperation = operationRef.current;
            if (result.status !== "staged" && !currentOperation?.operationId) await loadTimeline();
            return true;
        } catch (error) {
            setMessage(errorMessage(error));
            return false;
        }
    }

    async function cancelOperation() {
        if (!operation?.operationId) return;
        setMessage("");
        try {
            await ownerFetch(`/api/owner/session-operations/${encodeURIComponent(operation.operationId)}/cancel`, {
                method: "POST",
                body: JSON.stringify({}),
            });
            setMessage("Stop requested.");
        } catch (error) {
            setMessage(errorMessage(error));
        }
    }

    /** @param {Record<string, any>} envelope @param {Record<string, any>} payload */
    function acceptContinuation(envelope, payload) {
        setPendingUserMessages((messages) => [
            ...messages,
            {
                kind: "message",
                role: "user",
                key: `pending-user:${envelope.requestId}`,
                text: envelope.text,
                images: envelope.images,
                timestamp: envelope.createdAt,
                source: "transient",
            },
        ]);
        const stored = {
            ...envelope,
            status: payload.status || "running",
            operationId: payload.operationId,
            responseAccepted: true,
        };
        saveSessionDraft(requestKey, JSON.stringify(stored));
        setOperationStreamFailed(false);
        setOperation({
            operationId: payload.operationId,
            status: payload.status || "running",
            observed: 0,
            attempts: 0,
        });
        setMessage("");
    }

    /** @param {Record<string, any>} envelope */
    async function postContinuation(envelope) {
        return await ownerFetch(
            `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
                encodeURIComponent(runwieldSessionId)
            }/continue`,
            {
                method: "POST",
                body: JSON.stringify({
                    requestId: envelope.requestId,
                    expectedGeneration: envelope.expectedGeneration,
                    text: envelope.text,
                    images: Array.isArray(envelope.images) ? envelope.images : [],
                }),
            },
        );
    }

    /** @param {Record<string, any>} envelope */
    function queueContinuation(envelope) {
        setQueuedMessages((current) => [
            ...current,
            {
                id: String(envelope.requestId),
                text: String(envelope.text || ""),
                images: Array.isArray(envelope.images) ? envelope.images : [],
                queuedAt: String(envelope.createdAt || new Date().toISOString()),
            },
        ]);
        saveSessionDraft(requestKey, null);
        setDraft("");
        setImageAttachments([]);
        setMessage("Message queued in this browser tab. It will send when this Session becomes available.");
    }

    async function sendRequest(queueOnly = false) {
        const text = draft;
        const canSubmit = availability.canContinue || ["active", "workspace-running"].includes(availability.key);
        if (
            (!text.trim() && imageAttachments.length === 0) || !canSubmit || submitting || attachingImages ||
            loadedDraftKey !== draftKey || !timeline
        ) {
            return;
        }
        if (!queueOnly) scrollToLiveEdge();
        setSubmitting(true);
        setMessage("");
        const freshTimeline = timelineRef.current;
        if (!freshTimeline) {
            setSubmitting(false);
            setMessage("Could not refresh the Session state before sending. Try again.");
            return;
        }
        const existing = asRecord(readStored(requestKey));
        const envelope = existing.requestId && existing.status === "network-error" ? existing : {
            requestId: crypto.randomUUID(),
            expectedGeneration: freshTimeline.generation,
            text,
            images: imageAttachments.map(serializeSessionImageForRequest),
            status: "pending",
            createdAt: new Date().toISOString(),
        };
        if (freshTimeline.state === "active" || operationRef.current) {
            try {
                if (!queueOnly && operationRef.current) {
                    const result = await ownerFetch(
                        `/api/owner/projects/${encodeURIComponent(projectId)}/session-operations/${
                            encodeURIComponent(operationRef.current.operationId)
                        }/steer`,
                        {
                            method: "POST",
                            body: JSON.stringify({
                                requestId: envelope.requestId,
                                text: envelope.text,
                                images: envelope.images,
                            }),
                        },
                    );
                    if (result.ok && result.queued) {
                        setDraft("");
                        setImageAttachments([]);
                        setMessage("");
                        return;
                    }
                }
                queueContinuation(envelope);
            } catch (error) {
                setMessage(errorMessage(error));
            } finally {
                setSubmitting(false);
            }
            return;
        }
        await saveSessionDraft(requestKey, JSON.stringify(envelope));
        try {
            const payload = await postContinuation(envelope);
            setDraft("");
            setImageAttachments([]);
            acceptContinuation(envelope, payload);
        } catch (error) {
            const errorRecord = asRecord(error);
            const status = Number(errorRecord.status || 0);
            if (status === 409) {
                await loadTimeline();
                queueContinuation(envelope);
                return;
            }
            const nextStatus = status === 503 ? "unavailable" : (status === 422 ? "validation-error" : "network-error");
            await saveSessionDraft(requestKey, JSON.stringify({ ...envelope, status: nextStatus }));
            if (status === 503) await loadTimeline();
            setMessage(errorMessage(error));
        } finally {
            setSubmitting(false);
        }
    }

    async function applyOperationSnapshot(current, payload) {
        const existingTimeline = timelineRef.current;
        if (existingTimeline && payload.sessionInfo) {
            const nextTimeline = mergeLiveSessionInfo(existingTimeline, payload.sessionInfo);
            timelineRef.current = nextTimeline;
            setTimeline(nextTimeline);
        }
        const events = Array.isArray(payload.events) ? payload.events : [];
        const validationEvent = events.findLast((event) => event.validationProgress);
        setLiveValidationProgress(
            validationEvent ? { ...validationEvent.validationProgress, message: validationEvent.message } : null,
        );
        let items = reduceOperationTransientItems(events);
        if (payload.liveInteraction?.interactionId) {
            items = items.filter((item) => item.kind !== "busy");
            const request = payload.liveInteraction.request || {};
            const isPlanReview = request.type === "plan_review";
            const isCodeReview = request.type === "code_review";
            items = [...items, {
                kind: isPlanReview ? "plan-review" : isCodeReview ? "code-review" : "interaction",
                key: `interaction:${payload.liveInteraction.interactionId}`,
                interactionId: payload.liveInteraction.interactionId,
                operationId: current.operationId,
                request,
                reviewUrl: request.reviewUrl,
                source: "transient",
            }];
        }
        setTransientItems(items);
        const next = {
            operationId: current.operationId,
            remote: payload.remote === true,
            status: payload.status || "unknown",
            observed: events.length,
            attempts: current.attempts + 1,
        };
        setOperation(next);
        setPendingConfiguration(payload.pendingConfiguration || null);
        setSteeringMessages((payload.queuedMessages || []).filter((item) => item.delivery === "steer"));
        if (payload.runwieldSessionId && (mode === "new" || payload.runwieldSessionId !== runwieldSessionId)) {
            if (operationNavigationRef.current) return;
            operationNavigationRef.current = true;
            await saveSessionDraft(
                sessionRequestKey(projectId, payload.runwieldSessionId),
                JSON.stringify({ ...asRecord(readStored(requestKey)), operationId: current.operationId }),
            );
            await saveSessionDraft(requestKey, null);
            workspaceNavigate(
                `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(payload.runwieldSessionId)}`,
                "replace",
            );
            return;
        }
        if (!["completed", "failed", "unknown"].includes(next.status)) return;
        if (next.status === "failed") {
            const failedRequest = asRecord(readStored(requestKey));
            if (typeof failedRequest.text === "string") {
                setDraft(failedRequest.text);
                const images = Array.isArray(failedRequest.images) ? failedRequest.images : [];
                const attachments = images.map((image, index) => ({
                    ...image,
                    id: crypto.randomUUID(),
                    name: `Image ${index + 1}`,
                }));
                setImageAttachments(attachments);
                await saveSessionDraft(draftKey, failedRequest.text);
                await saveSessionDraft(attachmentsKey, JSON.stringify(attachments));
            }
            await saveSessionDraft(requestKey, null);
        }
        if (next.status === "completed") {
            await saveSessionDraft(requestKey, null);
            setMessage("");
        } else {
            if (next.status === "unknown") setInterruptedOperation(true);
            setMessage(
                next.status === "unknown"
                    ? "The agent was interrupted. Ask it to continue."
                    : payload.error || "The response failed. Your conversation is saved.",
            );
        }
        setPendingConfiguration(null);
        setOperationStreamFailed(false);
        setOperation(null);
        setTransientItems([]);
        operationRef.current = null;
        document.dispatchEvent(new CustomEvent("runwield:session-updated"));
        await loadTimeline();
    }

    useEffect(() => {
        if (!operation?.operationId) return undefined;
        let cancelled = false;
        let receivedTerminal = false;
        const observeSnapshot = async (current, payload) => {
            if (
                !shouldApplyOperationPoll({
                    cancelled,
                    currentOperationId: operationRef.current?.operationId,
                    polledOperationId: current.operationId,
                })
            ) return;
            observeOperationBrowserNotifications(
                { ...current, scopeKey: notificationScopeKey },
                payload,
                notificationCursorRef,
            );
            await applyOperationSnapshot(current, payload);
        };
        if (typeof EventSource !== "undefined" && !operationStreamFailed && !operation.remote) {
            const source = new EventSource(
                `/api/owner/session-operations/${encodeURIComponent(operation.operationId)}/stream`,
            );
            source.onmessage = (event) => {
                const current = operationRef.current;
                if (!current || cancelled) return;
                try {
                    const payload = JSON.parse(event.data);
                    if (["completed", "failed", "unknown"].includes(payload.status)) {
                        receivedTerminal = true;
                        source.close();
                    }
                    void observeSnapshot(current, payload).catch((error) => setMessage(errorMessage(error)));
                } catch (error) {
                    setMessage(`Observation interrupted: ${errorMessage(error)}.`);
                }
            };
            source.onerror = () => {
                if (cancelled || receivedTerminal) return;
                setMessage("");
                setOperationStreamFailed(true);
                source.close();
            };
            return () => {
                cancelled = true;
                source.close();
            };
        }
        let pending = false;
        const controller = new AbortController();
        const tick = async () => {
            const current = operationRef.current;
            if (!current || cancelled || pending) return;
            pending = true;
            try {
                const payload = await ownerFetch(
                    `/api/owner/session-operations/${encodeURIComponent(current.operationId)}`,
                    { method: "GET", signal: controller.signal },
                );
                await observeSnapshot(current, payload);
            } catch (error) {
                if (!cancelled && !controller.signal.aborted) {
                    setMessage(
                        `Observation interrupted: ${errorMessage(error)}. The server-owned operation was not canceled.`,
                    );
                }
            } finally {
                pending = false;
            }
        };
        const id = setInterval(tick, POLL_INTERVAL_MS);
        void tick();
        return () => {
            cancelled = true;
            clearInterval(id);
            controller.abort();
        };
    }, [
        operation?.operationId,
        operation?.remote,
        operationStreamFailed,
        requestKey,
        mode,
        projectId,
        notificationScopeKey,
    ]);

    useEffect(() => {
        if (
            loadedDraftKey !== draftKey || !shouldRefreshSessionAvailability({
                mode,
                state: timeline?.state,
                localOperationActive: Boolean(operation?.operationId),
                queuedMessageCount: queuedMessages.length,
            })
        ) return undefined;
        let cancelled = false;
        let refreshing = false;
        const refresh = async () => {
            if (refreshing || cancelled) return;
            refreshing = true;
            try {
                const live = await ownerFetch(
                    `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
                        encodeURIComponent(runwieldSessionId)
                    }/live`,
                );
                if (cancelled) return;
                if (live.generation !== timelineRef.current?.generation || live.state !== timelineRef.current?.state) {
                    await loadTimeline();
                }
                if (live.operation && !operationRef.current && !cancelled) {
                    document.dispatchEvent(new CustomEvent("runwield:session-updated"));
                    const current = { operationId: live.operation.operationId, attempts: 0 };
                    await applyOperationSnapshot(current, live.operation);
                }
            } catch (error) {
                if (!cancelled) setMessage(errorMessage(error));
            } finally {
                refreshing = false;
            }
        };
        const refreshWhenVisible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        globalThis.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refreshWhenVisible);
        const id = setInterval(refresh, POLL_INTERVAL_MS);
        void refresh();
        return () => {
            cancelled = true;
            globalThis.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refreshWhenVisible);
            clearInterval(id);
        };
    }, [
        mode,
        timeline?.state,
        queuedMessages.length,
        operation?.operationId,
        projectId,
        runwieldSessionId,
        loadedDraftKey,
        draftKey,
    ]);

    useEffect(() => {
        if (
            mode !== "detail" || timeline?.state !== "idle" || operation?.operationId || queuedMessages.length === 0
        ) return undefined;
        let cancelled = false;
        const sendOldestQueuedMessage = async () => {
            if (cancelled || queuedDispatchActiveRef.current) return;
            const queued = queuedMessages[0];
            if (!queued) return;
            queuedDispatchActiveRef.current = true;
            setSubmitting(true);
            try {
                const freshTimeline = await loadTimeline();
                if (
                    cancelled || !freshTimeline || freshTimeline.state !== "idle"
                ) return;
                const envelope = {
                    requestId: queued.id,
                    expectedGeneration: freshTimeline.generation,
                    text: queued.text,
                    images: queued.images,
                    status: "pending",
                    createdAt: queued.queuedAt,
                };
                saveSessionDraft(requestKey, JSON.stringify(envelope));
                try {
                    const payload = await postContinuation(envelope);
                    if (cancelled) return;
                    setQueuedMessages((current) => current.filter((item) => item.id !== queued.id));
                    acceptContinuation(envelope, payload);
                } catch (error) {
                    saveSessionDraft(requestKey, null);
                    const status = Number(asRecord(error).status || 0);
                    if (status === 409 || status === 503) await loadTimeline();
                    if (!cancelled) {
                        setMessage(`${errorMessage(error)} Message remains queued in this browser tab.`);
                    }
                }
            } finally {
                queuedDispatchActiveRef.current = false;
                if (!cancelled) setSubmitting(false);
            }
        };
        void sendOldestQueuedMessage();
        const id = setInterval(sendOldestQueuedMessage, AVAILABILITY_REFRESH_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [mode, timeline?.state, queuedMessages, operation?.operationId, projectId, runwieldSessionId, requestKey]);

    useEffect(() => {
        if (mode !== "detail" || !timeline) {
            setWorkflowProgress(null);
            setWorkflowProgressError("");
            return;
        }
        const apiUrl = activePlanProgressApiUrl(projectId, runwieldSessionId, timeline.snapshot);
        if (!apiUrl) {
            setWorkflowProgress(null);
            setWorkflowProgressError("");
            return;
        }
        let cancelled = false;
        let refreshing = false;
        setWorkflowProgress(null);
        setWorkflowProgressError("");
        const refresh = async () => {
            if (cancelled || refreshing) return;
            refreshing = true;
            try {
                const payload = await ownerFetch(apiUrl, { method: "GET" });
                if (!cancelled) {
                    setWorkflowProgress(payload);
                    setWorkflowProgressError("");
                }
            } catch (error) {
                if (!cancelled) setWorkflowProgressError(errorMessage(error));
            } finally {
                refreshing = false;
            }
        };
        void refresh();
        const id = setInterval(refresh, AVAILABILITY_REFRESH_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [mode, projectId, runwieldSessionId, activePlanId(timeline?.snapshot)]);

    function captureHistoryViewport() {
        const scroller = timelineScrollRef.current;
        if (!scroller) return;
        historyViewportRef.current = {
            height: scroller.clientHeight,
            bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        };
    }

    function restoreHistoryViewport() {
        const scroller = timelineScrollRef.current;
        const previous = historyViewportRef.current;
        if (!scroller || !previous) return;
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - previous.bottomGap;
        captureHistoryViewport();
    }

    useLayoutEffect(() => {
        const scroller = timelineScrollRef.current;
        if (!scroller) return;
        captureHistoryViewport();
        const resize = new ResizeObserver(() => {
            const previous = historyViewportRef.current;
            const height = scroller.clientHeight;
            if (!previous || previous.height === height) return;
            // Use the saved gap: browsers may clamp scrollTop before resize is delivered.
            restoreHistoryViewport();
        });
        resize.observe(scroller);
        return () => resize.disconnect();
    }, [mode, Boolean(timeline)]);

    function scrollToLiveEdge() {
        const scroller = timelineScrollRef.current;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        followingLiveEdgeRef.current = true;
        setFollowingLiveEdge(true);
        setLatestActivityAvailable(false);
    }

    function updateScrollFollowState() {
        const scroller = timelineScrollRef.current;
        if (!scroller) return;
        if (historyViewportRef.current && historyViewportRef.current.height !== scroller.clientHeight) return;
        captureHistoryViewport();
        const atLiveEdge = isAtLiveScrollEdge(scroller);
        followingLiveEdgeRef.current = atLiveEdge;
        setFollowingLiveEdge(atLiveEdge);
        if (atLiveEdge) setLatestActivityAvailable(false);
    }

    useLayoutEffect(() => {
        if (mode !== "detail" && mode !== "new") return;
        const scroller = timelineScrollRef.current;
        if (!scroller) return;
        const shouldPinInitial = !didPinInitialTimelineRef.current && (mode === "new" || !loadingDetail);
        if (shouldPinInitial || followingLiveEdgeRef.current) {
            scroller.scrollTop = scroller.scrollHeight;
            didPinInitialTimelineRef.current = true;
            followingLiveEdgeRef.current = true;
            setFollowingLiveEdge(true);
            setLatestActivityAvailable(false);
            return;
        }
        setLatestActivityAvailable(true);
    }, [mode, loadingDetail, timelineItems, transientItems, pendingUserMessages, interruptedOperation]);

    useEffect(() => {
        if (!operation?.operationId) return undefined;
        const onKeyDown = (event) => {
            if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) {
                cancelOperation();
            }
        };
        globalThis.addEventListener("keydown", onKeyDown);
        return () => globalThis.removeEventListener("keydown", onKeyDown);
    }, [operation?.operationId]);

    async function answerInteraction(operationId, interactionId, response) {
        try {
            await ownerFetch(
                `/api/owner/projects/${encodeURIComponent(projectId)}/session-operations/${
                    encodeURIComponent(operationId)
                }/interactions/${encodeURIComponent(interactionId)}/answer`,
                {
                    method: "POST",
                    body: JSON.stringify({
                        response,
                        requestId: crypto.randomUUID(),
                        runwieldSessionId: runwieldSessionId || undefined,
                    }),
                },
            );
            setMessage("");
        } catch (error) {
            const message = errorMessage(error);
            setMessage(message);
            throw new Error(message);
        }
    }

    useEffect(() => {
        if (!location.hash.startsWith("#interaction-")) return;
        const interactionId = location.hash.slice("#interaction-".length);
        if (!latestLiveWorkflowInteraction(transientItems.filter((item) => item.interactionId === interactionId))) {
            return;
        }
        const target = document.getElementById(location.hash.slice(1));
        const focusTarget = target?.querySelector?.("textarea, input, button, a") || target;
        if (focusTarget instanceof HTMLElement) focusTarget.focus();
    }, [transientItems]);

    if (mode === "list") {
        return (
            <SessionList
                projectId={projectId}
                data={listData}
                preserveArchived={Boolean(planId)}
                loading={loadingList}
                error={listError}
                onRetry={() => loadList(listPage)}
                onPageChange={setListPage}
                onSessionChanged={() => {
                    void loadList(listPage);
                }}
            />
        );
    }

    if (mode === "new") {
        const newSessionItems = [
            ...(transientItems.some((item) => item.kind === "message" && item.role === "user")
                ? []
                : pendingUserMessages),
            ...transientItems.map((item) =>
                item.kind === "interaction"
                    ? {
                        ...item,
                        onAnswer: (response) => answerInteraction(item.operationId, item.interactionId, response),
                    }
                    : item
            ),
            ...(interruptedOperation ? [{ kind: "interruption", key: "interruption:lost-workspace-operation" }] : []),
        ];
        const availableProjects = projects?.filter((project) => project.enabled && project.projectId);
        const currentProject = availableProjects?.find((project) => project.projectId === projectId);
        const canChangeProject = Boolean(
            availableProjects && loadedDraftKey === draftKey && !draft.length &&
                !imageAttachments.length && !attachingImages && !navigationPending && !submitting &&
                !requestUnresolved && !operation?.operationId,
        );
        const canSendNew = !submitting && !attachingImages && !navigationPending && !creationAccepted &&
            loadedDraftKey === draftKey && Boolean(currentProject) && Boolean(sessionOptions) &&
            !operation?.operationId;
        const changeProject = (event) => {
            const nextId = event.currentTarget.value;
            if (
                !canChangeProject || navigationInFlight.current || nextId === projectId ||
                !availableProjects.some((project) => project.projectId === nextId)
            ) return;
            navigationInFlight.current = true;
            setNavigationPending(true);
            workspaceNavigate(`/projects/${encodeURIComponent(nextId)}/sessions/new`, "push", (error) => {
                if (!error || !surfaceCurrent.current) return;
                navigationInFlight.current = false;
                setNavigationPending(false);
                setMessage("Project could not open. Try again.");
            });
        };
        const agents = Array.isArray(sessionOptions?.agents) ? sessionOptions.agents : [];
        const models = Array.isArray(sessionOptions?.models) ? sessionOptions.models : [];
        const thinkingLevels = Array.isArray(sessionOptions?.thinkingLevels) ? sessionOptions.thinkingLevels : [];
        return (
            <section className="session-surface session-surface-detail" aria-label="RunWield Session chat">
                {optionsError && (
                    <p className="rw-plan-review-dev-notice session-dev-shell-bar" role="status">
                        Session settings could not load: {optionsError}{" "}
                        <button type="button" onClick={loadSessionOptions}>Retry</button>
                    </p>
                )}
                <div className="session-detail-layout session-detail-layout--chat-only">
                    <main className="session-stream-panel" aria-label="Session stream">
                        <div
                            className="session-timeline-scroll"
                            ref={timelineScrollRef}
                            onScroll={updateScrollFollowState}
                        >
                            <div className="session-surface-status" aria-live="polite">{message}</div>
                            <SessionTimeline items={newSessionItems} emptyMessage="" />
                            <div ref={timelineEndRef} aria-hidden="true" />
                        </div>
                        {!creationAccepted && (
                            <div className="session-project-choice">
                                <label htmlFor="new-session-project">Project</label>
                                {projectsError
                                    ? (
                                        <span role="alert">
                                            Projects could not load: {projectsError}{" "}
                                            <button type="button" onClick={loadProjects}>Retry</button>
                                        </span>
                                    )
                                    : availableProjects?.length === 0
                                    ? (
                                        <span>
                                            No available Projects. <a href="/projects">View Projects</a>
                                        </span>
                                    )
                                    : (
                                        <select
                                            id="new-session-project"
                                            className="rw-toolbar-select"
                                            value={currentProject ? projectId : ""}
                                            title={currentProject?.displayName || "Project unavailable"}
                                            disabled={!canChangeProject || availableProjects?.length === 0}
                                            onChange={changeProject}
                                        >
                                            {!currentProject && (
                                                <option value="">
                                                    {projects ? "Project unavailable" : "Loading Projects"}
                                                </option>
                                            )}
                                            {availableProjects?.map((project) => (
                                                <option key={project.projectId} value={project.projectId}>
                                                    {project.displayName}
                                                    {availableProjects.filter((entry) =>
                                                                    entry.displayName === project.displayName
                                                                ).length > 1 && project.rootLabel
                                                        ? ` · ${project.rootLabel}`
                                                        : ""}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                            </div>
                        )}
                        <SessionComposer
                            id="new-session-request-text"
                            onResizeStart={captureHistoryViewport}
                            onResize={restoreHistoryViewport}
                            draft={draft}
                            disabled={!canSendNew}
                            canSend={canSendNew && Boolean(draft.trim() || imageAttachments.length)}
                            submitting={submitting || Boolean(operation?.operationId)}
                            onDraftChange={setDraft}
                            onSubmit={createSession}
                            onStop={operation?.operationId ? cancelOperation : undefined}
                            onPaste={handleComposerPaste}
                            onFiles={handleComposerFiles}
                            imageAttachments={imageAttachments}
                            onRemoveImage={removeImageAttachment}
                            agents={agents}
                            models={models}
                            thinkingLevels={thinkingLevels}
                            mascotVisible={Boolean(sessionOptions) && sessionOptions.mascot !== false}
                            agentValue={selectedAgent}
                            modelValue={selectedModelKey}
                            thinkingValue={selectedThinking}
                            onAgentChange={(agentName) => {
                                const applied = selectNewAgent(agentName);
                                finishCommandPicker("agent", applied);
                                return applied;
                            }}
                            onModelChange={(modelKey) => {
                                selectNewModel(modelKey);
                                finishCommandPicker("model", true);
                            }}
                            onThinkingChange={selectNewThinking}
                            commands={sessionOptions?.commands || []}
                            onCommand={handleComposerCommand}
                            onCommandPickerOpen={openCommandPicker}
                            onCommandPickerCancel={cancelCommandPicker}
                            agentFallback={agents.length ? null : <option value="router">Router</option>}
                            modelFallback={<option value="">Project default</option>}
                            thinkingFallback={<option value="default">Default</option>}
                        />
                    </main>
                </div>
            </section>
        );
    }

    const allItems = mergeSessionTimelineItems(timelineItems, [
        ...(transientItems.some((item) => item.kind === "message" && item.role === "user") ? [] : pendingUserMessages),
        ...transientItems.map((item) =>
            item.kind === "interaction"
                ? {
                    ...item,
                    onAnswer: (response) => answerInteraction(item.operationId, item.interactionId, response),
                }
                : item
        ),
        ...(interruptedOperation ? [{ kind: "interruption", key: "interruption:lost-workspace-operation" }] : []),
    ]);
    const liveWorkflowInteraction = latestLiveWorkflowInteraction(transientItems);
    const activeExecutionWorkflow = asRecord(timeline?.snapshot?.activeExecutionWorkflow || {});
    const persistedWorkflowContext = asRecord(timeline?.snapshot?.workflowContext || {});
    const workflowContext = Object.keys(activeExecutionWorkflow).length
        ? activeExecutionWorkflow
        : persistedWorkflowContext;
    const activeWorkflowTriageMeta = asRecord(activeExecutionWorkflow.triageMeta || {});
    const workflowEpic = activeExecutionWorkflow.planName
        ? typeof activeWorkflowTriageMeta.parentPlan === "string" ? activeWorkflowTriageMeta.parentPlan : ""
        : typeof persistedWorkflowContext.parentPlan === "string"
        ? persistedWorkflowContext.parentPlan
        : "";
    const activeWorkflowPlan = typeof workflowContext.planName === "string"
        ? workflowContext.planName
        : typeof workflowContext.planId === "string"
        ? workflowContext.planId
        : "";
    const workflowSidebar = buildSessionSidebarProjection({
        workflowPlan: activeWorkflowPlan,
        workflowEpic,
        workflowIntent: typeof persistedWorkflowContext.routingIntent === "string"
            ? persistedWorkflowContext.routingIntent
            : "",
        workflowStatus: workflowProgress?.overall?.state === "completed"
            ? "verified"
            : typeof workflowProgress?.plan?.status === "string"
            ? workflowProgress.plan.status
            : "",
        workflowClassification: typeof workflowProgress?.plan?.classification === "string"
            ? workflowProgress.plan.classification
            : "",
        workflowValidationPhase: workflowProgress?.plan?.validationPhase,
        workflowProgressFacts: Array.isArray(workflowProgress?.progressFacts)
            ? workflowProgress.progressFacts
            : undefined,
        workflowLiveValidationProgress: operation?.status === "running" ? liveValidationProgress : null,
        workflowDegradedMessage: typeof workflowProgress?.degraded?.message === "string"
            ? workflowProgress.degraded.message
            : workflowProgressError,
        workflowSessionState: typeof workflowProgress?.session?.state === "string"
            ? workflowProgress.session.state
            : "",
        workflowHasWorkingSession: Boolean(workflowProgress?.session?.runwieldSessionId || runwieldSessionId),
        workflowHasLiveQuestion: liveWorkflowInteraction?.kind === "interaction",
        workflowHasPlanReview: liveWorkflowInteraction?.kind === "plan-review",
        workflowHasCodeReview: liveWorkflowInteraction?.kind === "code-review",
        workflowCanResume: Boolean(runwieldSessionId && availability.canContinue && workflowProgress?.canResume),
        workflowCanRecover: Boolean(runwieldSessionId && availability.canContinue && workflowProgress?.canRecover),
    }).workflow;
    const planHomeFromSnapshot = timeline ? activePlanHomeUrl(projectId, runwieldSessionId, timeline.snapshot) : "";
    const planHomeUrl = planHomeFromSnapshot;
    const workflowActionUrl = liveWorkflowInteraction?.reviewUrl ||
        (liveWorkflowInteraction?.interactionId ? `#interaction-${liveWorkflowInteraction.interactionId}` : "") ||
        planHomeUrl;
    async function runWorkflowAction(action) {
        if (
            !["run", "resume", "recover", "review_plan", "resume_from_hold", "retry_work_record"].includes(action.kind)
        ) return;
        const currentTimeline = timelineRef.current;
        const planId = action.planId || activePlanId(currentTimeline?.snapshot);
        if (!planId) {
            throw new Error("Plan workflow evidence is unavailable. Refresh the Session and try again.");
        }
        const result = await submitWorkflowAction(
            `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${
                encodeURIComponent(runwieldSessionId)
            }/plan-workflow`,
            {
                requestId: crypto.randomUUID(),
                planId,
                action: action.kind,
                expectedGeneration: currentTimeline.generation,
                expectedRevision: workflowProgress?.expectedRevision,
            },
        );
        if (result.canceled) return "Plan remains on hold.";
        if (action.kind === "resume_from_hold") {
            const progressUrl = activePlanProgressApiUrl(projectId, runwieldSessionId, currentTimeline.snapshot);
            if (progressUrl) setWorkflowProgress(await ownerFetch(progressUrl));
        }
        if (result.reviewUrl) {
            workspaceNavigate(result.reviewUrl);
            return "Plan review opened.";
        }
        if (result.operationId) {
            setOperationStreamFailed(false);
            setOperation({
                operationId: result.operationId,
                status: result.status || "running",
                observed: 0,
                attempts: 0,
            });
        }
        await loadTimeline();
        return result.result?.message || result.reason || "Workflow started.";
    }
    const agents = Array.isArray(sessionOptions?.agents) ? sessionOptions.agents : [];
    const models = Array.isArray(sessionOptions?.models) ? sessionOptions.models : [];
    const thinkingLevels = Array.isArray(sessionOptions?.thinkingLevels) ? sessionOptions.thinkingLevels : [];
    const activeModel = asRecord(timeline?.snapshot?.activeModel || {});
    const activeProvider = typeof activeModel.provider === "string"
        ? activeModel.provider
        : timeline?.snapshot?.provider || "";
    const activeModelId = typeof activeModel.model === "string" ? activeModel.model : timeline?.snapshot?.model || "";
    const activeModelKey = activeModelId ? `${activeProvider}\u001f${activeModelId}` : "";
    const activeThinking = typeof timeline?.snapshot?.thinkingLevel === "string"
        ? timeline.snapshot.thinkingLevel
        : "default";
    const hasActivePlan = Boolean(workflowContext.planId || workflowContext.planName || planHomeFromSnapshot);
    const localOperationActive = Boolean(operation && !["completed", "failed", "unknown"].includes(operation.status));
    const canConfigureSession = availability.canContinue || (localOperationActive && !operation?.remote);
    const stagedAgent = pendingConfiguration?.agentName || timeline?.snapshot?.activeAgent || "";
    const stagedAgentDefaults = pendingConfiguration?.agentName
        ? agents.find((agent) => agent.name === pendingConfiguration.agentName)?.defaults
        : null;
    const stagedModelKey = pendingConfiguration?.model
        ? `${pendingConfiguration.provider || ""}\u001f${pendingConfiguration.model}`
        : stagedAgentDefaults?.model
        ? `${stagedAgentDefaults.provider}\u001f${stagedAgentDefaults.model}`
        : activeModelKey;
    const displayedThinking = liveThinkingLevel || stagedAgentDefaults?.thinkingLevel || activeThinking;
    const canSubmitSession = availability.canContinue || ["active", "workspace-running"].includes(availability.key);
    const sessionSidebar = buildSessionSidebarProjection({
        sessionName: timeline?.snapshot?.name,
        ...timeline?.snapshot?.sessionStats,
        queuedMessages: queuedMessages.length,
        contextUsedTokens: timeline?.snapshot?.contextUsage?.tokens,
        contextWindowTokens: timeline?.snapshot?.contextUsage?.contextWindow,
        contextPercent: timeline?.snapshot?.contextUsage?.percent,
        systemContextTokens: timeline?.snapshot?.systemContextTokens,
    }).session;
    const currentAgent = timeline?.snapshot?.activeAgent || "";
    const sessionFields = sessionSidebarFields(sessionSidebar).filter((field) => field.label !== "Session");
    sessionFields.unshift({
        label: "Agent",
        value: currentAgent
            ? agents.find((agent) => agent.name === currentAgent)?.displayName || displayAgentName(currentAgent)
            : "Unknown",
    }, {
        label: "Model",
        value: activeModelId
            ? activeProvider && !activeModelId.startsWith(`${activeProvider}/`)
                ? [activeProvider, activeModelId].filter(Boolean).join("/")
                : activeModelId
            : "Unknown",
    }, {
        label: "Thinking",
        value: activeThinking,
    });
    return (
        <section className="session-surface session-surface-detail" aria-label="RunWield Session chat">
            {timeline && (
                <WorkspaceHeaderActionsPortal>
                    {returnHref && <RunWieldLink href={returnHref}>Back to Search</RunWieldLink>}
                    <div className="session-context-header" data-expanded={!contextCollapsed}>
                        <RunWieldPanelToggle
                            side="right"
                            collapsed={contextCollapsed}
                            label="Session sidebar"
                            controls="session-context-sidebar"
                            onClick={toggleContext}
                        />
                        {!contextCollapsed && (
                            <div
                                className="rw-underline-tabs session-context-tabs"
                                role="tablist"
                                aria-label="Session context views"
                            >
                                {SESSION_SIDEBAR_TABS.map((tab) => (
                                    <button
                                        key={tab}
                                        type="button"
                                        role="tab"
                                        id={`session-context-tab-${tab}`}
                                        aria-controls="session-context-panel"
                                        aria-selected={sessionSidebarTab === tab}
                                        tabIndex={sessionSidebarTab === tab ? 0 : -1}
                                        onKeyDown={(event) => {
                                            const index = SESSION_SIDEBAR_TABS.indexOf(tab);
                                            const next = event.key === "ArrowRight"
                                                ? (index + 1) % SESSION_SIDEBAR_TABS.length
                                                : event.key === "ArrowLeft"
                                                ? (index - 1 + SESSION_SIDEBAR_TABS.length) %
                                                    SESSION_SIDEBAR_TABS.length
                                                : event.key === "Home"
                                                ? 0
                                                : event.key === "End"
                                                ? SESSION_SIDEBAR_TABS.length - 1
                                                : -1;
                                            if (next < 0) return;
                                            event.preventDefault();
                                            const nextTab = SESSION_SIDEBAR_TABS[next];
                                            setSessionSidebarTab(nextTab);
                                            document.getElementById(`session-context-tab-${nextTab}`)?.focus();
                                        }}
                                        onClick={() => setSessionSidebarTab(tab)}
                                    >
                                        {tab[0].toUpperCase() + tab.slice(1)}
                                        {tab === "artifacts" && Array.isArray(timeline.artifacts) &&
                                                timeline.artifacts.length
                                            ? <span>{timeline.artifacts.length}</span>
                                            : null}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </WorkspaceHeaderActionsPortal>
            )}
            {loadingDetail && !timeline
                ? (
                    <p className="session-list-state" aria-busy="true">
                        <RunWieldThinkingDots label="Loading conversation" />
                    </p>
                )
                : null}
            {detailError
                ? (
                    <section className="error-panel" role="alert">
                        <h2>Session failed to load</h2>
                        <p>{detailError}</p>
                        <RunWieldButton type="button" onClick={loadTimeline}>Retry</RunWieldButton>
                    </section>
                )
                : null}
            {timeline
                ? (
                    <div
                        className={`session-detail-layout${
                            contextCollapsed ? " session-detail-layout--chat-only" : ""
                        }`}
                    >
                        <main
                            className="session-stream-panel"
                            aria-label="Session stream"
                            inert={!contextCollapsed && isNarrowScreen}
                        >
                            <div
                                className="session-timeline-scroll"
                                ref={timelineScrollRef}
                                onScroll={updateScrollFollowState}
                            >
                                {loadingDetail
                                    ? (
                                        <div className="session-inline-loader" aria-live="polite" aria-busy="true">
                                            <RunWieldThinkingDots label="Updating conversation" />
                                        </div>
                                    )
                                    : message
                                    ? <div className="session-surface-status" aria-live="polite">{message}</div>
                                    : null}
                                {latestActivityAvailable
                                    ? (
                                        <div className="session-scroll-offer" role="status">
                                            <span>New activity is available.</span>
                                            <button type="button" onClick={scrollToLiveEdge}>
                                                Latest activity
                                            </button>
                                        </div>
                                    )
                                    : null}
                                {timeline.previousCursor
                                    ? (
                                        <RunWieldButton
                                            type="button"
                                            onClick={loadEarlierMessages}
                                            disabled={loadingEarlier}
                                        >
                                            {loadingEarlier
                                                ? <RunWieldThinkingDots label="Loading earlier messages" />
                                                : "Load earlier messages"}
                                        </RunWieldButton>
                                    )
                                    : null}
                                <SessionTimeline
                                    items={allItems}
                                    onRetryWorkRecord={(report) =>
                                        runWorkflowAction({ kind: "retry_work_record", planId: report.planId })}
                                    sessionPath={`/projects/${encodeURIComponent(projectId)}/sessions/${
                                        encodeURIComponent(runwieldSessionId)
                                    }`}
                                />
                                <div ref={timelineEndRef} aria-hidden="true" />
                            </div>
                            <SessionComposer
                                id="session-request-text"
                                onResizeStart={captureHistoryViewport}
                                onResize={restoreHistoryViewport}
                                draft={draft}
                                disabled={!canSubmitSession || submitting || attachingImages ||
                                    loadedDraftKey !== draftKey}
                                controlsDisabled={!canConfigureSession}
                                canSend={canSubmitSession && !attachingImages && loadedDraftKey === draftKey &&
                                    Boolean(draft.trim() || imageAttachments.length)}
                                submitting={submitting}
                                onDraftChange={setDraft}
                                onSubmit={() => sendRequest()}
                                onQueue={operation?.operationId ? () => sendRequest(true) : undefined}
                                onStop={operation?.operationId ? cancelOperation : undefined}
                                sendLabel={operation?.operationId
                                    ? "Steer"
                                    : timeline.state === "active"
                                    ? "Queue"
                                    : "Send"}
                                steeringMessages={steeringMessages}
                                onPaste={handleComposerPaste}
                                onFiles={handleComposerFiles}
                                imageAttachments={imageAttachments}
                                onRemoveImage={removeImageAttachment}
                                agents={agents}
                                models={models}
                                thinkingLevels={thinkingLevels}
                                mascotVisible={Boolean(sessionOptions) && sessionOptions.mascot !== false}
                                agentValue={stagedAgent}
                                mascotAgent={timeline.snapshot?.activeAgentInfo?.agentName || currentAgent}
                                mascotParentAgent={currentAgent}
                                mascotActivity={mascotPose({
                                    busy: transientItems.some((item) => item.kind === "busy"),
                                    waiting: Boolean(liveWorkflowInteraction),
                                    answering: transientItems.filter((item) =>
                                                item.kind !== "busy"
                                            ).at(-1)?.kind === "message" &&
                                        transientItems.filter((item) => item.kind !== "busy").at(-1)?.role ===
                                            "assistant",
                                })}
                                modelValue={stagedModelKey}
                                thinkingValue={displayedThinking}
                                onAgentChange={async (agentName) => {
                                    const applied = await configureSession({ agentName });
                                    finishCommandPicker("agent", applied);
                                    return applied;
                                }}
                                onModelChange={async (value) => {
                                    const [provider, model] = value ? value.split("\u001f") : ["", ""];
                                    const applied = model ? await configureSession({ provider, model }) : false;
                                    finishCommandPicker("model", applied);
                                    return applied;
                                }}
                                onThinkingChange={(thinkingLevel) => configureSession({ thinkingLevel })}
                                commands={sessionOptions?.commands || []}
                                onCommand={handleComposerCommand}
                                onCommandPickerOpen={openCommandPicker}
                                onCommandPickerCancel={cancelCommandPicker}
                                agentFallback={agents.some((agent) => agent.name === timeline.snapshot?.activeAgent)
                                    ? null
                                    : (
                                        <option value={timeline.snapshot?.activeAgent || ""}>
                                            {timeline.snapshot?.activeAgent || "Agent"}
                                        </option>
                                    )}
                                modelFallback={activeModelKey &&
                                        !models.some((model) => `${model.provider}\u001f${model.id}` === activeModelKey)
                                    ? <option value={activeModelKey}>{activeProvider}/{activeModelId}</option>
                                    : null}
                                thinkingFallback={thinkingLevels.includes(displayedThinking)
                                    ? null
                                    : <option value={displayedThinking}>{displayedThinking}</option>}
                                queuedMessages={queuedMessages}
                            />
                        </main>
                        <aside
                            id="session-context-sidebar"
                            hidden={contextCollapsed}
                            className="session-workflow-sidebar session-context-sidebar"
                            aria-label="Session context"
                        >
                            <div className="session-context-content">
                                {sessionSidebarTab === "workflow"
                                    ? (
                                        <div
                                            id="session-context-panel"
                                            className="session-context-panel"
                                            role="tabpanel"
                                            aria-labelledby="session-context-tab-workflow"
                                        >
                                            {hasActivePlan
                                                ? (
                                                    <WorkflowSidebar
                                                        presentation={workflowSidebar}
                                                        payload={{
                                                            planHref: planHomeUrl,
                                                            sessionHref: runwieldSessionId
                                                                ? `/projects/${
                                                                    encodeURIComponent(projectId)
                                                                }/sessions/${encodeURIComponent(runwieldSessionId)}`
                                                                : "",
                                                            reviewHref: liveWorkflowInteraction?.reviewUrl || "",
                                                            interactionHref: workflowActionUrl,
                                                        }}
                                                        title="Workflow"
                                                        embedded
                                                        onAction={runWorkflowAction}
                                                        onAnswerAgent={() => {
                                                            setContextCollapsed(true);
                                                            globalThis.requestAnimationFrame(() => {
                                                                const target = document.getElementById(
                                                                    `interaction-${liveWorkflowInteraction?.interactionId}`,
                                                                );
                                                                target?.scrollIntoView({ block: "nearest" });
                                                                (target?.querySelector("textarea, input, button, a") ||
                                                                    target)?.focus();
                                                            });
                                                        }}
                                                        onOpenSession={() => {
                                                            setContextCollapsed(true);
                                                            scrollToLiveEdge();
                                                        }}
                                                    />
                                                )
                                                : (
                                                    <p className="session-context-empty">
                                                        This Session does not have an active Plan workflow.
                                                    </p>
                                                )}
                                        </div>
                                    )
                                    : sessionSidebarTab === "session"
                                    ? (
                                        <div
                                            id="session-context-panel"
                                            className="session-context-panel"
                                            role="tabpanel"
                                            aria-labelledby="session-context-tab-session"
                                        >
                                            <dl>
                                                {sessionFields.map((field) => (
                                                    <div key={field.label}>
                                                        <dt>{field.label}</dt>
                                                        <dd>{field.value}</dd>
                                                    </div>
                                                ))}
                                            </dl>
                                        </div>
                                    )
                                    : (
                                        <div
                                            id="session-context-panel"
                                            className="session-context-panel"
                                            role="tabpanel"
                                            aria-labelledby="session-context-tab-artifacts"
                                        >
                                            {Array.isArray(timeline.artifacts) && timeline.artifacts.length
                                                ? (
                                                    <ul className="session-artifact-list">
                                                        {timeline.artifacts.map((artifact) => (
                                                            <li key={artifact.artifactId}>
                                                                <a
                                                                    href={`/projects/${
                                                                        encodeURIComponent(projectId)
                                                                    }/sessions/${
                                                                        encodeURIComponent(runwieldSessionId)
                                                                    }/artifacts/${
                                                                        encodeURIComponent(artifact.artifactId)
                                                                    }`}
                                                                >
                                                                    <span>{artifact.title}</span>
                                                                    <small>
                                                                        {sessionArtifactKindLabel(artifact.kind)}
                                                                    </small>
                                                                </a>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )
                                                : (
                                                    <p className="session-context-empty">
                                                        Meaningful Markdown outputs will appear here when an agent
                                                        declares them.
                                                    </p>
                                                )}
                                        </div>
                                    )}
                            </div>
                        </aside>
                    </div>
                )
                : null}
        </section>
    );
}

export default SessionSurface;
