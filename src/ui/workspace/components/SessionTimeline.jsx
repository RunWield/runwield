import { DeliveryReportCard } from "./DeliveryReportCard.tsx";
import { useEffect, useRef, useState } from "react";
import { WORKFLOW_TOOL_NAMES } from "../../../tools/registry.ts";
import {
    isApprovalAcceptedValue,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../../../shared/session/interaction-values.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { SessionQuestionForm } from "./SessionQuestionForm.tsx";
import { RunWieldLink, RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

const MESSAGE_TYPES = new Set([
    "workflow",
    "message",
    "thinking",
    "busy",
    "tool",
    "status",
    "usage",
    "activity",
    "interaction",
    "plan-review",
    "code-review",
    "interruption",
    "system-event",
    "delivery-report",
]);

/** @param {unknown} value */
function asRecord(value) {
    return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : {};
}

/** @param {unknown} value */
function text(value) {
    return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/** @param {string} agentName */
export function displayAgentName(agentName) {
    const trimmed = agentName.trim();
    if (!trimmed) return "Ideator";
    const pinned = {
        "frontend-engineer": "Frontend Engineer",
        "plan-engineer": "Plan Engineer",
        "reviewer-feedback-engineer": "Validation Repair Engineer",
    }[trimmed];
    if (pinned) return pinned;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) return trimmed;
    return trimmed.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "").join(" ");
}

/** @param {unknown} timestamp */
export function formatSessionTimelineTime(timestamp) {
    const date = new Date(text(timestamp));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
}

/** @typedef {ReturnType<typeof reduceSessionEvents>[number]} TimelineItem */

/** @param {TimelineItem[]} rawItems */
function compactCompletedActivity(rawItems) {
    /** @type {Array<Record<string, any>>} */
    const compacted = [];
    /** @type {Array<Record<string, any>>} */
    let activity = [];
    const isCompletedActivity = (/** @type {Record<string, any>} */ item) =>
        (item.kind === "tool" && ["completed", "failed"].includes(text(item.status))) ||
        (item.kind === "thinking" && item.done === true);
    const flushActivity = () => {
        if (!activity.length) return;
        if (activity.length === 1) {
            compacted.push(activity[0]);
        } else {
            compacted.push({
                kind: "activity",
                key: `activity:${activity[0]?.key || compacted.length}`,
                title: "Activity",
                count: activity.length,
                source: activity.some((item) => item.source === "transient") ? "transient" : "committed",
                timestamp: activity.at(-1)?.timestamp || activity[0]?.timestamp || "",
                items: activity,
            });
        }
        activity = [];
    };
    for (const item of rawItems) {
        if (isCompletedActivity(item)) {
            activity.push(item);
            continue;
        }
        flushActivity();
        compacted.push(item);
    }
    compacted.push(...activity);
    return compacted;
}

/**
 * @param {Array<Record<string, any>>} events
 * @param {{ source?: "committed" | "transient", startIndex?: number }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function reduceSessionEvents(events, options = {}) {
    /** @type {Array<Record<string, any>>} */
    const items = [];
    /** @type {Map<string, Record<string, any>>} */
    const byKey = new Map();
    const source = options.source || "committed";
    const startIndex = options.startIndex || 0;
    let busy = false;
    let lastSegmentKey = null;
    /** @type {readonly string[] | undefined} */
    let currentBusyLines = undefined;
    /** @type {Record<string, any> | null} */
    let lastAssistantMessage = null;
    const ensure = (/** @type {string} */ key, /** @type {Record<string, any>} */ item) => {
        const existing = byKey.get(key);
        if (existing) return existing;
        byKey.set(key, item);
        item.orderTimestamp = item.timestamp;
        items.push(item);
        return item;
    };
    const appendSystemEvent = (/** @type {Record<string, any>} */ item) => {
        const previous = items.at(-1);
        if (
            previous?.kind === "system-event" && previous.header === item.header && previous.level === item.level &&
            previous.source === item.source
        ) {
            previous.lines = [...(Array.isArray(previous.lines) ? previous.lines : [previous.text]), item.text];
            previous.text = previous.lines.join("\n");
            if (item.timestamp) previous.timestamp = item.timestamp;
            return previous;
        }
        item.orderTimestamp = item.timestamp;
        item.lines = [item.text];
        items.push(item);
        return item;
    };

    events.forEach((raw, index) => {
        const event = asRecord(raw);
        const type = text(event.type);
        if (type === "busy_changed") {
            busy = event.busy === true;
            return;
        }
        if (type === "agent_changed") {
            currentBusyLines = Array.isArray(event.busyLines) && event.busyLines.length > 0
                ? event.busyLines
                : undefined;
            return;
        }
        const id = text(event.messageId || event.toolCallId || event.eventId || `${source}:${startIndex + index}`);
        const timestamp = text(event.timestamp);
        const segmentOrdinal = Number.isInteger(event.segmentOrdinal) ? event.segmentOrdinal : null;
        const segmentKind = text(event.segmentKind || "session");
        const segmentKey = segmentOrdinal === null ? null : `${segmentOrdinal}:${segmentKind}`;
        if (segmentKey && lastSegmentKey && segmentKey !== lastSegmentKey) {
            const label = text(event.agentName) ||
                (segmentKind === "planning"
                    ? "Planner"
                    : segmentKind === "execution"
                    ? "Plan Engineer"
                    : segmentKind === "semantic_repair"
                    ? "Semantic Repair"
                    : "Session");
            appendSystemEvent({
                kind: "system-event",
                key: `segment:${segmentKey}`,
                header: "Segment",
                text: label,
                level: "info",
                segmentKind,
                timestamp,
                source,
            });
        }
        if (segmentKey) lastSegmentKey = segmentKey;
        if (type === "user_message") {
            ensure(`user:${id}`, {
                kind: "message",
                role: "user",
                key: event.eventId || `user:${id}`,
                text: text(event.text),
                images: Array.isArray(event.images) ? event.images : [],
                timestamp,
                source,
            });
            lastAssistantMessage = null;
            return;
        }
        if (type === "assistant_text_delta") {
            if (event.workflowMessage) {
                const workflowMessage = event.workflowMessage === "manual_qa_checklist"
                    ? "manual_qa_completed"
                    : text(event.workflowMessage);
                const toolKey = event.toolCallId ? `tool:${event.toolCallId}` : "";
                const previous = items.at(-1);
                const legacyMatch = !toolKey && previous?.kind === "workflow" &&
                        previous.workflowMessage === workflowMessage && !previous.semanticMessage
                    ? previous
                    : null;
                const item = (toolKey ? byKey.get(toolKey) : legacyMatch) || ensure(toolKey || `workflow:${id}`, {
                    kind: "workflow",
                    key: event.eventId || `workflow:${id}`,
                    workflowMessage,
                    title: displayAgentName(workflowMessage.replaceAll("_", "-")),
                    source,
                });
                if (event.toolCallId) item.toolCallId = text(event.toolCallId);
                item.markdown = text(event.delta);
                item.semanticMessage = true;
                item.status = "completed";
                item.agentName = text(event.agentName);
                item.timestamp = timestamp;
                item.orderTimestamp = timestamp;
                return;
            }
            const item = ensure(`assistant:${id}`, {
                kind: "message",
                role: "assistant",
                key: event.eventId || `assistant:${id}`,
                text: "",
                agentName: text(event.agentName || "Ideator"),
                timestamp,
                source,
            });
            item.text += text(event.delta);
            if (timestamp) item.timestamp = timestamp;
            lastAssistantMessage = item;
            return;
        }
        if (type === "assistant_thinking_delta" || type === "assistant_thinking_end") {
            const item = ensure(`thinking:${id}`, {
                kind: "thinking",
                key: event.eventId || `thinking:${id}`,
                text: "",
                agentName: text(event.agentName || "Ideator"),
                done: false,
                timestamp,
                source,
            });
            if (type === "assistant_thinking_delta") item.text += text(event.delta);
            if (type === "assistant_thinking_end") item.done = true;
            if (timestamp) item.timestamp = timestamp;
            return;
        }
        if (type === "tool_start" || type === "tool_update" || type === "tool_end") {
            const toolId = text(event.toolCallId || id);
            const workflow = WORKFLOW_TOOL_NAMES.includes(text(event.toolName));
            if (workflow && !byKey.has(`tool:${toolId}`)) {
                const previous = items.at(-1);
                const message = previous?.workflowMessage === event.toolName && previous.semanticMessage &&
                        !previous.toolCallId
                    ? previous
                    : null;
                if (message) byKey.set(`tool:${toolId}`, message);
            }
            const item = ensure(`tool:${toolId}`, {
                kind: workflow ? "workflow" : "tool",
                workflowMessage: workflow ? text(event.toolName) : "",
                key: event.eventId || `tool:${toolId}`,
                title: text(event.title || event.toolName || "Tool activity"),
                toolName: text(event.toolName || "tool"),
                status: "running",
                output: "",
                timestamp,
                source,
            });
            item.toolCallId = toolId;
            item.title = text(event.title || item.title);
            if (event.details) item.details = { ...asRecord(item.details), ...asRecord(event.details) };
            if (type !== "tool_start") item.output = text(event.output || item.output);
            if (type === "tool_end") item.status = event.isError ? "failed" : "completed";
            if (timestamp && !item.semanticMessage) item.timestamp = timestamp;
            if (workflow && type === "tool_end" && !item.orderCompleted) {
                item.orderTimestamp = item.semanticMessage ? item.timestamp : timestamp;
                item.orderCompleted = true;
            }
            return;
        }
        if (type === "interaction_requested") {
            const requestType = text(event.interactionType || "text");
            const review = asRecord(event.review);
            ensure(`interaction:${text(event.interactionId || id)}`, {
                kind: requestType === "plan_review"
                    ? "plan-review"
                    : requestType === "code_review"
                    ? "code-review"
                    : "interaction",
                key: event.eventId || `interaction:${text(event.interactionId || id)}`,
                interactionId: text(event.interactionId || id),
                request: {
                    prompt: text(
                        event.prompt ||
                            (requestType === "plan_review" ? "Plan ready for review." : "The agent needs input."),
                    ),
                    type: requestType,
                    planReview: requestType === "plan_review"
                        ? {
                            planId: text(review.planId),
                            planName: text(review.planName || "Plan"),
                            classification: text(review.classification || "PLANNED_CHANGE"),
                            expectedStatus: text(review.expectedStatus),
                            expectedRevision: text(review.expectedRevision),
                        }
                        : null,
                },
                status: "live",
                timestamp,
                source,
            });
            return;
        }
        if (type === "interaction_resolved" || type === "interaction_canceled") {
            appendSystemEvent({
                kind: "system-event",
                key: event.eventId || `interaction-result:${id}:${index}`,
                header: "Interaction",
                level: type === "interaction_canceled" ? "warning" : "info",
                text: text(event.message || `Interaction ${text(event.outcome || "completed")}`),
                timestamp,
                source,
            });
            return;
        }
        if (
            type === "system_status" || type === "terminal_error" || type === "cancellation" ||
            type === "recovery_event"
        ) {
            if (event.validationProgress?.deliveryReport) {
                ensure(`delivery:${id}`, {
                    kind: "delivery-report",
                    key: event.eventId || `delivery:${id}`,
                    report: event.validationProgress.deliveryReport,
                    timestamp,
                    source,
                });
                return;
            }
            if (event.header === "Triage") {
                const previous = items.at(-1);
                const item = (previous?.workflowMessage === "triage_report" && !previous.markdown ? previous : null) ||
                    ensure(`workflow:${id}`, {
                        kind: "workflow",
                        key: `workflow:${id}`,
                        workflowMessage: "triage_report",
                        source,
                    });
                item.markdown = text(event.message);
                item.status = "completed";
                item.timestamp = timestamp;
                return;
            }
            if (type === "terminal_error" && event.messageAlreadyReported) return;
            const level = type === "terminal_error" ? "error" : text(event.level || "info");
            const header = type === "recovery_event" ? "Recovery" : type === "cancellation" ? "Cancellation" : "System";
            appendSystemEvent({
                kind: "system-event",
                key: event.eventId || `status:${id}:${index}`,
                header,
                level,
                text: text(event.message || type.replaceAll("_", " ")),
                timestamp,
                source,
            });
            return;
        }
        if (type === "usage") {
            const usage = asRecord(event.usage);
            const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : null;
            const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : null;
            if (lastAssistantMessage && inputTokens !== null && outputTokens !== null) {
                lastAssistantMessage.footerText = `Usage: ${inputTokens} in / ${outputTokens} out tokens`;
                lastAssistantMessage.completedTimestamp = timestamp;
            }
        }
    });
    const visibleItems = mergeSessionTimelineItems(items.filter((item) => MESSAGE_TYPES.has(item.kind)), []);
    // Runtime activity belongs at the live edge, never in saved conversation history.
    if (source === "transient" && busy) {
        visibleItems.push({
            kind: "busy",
            key: "runtime-busy",
            source,
            ...(currentBusyLines ? { busyLines: currentBusyLines } : {}),
        });
    }
    return visibleItems;
}

/**
 * Reconcile saved history with the running operation before grouping Activity.
 * Saved tool results win over their live copies; live-only review/status events remain visible.
 * @param {TimelineItem[]} committed
 * @param {TimelineItem[]} transient
 */
export function mergeSessionTimelineItems(committed, transient) {
    const flatten = (/** @type {TimelineItem[]} */ items) =>
        items.flatMap((item) => item.kind === "activity" ? item.items : [item]);
    const saved = flatten(committed);
    const live = flatten(transient);
    const savedCalls = new Map(saved.flatMap((item, index) => item.toolCallId ? [[item.toolCallId, index]] : []));
    const savedEnd = Math.max(0, ...saved.map((item) => Date.parse(item.timestamp) || 0));
    const matched = new Set();
    const remaining = live.filter((item) => {
        if (item.kind === "delivery-report" && saved.some((candidate) => candidate.key === item.key)) return false;
        if (item.toolCallId && savedCalls.has(item.toolCallId)) {
            const index = savedCalls.get(item.toolCallId);
            const previous = saved[index];
            if (previous.status === "running") saved[index] = { ...previous, ...item, key: previous.key };
            return false;
        }
        if (
            !["message", "thinking"].includes(item.kind) || !item.text ||
            !(Date.parse(item.timestamp) <= savedEnd)
        ) return true;
        const index = saved.findIndex((candidate, index) =>
            !matched.has(index) && candidate.kind === item.kind && candidate.role === item.role &&
            candidate.text === item.text && Date.parse(candidate.timestamp) >= Date.parse(item.timestamp)
        );
        if (index < 0) return true;
        matched.add(index);
        return false;
    });
    const ordered = [...saved, ...remaining].sort((a, b) => {
        const left = Date.parse(a.orderTimestamp || a.timestamp);
        const right = Date.parse(b.orderTimestamp || b.timestamp);
        if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
        if (!Number.isFinite(right)) return -1;
        return left - right;
    });
    return compactCompletedActivity(ordered);
}

/** Full workflow output is never truncated or folded into routine tool activity. */
export function workflowToolMarkdown(item) {
    const details = asRecord(item.details);
    const toolName = text(item.workflowMessage || item.toolName);
    let body = text(item.markdown || item.output);
    if (toolName === "triage_report" && details.summary) {
        body = [
            `**Routing Intent:** ${text(details.routingIntent || details.classification)}`,
            details.workKind ? `**Work Kind:** ${text(details.workKind)}` : "",
            `**Complexity:** ${text(details.complexity)}`,
            text(details.summary),
        ].filter(Boolean).join("\n\n");
    } else if (toolName === "work_record_completed" && details.summary) {
        body = [
            details.title ? `**${text(details.title)}**` : "",
            text(details.summary),
            ...[
                ["Deviations from Plan", details.deviationsFromPlan],
                ["Deferred work", details.deferredWork],
                ["Future planning notes", details.futurePlanningNotes],
            ].filter(([, value]) => value).map(([label, value]) => `### ${label}\n\n${text(value)}`),
        ].filter(Boolean).join("\n\n");
    } else if (details.checklistMarkdown) {
        body = text(details.checklistMarkdown);
    } else if (!body) {
        body = [
            details.planName ? `**Plan:** ${text(details.planName)}` : "",
            details.title ? `**${text(details.title)}**` : "",
            details.outcome ? text(details.outcome).replaceAll("_", " ") : "",
            text(details.message || details.summary),
            text(details.feedback),
            text(details.artifactPath),
            ...(Array.isArray(details.findings)
                ? details.findings.map((finding) =>
                    [text(finding.title), text(finding.requirement), text(finding.evidence)].filter(Boolean).join(
                        "\n\n",
                    )
                )
                : []),
        ].filter(Boolean).join("\n\n");
    }
    const advisories = Array.isArray(details.advisories)
        ? details.advisories.map((advisory) =>
            [text(advisory.title), text(advisory.detail)].filter(Boolean).join("\n\n")
        ).join("\n\n")
        : "";
    return [body, advisories ? `### Review notes\n\n${advisories}` : ""].filter(Boolean).join("\n\n");
}

/** @param {{ image: { base64: string, mimeType: string }, label: string }} props */
function SessionImage({ image, label }) {
    const dialog = useRef(null);
    const src = `data:${image.mimeType};base64,${image.base64}`;
    return (
        <>
            <button type="button" className="rw-image-preview-button" onClick={() => dialog.current?.showModal()}>
                <img src={src} alt={label} loading="lazy" />
            </button>
            <dialog ref={dialog} className="rw-dialog-panel rw-image-dialog" aria-label={label}>
                <form method="dialog">
                    <button type="submit" className="rw-toolbar-button">Close image</button>
                </form>
                <img src={src} alt={label} />
            </dialog>
        </>
    );
}

/**
 * @param {string} requestType
 * @param {Record<string, any>} request
 * @param {Record<string, any>|string} choice
 */
export function sessionInteractionChoiceResponse(requestType, request, choice) {
    const choiceRecord = typeof choice === "string" ? { value: choice, label: choice } : choice;
    const choiceLabel = text(choiceRecord.label || choiceRecord.value);
    const choiceValue = text(choiceRecord.value || choiceLabel);
    if (requestType === RuntimeInteractionTypes.APPROVAL) {
        const accepted = isApprovalAcceptedValue(
            /** @type {import("../../../shared/session/session-runtime-interactions.js").RuntimeInteractionRequest} */
            (request),
            choiceValue,
        );
        return {
            outcome: accepted ? RuntimeInteractionOutcomes.ACCEPTED : RuntimeInteractionOutcomes.CANCELED,
            value: choiceValue,
            valueLabel: choiceLabel,
        };
    }
    return {
        outcome: RuntimeInteractionOutcomes.SELECTED,
        value: choiceValue,
        valueLabel: choiceLabel,
    };
}

/**
 * @param {string} requestType
 * @param {string} value
 * @param {boolean} hasChoices
 */
export function sessionInteractionTypedResponse(requestType, value, hasChoices) {
    if (hasChoices && requestType === RuntimeInteractionTypes.SELECT) {
        return { outcome: RuntimeInteractionOutcomes.SELECTED, value, valueLabel: "Other" };
    }
    return { outcome: RuntimeInteractionOutcomes.TEXT, value };
}

function ActivityChevronIcon() {
    return (
        <svg className="session-activity-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function activityRowLabel(activityItem) {
    if (activityItem.kind === "tool") return activityItem.toolName || activityItem.title || "tool";
    if (activityItem.kind === "thinking") return "Thinking";
    return "Usage";
}

export function compactToolLine(activityItem) {
    const title = text(activityItem.title || activityItem.toolName || "Tool activity").trim();
    const status = text(activityItem.status || "running");
    return status === "running" ? `${title} running` : title;
}

function activityRowSummary(activityItem) {
    if (activityItem.kind === "tool") return compactToolLine(activityItem);
    return activityRowLabel(activityItem);
}

function activityRowDetail(activityItem) {
    if (activityItem.kind === "tool") return activityItem.output || activityItem.status || "No output.";
    if (activityItem.kind === "thinking") return activityItem.text || "Thinking complete.";
    return activityItem.text || "Usage recorded";
}

function SessionInteractionCard({ item }) {
    const value = text(item.request?.defaultValue);
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const requestType = text(item.request?.type || RuntimeInteractionTypes.TEXT);
    const choices = Array.isArray(item.request?.options) ? item.request.options : [];
    const answer = item.onAnswer;
    const sendAnswer = async (/** @type {Record<string, any>} */ response) => {
        if (!answer || submitting) return;
        setSubmitting(true);
        setError("");
        try {
            await answer(response);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught || "Could not send answer."));
            throw caught;
        } finally {
            setSubmitting(false);
        }
    };
    return (
        <article
            className="session-live-interaction"
            id={item.interactionId ? `interaction-${item.interactionId}` : undefined}
        >
            <strong>{requestType === "approval" ? "Approval needed" : "Agent needs input"}</strong>
            <p>{item.request?.prompt || "The agent is waiting for your answer."}</p>
            {item.request?.artifactReview && item.reviewUrl
                ? (
                    <RunWieldLink
                        variant="primary"
                        className="rw-plan-review-link"
                        href={item.reviewUrl}
                        target="_blank"
                    >
                        Open {String(item.request.artifactReview.kind || "artifact").toUpperCase()}
                    </RunWieldLink>
                )
                : null}
            {answer
                ? (
                    <SessionQuestionForm
                        mode={requestType}
                        state={submitting ? "submitting" : "pending"}
                        error={error}
                        prompt=""
                        value={value}
                        placeholder={item.request?.placeholder || "Answer…"}
                        allowEmpty={item.request?.allowEmpty === true}
                        options={choices.map((choice) => {
                            const choiceRecord = typeof choice === "string" ? { value: choice, label: choice } : choice;
                            return {
                                value: text(choiceRecord.value || choiceRecord.label),
                                label: text(choiceRecord.label || choiceRecord.value),
                                description: text(choiceRecord.description),
                                ...(choiceRecord._meta && typeof choiceRecord._meta === "object"
                                    ? { _meta: choiceRecord._meta }
                                    : {}),
                            };
                        })}
                        onResponse={sendAnswer}
                    />
                )
                : null}
        </article>
    );
}

/** @param {{ items?: Array<Record<string, any>>, events?: Array<Record<string, any>>, emptyMessage?: string }} props */
function SessionActivityRow({ item, groupOpen }) {
    const [thinkingOpen, setThinkingOpen] = useState(groupOpen);
    useEffect(() => {
        if (item.kind === "thinking") setThinkingOpen(groupOpen);
    }, [groupOpen, item.kind]);
    return (
        <details
            className={`session-activity-row activity-${item.kind || "item"} status-${item.status || "complete"}`}
            {...(item.kind === "thinking"
                ? {
                    open: thinkingOpen,
                    onToggle: (event) => {
                        if (event.target === event.currentTarget) setThinkingOpen(event.currentTarget.open);
                    },
                }
                : {})}
        >
            <summary>
                <ActivityChevronIcon />
                <span>{activityRowSummary(item)}</span>
            </summary>
            <p>{activityRowDetail(item)}</p>
        </details>
    );
}

function SessionActivityGroup({ item }) {
    const [open, setOpen] = useState(false);
    return (
        <details
            className="session-activity-group"
            open={open}
            onToggle={(event) => {
                if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
            }}
        >
            <summary className="session-activity-group-summary">
                <ActivityChevronIcon />
                <strong>{item.title || "Activity"}</strong>
                <span>{item.count || item.items?.length || 0} events</span>
            </summary>
            <div className="session-activity-rows">
                {(Array.isArray(item.items) ? item.items : []).map((activityItem, index) => (
                    <SessionActivityRow
                        key={activityItem.key || `activity:${index}`}
                        item={activityItem}
                        groupOpen={open}
                    />
                ))}
            </div>
        </details>
    );
}

export function SessionTimeline({ items, events, emptyMessage = "", sessionPath = "", onRetryWorkRecord }) {
    const timelineItems = items || reduceSessionEvents(events || []);
    if (!timelineItems.length) {
        return emptyMessage
            ? (
                <section className="session-timeline empty-state">
                    <p>{emptyMessage}</p>
                </section>
            )
            : null;
    }
    return (
        <ol className="session-timeline" aria-label="Session timeline">
            {timelineItems.map((item, index) => (
                <li key={item.key || `${item.kind}:${index}`} className={`session-timeline-item item-${item.kind}`}>
                    {item.kind === "busy"
                        ? (
                            <RunWieldThinkingDots
                                label={Array.isArray(item.busyLines) && item.busyLines.length > 0
                                    ? item.busyLines[0]
                                    : "Working..."}
                            />
                        )
                        : item.kind === "workflow"
                        ? (
                            <article
                                className={`rw-workflow-block status-${item.status}`}
                                aria-label={displayAgentName(text(item.workflowMessage).replaceAll("_", "-"))}
                            >
                                <header>
                                    <strong>{displayAgentName(text(item.workflowMessage).replaceAll("_", "-"))}</strong>
                                    <span>
                                        {item.status === "running"
                                            ? "In progress"
                                            : item.status === "failed"
                                            ? "Failed"
                                            : "Completed"}
                                    </span>
                                </header>
                                <MarkdownView markdown={workflowToolMarkdown(item)} />
                                {sessionPath && item.details?.artifact?.artifactId
                                    ? (
                                        <RunWieldLink
                                            href={`${sessionPath}/artifacts/${
                                                encodeURIComponent(item.details.artifact.artifactId)
                                            }`}
                                            variant="secondary"
                                        >
                                            Open {item.details.artifact.title || "artifact"}
                                        </RunWieldLink>
                                    )
                                    : null}
                                {item.agentName || item.timestamp
                                    ? (
                                        <footer>
                                            {item.agentName ? <span>{displayAgentName(item.agentName)}</span> : null}
                                            {item.timestamp
                                                ? <time>{formatSessionTimelineTime(item.timestamp)}</time>
                                                : null}
                                        </footer>
                                    )
                                    : null}
                            </article>
                        )
                        : null}
                    {item.kind === "message"
                        ? (
                            <article className={`session-message role-${item.role}`}>
                                <header>
                                    <strong>
                                        {item.role === "user" ? "You" : displayAgentName(item.agentName || "Ideator")}
                                    </strong>
                                </header>
                                {item.role === "assistant"
                                    ? <MarkdownView markdown={item.text || ""} />
                                    : <p>{item.text}</p>}
                                {Array.isArray(item.images) && item.images.length
                                    ? (
                                        <div className="rw-image-previews" aria-label="Message images">
                                            {item.images.map((image, imageIndex) =>
                                                image.base64 && /^image\/(png|jpeg|jpg|gif|webp)$/.test(image.mimeType)
                                                    ? (
                                                        <SessionImage
                                                            key={image.ref || imageIndex}
                                                            image={image}
                                                            label={`Attached image ${imageIndex + 1}`}
                                                        />
                                                    )
                                                    : null
                                            )}
                                        </div>
                                    )
                                    : null}
                                {item.footerText || item.completedTimestamp
                                    ? (
                                        <footer className="session-message-footer">
                                            {item.footerText ? <span>{item.footerText}</span> : null}
                                            {item.footerText && item.completedTimestamp
                                                ? <span aria-hidden="true">-</span>
                                                : null}
                                            {item.completedTimestamp
                                                ? <time>{formatSessionTimelineTime(item.completedTimestamp)}</time>
                                                : null}
                                        </footer>
                                    )
                                    : null}
                            </article>
                        )
                        : item.kind === "thinking"
                        ? (
                            <details className="session-thinking">
                                <summary>
                                    <ActivityChevronIcon />
                                    <span>
                                        {item.done
                                            ? `${displayAgentName(item.agentName || "Ideator")} thinking complete`
                                            : (
                                                <RunWieldThinkingDots
                                                    label={`${displayAgentName(item.agentName || "Ideator")} thinking`}
                                                />
                                            )}
                                    </span>
                                </summary>
                                <p>{item.text || "Thinking details hidden."}</p>
                            </details>
                        )
                        : item.kind === "tool"
                        ? (
                            <details className={`session-tool status-${item.status}`}>
                                <summary>
                                    <ActivityChevronIcon />
                                    <span>{compactToolLine(item)}</span>
                                </summary>
                                <p>{activityRowDetail(item)}</p>
                            </details>
                        )
                        : item.kind === "activity"
                        ? <SessionActivityGroup item={item} />
                        : item.kind === "interaction"
                        ? <SessionInteractionCard item={item} />
                        : item.kind === "plan-review" || item.kind === "code-review"
                        ? (
                            <article
                                className="session-plan-review-card"
                                id={item.interactionId ? `interaction-${item.interactionId}` : undefined}
                                aria-label={item.kind === "code-review"
                                    ? "Code ready for review"
                                    : "Plan ready for review"}
                            >
                                <p className="kicker">
                                    {item.kind === "code-review" ? "Code ready for review" : "Plan ready for review"}
                                </p>
                                <strong>
                                    {item.kind === "code-review"
                                        ? item.request?.codeReview?.planName || "Workspace changes"
                                        : item.request?.planReview?.planName || "Plan"}
                                </strong>
                                {item.kind === "plan-review"
                                    ? (
                                        <p>
                                            {item.request?.planReview?.classification || "PLANNED_CHANGE"}
                                            {item.request?.planReview?.expectedStatus
                                                ? ` · ${item.request.planReview.expectedStatus}`
                                                : ""}
                                        </p>
                                    )
                                    : <p>Review the current workflow diff without leaving this Workspace.</p>}
                                {item.reviewUrl
                                    ? (
                                        <RunWieldLink
                                            variant="primary"
                                            className="rw-plan-review-link"
                                            href={item.reviewUrl}
                                        >
                                            {item.kind === "code-review" ? "Review Code" : "Review Plan"}
                                        </RunWieldLink>
                                    )
                                    : null}
                            </article>
                        )
                        : item.kind === "delivery-report"
                        ? (
                            <DeliveryReportCard
                                report={item.report}
                                sessionPath={sessionPath}
                                onRetryWorkRecord={onRetryWorkRecord}
                            />
                        )
                        : item.kind === "system-event" && item.header === "Segment"
                        ? (
                            <div className={`session-segment-marker segment-${item.segmentKind || "session"}`}>
                                <span>{item.text}</span>
                            </div>
                        )
                        : item.kind === "system-event"
                        ? (
                            <article className={`session-system-event level-${item.level || "info"}`}>
                                <header>
                                    <strong>{item.header || "System"}</strong>
                                </header>
                                {Array.isArray(item.lines) && item.lines.length > 1
                                    ? (
                                        <ul>
                                            {item.lines.map((line, lineIndex) => (
                                                <li key={`${item.key}:line:${lineIndex}`}>{line}</li>
                                            ))}
                                        </ul>
                                    )
                                    : <p>{item.text}</p>}
                            </article>
                        )
                        : item.kind === "interruption"
                        ? <p className="session-interruption">The agent was interrupted. Ask it to continue.</p>
                        : <p className={`session-status-row level-${item.level || "info"}`}>{item.text}</p>}
                </li>
            ))}
        </ol>
    );
}

export default SessionTimeline;
