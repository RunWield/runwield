/**
 * Accepted workflow Custom Tool events.
 *
 * These events are the live, consume-once handoff between an accepted tool call
 * and the workflow owner that can act on it. Transcripts remain display and
 * audit data only.
 */

import type { HostedSession } from "../session/hosted-session.js";
import { AsyncLocalStorage } from "node:async_hooks";

export const WORKFLOW_TOOL_EVENT_CUSTOM_TYPE = "runwield.workflow_tool_event" as const;

export type WorkflowToolEventKind =
    | "triage_report"
    | "plan_written"
    | "task_completed"
    | "review_diff"
    | "review_complete"
    | "qa_checklist_generated"
    | "work_record_completed"
    | "manual_qa_completed";

export type WorkflowToolEventOwnerKind = "root" | "isolated";

export interface TriageReportEventPayload {
    routingIntent: "INQUIRY" | "IDEATION" | "OPERATION" | "QUICK_FIX" | "PLANNED_CHANGE" | "PROJECT" | "FEATURE";
    complexity: "LOW" | "MEDIUM" | "HIGH";
    summary: string;
    classification?: "INQUIRY" | "IDEATION" | "OPERATION" | "QUICK_FIX" | "PLANNED_CHANGE" | "FEATURE" | "PROJECT";
    workKind?: "BUG_FIX" | "FEATURE" | "REFACTOR" | "MAINTENANCE" | "DOCUMENTATION";
    sessionName?: string;
}

export interface PlanWrittenEventPayload {
    outcome:
        | "approved_execute"
        | "approved_decompose"
        | "saved"
        | "conversation"
        | "feedback"
        | "canceled"
        | "repair_required"
        | "no_call";
    planName?: string;
    triageMeta?: import("../../tools/plan-written.ts").TriageMeta;
    feedback?: string;
    images?: { base64: string; mimeType: string }[];
}

export interface TaskCompletedEventPayload {
    outcome: "task_completed";
    agentName: string;
    message: string;
    browserPreflightOutcome?: "pass" | "fail" | "not_applicable";
}

export interface ReviewDiffEventPayload {
    reviewRoundId?: string;
    hasDiff: boolean;
}

export interface ReviewCompleteEventPayload {
    outcome: "approved" | "feedback";
    approved: boolean;
    feedback: string;
    findings: import("../../tools/review-complete.ts").ReviewFinding[];
    advisories: import("../../tools/review-complete.ts").ReviewAdvisory[];
    /** Epic children only; absent from older recorded events. */
    integrationNotes?: import("../../tools/review-complete.ts").ReviewIntegrationNote[];
}

export interface QaChecklistGeneratedEventPayload {
    outcome: "recorded" | "already_present";
    qaName?: string;
    artifactPath?: string;
}

export type WorkflowToolEventPayloadByKind = {
    triage_report: TriageReportEventPayload;
    plan_written: PlanWrittenEventPayload;
    task_completed: TaskCompletedEventPayload;
    review_diff: ReviewDiffEventPayload;
    review_complete: ReviewCompleteEventPayload;
    qa_checklist_generated: QaChecklistGeneratedEventPayload;
    work_record_completed: import("../work-records/generation.js").GeneratedWorkRecordSections;
    manual_qa_completed: { checklistMarkdown: string };
};

export type WorkflowToolEventPayload<K extends WorkflowToolEventKind = WorkflowToolEventKind> =
    WorkflowToolEventPayloadByKind[K];

type ActiveExecutionWorkflow = import("../session/hosted-session.js").ActiveExecutionWorkflow;
type OwningSession = ReturnType<HostedSession["getRootAgentSession"]>;
type EventSourceSession = { sessionManager?: { getSessionId(): string } };
type ToolEventSource = { hostedSession: HostedSession; owningSession: OwningSession };
const toolEventSources = new AsyncLocalStorage<ToolEventSource>();

/** Internal shutdown after accepted completion, distinct from user cancellation or failure. */
export class WorkflowStepCompleted extends Error {
    constructor() {
        super("Workflow step completed");
        this.name = "WorkflowStepCompleted";
    }
}

/** Concurrent isolated Agents must not borrow whichever Agent last updated the footer. */
export function withWorkflowToolEventSource<T>(
    hostedSession: HostedSession,
    owningSession: OwningSession,
    run: () => Promise<T>,
): Promise<T> {
    return toolEventSources.run({ hostedSession, owningSession }, run);
}

export interface WorkflowToolEvent<K extends WorkflowToolEventKind = WorkflowToolEventKind> {
    version: 1;
    eventId: string;
    toolCallId: string;
    kind: K;
    owner: WorkflowToolEventOwnerKind;
    owningSession: OwningSession;
    sourceSessionId?: string;
    turnId: string | null;
    acceptedAtMs: number;
    payload: WorkflowToolEventPayload<K>;
    workflow: ActiveExecutionWorkflow | null;
    workflowAttemptKey: string;
    validationGeneration?: string;
    claimed: boolean;
    settled: boolean;
}

type DurableAcceptedEvent = {
    version: 1;
    state: "accepted";
    eventId: string;
    toolCallId: string;
    kind: WorkflowToolEventKind;
    owner: "root";
    turnId: string | null;
    acceptedAtMs: number;
    payload: WorkflowToolEventPayload;
    workflow: ActiveExecutionWorkflow | null;
    workflowAttemptKey: string;
    validationGeneration?: string;
};

type DurableSettledEvent = {
    version: 1;
    state: "settled";
    eventId: string;
    settledAtMs: number;
};

type DurableEvent = DurableAcceptedEvent | DurableSettledEvent;

type WorkflowToolEventSessionEntry = {
    type?: string;
    customType?: string;
    data?: DurableEvent | null;
};

type WorkflowToolEventSessionManager = {
    appendCustomEntry?: (customType: string, data: DurableEvent) => void;
    getBranch?: () => WorkflowToolEventSessionEntry[];
    getEntries?: () => WorkflowToolEventSessionEntry[];
};

interface EventState {
    events: WorkflowToolEvent[];
    waiters: EventWaiter[];
}

interface EventWaiter {
    kinds: Set<WorkflowToolEventKind>;
    owningSession: OwningSession;
    turnId?: string;
    validationGeneration?: string;
    excludeEventIds?: string[];
    sourceSessionId?: string;
    resolve: (event: WorkflowToolEvent) => void;
}

export interface PublishWorkflowToolEventOptions<K extends WorkflowToolEventKind> {
    hostedSession: HostedSession;
    toolCallId: string;
    kind: K;
    payload: WorkflowToolEventPayload<K>;
    acceptedAtMs?: number;
}

export interface ClaimWorkflowToolEventOptions {
    kinds: WorkflowToolEventKind[];
    owningSession: OwningSession;
    turnId?: string;
    validationGeneration?: string;
    signal?: AbortSignal;
    /** An invocation must not adopt completion from an earlier turn. */
    excludeEventIds?: string[];
    sourceSessionId?: string;
}

const states = new WeakMap<HostedSession, EventState>();

function stateFor(hostedSession: HostedSession): EventState {
    let state = states.get(hostedSession);
    if (!state) {
        state = { events: [], waiters: [] };
        states.set(hostedSession, state);
    }
    return state;
}

function getEventSessionManager(hostedSession: HostedSession): WorkflowToolEventSessionManager | null {
    return hostedSession.getRootSessionManager?.() as WorkflowToolEventSessionManager | null;
}

function getEntries(sessionManager: WorkflowToolEventSessionManager | null): WorkflowToolEventSessionEntry[] {
    if (!sessionManager) return [];
    const entries = sessionManager.getBranch?.() || sessionManager.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

export function workflowAttemptKey(workflow: ActiveExecutionWorkflow | null): string {
    if (!workflow) return "";
    if (typeof workflow.worktreeId === "string" && workflow.worktreeId) return `worktree:${workflow.worktreeId}`;
    if (typeof workflow.baselineTree === "string" && workflow.baselineTree) return `tree:${workflow.baselineTree}`;
    if (typeof workflow.executionAttemptStartedAtMs === "number") {
        return `started:${workflow.executionAttemptStartedAtMs}`;
    }
    return "";
}

function isRootOwnedSession(owningSession: OwningSession, rootSession: OwningSession): boolean {
    if (owningSession === null || owningSession === rootSession) return true;
    if (!owningSession || !rootSession) return false;
    if (typeof owningSession !== "object" || typeof rootSession !== "object") return false;
    const wrapper = rootSession as { kind?: string; session?: OwningSession };
    return (wrapper.kind === "claude-cli" || wrapper.kind === "agy-cli") && wrapper.session === owningSession;
}

function matchesOptions(event: WorkflowToolEvent, options: ClaimWorkflowToolEventOptions): boolean {
    if (event.claimed || event.settled) return false;
    if (!options.kinds.includes(event.kind)) return false;
    if (options.excludeEventIds?.includes(event.eventId)) return false;
    if (options.sourceSessionId && event.sourceSessionId !== options.sourceSessionId) return false;
    if (
        options.owningSession !== null &&
        !isRootOwnedSession(event.owningSession, options.owningSession) &&
        event.owningSession !== options.owningSession
    ) {
        return false;
    }
    if (options.turnId && event.turnId !== options.turnId) return false;
    if (options.validationGeneration && event.validationGeneration !== options.validationGeneration) {
        return false;
    }
    return true;
}

function isDurableAccepted(event: DurableEvent | null | undefined): event is DurableAcceptedEvent {
    return (
        event?.version === 1 &&
        event.state === "accepted" &&
        typeof event.eventId === "string" &&
        typeof event.toolCallId === "string" &&
        typeof event.kind === "string" &&
        event.owner === "root" &&
        typeof event.acceptedAtMs === "number"
    );
}

function isDurableSettled(event: DurableEvent | null | undefined): event is DurableSettledEvent {
    return event?.version === 1 && event.state === "settled" && typeof event.eventId === "string";
}

function readUnsettledDurableEvents(hostedSession: HostedSession): WorkflowToolEvent[] {
    const sessionManager = getEventSessionManager(hostedSession);
    const accepted: DurableAcceptedEvent[] = [];
    const settled = new Set<string>();
    for (const entry of getEntries(sessionManager)) {
        if (entry.type !== "custom" || entry.customType !== WORKFLOW_TOOL_EVENT_CUSTOM_TYPE) continue;
        if (isDurableAccepted(entry.data)) accepted.push(entry.data);
        if (isDurableSettled(entry.data)) settled.add(entry.data.eventId);
    }
    const rootSession = hostedSession.getRootAgentSession();
    return accepted
        .filter((event) => !settled.has(event.eventId))
        .map((event) => ({
            ...event,
            owningSession: rootSession,
            claimed: false,
            settled: false,
        }));
}

function refreshDurableState(hostedSession: HostedSession): void {
    const state = stateFor(hostedSession);
    const known = new Set(state.events.map((event) => event.eventId));
    for (const event of readUnsettledDurableEvents(hostedSession)) {
        if (!known.has(event.eventId)) state.events.push(event);
    }
}

function workflowToolCallKey(turnId: string | null, toolCallId: string): string {
    return `${turnId || ""}:${toolCallId}`;
}

function readDurableToolCallKeys(hostedSession: HostedSession): Set<string> {
    const toolCallKeys = new Set<string>();
    for (const entry of getEntries(getEventSessionManager(hostedSession))) {
        if (entry.type !== "custom" || entry.customType !== WORKFLOW_TOOL_EVENT_CUSTOM_TYPE) continue;
        if (isDurableAccepted(entry.data)) {
            toolCallKeys.add(workflowToolCallKey(entry.data.turnId, entry.data.toolCallId));
        }
    }
    return toolCallKeys;
}

function wakeWaiters(hostedSession: HostedSession): void {
    const state = stateFor(hostedSession);
    for (const waiter of [...state.waiters]) {
        const event = claimWorkflowToolEvent(hostedSession, {
            kinds: [...waiter.kinds],
            owningSession: waiter.owningSession,
            excludeEventIds: waiter.excludeEventIds,
            sourceSessionId: waiter.sourceSessionId,
            ...(waiter.turnId ? { turnId: waiter.turnId } : {}),
            ...(waiter.validationGeneration ? { validationGeneration: waiter.validationGeneration } : {}),
        });
        if (!event) continue;
        state.waiters = state.waiters.filter((entry) => entry !== waiter);
        waiter.resolve(event);
    }
}

export function publishWorkflowToolEvent<K extends WorkflowToolEventKind>(
    options: PublishWorkflowToolEventOptions<K>,
): WorkflowToolEvent<K> {
    const { hostedSession, toolCallId, kind, payload } = options;
    const source = toolEventSources.getStore();
    const owningSession =
        source?.hostedSession === hostedSession ? source.owningSession : hostedSession.getActiveSteeringTargetSession();
    const rootSession = hostedSession.getRootAgentSession();
    const owner: WorkflowToolEventOwnerKind = isRootOwnedSession(owningSession, rootSession) ? "root" : "isolated";
    const workflow = hostedSession.getActiveExecutionWorkflow?.() || null;
    const turnId = hostedSession.getActiveTurnId?.() || null;
    refreshDurableState(hostedSession);
    const state = stateFor(hostedSession);
    const toolCallKey = workflowToolCallKey(turnId, toolCallId);
    if (
        state.events.some((entry) => workflowToolCallKey(entry.turnId, entry.toolCallId) === toolCallKey) ||
        readDurableToolCallKeys(hostedSession).has(toolCallKey)
    ) {
        throw new Error(`Duplicate Workflow Tool Event tool call: ${toolCallId}`);
    }
    const event: WorkflowToolEvent<K> = {
        version: 1,
        eventId: turnId ? `${kind}:${turnId}:${toolCallId}` : `${kind}:${toolCallId}`,
        toolCallId,
        kind,
        owner,
        owningSession,
        sourceSessionId: (owningSession as EventSourceSession | null)?.sessionManager?.getSessionId(),
        turnId,
        acceptedAtMs: options.acceptedAtMs ?? Date.now(),
        payload,
        workflow: workflow ? { ...workflow } : null,
        workflowAttemptKey: workflowAttemptKey(workflow),
        ...(workflow?.validationGeneration ? { validationGeneration: workflow.validationGeneration } : {}),
        claimed: false,
        settled: false,
    };
    const sessionManager = getEventSessionManager(hostedSession);
    if (owner === "root" && sessionManager?.appendCustomEntry) {
        sessionManager.appendCustomEntry(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE, {
            version: 1,
            state: "accepted",
            eventId: event.eventId,
            toolCallId: event.toolCallId,
            kind: event.kind,
            owner: "root",
            turnId: event.turnId,
            acceptedAtMs: event.acceptedAtMs,
            payload: event.payload,
            workflow: event.workflow,
            workflowAttemptKey: event.workflowAttemptKey,
            ...(event.validationGeneration ? { validationGeneration: event.validationGeneration } : {}),
        });
    }
    state.events.push(event);
    wakeWaiters(hostedSession);
    return event;
}

export function claimWorkflowToolEvent(
    hostedSession: HostedSession,
    options: ClaimWorkflowToolEventOptions,
): WorkflowToolEvent | null {
    refreshDurableState(hostedSession);
    const state = stateFor(hostedSession);
    const activeWorkflow = hostedSession.getActiveExecutionWorkflow?.() || null;
    const workflowPlanName = hostedSession.getWorkflowContext?.()?.planName || "";
    const event = [...state.events].reverse().find((candidate) => {
        if (!matchesOptions(candidate, options)) return false;
        if (activeWorkflow && candidate.workflow) {
            if (candidate.workflow.planName !== activeWorkflow.planName) return false;
            if (
                activeWorkflow.validationGeneration &&
                candidate.validationGeneration !== activeWorkflow.validationGeneration
            ) {
                return false;
            }
            const candidateAttempt = candidate.workflowAttemptKey;
            const activeAttempt = workflowAttemptKey(activeWorkflow);
            if (candidateAttempt && activeAttempt && candidateAttempt !== activeAttempt) return false;
        } else if (!activeWorkflow && workflowPlanName) {
            const candidatePlanName =
                candidate.workflow?.planName ||
                (candidate.kind === "plan_written"
                    ? (candidate.payload as PlanWrittenEventPayload).planName
                    : undefined);
            if (candidatePlanName && candidatePlanName !== workflowPlanName) return false;
        }
        return true;
    });
    if (!event) return null;
    event.claimed = true;
    return event;
}

export function waitForWorkflowToolEvent(
    hostedSession: HostedSession,
    options: ClaimWorkflowToolEventOptions,
): Promise<WorkflowToolEvent> {
    const claimed = claimWorkflowToolEvent(hostedSession, options);
    if (claimed) return Promise.resolve(claimed);
    return new Promise((resolve, reject) => {
        const state = stateFor(hostedSession);
        const waiter: EventWaiter = {
            kinds: new Set(options.kinds),
            owningSession: options.owningSession,
            excludeEventIds: options.excludeEventIds,
            sourceSessionId: options.sourceSessionId,
            resolve,
            ...(options.turnId ? { turnId: options.turnId } : {}),
            ...(options.validationGeneration ? { validationGeneration: options.validationGeneration } : {}),
        };
        const abort = () => {
            state.waiters = state.waiters.filter((entry) => entry !== waiter);
            reject(options.signal?.reason || new DOMException("Workflow tool event wait canceled.", "AbortError"));
        };
        if (options.signal?.aborted) {
            abort();
            return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        const originalResolve = waiter.resolve;
        waiter.resolve = (event) => {
            options.signal?.removeEventListener("abort", abort);
            originalResolve(event);
        };
        state.waiters.push(waiter);
    });
}

export function settleWorkflowToolEvent(
    hostedSession: HostedSession,
    event: WorkflowToolEvent,
    settledAtMs = Date.now(),
): void {
    event.settled = true;
    const sessionManager = getEventSessionManager(hostedSession);
    if (event.owner === "root" && sessionManager?.appendCustomEntry) {
        sessionManager.appendCustomEntry(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE, {
            version: 1,
            state: "settled",
            eventId: event.eventId,
            settledAtMs,
        });
    }
}

export function listPendingWorkflowToolEvents(hostedSession: HostedSession): WorkflowToolEvent[] {
    refreshDurableState(hostedSession);
    return stateFor(hostedSession)
        .events.filter((event) => !event.settled)
        .map((event) => ({ ...event }));
}
