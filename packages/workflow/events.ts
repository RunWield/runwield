/**
 * Accepted workflow Custom Tool events.
 *
 * These events are the live, consume-once handoff between an accepted tool call
 * and the workflow owner that can act on it. Transcripts remain display and
 * audit data only.
 */

import type { TriageOutcome } from "@runwield/tools";
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

/** Reports the planning outcome and any review feedback needed to continue. */
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
    triageMeta?: import("./state.ts").TriageMeta;
    feedback?: string;
    images?: { base64: string; mimeType: string }[];
}

/** Identifies the agent that finished its task and carries its completion message. */
export interface TaskCompletedEventPayload {
    outcome: "task_completed";
    agentName: string;
    message: string;
    browserPreflightOutcome?: "pass" | "fail" | "not_applicable";
}

/** Reports whether the requested review round has a diff to inspect. */
export interface ReviewDiffEventPayload {
    reviewRoundId?: string;
    hasDiff: boolean;
}

/** Carries the review verdict, findings, and feedback for the next workflow step. */
export interface ReviewCompleteEventPayload {
    outcome: "approved" | "feedback";
    approved: boolean;
    feedback: string;
    findings: import("../../src/shared/workflow/review-outcome.ts").ReviewFinding[];
    advisories: import("../../src/shared/workflow/review-outcome.ts").ReviewAdvisory[];
    /** Epic children only; absent from older recorded events. */
    integrationNotes?: import("../../src/shared/workflow/review-outcome.ts").ReviewIntegrationNote[];
}

/** Reports whether the QA checklist was newly recorded or already existed. */
export interface QaChecklistGeneratedEventPayload {
    outcome: "recorded" | "already_present";
    qaName?: string;
    artifactPath?: string;
}

export type WorkflowToolEventPayloadByKind = {
    triage_report: TriageOutcome;
    plan_written: PlanWrittenEventPayload;
    task_completed: TaskCompletedEventPayload;
    review_diff: ReviewDiffEventPayload;
    review_complete: ReviewCompleteEventPayload;
    qa_checklist_generated: QaChecklistGeneratedEventPayload;
    work_record_completed: import("@runwield/plans/work-records").GeneratedWorkRecordSections;
    manual_qa_completed: { checklistMarkdown: string };
};

export type WorkflowToolEventPayload<K extends WorkflowToolEventKind = WorkflowToolEventKind> =
    WorkflowToolEventPayloadByKind[K];

type ActiveExecutionWorkflow = import("./state.ts").ActiveExecutionWorkflow;

/** Identity of the root or isolated agent that emitted a report. */
interface WorkflowEventOwner {
    dispose?: () => void | Promise<void>;
}

type OwningSession = WorkflowEventOwner | null;

/** Read the agent, turn, and transcript identity needed to route accepted tool reports. */
export interface WorkflowEventHost {
    /** Return the agent session that owns the root transcript. */
    getRootAgentSession(): OwningSession;
    /** Read the root transcript's workflow reports, when the host supports replay. */
    getWorkflowEventJournalReader(): WorkflowEventJournalReader | null;
    /** Write root workflow reports, when the host supports appending to the transcript. */
    getWorkflowEventJournalWriter(): WorkflowEventJournalWriter | null;
    /** Identify the agent session currently receiving steering input. */
    getActiveSteeringTargetSession(): OwningSession;
    /** Read the workflow whose step is accepting reports. */
    getActiveExecutionWorkflow(): ActiveExecutionWorkflow | null;
    /** Read the Plan name associated with the current work. */
    getWorkflowContext(): { planName?: string } | null;
    /** Identify the turn that owns a new report. */
    getActiveTurnId(): string | null;
}

/** Access the volatile completion mirror alongside accepted reports from the transcript. */
export interface WorkflowTaskCompletionHost extends WorkflowEventHost {
    /** Keep a completion available to the active host until it is consumed. */
    recordPendingTaskCompletion(agentName: string, report: string, timestampMs: number): void;
    /** Remove and return the pending completion for its owning agent session. */
    consumePendingTaskCompletion(owningSession: OwningSession): PendingCompletionReport | null;
}

interface PendingCompletionReport {
    agentName: string;
    report: string;
    timestampMs: number;
}

type EventSourceSession = { sessionManager?: { getSessionId(): string } };
type ToolEventSource = { hostedSession: WorkflowEventHost; owningSession: OwningSession };
const toolEventSources = new AsyncLocalStorage<ToolEventSource>();

/** Internal shutdown after accepted completion, distinct from user cancellation or failure. */
export class WorkflowStepCompleted extends Error {
    constructor() {
        super("Workflow step completed");
        this.name = "WorkflowStepCompleted";
    }
}

/** Concurrent isolated Agents must not borrow whichever Agent last updated the footer. */
function withWorkflowToolEventSource<T>(
    hostedSession: WorkflowEventHost,
    owningSession: OwningSession,
    run: () => Promise<T>,
): Promise<T> {
    return toolEventSources.run({ hostedSession, owningSession }, run);
}

/** Tracks an accepted tool report, its owning session and attempt, and whether it was claimed or settled. */
interface StoredWorkflowToolEvent<K extends WorkflowToolEventKind = WorkflowToolEventKind> {
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

export type WorkflowToolEvent<K extends WorkflowToolEventKind = WorkflowToolEventKind> = Readonly<
    StoredWorkflowToolEvent<K>
>;

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

/** Fields shared by versioned records in the workflow report journal. */
export interface WorkflowEventJournalRecord {
    version: number;
    state: string;
}

/** Replay root workflow reports from the host's transcript. */
export interface WorkflowEventJournalReader {
    /** Read records for this custom type in transcript order, using the active branch when available. */
    read(customType: string): readonly WorkflowEventJournalRecord[];
}

/** Persist root workflow reports in the host's transcript. */
export interface WorkflowEventJournalWriter {
    /** Append a record to the transcript history used for replay. */
    append<Record extends WorkflowEventJournalRecord>(customType: string, record: Record): void;
}

/** Holds a host's events and the consumers waiting for matching reports. */
interface EventState {
    events: StoredWorkflowToolEvent[];
    waiters: EventWaiter[];
}

/** Describes the reports a waiting consumer can claim and how to wake it. */
interface EventWaiter {
    kinds: Set<WorkflowToolEventKind>;
    owningSession: OwningSession;
    turnId?: string;
    validationGeneration?: string;
    excludeEventIds?: string[];
    sourceSessionId?: string;
    /** Wake the waiting consumer with the event it claimed. */
    resolve: (event: WorkflowToolEvent) => void;
}

/** Identifies the accepted tool call and carries the payload for its event kind. */
export interface PublishWorkflowToolEventOptions<K extends WorkflowToolEventKind> {
    toolCallId: string;
    kind: K;
    payload: WorkflowToolEventPayload<K>;
    acceptedAtMs?: number;
}

/** Selects matching events by owner, kind, and optional turn or validation context. */
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

const states = new WeakMap<WorkflowEventHost, EventState>();
const pendingSnapshots = new WeakMap<WorkflowToolEvent, StoredWorkflowToolEvent>();

function stateFor(hostedSession: WorkflowEventHost): EventState {
    let state = states.get(hostedSession);
    if (!state) {
        state = { events: [], waiters: [] };
        states.set(hostedSession, state);
    }
    return state;
}

/** Reconstruct the attempt key used by older session records. */
export function legacyWorkflowAttemptKey(workflow: ActiveExecutionWorkflow | null): string {
    if (!workflow) return "";
    if (typeof workflow.worktreeId === "string" && workflow.worktreeId) return `worktree:${workflow.worktreeId}`;
    if (typeof workflow.baselineTree === "string" && workflow.baselineTree) return `tree:${workflow.baselineTree}`;
    if (typeof workflow.executionAttemptStartedAtMs === "number") {
        return `started:${workflow.executionAttemptStartedAtMs}`;
    }
    return "";
}

/** Build an event key from the recorded execution context, or return an empty string if it has no identifier. */
export function workflowAttemptKey(workflow: ActiveExecutionWorkflow | null): string {
    return (
        legacyWorkflowAttemptKey(workflow) || (workflow?.packageAttemptId ? `package:${workflow.packageAttemptId}` : "")
    );
}

/** Use canonical IDs when available and preserve the journal's older comparison otherwise. */
export function compareWorkflowAttempts(
    recorded: ActiveExecutionWorkflow,
    active: ActiveExecutionWorkflow,
    recordedKey = legacyWorkflowAttemptKey(recorded),
): "match" | "mismatch" | "unidentified" {
    if (recorded.packageAttemptId && active.packageAttemptId)
        return recorded.packageAttemptId === active.packageAttemptId ? "match" : "mismatch";
    const recordedLegacyKey =
        typeof recordedKey === "string" && !recordedKey.startsWith("package:")
            ? recordedKey
            : legacyWorkflowAttemptKey(recorded);
    const activeLegacyKey = legacyWorkflowAttemptKey(active);
    if (recordedLegacyKey === activeLegacyKey) return "match";
    return recordedLegacyKey && activeLegacyKey ? "mismatch" : "unidentified";
}

function isRootOwnedSession(owningSession: OwningSession, rootSession: OwningSession): boolean {
    if (owningSession === null || owningSession === rootSession) return true;
    if (!owningSession || !rootSession) return false;
    if (typeof owningSession !== "object" || typeof rootSession !== "object") return false;
    const wrapper = rootSession as { kind?: string; session?: OwningSession };
    return wrapper.kind === "claude-cli" && wrapper.session === owningSession;
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

function isDurableAccepted(event: WorkflowEventJournalRecord): event is DurableAcceptedEvent {
    return (
        event.version === 1 &&
        event.state === "accepted" &&
        "eventId" in event &&
        typeof event.eventId === "string" &&
        "toolCallId" in event &&
        typeof event.toolCallId === "string" &&
        "kind" in event &&
        typeof event.kind === "string" &&
        "owner" in event &&
        event.owner === "root" &&
        "acceptedAtMs" in event &&
        typeof event.acceptedAtMs === "number"
    );
}

function isDurableSettled(event: WorkflowEventJournalRecord): event is DurableSettledEvent {
    return event.version === 1 && event.state === "settled" && "eventId" in event && typeof event.eventId === "string";
}

function readUnsettledDurableEvents(hostedSession: WorkflowEventHost): WorkflowToolEvent[] {
    const journal = hostedSession.getWorkflowEventJournalReader();
    const accepted: DurableAcceptedEvent[] = [];
    const settled = new Set<string>();
    for (const record of journal?.read(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE) ?? []) {
        if (isDurableAccepted(record)) accepted.push(record);
        if (isDurableSettled(record)) settled.add(record.eventId);
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

function refreshDurableState(hostedSession: WorkflowEventHost): void {
    const state = stateFor(hostedSession);
    const known = new Set(state.events.map((event) => event.eventId));
    for (const event of readUnsettledDurableEvents(hostedSession)) {
        if (!known.has(event.eventId)) state.events.push(event);
    }
}

function workflowToolCallKey(turnId: string | null, toolCallId: string): string {
    return `${turnId || ""}:${toolCallId}`;
}

function readDurableToolCallKeys(hostedSession: WorkflowEventHost): Set<string> {
    const toolCallKeys = new Set<string>();
    const journal = hostedSession.getWorkflowEventJournalReader();
    for (const record of journal?.read(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE) ?? []) {
        if (isDurableAccepted(record)) {
            toolCallKeys.add(workflowToolCallKey(record.turnId, record.toolCallId));
        }
    }
    return toolCallKeys;
}

function wakeWaiters(hostedSession: WorkflowEventHost): void {
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

function publishWorkflowToolEvent<K extends WorkflowToolEventKind>(
    hostedSession: WorkflowEventHost,
    options: PublishWorkflowToolEventOptions<K>,
): WorkflowToolEvent<K> {
    const { toolCallId, kind, payload } = options;
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
    if (owner === "root") {
        hostedSession.getWorkflowEventJournalWriter()?.append(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE, {
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
        } satisfies DurableAcceptedEvent);
    }
    state.events.push(event);
    wakeWaiters(hostedSession);
    return event;
}

function claimWorkflowToolEvent(
    hostedSession: WorkflowEventHost,
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
            if (
                compareWorkflowAttempts(candidate.workflow, activeWorkflow, candidate.workflowAttemptKey) === "mismatch"
            )
                return false;
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

function waitForWorkflowToolEvent(
    hostedSession: WorkflowEventHost,
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

function settleWorkflowToolEvent(
    hostedSession: WorkflowEventHost,
    event: WorkflowToolEvent,
    settledAtMs = Date.now(),
): void {
    const record = pendingSnapshots.get(event) ?? event;
    const stored = stateFor(hostedSession).events.find((candidate) => candidate === record);
    if (!stored) throw new Error("The workflow event belongs to a different Session.");
    if (stored.settled) return;
    if (stored.owner === "root") {
        hostedSession.getWorkflowEventJournalWriter()?.append(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE, {
            version: 1,
            state: "settled",
            eventId: stored.eventId,
            settledAtMs,
        } satisfies DurableSettledEvent);
    }
    stored.settled = true;
}

function listPendingWorkflowToolEvents(hostedSession: WorkflowEventHost): WorkflowToolEvent[] {
    refreshDurableState(hostedSession);
    return stateFor(hostedSession)
        .events.filter((event) => !event.settled)
        .map((event) => {
            const snapshot = { ...event };
            pendingSnapshots.set(snapshot, event);
            return snapshot;
        });
}

/** Session-bound handoff between tools and the workflow that accepts their reports. */
export interface WorkflowEvents {
    /** Record an accepted tool report and wake matching waiters. Duplicate calls in the same turn are rejected. */
    publish<K extends WorkflowToolEventKind>(report: PublishWorkflowToolEventOptions<K>): WorkflowToolEvent<K>;
    /** Claim the newest matching available report, or return null if none is ready. */
    claim(options: ClaimWorkflowToolEventOptions): WorkflowToolEvent | null;
    /** Claim a matching report now or wait until one arrives or the signal aborts. */
    wait(options: ClaimWorkflowToolEventOptions): Promise<WorkflowToolEvent>;
    /** Mark a handled report as settled so it stays out of the pending list. */
    settle(event: WorkflowToolEvent, settledAtMs?: number): void;
    /** List snapshots of unsettled reports, including reports already claimed. */
    pending(): WorkflowToolEvent[];
    /** Attribute tool reports emitted during the callback to the supplied agent session. */
    withSource<T>(source: OwningSession, run: () => Promise<T>): Promise<T>;
}

/** Open the tool report queue for one host session. */
export function workflowEvents(session: WorkflowEventHost): WorkflowEvents {
    return {
        publish: (report) => publishWorkflowToolEvent(session, report),
        claim: (options) => claimWorkflowToolEvent(session, options),
        wait: (options) => waitForWorkflowToolEvent(session, options),
        settle: (event, settledAtMs) => settleWorkflowToolEvent(session, event, settledAtMs),
        pending: () => listPendingWorkflowToolEvents(session),
        withSource: (source, run) => withWorkflowToolEventSource(session, source, run),
    };
}
