/**
 * Durable, consume-once task completion handoff.
 *
 * The Plan lifecycle remains the durable workflow state machine. These JSONL
 * entries are only an outbox between an accepted `task_completed` tool call and
 * the lifecycle/validation code that acts on it.
 */

import type { HostedSession } from "./hosted-session.ts";
import {
    claimWorkflowToolEvent,
    publishWorkflowToolEvent,
    settleWorkflowToolEvent,
    type WorkflowToolEvent,
} from "../workflow/workflow-tool-events.ts";

export const TASK_COMPLETION_CUSTOM_TYPE = "runwield.task_completion";

type ActiveExecutionWorkflow = import("./hosted-session.ts").ActiveExecutionWorkflow;
type OwningSession = ReturnType<HostedSession["getRootAgentSession"]>;

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

type TaskCompletionJournalEvent = AcceptedTaskCompletionEvent | ConsumedTaskCompletionEvent;

type TaskCompletionSessionEntry = {
    type?: string;
    customType?: string;
    data?: TaskCompletionJournalEvent | null;
};

type TaskCompletionSessionManager = {
    appendCustomEntry?: (customType: string, data: TaskCompletionJournalEvent) => void;
    getBranch?: () => TaskCompletionSessionEntry[];
    getEntries?: () => TaskCompletionSessionEntry[];
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
    hostedSession: HostedSession;
    toolCallId: string;
    agentName: string;
    report: string;
    timestampMs: number;
};

function getCompletionSessionManager(hostedSession: HostedSession): TaskCompletionSessionManager | null {
    return hostedSession.getRootSessionManager?.() as TaskCompletionSessionManager | null;
}

function getEntries(sessionManager: TaskCompletionSessionManager | null): TaskCompletionSessionEntry[] {
    if (!sessionManager) return [];
    const entries = sessionManager.getBranch?.() || sessionManager.getEntries?.() || [];
    return Array.isArray(entries) ? entries : [];
}

function isAcceptedEvent(event: TaskCompletionJournalEvent | null | undefined): event is AcceptedTaskCompletionEvent {
    return event?.version === 1 && event.state === "accepted" && typeof event.completionId === "string" &&
        (event.validationGeneration === undefined || typeof event.validationGeneration === "string") &&
        typeof event.agentName === "string" && typeof event.report === "string" &&
        typeof event.timestampMs === "number" && event.owner === "root" &&
        typeof event.workflow?.planName === "string" &&
        (event.workflow.executionAgent === "engineer" || event.workflow.executionAgent === "frontend-engineer");
}

function isConsumedEvent(event: TaskCompletionJournalEvent | null | undefined): event is ConsumedTaskCompletionEvent {
    return event?.version === 1 && event.state === "consumed" && typeof event.completionId === "string";
}

function readUnconsumedAcceptedEvents(
    sessionManager: TaskCompletionSessionManager | null,
): AcceptedTaskCompletionEvent[] {
    const accepted: AcceptedTaskCompletionEvent[] = [];
    const consumed = new Set<string>();
    for (const entry of getEntries(sessionManager)) {
        if (entry.type !== "custom" || entry.customType !== TASK_COMPLETION_CUSTOM_TYPE) continue;
        if (isAcceptedEvent(entry.data)) accepted.push(entry.data);
        if (isConsumedEvent(entry.data)) consumed.add(entry.data.completionId);
    }
    return accepted.filter((event) => !consumed.has(event.completionId));
}

export function workflowAttemptKey(workflow: ActiveExecutionWorkflow): string {
    if (typeof workflow.worktreeId === "string" && workflow.worktreeId) return `worktree:${workflow.worktreeId}`;
    if (typeof workflow.baselineTree === "string" && workflow.baselineTree) return `tree:${workflow.baselineTree}`;
    if (typeof workflow.executionAttemptStartedAtMs === "number") {
        return `started:${workflow.executionAttemptStartedAtMs}`;
    }
    return "";
}

function matchesActiveWorkflow(event: AcceptedTaskCompletionEvent, activeWorkflow: ActiveExecutionWorkflow): boolean {
    if (event.workflow.planName !== activeWorkflow.planName) return false;
    if (
        event.validationGeneration && activeWorkflow.validationGeneration &&
        event.validationGeneration !== activeWorkflow.validationGeneration
    ) return false;
    if (Boolean(event.workflow.validationContinuation) !== Boolean(activeWorkflow.validationContinuation)) return false;
    const acceptedAttempt = workflowAttemptKey(event.workflow);
    const activeAttempt = workflowAttemptKey(activeWorkflow);
    return !acceptedAttempt || !activeAttempt || acceptedAttempt === activeAttempt;
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
    return (wrapper.kind === "claude-cli" || wrapper.kind === "agy-cli") && wrapper.session === owningSession;
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
    const sessionManager = getCompletionSessionManager(hostedSession);
    if (rootOwned && workflow && sessionManager?.appendCustomEntry) {
        completionId = `${args.toolCallId || "task-completed"}:${crypto.randomUUID()}`;
        sessionManager.appendCustomEntry(TASK_COMPLETION_CUSTOM_TYPE, {
            version: 1,
            state: "accepted",
            completionId,
            agentName,
            report,
            timestampMs,
            owner: "root",
            workflow: { ...workflow },
            validationGeneration: workflow.validationGeneration || workflowAttemptKey(workflow),
        });
    }

    publishWorkflowToolEvent({
        hostedSession,
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
    hostedSession: HostedSession,
    owningSession: OwningSession,
): PendingTaskCompletionClaim | null {
    const activeWorkflow = hostedSession.getActiveExecutionWorkflow();
    const workflowPlanName = hostedSession.getWorkflowContext()?.planName || "";
    const workflowEvent = claimWorkflowToolEvent(hostedSession, {
        kinds: ["task_completed"],
        owningSession,
        ...(activeWorkflow?.validationGeneration ? { validationGeneration: activeWorkflow.validationGeneration } : {}),
    });
    if (workflowEvent?.kind === "task_completed") {
        const eventWorkflow = workflowEvent.workflow;
        const payload = workflowEvent
            .payload as import("../workflow/workflow-tool-events.ts").TaskCompletedEventPayload;
        if (
            !activeWorkflow || !eventWorkflow ||
            eventWorkflow.planName === activeWorkflow.planName ||
            (!workflowPlanName || eventWorkflow.planName === workflowPlanName)
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
    const sessionManager = getCompletionSessionManager(hostedSession);
    const pending = readUnconsumedAcceptedEvents(sessionManager).filter((event) => {
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
    hostedSession: HostedSession,
    completion: PendingTaskCompletionClaim,
    timestampMs = Date.now(),
): void {
    const sessionManager = getCompletionSessionManager(hostedSession);
    if (completion.workflowToolEvent) {
        settleWorkflowToolEvent(hostedSession, completion.workflowToolEvent, timestampMs);
        const legacy = readUnconsumedAcceptedEvents(sessionManager).filter((event) =>
            event.agentName === completion.agentName && event.report === completion.report
        ).at(-1);
        if (legacy && sessionManager?.appendCustomEntry) {
            sessionManager.appendCustomEntry(TASK_COMPLETION_CUSTOM_TYPE, {
                version: 1,
                state: "consumed",
                completionId: legacy.completionId,
                timestampMs,
            });
        }
    }
    if (!completion.completionId || completion.workflowToolEvent) return;
    if (!sessionManager?.appendCustomEntry) {
        throw new Error("Cannot acknowledge durable task completion without a writable root SessionManager.");
    }
    sessionManager.appendCustomEntry(TASK_COMPLETION_CUSTOM_TYPE, {
        version: 1,
        state: "consumed",
        completionId: completion.completionId,
        timestampMs,
    });
}

export function listPendingTaskCompletions(hostedSession: HostedSession): PendingTaskCompletionClaim[] {
    const owningSession = hostedSession.getRootAgentSession();
    return readUnconsumedAcceptedEvents(getCompletionSessionManager(hostedSession)).map((event) => ({
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
