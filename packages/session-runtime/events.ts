/**
 * @module @runwield/session-runtime/events
 * Adapter-neutral SessionRuntime event vocabulary.
 */
import type { JsonValue } from "@runwield/parsing/jsonc";
import type { ActiveModelState } from "@runwield/pi-ai";
import type { ToolResult } from "@runwield/pi-ai/turn";
import type { DeliveryReport } from "../../src/shared/workflow/delivery-report.ts";
import type { SequenceReviewPresentation } from "@runwield/plans/lifecycle";
import type { RuntimeInteractionOutcome, RuntimeInteractionType } from "./interactions.ts";
import type { WorkflowProgressFact } from "../../src/shared/workflow/workflow-presentation.ts";

/** An image carried by a user message or queued input, with optional persisted reference. */
export type ImageAttachment = {
    base64: string;
    mimeType: string;
    ref?: string;
    path?: string;
};

/** Image data or a persisted reference displayed with a user message. */
export interface RuntimeMessageImage {
    base64?: string;
    mimeType?: string;
    ref?: string;
    path?: string;
}

/** Display category supplied with every tool event. */
export type RuntimeToolKind =
    "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

/** Workflow context projected in a Session. It reflects workflow state for display. */
export type WorkflowContext = {
    routingIntent?: string;
    complexity?: string;
    summary?: string;
    planName?: string;
    parentPlan?: string;
    planId?: string;
    status?: string;
    classification?: string;
    progressFacts?: WorkflowProgressFact[];
    validationProgress?: RuntimeValidationProgress;
    canRun?: boolean;
    canResume?: boolean;
    canRecover?: boolean;
    liveQuestion?: boolean;
    livePlanReview?: boolean;
    liveCodeReview?: boolean;
    liveReviewUrl?: string;
};

/** Current state of a background task. */
export type BackgroundTaskState = "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** A keyboard shortcut and its label for display. */
export interface RuntimeKeyboardHelpItem {
    key: string;
    description: string;
}

/** Search layer that supplied a prompt template. */
export type PromptTemplateSource = "local" | "home" | "bundled" | "package";

/** Prompt template available to the Session command catalog. */
export interface PromptTemplateMeta {
    name: string;
    description: string;
    argumentHint: string | undefined;
    model: string | undefined;
    agent: string | undefined;
    thinkingLevel: string | undefined;
    path: string;
    source: PromptTemplateSource;
    packageSource?: string | undefined;
    packageBaseDir?: string | undefined;
}

/** Search layer that supplied a skill. */
export type SkillSource = "local" | "home" | "bundled" | "external";

/** Skill available to the Session command catalog. */
export interface SkillRecord {
    name: string;
    description: string;
    path: string;
    source: SkillSource;
    disableModelInvocation: boolean;
    directoryName: string;
}

/** Reasons a Session requests a user's attention. */
export type RuntimeAttentionNotificationEventName = "agentStopped" | "planWritten" | "userInterview";

/** Identify an attention reason emitted by Session Runtime. */
export function isRuntimeAttentionNotificationEventName(
    eventName: string,
): eventName is RuntimeAttentionNotificationEventName {
    return eventName === "agentStopped" || eventName === "planWritten" || eventName === "userInterview";
}

/** Discriminators for events shared by live and replay consumers. */
export const RuntimeEventTypes = Object.freeze({
    SESSION_CREATED: "session_created",
    SESSION_LOADED: "session_loaded",
    SESSION_CLOSED: "session_closed",
    SESSION_REPLACED: "session_replaced",
    USER_MESSAGE: "user_message",
    ASSISTANT_TEXT_DELTA: "assistant_text_delta",
    ASSISTANT_THINKING_DELTA: "assistant_thinking_delta",
    ASSISTANT_THINKING_END: "assistant_thinking_end",
    TOOL_START: "tool_start",
    TOOL_UPDATE: "tool_update",
    TOOL_END: "tool_end",
    SYSTEM_STATUS: "system_status",
    TURN_START: "turn_start",
    TURN_END: "turn_end",
    BUSY_CHANGED: "busy_changed",
    AGENT_CHANGED: "agent_changed",
    MODEL_CHANGED: "model_changed",
    THINKING_LEVEL_CHANGED: "thinking_level_changed",
    WORKFLOW_CONTEXT_CHANGED: "workflow_context_changed",
    SESSION_RENAMED: "session_renamed",
    INPUT_STATE_CHANGED: "input_state_changed",
    MESSAGES_CLEARED: "messages_cleared",
    QUEUED_MESSAGE_CHANGED: "queued_message_changed",
    USAGE: "usage",
    CANCELLATION: "cancellation",
    BACKGROUND_TASK_SETTLED: "background_task_settled",
    TERMINAL_ERROR: "terminal_error",
    INTERACTION_REQUESTED: "interaction_requested",
    INTERACTION_RESOLVED: "interaction_resolved",
    INTERACTION_CANCELED: "interaction_canceled",
    PLAN_REVIEW_LINK: "plan_review_link",
    ATTENTION_REQUESTED: "attention_requested",
    KEYBOARD_HELP: "keyboard_help",
    MANAGED_SYNC_STATE_CHANGED: "managed_sync_state_changed",
    COMMAND_CATALOG_CHANGED: "command_catalog_changed",
});

/** Session identity, timing, and optional turn and transcript correlation for an event. */
export interface RuntimeEventBase {
    type: string;
    sessionId: string;
    timestamp: string;
    turnId?: string;
    _meta?: RuntimeEventMetadata;
    /** Stable committed transcript projection cursor. */
    eventId?: string;
}

/** Replay origin and managed Session identity attached to an event by the publisher. */
export interface RuntimeEventMetadata {
    replay?: boolean;
    entryId?: string;
    entryType?: string;
    role?: string;
    timestamp?: string;
    managed?: boolean;
    runwieldSessionId?: string;
    sessionManagerId?: string;
    sessionPath?: string;
}

/** Announce that a Session was created, loaded, or closed. */
export type RuntimeSessionLifecycleEvent = RuntimeEventBase & {
    type: "session_created" | "session_loaded" | "session_closed";
    cwd?: string;
};

/** Identify the replacement Session and next action for the Epic’s next child Plan. */
export type RuntimeEpicContinuationSessionReplacedEvent = RuntimeEventBase & {
    type: "session_replaced";
    oldSessionId: string;
    newSessionId: string;
    reason: "epic_continuation";
    parentPlanName: string;
    completedPlanName: string;
    childPlanName: string;
    action: "plan" | "readiness_execute" | "execute";
};
/** Identify the replacement Session opened to follow up on a Plan’s execution. */
export type RuntimeExecutionFollowUpSessionReplacedEvent = RuntimeEventBase & {
    type: "session_replaced";
    oldSessionId: string;
    newSessionId: string;
    reason: "execution_follow_up";
    planName: string;
};
/** Identify the replacement Session opened for a named prompt template. */
export type RuntimePromptTemplateSessionReplacedEvent = RuntimeEventBase & {
    type: "session_replaced";
    oldSessionId: string;
    newSessionId: string;
    reason: "prompt_template";
    templateName: string;
};
/** Connect the previous and replacement Session identities with the reason for the handoff. */
export type RuntimeSessionReplacedEvent =
    | RuntimeEpicContinuationSessionReplacedEvent
    | RuntimeExecutionFollowUpSessionReplacedEvent
    | RuntimePromptTemplateSessionReplacedEvent;

/** Publish user-visible text and images, including messages generated from background-task results. */
export type RuntimeUserMessageEvent = RuntimeEventBase & {
    type: "user_message";
    text: string;
    messageId: string;
    images: RuntimeMessageImage[];
    origin?: "background_task_result";
    taskId?: string;
};

/** Append text to an assistant, workflow, or review-result message. */
export type RuntimeAssistantTextDeltaEvent = RuntimeEventBase & {
    type: "assistant_text_delta";
    delta: string;
    messageId: string;
    agentName: string;
    messageKind: "assistant" | "workflow" | "review_result";
    workflowMessage?: string;
    toolCallId?: string;
    approved?: boolean;
};

/** Append a thinking chunk to an assistant message. */
export type RuntimeAssistantThinkingDeltaEvent = RuntimeEventBase & {
    type: "assistant_thinking_delta";
    delta: string;
    messageId: string;
    agentName: string;
};

/** Mark the end of a streamed thinking message. */
export type RuntimeAssistantThinkingEndEvent = RuntimeEventBase & {
    type: "assistant_thinking_end";
    messageId: string;
    agentName: string;
};

/** Identity and display details shared by the start, updates, and end of one tool call. */
export type RuntimeToolIdentity = { toolCallId: string; toolName: string; title: string; kind: RuntimeToolKind };

/** Announce a tool call before it starts, with arguments when available. */
export type RuntimeToolStartEvent = RuntimeEventBase & RuntimeToolIdentity & { type: "tool_start"; args?: JsonValue };

/** Publish the current output and structured result from a running tool call. */
export type RuntimeToolUpdateEvent = RuntimeEventBase & RuntimeToolIdentity & ToolResult & { type: "tool_update" };

/** Publish the final tool result, failure flag, and elapsed time if measured. */
export type RuntimeToolEndEvent = RuntimeEventBase &
    RuntimeToolIdentity &
    ToolResult & { type: "tool_end"; isError: boolean; durationMs: number | null };

/** Disposition of one validation check within a workflow. */
export type RuntimeValidationCheckResult = "pending" | "running" | "passed" | "failed" | "skipped" | "canceled";

/** Current reported disposition of each validation check. */
export interface RuntimeValidationCheckResults {
    ci: RuntimeValidationCheckResult;
    semanticReview: RuntimeValidationCheckResult;
    humanReview: RuntimeValidationCheckResult;
    merge: RuntimeValidationCheckResult;
}

/** Progress and publication evidence displayed during workflow validation. */
export interface RuntimeValidationProgress {
    kind: "workflow" | "mechanical";
    outcome: "running" | "paused" | "verified" | "failed";
    stage: "cycle" | "ci" | "engineer_repair" | "semantic_review" | "human_review" | "merge" | "manual_qa" | "terminal";
    checks: RuntimeValidationCheckResults;
    cycle?: number;
    maxCycles?: number;
    totalCycle?: number;
    repairAttempt?: number;
    maxRepairAttempts?: number;
    message?: string;
    workRecordFailed?: boolean;
    workRecordPlanName?: string;
    deliveryReport?: DeliveryReport;
}

/** Publish a status message with its severity and optional validation progress. */
export type RuntimeSystemStatusEvent = RuntimeEventBase & {
    type: "system_status";
    messageId: string;
    message: string;
    level: "info" | "success" | "warning" | "error";
    header?: string;
    validationProgress?: RuntimeValidationProgress;
};

/** Outcome fields included when the Runtime settles a turn. */
export interface RuntimeTurnSummary {
    turns: number;
    ok?: boolean;
    error?: string;
}

/** Announce the start or settlement of a turn, with any final outcome. */
export type RuntimeTurnEvent = RuntimeEventBase & {
    type: "turn_start" | "turn_end";
    ok?: boolean;
    stopReason?: string;
    result?: RuntimeTurnSummary;
};

/** Signal that the Session entered or left a busy state. */
export type RuntimeBusyChangedEvent = RuntimeEventBase & { type: "busy_changed"; busy: boolean };

/** Announce the active Agent and any display details supplied at handoff. */
export type RuntimeAgentChangedEvent = RuntimeEventBase & {
    type: "agent_changed";
    messageId: string;
    agentName: string;
    displayName?: string;
    model?: string;
    rootHandoff?: boolean;
    busyLines?: readonly string[];
};

/** Publish the current model and optional provider selection. */
export type RuntimeModelChangedEvent = RuntimeEventBase & ActiveModelState & { type: "model_changed" };

/** Publish the current model thinking level. */
export type RuntimeThinkingLevelChangedEvent = RuntimeEventBase & {
    type: "thinking_level_changed";
    thinkingLevel: string;
};

/** Publish workflow context for status and progress displays. */
export type RuntimeWorkflowContextChangedEvent = RuntimeEventBase & {
    type: "workflow_context_changed";
    workflowContext: WorkflowContext;
};

/** Publish the Session’s updated display name. */
export type RuntimeSessionRenamedEvent = RuntimeEventBase & { type: "session_renamed"; name: string };

/** Control whether a view accepts input or clears its displayed messages. */
export type RuntimePresentationStateEvent =
    | (RuntimeEventBase & { type: "input_state_changed"; enabled: boolean })
    | (RuntimeEventBase & { type: "messages_cleared" });

/** Pending user input with a stable ID and its requested delivery mode. */
export interface RuntimeQueuedMessage {
    inputSurface?: NotificationSurface;
    id: string;
    text: string;
    images: ImageAttachment[];
    delivery: "steer" | "next_turn";
    queuedAt: string;
}

/** Report when a queued message is added, consumed, or removed. */
export type RuntimeQueuedMessageEvent = RuntimeEventBase & {
    type: "queued_message_changed";
    status: "queued" | "consumed" | "dequeued";
    message: RuntimeQueuedMessage;
    reason?: string;
};

/** Measured token counts and cost. A null field means no measurement was supplied. */
export interface RuntimeUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number | null;
    contextWindow?: number;
}

/** Publish normalized token counts and cost for a provider turn. */
export type RuntimeUsageEvent = RuntimeEventBase & { type: "usage"; usage: RuntimeUsage };

/** Report a cancellation with its scope and optional display message. */
export type RuntimeCancellationEvent = RuntimeEventBase & {
    type: "cancellation";
    messageId: string;
    reason?: string;
    aborted?: boolean;
    message?: string;
    scope?: "agent" | "operation" | "session";
};
/** Report the resulting state of a background task by task ID. */
export type RuntimeBackgroundTaskSettledEvent = RuntimeEventBase & {
    type: "background_task_settled";
    taskId: string;
    state: BackgroundTaskState;
};

/** Report a terminal failure and indicate whether its message was already displayed. */
export type RuntimeTerminalErrorEvent = RuntimeEventBase & {
    type: "terminal_error";
    messageId: string;
    message: string;
    messageAlreadyReported?: boolean;
    error?: string | Error;
};

/** Review facts available to clients while the interaction is pending. */
export interface RuntimePlanReviewEventDetails {
    sequenceDocuments?: Omit<SequenceReviewPresentation, "body">[];
    planId?: string;
    planName?: string;
    classification?: string;
    expectedRevision?: string;
    expectedStatus?: string;
}

/** Report when a user interaction starts, resolves, or is canceled. */
export type RuntimeInteractionLifecycleEvent = RuntimeEventBase & {
    type: "interaction_requested" | "interaction_resolved" | "interaction_canceled";
    interactionId: string;
    interactionType?: RuntimeInteractionType;
    prompt?: string;
    review?: RuntimePlanReviewEventDetails;
    outcome?: RuntimeInteractionOutcome;
    message?: string;
};

/** Publish a shareable Plan review link with its announcement and available revision details. */
export type RuntimePlanReviewLinkEvent = RuntimeEventBase & {
    type: "plan_review_link";
    messageId: string;
    planName: string;
    reviewerUrl: string;
    spaceId?: string;
    serverUrl?: string;
    revision?: number;
    reused?: boolean;
    message: string;
};

/** Application surface associated with a queued input or attention notification. */
export type NotificationSurface = "workspace" | "tui" | "acp" | "test";

/** Ask an adapter to notify the user for a Session event. */
export type RuntimeAttentionRequestedEvent = RuntimeEventBase & {
    notificationSurface?: NotificationSurface;
    type: "attention_requested";
    reason: RuntimeAttentionNotificationEventName;
    agentName?: string;
    sessionName?: string;
};

/** Publish the title and shortcuts for a keyboard help display. */
export type RuntimeKeyboardHelpEvent = RuntimeEventBase & {
    type: "keyboard_help";
    title: string;
    items: RuntimeKeyboardHelpItem[];
};

/** State of the local Session view relative to the managed transcript and its current owner. */
export type RuntimeManagedSyncStatus = "current" | "syncing" | "active_elsewhere" | "blocked" | "degraded";

/** Report synchronization status and the local and latest known transcript generations. */
export type RuntimeManagedSyncStateEvent = RuntimeEventBase & {
    type: "managed_sync_state_changed";
    status: RuntimeManagedSyncStatus;
    localGeneration: number | null;
    latestGeneration: number | null;
    owningSurfaceKind?: "workspace" | "tui" | "acp" | "unknown";
    message?: string;
};

/** Publish the current prompt templates and skills available in a Session. */
export type RuntimeCommandCatalogChangedEvent = RuntimeEventBase & {
    type: "command_catalog_changed";
    promptTemplates: PromptTemplateMeta[];
    skills: SkillRecord[];
};

/** The discriminated union delivered to Session Runtime observers and used for replay. */
export type SessionRuntimeEvent =
    | RuntimeSessionLifecycleEvent
    | RuntimeSessionReplacedEvent
    | RuntimeUserMessageEvent
    | RuntimeAssistantTextDeltaEvent
    | RuntimeAssistantThinkingDeltaEvent
    | RuntimeAssistantThinkingEndEvent
    | RuntimeToolStartEvent
    | RuntimeToolUpdateEvent
    | RuntimeToolEndEvent
    | RuntimeSystemStatusEvent
    | RuntimeTurnEvent
    | RuntimeBusyChangedEvent
    | RuntimeAgentChangedEvent
    | RuntimeModelChangedEvent
    | RuntimeThinkingLevelChangedEvent
    | RuntimeWorkflowContextChangedEvent
    | RuntimeSessionRenamedEvent
    | RuntimePresentationStateEvent
    | RuntimeQueuedMessageEvent
    | RuntimeUsageEvent
    | RuntimeCancellationEvent
    | RuntimeBackgroundTaskSettledEvent
    | RuntimeTerminalErrorEvent
    | RuntimeInteractionLifecycleEvent
    | RuntimePlanReviewLinkEvent
    | RuntimeAttentionRequestedEvent
    | RuntimeKeyboardHelpEvent
    | RuntimeManagedSyncStateEvent
    | RuntimeCommandCatalogChangedEvent;

type RuntimeEventDefaultField = "sessionId" | "timestamp" | "messageId" | "images" | "level";

type WithEventDefaults<Event extends SessionRuntimeEvent> = Event extends SessionRuntimeEvent
    ? Omit<Event, RuntimeEventDefaultField> & Partial<Pick<Event, Extract<keyof Event, RuntimeEventDefaultField>>>
    : never;

/** Semantic fields supplied by a producer before the Runtime applies event defaults. */
export type RuntimeEventDraft = WithEventDefaults<SessionRuntimeEvent>;
type ValidationCheck = keyof RuntimeValidationCheckResults;
type ValidationCounter = "cycle" | "maxCycles" | "totalCycle" | "repairAttempt" | "maxRepairAttempts";
type UsageMeasurement = Exclude<keyof RuntimeUsage, "contextWindow">;

const MESSAGE_ID_EVENT_TYPES = new Set<string>([
    RuntimeEventTypes.USER_MESSAGE,
    RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
    RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
    RuntimeEventTypes.ASSISTANT_THINKING_END,
    RuntimeEventTypes.SYSTEM_STATUS,
    RuntimeEventTypes.TERMINAL_ERROR,
    RuntimeEventTypes.CANCELLATION,
    RuntimeEventTypes.PLAN_REVIEW_LINK,
    RuntimeEventTypes.AGENT_CHANGED,
]);

const RUNTIME_EVENT_TYPE_VALUES = new Set<string>(Object.values(RuntimeEventTypes));
const TOOL_KINDS = new Set([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
]);
const VALIDATION_KINDS = new Set(["workflow", "mechanical"]);
const VALIDATION_OUTCOMES = new Set(["running", "paused", "verified", "failed"]);
const VALIDATION_STAGES = new Set([
    "cycle",
    "ci",
    "engineer_repair",
    "semantic_review",
    "human_review",
    "merge",
    "manual_qa",
    "terminal",
]);
const VALIDATION_CHECK_RESULTS = new Set(["pending", "running", "passed", "failed", "skipped", "canceled"]);
const MANAGED_SYNC_STATUSES = new Set(["current", "syncing", "active_elsewhere", "blocked", "degraded"]);
const MANAGED_SYNC_SURFACES = new Set(["workspace", "tui", "acp", "unknown"]);
const BACKGROUND_TASK_STATES = new Set<BackgroundTaskState>([
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
]);
const PROMPT_TEMPLATE_SOURCES = new Set<PromptTemplateSource>(["local", "home", "bundled", "package"]);
const SKILL_SOURCES = new Set<SkillSource>(["local", "home", "bundled", "external"]);
const FORBIDDEN_SYNC_STATE_KEYS = new Set([
    "path",
    "transcriptPath",
    "sessionPath",
    "piSessionId",
    "ownerInstanceId",
    "operationId",
    "fence",
    "proof",
    "leaseProof",
]);

function validateRuntimeValidationProgress(progress: RuntimeValidationProgress, type: string) {
    requireRuntimeEvent(
        Boolean(progress && typeof progress === "object"),
        type,
        "validationProgress must be an object",
    );
    const value = progress;
    requireRuntimeEvent(VALIDATION_KINDS.has(value.kind), type, "validationProgress.kind is invalid");
    requireRuntimeEvent(VALIDATION_OUTCOMES.has(value.outcome), type, "validationProgress.outcome is invalid");
    requireRuntimeEvent(VALIDATION_STAGES.has(value.stage), type, "validationProgress.stage is invalid");
    requireRuntimeEvent(value.checks && typeof value.checks === "object", type, "validationProgress.checks required");
    for (const field of ["ci", "semanticReview", "humanReview", "merge"] satisfies ValidationCheck[]) {
        requireRuntimeEvent(
            VALIDATION_CHECK_RESULTS.has(value.checks[field]),
            type,
            `validationProgress.checks.${field} is invalid`,
        );
    }
    const requirePositiveInteger = (field: ValidationCounter) => {
        if (value[field] === undefined) return;
        requireRuntimeEvent(
            Number.isInteger(value[field]) && value[field] > 0,
            type,
            `validationProgress.${field} must be a positive integer`,
        );
    };
    for (const field of [
        "cycle",
        "maxCycles",
        "totalCycle",
        "repairAttempt",
        "maxRepairAttempts",
    ] satisfies ValidationCounter[]) {
        requirePositiveInteger(field);
    }
    if (value.kind === "workflow") {
        for (const field of ["cycle", "maxCycles", "totalCycle"] satisfies ValidationCounter[]) {
            requireRuntimeEvent(value[field] !== undefined, type, `validationProgress.${field} required for workflow`);
        }
    }
    if (value.maxCycles !== undefined) {
        requireRuntimeEvent(value.cycle !== undefined, type, "validationProgress.cycle required with maxCycles");
        requireRuntimeEvent(value.cycle <= value.maxCycles, type, "validationProgress.cycle must be <= maxCycles");
    }
    requireRuntimeEvent(
        (value.maxRepairAttempts === undefined) === (value.repairAttempt === undefined),
        type,
        "validationProgress repairAttempt and maxRepairAttempts must be provided together",
    );
    if (value.maxRepairAttempts !== undefined) {
        requireRuntimeEvent(
            value.repairAttempt! <= value.maxRepairAttempts,
            type,
            "validationProgress.repairAttempt must be <= maxRepairAttempts",
        );
    }
    if (value.kind === "mechanical") {
        requireRuntimeEvent(
            value.checks.semanticReview === "skipped" &&
                value.checks.humanReview === "skipped" &&
                value.checks.merge === "skipped",
            type,
            "mechanical validation must skip non-CI checks",
        );
    }
    const runningChecks = Object.values(value.checks).filter((check) => check === "running");
    if (value.stage === "ci") {
        requireRuntimeEvent(
            value.checks.ci !== "pending" && value.checks.ci !== "skipped",
            type,
            "ci stage requires active or completed CI",
        );
    }
    if (value.stage === "semantic_review") {
        requireRuntimeEvent(
            value.checks.semanticReview !== "pending" && value.checks.semanticReview !== "skipped",
            type,
            "semantic_review stage requires active or completed semantic review",
        );
    }
    if (value.stage === "human_review") {
        requireRuntimeEvent(
            value.checks.humanReview !== "pending" && value.checks.humanReview !== "skipped",
            type,
            "human_review stage requires active or completed human review",
        );
    }
    if (value.stage === "merge") {
        requireRuntimeEvent(
            value.checks.merge !== "pending" && value.checks.merge !== "skipped",
            type,
            "merge stage requires active or completed merge",
        );
    }
    if (value.outcome === "verified" || value.outcome === "failed") {
        const checkValues = Object.values(value.checks);
        const failedOrCanceledChecks = checkValues.filter((check) => check === "failed" || check === "canceled");
        requireRuntimeEvent(value.stage === "terminal", type, "terminal validation outcome requires terminal stage");
        requireRuntimeEvent(runningChecks.length === 0, type, "terminal validation outcome cannot have running checks");
        requireRuntimeEvent(
            !checkValues.includes("pending"),
            type,
            "terminal validation outcome cannot have pending checks",
        );
        if (value.outcome === "verified") {
            requireRuntimeEvent(
                failedOrCanceledChecks.length === 0,
                type,
                "verified validation outcome cannot have failed or canceled checks",
            );
        }
        if (value.outcome === "failed") {
            requireRuntimeEvent(
                failedOrCanceledChecks.length > 0,
                type,
                "failed validation outcome requires a failed or canceled check",
            );
        }
    }
    if (value.stage === "terminal") {
        requireRuntimeEvent(
            value.outcome === "verified" || value.outcome === "failed" || value.outcome === "paused",
            type,
            "terminal stage requires terminal or paused outcome",
        );
    }
    if (value.deliveryReport !== undefined) {
        const report = value.deliveryReport;
        requireRuntimeEvent(
            value.stage === "terminal" && value.outcome === "verified",
            type,
            "delivery report requires completed workflow",
        );
        requireRuntimeEvent(
            report?.version === 1 &&
                typeof report.planName === "string" &&
                typeof report.heading === "string" &&
                typeof report.settings === "string" &&
                typeof report.workRecordFailed === "boolean" &&
                Array.isArray(report.rows) &&
                Array.isArray(report.artifacts),
            type,
            "delivery report is invalid",
        );
        for (const row of report.rows) {
            requireRuntimeEvent(
                typeof row.label === "string" &&
                    typeof row.outcome === "string" &&
                    typeof row.detail === "string" &&
                    ["success", "warning", "neutral"].includes(row.tone),
                type,
                "delivery report row is invalid",
            );
        }
        for (const artifact of report.artifacts) {
            requireRuntimeEvent(
                typeof artifact.title === "string" &&
                    typeof artifact.path === "string" &&
                    ["plan", "prd", "adr", "work-record", "epic-artifact", "report"].includes(artifact.kind),
                type,
                "delivery report artifact is invalid",
            );
        }
    }
    if (value.workRecordPlanName !== undefined) {
        requireRuntimeEvent(
            typeof value.workRecordPlanName === "string",
            type,
            "validationProgress.workRecordPlanName must be a string",
        );
    }
    if (value.workRecordFailed !== undefined) {
        requireRuntimeEvent(
            typeof value.workRecordFailed === "boolean",
            type,
            "validationProgress.workRecordFailed must be a boolean",
        );
    }
    if (value.message !== undefined) {
        requireRuntimeEvent(typeof value.message === "string", type, "validationProgress.message must be a string");
    }
}

function requireRuntimeEvent(
    condition: boolean | null | undefined,
    type: string,
    requirement: string,
): asserts condition {
    if (!condition) throw new TypeError(`Invalid SessionRuntime event "${type}": ${requirement}`);
}

function validateEventImages(images: RuntimeMessageImage[], type: string, field: string, requireData = false) {
    requireRuntimeEvent(Array.isArray(images), type, `${field} must be an array`);
    for (const image of images) {
        requireRuntimeEvent(
            image &&
                typeof image === "object" &&
                !Array.isArray(image) &&
                ((!requireData && image.base64 === undefined) || typeof image.base64 === "string") &&
                ((!requireData && image.mimeType === undefined) || typeof image.mimeType === "string") &&
                (image.ref === undefined || typeof image.ref === "string") &&
                (image.path === undefined || typeof image.path === "string"),
            type,
            `${field} entry is invalid`,
        );
    }
}

/**
 * Fail at the one outward boundary when a producer violates the semantic
 * contract. Consumer listeners are isolated separately by SessionRuntime.
 */
function assertSessionRuntimeEvent(event: SessionRuntimeEvent): SessionRuntimeEvent {
    requireRuntimeEvent(RUNTIME_EVENT_TYPE_VALUES.has(event.type), event.type, "unknown event type");
    requireRuntimeEvent(
        typeof event.sessionId === "string" && event.sessionId.length > 0,
        event.type,
        "sessionId required",
    );
    requireRuntimeEvent(
        typeof event.timestamp === "string" && event.timestamp.length > 0,
        event.type,
        "timestamp required",
    );
    const value = event;
    const requireString = (field: string, fieldValue: string | undefined) =>
        requireRuntimeEvent(typeof fieldValue === "string", event.type, `${field} must be a string`);

    if (MESSAGE_ID_EVENT_TYPES.has(event.type)) {
        requireRuntimeEvent(
            "messageId" in event && typeof event.messageId === "string",
            event.type,
            "messageId must be a string",
        );
    }
    switch (value.type) {
        case RuntimeEventTypes.SESSION_CREATED:
        case RuntimeEventTypes.SESSION_LOADED:
        case RuntimeEventTypes.SESSION_CLOSED:
            if (value.cwd !== undefined) requireString("cwd", value.cwd);
            break;
        case RuntimeEventTypes.SESSION_REPLACED:
            for (const field of ["oldSessionId", "newSessionId"] as const) requireString(field, value[field]);
            requireRuntimeEvent(
                ["epic_continuation", "execution_follow_up", "prompt_template"].includes(value.reason),
                event.type,
                "reason is invalid",
            );
            if (value.reason === "epic_continuation") {
                for (const field of ["parentPlanName", "completedPlanName", "childPlanName"] as const)
                    requireString(field, value[field]);
                requireRuntimeEvent(
                    ["plan", "readiness_execute", "execute"].includes(value.action),
                    event.type,
                    "action is invalid",
                );
            } else if (value.reason === "prompt_template") {
                requireString("templateName", value.templateName);
            } else {
                requireString("planName", value.planName);
            }
            break;
        case RuntimeEventTypes.USER_MESSAGE:
            requireString("text", value.text);
            validateEventImages(value.images, event.type, "images");
            break;
        case RuntimeEventTypes.ASSISTANT_TEXT_DELTA:
            requireString("delta", value.delta);
            requireString("agentName", value.agentName);
            requireRuntimeEvent(
                ["assistant", "workflow", "review_result"].includes(value.messageKind),
                event.type,
                "messageKind is invalid",
            );
            break;
        case RuntimeEventTypes.ASSISTANT_THINKING_DELTA:
            requireString("delta", value.delta);
            requireString("agentName", value.agentName);
            break;
        case RuntimeEventTypes.ASSISTANT_THINKING_END:
            requireString("agentName", value.agentName);
            break;
        case RuntimeEventTypes.TOOL_START:
        case RuntimeEventTypes.TOOL_UPDATE:
        case RuntimeEventTypes.TOOL_END:
            requireString("toolCallId", value.toolCallId);
            requireString("toolName", value.toolName);
            requireString("title", value.title);
            requireRuntimeEvent(TOOL_KINDS.has(value.kind), event.type, "kind is invalid");
            if (value.type !== RuntimeEventTypes.TOOL_START) {
                requireString("output", value.output);
                requireRuntimeEvent(Array.isArray(value.content), event.type, "content must be an array");
                for (const block of value.content) {
                    const validText = block?.type === "text" && typeof block.text === "string";
                    const validImage =
                        block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
                    requireRuntimeEvent(validText || validImage, event.type, "content block is invalid");
                }
                requireRuntimeEvent(
                    value.details === null || (value.details && typeof value.details === "object"),
                    event.type,
                    "details must be an object or null",
                );
            }
            if (value.type === RuntimeEventTypes.TOOL_END) {
                requireRuntimeEvent(typeof value.isError === "boolean", event.type, "isError must be boolean");
                requireRuntimeEvent(
                    value.durationMs === null || (typeof value.durationMs === "number" && value.durationMs >= 0),
                    event.type,
                    "durationMs must be a non-negative number or null",
                );
            }
            break;
        case RuntimeEventTypes.SYSTEM_STATUS:
            requireString("message", value.message);
            requireRuntimeEvent(
                ["info", "success", "warning", "error"].includes(value.level),
                event.type,
                "level is invalid",
            );
            if (value.validationProgress !== undefined) {
                validateRuntimeValidationProgress(value.validationProgress, event.type);
            }
            break;
        case RuntimeEventTypes.TURN_START:
        case RuntimeEventTypes.TURN_END:
            if (value.ok !== undefined) {
                requireRuntimeEvent(typeof value.ok === "boolean", event.type, "ok must be boolean");
            }
            if (value.stopReason !== undefined) requireString("stopReason", value.stopReason);
            if (value.result !== undefined) {
                requireRuntimeEvent(
                    typeof value.result?.turns === "number",
                    event.type,
                    "result.turns must be a number",
                );
                if (value.result.ok !== undefined) {
                    requireRuntimeEvent(typeof value.result.ok === "boolean", event.type, "result.ok must be boolean");
                }
                if (value.result.error !== undefined) requireString("result.error", value.result.error);
            }
            break;
        case RuntimeEventTypes.BUSY_CHANGED:
            requireRuntimeEvent(typeof value.busy === "boolean", event.type, "busy must be boolean");
            break;
        case RuntimeEventTypes.AGENT_CHANGED:
            requireString("agentName", value.agentName);
            if (value.displayName !== undefined) requireString("displayName", value.displayName);
            if (value.rootHandoff !== undefined) {
                requireRuntimeEvent(typeof value.rootHandoff === "boolean", event.type, "rootHandoff must be boolean");
            }
            if (value.busyLines !== undefined) {
                requireRuntimeEvent(
                    Array.isArray(value.busyLines) && value.busyLines.every((line) => typeof line === "string"),
                    event.type,
                    "busyLines must be an array of strings",
                );
            }
            break;
        case RuntimeEventTypes.MODEL_CHANGED:
            requireString("model", value.model);
            break;
        case RuntimeEventTypes.THINKING_LEVEL_CHANGED:
            requireString("thinkingLevel", value.thinkingLevel);
            break;
        case RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED:
            requireRuntimeEvent(
                value.workflowContext && typeof value.workflowContext === "object",
                event.type,
                "workflowContext must be an object",
            );
            requireRuntimeEvent(
                (typeof value.workflowContext.routingIntent === "string" &&
                    typeof value.workflowContext.complexity === "string") ||
                    (value.workflowContext.routingIntent === undefined &&
                        value.workflowContext.complexity === undefined),
                event.type,
                "routingIntent and complexity must be provided together",
            );
            if ("planName" in value.workflowContext) {
                requireRuntimeEvent(
                    typeof value.workflowContext.planName === "string",
                    event.type,
                    "workflowContext.planName must be a string",
                );
            }
            if ("parentPlan" in value.workflowContext) {
                requireRuntimeEvent(
                    typeof value.workflowContext.parentPlan === "string",
                    event.type,
                    "workflowContext.parentPlan must be a string",
                );
            }
            requireRuntimeEvent(
                typeof value.workflowContext.routingIntent === "string" ||
                    typeof value.workflowContext.planName === "string",
                event.type,
                "workflowContext must contain routing context or a plan name",
            );
            break;
        case RuntimeEventTypes.SESSION_RENAMED:
            requireString("name", value.name);
            break;
        case RuntimeEventTypes.INPUT_STATE_CHANGED:
            requireRuntimeEvent(typeof value.enabled === "boolean", event.type, "enabled must be boolean");
            break;
        case RuntimeEventTypes.MESSAGES_CLEARED:
            break;
        case RuntimeEventTypes.QUEUED_MESSAGE_CHANGED:
            requireRuntimeEvent(
                ["queued", "consumed", "dequeued"].includes(value.status),
                event.type,
                "status is invalid",
            );
            requireRuntimeEvent(value.message && typeof value.message === "object", event.type, "message required");
            requireRuntimeEvent(typeof value.message.id === "string", event.type, "message.id required");
            requireRuntimeEvent(typeof value.message.text === "string", event.type, "message.text required");
            validateEventImages(value.message.images, event.type, "message.images", true);
            requireRuntimeEvent(
                value.message.delivery === "steer" || value.message.delivery === "next_turn",
                event.type,
                "message.delivery is invalid",
            );
            requireString("message.queuedAt", value.message.queuedAt);
            break;
        case RuntimeEventTypes.USAGE:
            requireRuntimeEvent(value.usage && typeof value.usage === "object", event.type, "usage required");
            for (const field of [
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
                "costUsd",
            ] satisfies UsageMeasurement[]) {
                requireRuntimeEvent(
                    value.usage[field] === null ||
                        (typeof value.usage[field] === "number" &&
                            Number.isFinite(value.usage[field]) &&
                            value.usage[field] >= 0),
                    event.type,
                    `usage.${field} must be a finite nonnegative number or null`,
                );
            }
            break;
        case RuntimeEventTypes.CANCELLATION:
            if (value.reason !== undefined) requireString("reason", value.reason);
            if (value.message !== undefined) requireString("message", value.message);
            if (value.aborted !== undefined) {
                requireRuntimeEvent(typeof value.aborted === "boolean", event.type, "aborted must be boolean");
            }
            if (value.scope !== undefined) {
                requireRuntimeEvent(
                    ["agent", "operation", "session"].includes(value.scope),
                    event.type,
                    "scope is invalid",
                );
            }
            break;
        case RuntimeEventTypes.BACKGROUND_TASK_SETTLED:
            requireString("taskId", value.taskId);
            requireRuntimeEvent(BACKGROUND_TASK_STATES.has(value.state), event.type, "state is invalid");
            break;
        case RuntimeEventTypes.TERMINAL_ERROR:
            requireString("message", value.message);
            break;
        case RuntimeEventTypes.INTERACTION_REQUESTED:
        case RuntimeEventTypes.INTERACTION_RESOLVED:
        case RuntimeEventTypes.INTERACTION_CANCELED:
            requireString("interactionId", value.interactionId);
            break;
        case RuntimeEventTypes.PLAN_REVIEW_LINK:
            for (const field of ["planName", "reviewerUrl", "message"] as const) requireString(field, value[field]);
            break;
        case RuntimeEventTypes.ATTENTION_REQUESTED:
            requireRuntimeEvent(
                typeof value.reason === "string" && isRuntimeAttentionNotificationEventName(value.reason),
                event.type,
                "reason is invalid",
            );
            break;
        case RuntimeEventTypes.KEYBOARD_HELP:
            requireString("title", value.title);
            requireRuntimeEvent(value.title.trim().length > 0, event.type, "title must be non-empty");
            requireRuntimeEvent(Array.isArray(value.items), event.type, "items must be an array");
            requireRuntimeEvent(value.items.length > 0, event.type, "items must be non-empty");
            for (const item of value.items) {
                requireRuntimeEvent(item && typeof item === "object", event.type, "item must be an object");
                requireRuntimeEvent(typeof item.key === "string", event.type, "item.key must be a string");
                requireRuntimeEvent(item.key.trim().length > 0, event.type, "item.key must be non-empty");
                requireRuntimeEvent(
                    typeof item.description === "string",
                    event.type,
                    "item.description must be a string",
                );
                requireRuntimeEvent(
                    item.description.trim().length > 0,
                    event.type,
                    "item.description must be non-empty",
                );
            }
            break;
        case RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED:
            for (const key of FORBIDDEN_SYNC_STATE_KEYS) {
                requireRuntimeEvent(!(key in value), event.type, `${key} must not be exposed`);
            }
            requireRuntimeEvent(MANAGED_SYNC_STATUSES.has(value.status), event.type, "status is invalid");
            requireRuntimeEvent(
                value.localGeneration === null || Number.isSafeInteger(value.localGeneration),
                event.type,
                "localGeneration must be an integer or null",
            );
            requireRuntimeEvent(
                value.latestGeneration === null || Number.isSafeInteger(value.latestGeneration),
                event.type,
                "latestGeneration must be an integer or null",
            );
            if (value.owningSurfaceKind !== undefined) {
                requireRuntimeEvent(
                    MANAGED_SYNC_SURFACES.has(value.owningSurfaceKind),
                    event.type,
                    "owningSurfaceKind is invalid",
                );
            }
            if (value.message !== undefined) requireString("message", value.message);
            break;
        case RuntimeEventTypes.COMMAND_CATALOG_CHANGED:
            requireRuntimeEvent(Array.isArray(value.promptTemplates), event.type, "promptTemplates must be an array");
            for (const template of value.promptTemplates) {
                requireRuntimeEvent(
                    typeof template?.name === "string" &&
                        typeof template.description === "string" &&
                        typeof template.path === "string" &&
                        PROMPT_TEMPLATE_SOURCES.has(template.source),
                    event.type,
                    "promptTemplates entry is invalid",
                );
            }
            requireRuntimeEvent(Array.isArray(value.skills), event.type, "skills must be an array");
            for (const skill of value.skills) {
                requireRuntimeEvent(
                    typeof skill?.name === "string" &&
                        typeof skill.description === "string" &&
                        typeof skill.path === "string" &&
                        SKILL_SOURCES.has(skill.source) &&
                        typeof skill.disableModelInvocation === "boolean" &&
                        typeof skill.directoryName === "string",
                    event.type,
                    "skills entry is invalid",
                );
            }
            break;
        default:
            value satisfies never;
    }
    return event;
}

/** Apply Session identity and defaults, then validate the event before delivery. */
export function createSessionRuntimeEvent(sessionId: string, event: RuntimeEventDraft): SessionRuntimeEvent {
    const messageId =
        MESSAGE_ID_EVENT_TYPES.has(event.type) && (!("messageId" in event) || event.messageId === undefined)
            ? `${sessionId}:${event.type}:${crypto.randomUUID()}`
            : undefined;
    const level = event.type === RuntimeEventTypes.SYSTEM_STATUS && event.level === undefined ? "info" : undefined;
    const images = event.type === RuntimeEventTypes.USER_MESSAGE && event.images === undefined ? [] : undefined;
    const runtimeEvent = {
        ...event,
        ...(messageId ? { messageId } : {}),
        ...(level ? { level } : {}),
        ...(images ? { images } : {}),
        sessionId,
        timestamp: event.timestamp === undefined ? new Date().toISOString() : event.timestamp,
    } as SessionRuntimeEvent;
    return assertSessionRuntimeEvent(runtimeEvent);
}
