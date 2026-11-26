/**
 * Durable, consume-once task completion handoff.
 *
 * The Plan lifecycle remains the durable workflow state machine. These JSONL
 * entries are only an outbox between an accepted `task_completed` tool call and
 * the lifecycle/validation code that acts on it.
 */

import {
    compareWorkflowAttempts,
    legacyWorkflowAttemptKey,
    workflowEvents,
    type WorkflowEventJournalReader,
    type WorkflowEventJournalRecord,
    type WorkflowToolEvent,
    type WorkflowTaskCompletionHost,
} from "@runwield/workflow/events";

export const TASK_COMPLETION_CUSTOM_TYPE = "runwield.task_completion";

type ActiveExecutionWorkflow = import("@runwield/workflow/state").ActiveExecutionWorkflow;
type OwningSession = ReturnType<WorkflowTaskCompletionHost["getRootAgentSession"]>;

type AcceptedTaskCompletionEvent = {
    version: 1;
    state: "accepted";
    completionId: string;
    agentName: string;
    report: string;
    timestampMs: number;
    owner: "root";
    workflow: ActiveExecutionWorkflow;
    validationGeneration?: string;
};

type ConsumedTaskCompletionEvent = {
    version: 1;
    state: "consumed";
    completionId: string;
    timestampMs: number;
};

export type PendingTaskCompletionClaim = {
    completionId: string | null;
    agentName: string;
    report: string;
    timestampMs: number;
    owningSession: OwningSession;
    workflow: ActiveExecutionWorkflow | null;
    durable: boolean;
    validationGeneration?: string;
    workflowToolEvent?: WorkflowToolEvent;
};

type RecordTaskCompletionArgs = {
    hostedSession: WorkflowTaskCompletionHost;
    toolCallId: string;
    agentName: string;
    report: string;
    timestampMs: number;
};

function isAcceptedEvent(event: WorkflowEventJournalRecord): event is AcceptedTaskCompletionEvent {
    const workflow = "workflow" in event ? event.workflow : null;
    return (
        event.version === 1 &&
        event.state === "accepted" &&
        "completionId" in event &&
        typeof event.completionId === "string" &&
        (!("validationGeneration" in event) ||
            event.validationGeneration === undefined ||
            typeof event.validationGeneration === "string") &&
        "agentName" in event &&
        typeof event.agentName === "string" &&
        "report" in event &&
        typeof event.report === "string" &&
        "timestampMs" in event &&
        typeof event.timestampMs === "number" &&
        "owner" in event &&
        event.owner === "root" &&
        workflow !== null &&
        typeof workflow === "object" &&
        "planName" in workflow &&
        typeof workflow.planName === "string" &&
        "executionAgent" in workflow &&
        (workflow.executionAgent === "engineer" || workflow.executionAgent === "frontend-engineer")
    );
}

function isConsumedEvent(event: WorkflowEventJournalRecord): event is ConsumedTaskCompletionEvent {
    return (
        event.version === 1 &&
        event.state === "consumed" &&
        "completionId" in event &&
        typeof event.completionId === "string"
    );
}

function readUnconsumedAcceptedEvents(journal: WorkflowEventJournalReader | null): AcceptedTaskCompletionEvent[] {
    const accepted: AcceptedTaskCompletionEvent[] = [];
    const consumed = new Set<string>();
    for (const record of journal?.read(TASK_COMPLETION_CUSTOM_TYPE) ?? []) {
        if (isAcceptedEvent(record)) accepted.push(record);
        if (isConsumedEvent(record)) consumed.add(record.completionId);
    }
    return accepted.filter((event) => !consumed.has(event.completionId));
}

function matchesActiveWorkflow(event: AcceptedTaskCompletionEvent, activeWorkflow: ActiveExecutionWorkflow): boolean {
    if (event.workflow.planName !== activeWorkflow.planName) return false;
    if (
        event.validationGeneration &&
        activeWorkflow.validationGeneration &&
        event.validationGeneration !== activeWorkflow.validationGeneration
    )
        return false;
    if (Boolean(event.workflow.validationContinuation) !== Boolean(activeWorkflow.validationContinuation)) return false;
    return compareWorkflowAttempts(event.workflow, activeWorkflow) !== "mismatch";
}

/**
 * Whether the owning steering-target session is the root's own session.
 *
 * Pi roots store the AgentSession directly as both steering target and root
 * session, so a plain identity comparison holds. External CLI roots store a
 * `{ kind, session }` wrapper as the root session while the steering target is
 * the inner execution session, so the wrapper must be unwrapped before comparing.
 */
function isRootOwnedSession(owningSession: OwningSession, rootSession: OwningSession): boolean {
    if (owningSession === null || owningSession === rootSession) return true;
    if (!owningSession || !rootSession) return false;
    if (typeof owningSession !== "object" || typeof rootSession !== "object") return false;
    const wrapper = rootSession as { kind?: unknown; session?: unknown };
    return wrapper.kind === "claude-cli" && wrapper.session === owningSession;
}

/**
 * Record an accepted root completion before the tool reports success. Isolated
 * Agent sessions publish owner-scoped accepted tool events and are intentionally
 * excluded from the root-session outbox.
 */
export function recordAcceptedTaskCompletion(args: RecordTaskCompletionArgs): string | null {
    const { hostedSession, agentName, report, timestampMs } = args;
    const owningSession = hostedSession.getActiveSteeringTargetSession();
    const rootSession = hostedSession.getRootAgentSession();
    const rootOwned = isRootOwnedSession(owningSession, rootSession);
    const workflow = hostedSession.getActiveExecutionWorkflow();

    let completionId: string | null = null;
    const journal = hostedSession.getWorkflowEventJournalWriter();
    if (rootOwned && workflow && journal) {
        completionId = `${args.toolCallId || "task-completed"}:${crypto.randomUUID()}`;
        journal.append(TASK_COMPLETION_CUSTOM_TYPE, {
            version: 1,
            state: "accepted",
            completionId,
            agentName,
            report,
            timestampMs,
            owner: "root",
            workflow: { ...workflow },
            validationGeneration: workflow.validationGeneration || legacyWorkflowAttemptKey(workflow),
        } satisfies AcceptedTaskCompletionEvent);
    }

    workflowEvents(hostedSession).publish({
        toolCallId: args.toolCallId,
        kind: "task_completed",
        acceptedAtMs: timestampMs,
        payload: {
            outcome: "task_completed",
            agentName,
            message: report,
        },
    });

    // Keep the existing in-process fast path and compatibility for sessions that
    // do not have a persisted root SessionManager.
    hostedSession.recordPendingTaskCompletion(agentName, report, timestampMs);
    return completionId;
}

/**
 * Claim the latest matching completion without acknowledging it. The caller must
 * acknowledge only after the existing durable lifecycle checkpoint—or another
 * state from which retry is safe—has been reached.
 */
export function claimPendingTaskCompletion(
    hostedSession: WorkflowTaskCompletionHost,
    owningSession: OwningSession,
): PendingTaskCompletionClaim | null {
    const activeWorkflow = hostedSession.getActiveExecutionWorkflow();
    const workflowPlanName = hostedSession.getWorkflowContext()?.planName || "";
    const workflowEvent = workflowEvents(hostedSession).claim({
        kinds: ["task_completed"],
        owningSession,
        ...(activeWorkflow?.validationGeneration ? { validationGeneration: activeWorkflow.validationGeneration } : {}),
    });
    if (workflowEvent?.kind === "task_completed") {
        const eventWorkflow = workflowEvent.workflow;
        const payload = workflowEvent.payload as import("@runwield/workflow/events").TaskCompletedEventPayload;
        if (
            !activeWorkflow ||
            !eventWorkflow ||
            eventWorkflow.planName === activeWorkflow.planName ||
            !workflowPlanName ||
            eventWorkflow.planName === workflowPlanName
        ) {
            hostedSession.consumePendingTaskCompletion(owningSession);
            return {
                completionId: workflowEvent.eventId,
                agentName: payload.agentName,
                report: payload.message,
                timestampMs: workflowEvent.acceptedAtMs,
                owningSession,
                workflow: eventWorkflow ? { ...eventWorkflow } : null,
                durable: workflowEvent.owner === "root",
                validationGeneration: workflowEvent.validationGeneration,
                workflowToolEvent: workflowEvent,
            };
        }
    }
    const pending = readUnconsumedAcceptedEvents(hostedSession.getWorkflowEventJournalReader()).filter((event) => {
        if (activeWorkflow) return matchesActiveWorkflow(event, activeWorkflow);
        return !workflowPlanName || event.workflow.planName === workflowPlanName;
    });
    const accepted = pending.at(-1);
    if (accepted) {
        // Clear only the volatile mirror owned by this consumer. The JSONL event
        // remains pending until acknowledgeTaskCompletion is called.
        hostedSession.consumePendingTaskCompletion(owningSession);
        return {
            completionId: accepted.completionId,
            agentName: accepted.agentName,
            report: accepted.report,
            timestampMs: accepted.timestampMs,
            owningSession,
            workflow: { ...accepted.workflow },
            durable: true,
            validationGeneration: accepted.validationGeneration,
        };
    }

    const volatile = hostedSession.consumePendingTaskCompletion(owningSession);
    if (!volatile) return null;
    return {
        completionId: null,
        agentName: volatile.agentName,
        report: volatile.report,
        timestampMs: volatile.timestampMs,
        owningSession,
        workflow: activeWorkflow ? { ...activeWorkflow } : null,
        durable: false,
        validationGeneration: activeWorkflow?.validationGeneration,
    };
}

export function acknowledgeTaskCompletion(
    hostedSession: WorkflowTaskCompletionHost,
    completion: PendingTaskCompletionClaim,
    timestampMs = Date.now(),
): void {
    const journal = hostedSession.getWorkflowEventJournalWriter();
    if (completion.workflowToolEvent) {
        workflowEvents(hostedSession).settle(completion.workflowToolEvent, timestampMs);
        const legacy = readUnconsumedAcceptedEvents(hostedSession.getWorkflowEventJournalReader())
            .filter((event) => event.agentName === completion.agentName && event.report === completion.report)
            .at(-1);
        if (legacy && journal) {
            journal.append(TASK_COMPLETION_CUSTOM_TYPE, {
                version: 1,
                state: "consumed",
                completionId: legacy.completionId,
                timestampMs,
            } satisfies ConsumedTaskCompletionEvent);
        }
    }
    if (!completion.completionId || completion.workflowToolEvent) return;
    if (!journal) {
        throw new Error("Cannot acknowledge durable task completion without a root workflow journal.");
    }
    journal.append(TASK_COMPLETION_CUSTOM_TYPE, {
        version: 1,
        state: "consumed",
        completionId: completion.completionId,
        timestampMs,
    } satisfies ConsumedTaskCompletionEvent);
}

export function listPendingTaskCompletions(hostedSession: WorkflowTaskCompletionHost): PendingTaskCompletionClaim[] {
    const owningSession = hostedSession.getRootAgentSession();
    return readUnconsumedAcceptedEvents(hostedSession.getWorkflowEventJournalReader()).map((event) => ({
        completionId: event.completionId,
        agentName: event.agentName,
        report: event.report,
        timestampMs: event.timestampMs,
        owningSession,
        workflow: { ...event.workflow },
        durable: true,
        validationGeneration: event.validationGeneration,
    }));
}
