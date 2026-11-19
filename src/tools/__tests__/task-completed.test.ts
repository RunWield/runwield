import { throws as assertThrows } from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "../../shared/session/hosted-session.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.ts";
import { createPairCheckpointTool } from "../pair-checkpoint.ts";
import { readCurrentPairCheckpoint } from "../../shared/session/pair-checkpoint-session.ts";
import { createTaskCompletedTool } from "../task-completed.ts";
import { makeToolProjectFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

import type { TextContent } from "@earendil-works/pi-ai";
import type { ActiveExecutionWorkflow } from "../../shared/session/hosted-session.ts";
import type { RequestDispatchKind } from "../../shared/session/request-dispatch.ts";
import type {
    RuntimeAssistantTextDeltaEvent,
    SessionRuntimeEvent,
} from "../../shared/session/session-runtime-events.ts";
import type { PairCheckpointDecision } from "../../shared/session/pair-checkpoint-session.ts";
import type { PairCheckpointDetails, PairCheckpointParameters } from "../pair-checkpoint.ts";
import type { BrowserPreflightOutcome, TaskCompletedDetails } from "../task-completed.ts";

interface ObservedCompletionEvent extends Partial<Omit<RuntimeAssistantTextDeltaEvent, "type">> {
    type: SessionRuntimeEvent["type"];
}
interface CompletionTestParameters extends PairCheckpointParameters {
    message?: string;
    browserPreflightOutcome?: BrowserPreflightOutcome;
}
interface CompletionTestDetails {
    outcome: TaskCompletedDetails["outcome"] | PairCheckpointDetails["outcome"];
    reason?: string;
    checkpointId?: string;
    checkpointNumber?: number;
    decision?: PairCheckpointDecision | "pending";
    message?: string;
    browserPreflightOutcome?: BrowserPreflightOutcome;
}
interface CompletionTestResult {
    terminate: boolean;
    details: CompletionTestDetails;
    content: TextContent[];
}
// Existing direct-handler tests omit the unused SDK signal, update callback, and context arguments.
type CompletionTestExecute = (toolCallId: string, params: CompletionTestParameters) => Promise<CompletionTestResult>;

const TASK_PROJECT_ROOT = makeToolProjectFixture("runwield-task-completed-");

function makeSessionManager(projectRoot: string): SessionManager {
    const manager = SessionManager.create(projectRoot, join(projectRoot, ".test-sessions", crypto.randomUUID()));
    manager.appendMessage({ role: "user", content: "Begin the task.", timestamp: Date.now() });
    manager.appendMessage(fauxAssistantMessage(fauxText("Ready for the task.")));
    return manager;
}

function beginRequest(
    hostedSession: HostedSession,
    sessionManager: SessionManager,
    dispatchKind: RequestDispatchKind = "interactive",
) {
    const activeTurnId = hostedSession.getActiveTurnId();
    if (activeTurnId) hostedSession.endTurn(activeTurnId);
    hostedSession.beginTurn(`turn:${crypto.randomUUID()}`);
    sessionManager.appendCustomEntry("runwield.request_attempt", {
        version: 1,
        requestId: `request:${crypto.randomUUID()}`,
        attemptId: `attempt:${crypto.randomUUID()}`,
        requestHash: "hash",
        dispatchKind,
        backend: "test",
        phase: "started",
        promptMode: "original",
        requestRecorded: false,
    });
}

test("task_completed emits one semantic assistant message and terminates", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const events: ObservedCompletionEvent[] = [];
        const hostedSession = new HostedSession({ id: "task-completed", cwd: projectRoot });
        hostedSession.setEventSink({ emit: (event: ObservedCompletionEvent) => events.push(event) });
        const tool = createTaskCompletedTool({ hostedSession, agentName: "engineer" });

        const result = await (tool.execute as CompletionTestExecute)("call", { message: "- Implemented and tested." });

        assertEquals(result.terminate, true);
        assertEquals(result.details, { outcome: "task_completed", message: "- Implemented and tested." });
        assertEquals(events.length, 1);
        assertEquals(events[0].type, RuntimeEventTypes.ASSISTANT_TEXT_DELTA);
        assertEquals(events[0].agentName, "engineer");
        assertEquals(events[0].messageKind, "workflow");
        assertEquals(events[0].workflowMessage, "task_completed");
        assertEquals(events[0].delta, "**Task completed.**\n\n- Implemented and tested.");
        const metrics = await readMetrics();
        assertEquals(metrics.length, 1);
        assertEquals(metrics[0].event, "task_completed");
        assertEquals(metrics[0].agentName, "engineer");
        assertEquals(metrics[0].details, { hasMessage: true });
    });
});

test("task_completed warns once for running work and cancels it before publishing acceptance", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const events: ObservedCompletionEvent[] = [];
        const session = new HostedSession({ id: `completion-warning-${crypto.randomUUID()}`, cwd: projectRoot });
        session.setEventSink({ emit: (event: ObservedCompletionEvent) => events.push(event) });
        try {
            const task = session.backgroundTasks.startShell({ command: "sleep 8", cwd: projectRoot });
            const first = await (
                createTaskCompletedTool({ hostedSession: session, agentName: "engineer" })
                    .execute as CompletionTestExecute
            )("first", { message: "- Done." });
            assertEquals(first.details, { outcome: "rejected", reason: "background_tasks_pending" });
            assertEquals(first.terminate, false);
            assertStringIncludes(first.content[0].text, task.task_id);
            assertStringIncludes(first.content[0].text, "shell");
            assertEquals(session.backgroundTasks.status(task.task_id).state, "running");
            assertEquals(session.consumePendingTaskCompletion(null), null);
            assertEquals(events, []);
            assertEquals((await readMetrics()).length, 0);
            const second = await (
                createTaskCompletedTool({ hostedSession: session, agentName: "engineer" })
                    .execute as CompletionTestExecute
            )("retry", { message: "- Done." });
            assertEquals(second.details.outcome, "task_completed");
            assertEquals(session.backgroundTasks.activeCount, 0);
            assertEquals(session.backgroundTasks.pendingCompletions(), []);
            assertEquals(session.backgroundTasks.status(task.task_id).state, "cancelled");
            let startError = "";
            try {
                session.backgroundTasks.startShell({ command: "printf 'too late'", cwd: projectRoot });
            } catch (error) {
                startError = String(error);
            }
            assertStringIncludes(startError, "Background tasks are stopping");
            assertEquals((await readMetrics()).length, 1);
        } finally {
            await session.dispose();
        }
    });
});

test("workflow metadata refresh preserves the warning but a new assignment gets its own warning", async () => {
    const session = new HostedSession({ id: `completion-workflow-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    const workflow: ActiveExecutionWorkflow = {
        planName: "first-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionAttemptStartedAtMs: 1234,
    };
    session.setActiveExecutionWorkflow(workflow);
    try {
        session.backgroundTasks.startShell({ command: "sleep 8", cwd: TASK_PROJECT_ROOT });
        const finish = createTaskCompletedTool({ hostedSession: session, agentName: "Plan Engineer" });
        assertEquals(
            (await (finish.execute as CompletionTestExecute)("first", { message: "- Done." })).details.reason,
            "background_tasks_pending",
        );
        session.setActiveExecutionWorkflow({ ...workflow, pairCheckpointCount: 2 });
        const refreshed = await (finish.execute as CompletionTestExecute)("second", { message: "- Done." });
        assertEquals(refreshed.details.outcome, "task_completed");
        session.backgroundTasks.resumeDelivery();
        session.backgroundTasks.startShell({ command: "sleep 8", cwd: TASK_PROJECT_ROOT });
        session.setActiveExecutionWorkflow({ ...workflow, planName: "second-plan" });
        const newAssignment = await (finish.execute as CompletionTestExecute)("third", { message: "- Done." });
        assertEquals(newAssignment.details.reason, "background_tasks_pending");
    } finally {
        await session.dispose();
    }
});

test("later completion cycle warns again for new tasks", async () => {
    const session = new HostedSession({ id: `completion-cycle-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    try {
        const firstTask = session.backgroundTasks.startShell({ command: "sleep 8", cwd: TASK_PROJECT_ROOT });
        const firstWarning = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }).execute as CompletionTestExecute
        )("first", { message: "- Done." });
        assertEquals(firstWarning.details.reason, "background_tasks_pending");
        const accepted = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }).execute as CompletionTestExecute
        )("retry", { message: "- Done." });
        assertEquals(accepted.details.outcome, "task_completed");
        assertEquals(session.backgroundTasks.status(firstTask.task_id).state, "cancelled");
        session.backgroundTasks.resumeDelivery();
        const secondTask = session.backgroundTasks.startShell({ command: "sleep 8", cwd: TASK_PROJECT_ROOT });
        const nextWarning = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }).execute as CompletionTestExecute
        )("new-cycle", { message: "- New work done." });
        assertEquals(nextWarning.details.reason, "background_tasks_pending");
        assertEquals(session.backgroundTasks.status(secondTask.task_id).state, "running");
    } finally {
        await session.dispose();
    }
});

test("a finished task after the first warning does not require another warning", async () => {
    const session = new HostedSession({ id: `completion-finish-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    try {
        const task = session.backgroundTasks.startShell({
            command: "sleep 0.1; printf 'done'",
            cwd: TASK_PROJECT_ROOT,
        });
        const first = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }).execute as CompletionTestExecute
        )("first", { message: "- Done." });
        assertEquals(first.details, { outcome: "rejected", reason: "background_tasks_pending" });
        await session.backgroundTasks.wait(task.task_id);
        const second = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }).execute as CompletionTestExecute
        )("second", { message: "- Verified result." });
        assertEquals(second.details.outcome, "task_completed");
        assertEquals(session.backgroundTasks.pendingCompletions(), []);
    } finally {
        await session.dispose();
    }
});

test("wrong owner does not consume the background completion warning", async () => {
    const session = new HostedSession({ id: `completion-owner-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    session.setActiveExecutionWorkflow({
        planName: "owner-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
    });
    try {
        const task = session.backgroundTasks.startShell({ command: "sleep 8", cwd: TASK_PROJECT_ROOT });
        const invalid = await (
            createTaskCompletedTool({
                hostedSession: session,
                agentName: "Frontend Engineer",
            }).execute as CompletionTestExecute
        )("invalid", { message: "- Done.", browserPreflightOutcome: "succeeded" });
        assertEquals(invalid.details, { outcome: "rejected", reason: "wrong_execution_owner" });
        const valid = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "Plan Engineer" })
                .execute as CompletionTestExecute
        )("valid", { message: "- Done." });
        assertEquals(valid.details, { outcome: "rejected", reason: "background_tasks_pending" });
        assertEquals(session.backgroundTasks.status(task.task_id).state, "running");
    } finally {
        await session.dispose();
    }
});

test("completion does not suppress another Session's background result", async () => {
    const first = new HostedSession({ id: `completion-isolation-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    const second = new HostedSession({ id: `other-isolation-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    try {
        const other = second.backgroundTasks.startShell({ command: "printf 'other result'", cwd: TASK_PROJECT_ROOT });
        const finished = await (
            createTaskCompletedTool({ hostedSession: first, agentName: "engineer" }).execute as CompletionTestExecute
        )("first", { message: "- Done." });
        assertEquals(finished.details.outcome, "task_completed");
        await second.backgroundTasks.wait(other.task_id);
        assertEquals(
            second.backgroundTasks.pendingCompletions().map((task) => task.task_id),
            [other.task_id],
        );
    } finally {
        await first.dispose();
        await second.dispose();
    }
});

test("task_completed suppresses a finished undelivered result and allows new work", async () => {
    const session = new HostedSession({ id: `completion-pending-${crypto.randomUUID()}`, cwd: TASK_PROJECT_ROOT });
    try {
        const task = session.backgroundTasks.startShell({ command: "printf 'finished'", cwd: TASK_PROJECT_ROOT });
        await session.backgroundTasks.wait(task.task_id);
        assertEquals(session.backgroundTasks.pendingCompletions().length, 1);
        const accepted = await (
            createTaskCompletedTool({ hostedSession: session, agentName: "engineer" }).execute as CompletionTestExecute
        )("accept", { message: "- Done." });
        assertEquals(accepted.details.outcome, "task_completed");
        assertEquals(session.backgroundTasks.pendingCompletions(), []);
        session.backgroundTasks.resumeDelivery();
        const next = session.backgroundTasks.startShell({ command: "printf 'new'", cwd: TASK_PROJECT_ROOT });
        await session.backgroundTasks.wait(next.task_id);
        assertEquals(
            session.backgroundTasks.pendingCompletions().map((item) => item.task_id),
            [next.task_id],
        );
        assertEquals(session.backgroundTasks.canDeliver(task.task_id), false);
    } finally {
        await session.dispose();
    }
});

test("task_completed records accepted completion on hosted session only after ownership checks", async () => {
    const hostedSession = new HostedSession({ id: "task-completed-records-accepted", cwd: TASK_PROJECT_ROOT });
    hostedSession.setActiveExecutionWorkflow({
        planName: "implementation-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
    });
    const tool = createTaskCompletedTool({
        hostedSession,
        agentName: "Plan Engineer",
        now: () => 1234,
    });

    const result = await (tool.execute as CompletionTestExecute)("call", { message: "- Done." });
    const completion = hostedSession.consumePendingTaskCompletion(null);

    assertEquals(result.details, { outcome: "task_completed", message: "- Done." });
    assertEquals(completion, {
        agentName: "plan-engineer",
        report: "- Done.",
        timestampMs: 1234,
        owningSession: null,
    });
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);

    hostedSession.setActiveExecutionWorkflow({
        planName: "frontend-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "frontend-engineer",
    });
    const rejectedTool = createTaskCompletedTool({ hostedSession, agentName: "Engineer" });

    const rejected = await (rejectedTool.execute as CompletionTestExecute)("call", { message: "- Wrong owner." });

    assertEquals(rejected.details, { outcome: "rejected", reason: "wrong_execution_owner" });
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);
});

test("task_completed rejects a mismatched active workflow owner without side effects", async () => {
    const events: ObservedCompletionEvent[] = [];
    const hostedSession = new HostedSession({ id: "task-completed-wrong-owner", cwd: TASK_PROJECT_ROOT });
    hostedSession.setEventSink({ emit: (event: ObservedCompletionEvent) => events.push(event) });
    hostedSession.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
    });
    const tool = createTaskCompletedTool({ hostedSession, agentName: "engineer" });

    const result = await (tool.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(result.terminate, false);
    assertEquals(result.details, { outcome: "rejected", reason: "wrong_execution_owner" });
    assertEquals(events, []);
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAgent, "frontend-engineer");
});

test("task_completed rejects a provisional workflow before execution starts", async () => {
    const events: ObservedCompletionEvent[] = [];
    const hostedSession = new HostedSession({ id: "task-completed-not-started", cwd: TASK_PROJECT_ROOT });
    hostedSession.setEventSink({ emit: (event: ObservedCompletionEvent) => events.push(event) });
    hostedSession.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        executionStarted: false,
        collaborationStyle: "autonomous",
    });
    const tool = createTaskCompletedTool({ hostedSession, agentName: "Frontend Engineer" });

    const result = await (tool.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(result.terminate, false);
    assertEquals(result.details, { outcome: "rejected", reason: "execution_not_started" });
    assertEquals(events, []);
});

test("task_completed rejects a paused Pair turn without terminal side effects", async () => {
    const events: ObservedCompletionEvent[] = [];
    const hostedSession = new HostedSession({ id: "task-completed-pair-paused", cwd: TASK_PROJECT_ROOT });
    hostedSession.setEventSink({ emit: (event: ObservedCompletionEvent) => events.push(event) });
    hostedSession.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        collaborationStyle: "pair",
        pairCheckpointCount: 1,
        pairPauseReason: "stop",
    });
    const tool = createTaskCompletedTool({ hostedSession, agentName: "Frontend Engineer" });

    const result = await (tool.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(result.terminate, false);
    assertEquals(result.details, { outcome: "rejected", reason: "pair_execution_paused" });
    assertEquals(events, []);
});

test("task_completed records a final Pair checkpoint before accepting completion", async () => {
    const sessionManager = makeSessionManager(TASK_PROJECT_ROOT);
    const hostedSession = new HostedSession({
        id: "task-completed-final-pair",
        cwd: TASK_PROJECT_ROOT,
        sessionManager,
    });
    hostedSession.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 1000,
        collaborationStyle: "pair",
        pairCheckpointCount: 1,
    });
    const completionTool = createTaskCompletedTool({ hostedSession, agentName: "Frontend Engineer" });
    beginRequest(hostedSession, sessionManager, "plan_execution");

    const pending = await (completionTool.execute as CompletionTestExecute)("final-call", {
        message: "- Final page is ready.",
        browserPreflightOutcome: "succeeded",
    });
    const checkpoint = readCurrentPairCheckpoint(hostedSession);

    assertEquals(pending.terminate, true);
    assertEquals(pending.details.outcome, "pair_completion_checkpoint");
    assertEquals(pending.details.decision, "pending");
    assertEquals(checkpoint?.report.report.final, true);
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);

    const task = hostedSession.backgroundTasks.startShell({ command: "sleep 8", cwd: TASK_PROJECT_ROOT });
    beginRequest(hostedSession, sessionManager);
    const stillPending = await (completionTool.execute as CompletionTestExecute)("early-call", {
        message: "- Final page is ready.",
        browserPreflightOutcome: "succeeded",
    });
    assertEquals(stillPending.details, { outcome: "rejected", reason: "pair_final_checkpoint_pending" });
    assertEquals(hostedSession.backgroundTasks.status(task.task_id).state, "running");

    const pairTool = createPairCheckpointTool({ hostedSession });
    const accepted = await (pairTool.execute as CompletionTestExecute)("resolve-final", {
        action: "resolve",
        checkpointId: checkpoint?.report.checkpointId,
        decision: "continue",
    });
    assertEquals(accepted.details.decision, "continue");

    const warned = await (completionTool.execute as CompletionTestExecute)("warn-call", {
        message: "- Final page is ready.",
        browserPreflightOutcome: "succeeded",
    });
    assertEquals(warned.details, { outcome: "rejected", reason: "background_tasks_pending" });
    const completed = await (completionTool.execute as CompletionTestExecute)("accepted-call", {
        message: "- Final page is ready.",
        browserPreflightOutcome: "succeeded",
    });
    assertEquals(completed.details.outcome, "task_completed");
    assertEquals(completed.terminate, true);
    assertEquals(readCurrentPairCheckpoint(hostedSession), null);
});

test("a later revision revokes final Pair assent", async () => {
    const sessionManager = makeSessionManager(TASK_PROJECT_ROOT);
    const hostedSession = new HostedSession({
        id: "task-completed-revised-final-pair",
        cwd: TASK_PROJECT_ROOT,
        sessionManager,
    });
    hostedSession.setActiveExecutionWorkflow({
        planName: "revised-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "frontend-engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 1000,
        collaborationStyle: "pair",
        pairCheckpointCount: 0,
    });
    const completionTool = createTaskCompletedTool({ hostedSession, agentName: "Frontend Engineer" });
    const pairTool = createPairCheckpointTool({ hostedSession });
    beginRequest(hostedSession, sessionManager, "plan_execution");
    const pending = await (completionTool.execute as CompletionTestExecute)("final-call", {
        message: "- Final result is ready.",
        browserPreflightOutcome: "succeeded",
    });

    beginRequest(hostedSession, sessionManager);
    const accepted = await (pairTool.execute as CompletionTestExecute)("resolve-final", {
        action: "resolve",
        checkpointId: pending.details.checkpointId,
        decision: "continue",
    });
    assertEquals(accepted.details.decision, "continue");

    beginRequest(hostedSession, sessionManager);
    const revised = await (pairTool.execute as CompletionTestExecute)("revise-final", {
        action: "resolve",
        checkpointId: pending.details.checkpointId,
        decision: "revise",
        revisionDirection: "Change the final result before validation.",
    });
    assertEquals(revised.details.decision, "revise");

    const replacement = await (completionTool.execute as CompletionTestExecute)("replacement-final", {
        message: "- Revised final result is ready.",
        browserPreflightOutcome: "succeeded",
    });
    assertEquals(replacement.details.outcome, "pair_completion_checkpoint");
    assertEquals(replacement.details.decision, "pending");
    assertEquals(replacement.details.checkpointId === pending.details.checkpointId, false);
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);
});

test("final Pair assent cannot authorize a different execution attempt", async () => {
    const sessionManager = makeSessionManager(TASK_PROJECT_ROOT);
    const hostedSession = new HostedSession({
        id: "task-completed-stale-final-assent",
        cwd: TASK_PROJECT_ROOT,
        sessionManager,
    });
    const workflow: ActiveExecutionWorkflow = {
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 1000,
        collaborationStyle: "pair",
        pairCheckpointCount: 0,
    };
    hostedSession.setActiveExecutionWorkflow(workflow);
    const completionTool = createTaskCompletedTool({ hostedSession, agentName: "Frontend Engineer" });
    beginRequest(hostedSession, sessionManager, "plan_execution");
    const pending = await (completionTool.execute as CompletionTestExecute)("first-final", {
        message: "- First attempt is ready.",
        browserPreflightOutcome: "succeeded",
    });
    beginRequest(hostedSession, sessionManager);
    await (createPairCheckpointTool({ hostedSession }).execute as CompletionTestExecute)("resolve-first", {
        action: "resolve",
        checkpointId: pending.details.checkpointId,
        decision: "continue",
    });

    hostedSession.setActiveExecutionWorkflow({
        ...workflow,
        executionAttemptStartedAtMs: 2000,
        pairCheckpointCount: 0,
    });
    const stale = await (completionTool.execute as CompletionTestExecute)("second-final", {
        message: "- Second attempt is ready.",
        browserPreflightOutcome: "succeeded",
    });

    assertEquals(stale.details.outcome, "pair_completion_checkpoint");
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);
    assertEquals(readCurrentPairCheckpoint(hostedSession)?.report.workflow.executionAttemptStartedAtMs, 2000);
});

for (const outcome of ["succeeded", "failed", "externally_blocked"] satisfies BrowserPreflightOutcome[]) {
    test(`task_completed records Frontend Engineer completion preflight outcome ${outcome}`, async () => {
        await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
            const sessionManager = makeSessionManager(projectRoot);
            const hostedSession = new HostedSession({
                id: `task-completed-${outcome}`,
                cwd: projectRoot,
                sessionManager,
            });
            hostedSession.setActiveExecutionWorkflow({
                planName: "visual-plan",
                triageMeta: { classification: "FEATURE" },
                executionAgent: "frontend-engineer",
                executionStarted: true,
                executionAttemptStartedAtMs: 1000,
                collaborationStyle: "pair",
                pairCheckpointCount: 2,
                pairSwitchedToAutonomous: true,
                pairCapabilityLost: false,
            });
            const tool = createTaskCompletedTool({
                hostedSession,
                agentName: "Frontend Engineer",
                now: () => 1750,
            });

            beginRequest(hostedSession, sessionManager, "plan_execution");
            const pending = await (tool.execute as CompletionTestExecute)("call", {
                message: "- URL: http://localhost:5173/private\n- Screenshot: /tmp/secret.png",
                browserPreflightOutcome: outcome,
            });
            beginRequest(hostedSession, sessionManager);
            await (createPairCheckpointTool({ hostedSession }).execute as CompletionTestExecute)("resolve", {
                action: "resolve",
                checkpointId: pending.details.checkpointId,
                decision: "continue",
            });
            const result = await (tool.execute as CompletionTestExecute)("accepted", {
                message: "- URL: http://localhost:5173/private\n- Screenshot: /tmp/secret.png",
                browserPreflightOutcome: outcome,
            });

            assertEquals(result.terminate, true);
            assertEquals(result.details.browserPreflightOutcome, outcome);
            const metrics = await readMetrics();
            assertEquals(
                metrics.map((metric) => ({
                    event: metric.event,
                    agentName: metric.agentName,
                    details: metric.details,
                })),
                [
                    {
                        event: "pair_checkpoint_decided",
                        agentName: undefined,
                        details: {
                            checkpointNumber: 3,
                            decision: "continue",
                        },
                    },
                    {
                        event: "task_completed",
                        agentName: "Frontend Engineer",
                        details: { hasMessage: true },
                    },
                    {
                        event: "frontend_execution_completed",
                        agentName: undefined,
                        details: {
                            phase: "implementation",
                            runtimeStyle: "pair",
                            checkpointCount: 3,
                            switchedToAutonomous: true,
                            capabilityLost: false,
                            browserPreflightOutcome: outcome,
                            elapsedMs: 750,
                        },
                    },
                ],
            );
            assertEquals(JSON.stringify(metrics).includes("localhost"), false);
            assertEquals(JSON.stringify(metrics).includes("secret.png"), false);
        });
    });
}

test("task_completed labels validation repair Frontend Engineer completion", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const hostedSession = new HostedSession({ id: "task-completed-repair", cwd: projectRoot });
        hostedSession.setActiveExecutionWorkflow({
            planName: "visual-plan",
            triageMeta: { classification: "FEATURE" },
            executionAgent: "frontend-engineer",
            executionStarted: true,
            executionAttemptStartedAtMs: 500,
            validationContinuation: true,
            collaborationStyle: "autonomous",
            pairCheckpointCount: 0,
        });
        const tool = createTaskCompletedTool({
            hostedSession,
            agentName: "frontend-engineer",
            now: () => 900,
        });

        await (tool.execute as CompletionTestExecute)("call", {
            message: "- Repair complete.",
            browserPreflightOutcome: "succeeded",
        });

        const metrics = await readMetrics();
        assertEquals(metrics[1].details?.phase, "validation_repair");
        assertEquals(metrics[1].details?.elapsedMs, 400);
    });
});

test("task_completed accepts the Reviewer-Feedback Engineer completing on the owner's behalf", async () => {
    // Validation keeps the execution owner on the active workflow while a repair agent
    // works, so an owner check alone rejects the completion the loop is waiting for and
    // the repair round can never finish.
    const events: ObservedCompletionEvent[] = [];
    const hostedSession = new HostedSession({ id: "task-completed-repair-agent", cwd: TASK_PROJECT_ROOT });
    hostedSession.setEventSink({ emit: (event: ObservedCompletionEvent) => events.push(event) });
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        validationContinuation: true,
    });
    const tool = createTaskCompletedTool({
        hostedSession,
        agentName: "reviewer-feedback-engineer",
    });

    const result = await (tool.execute as CompletionTestExecute)("call", { message: "- Repaired the finding." });

    assertEquals(result.details.outcome, "task_completed");
    assertEquals(
        hostedSession.getActiveExecutionWorkflow()?.executionAgent,
        "engineer",
        "the execution owner is unchanged by a repair completion",
    );
});

test("an engineer-owned Plan is completed by Plan Engineer, not by the Quick Fix Engineer", async () => {
    // The workflow records `engineer` for both a Plan and a QUICK_FIX, so the
    // owner check has to resolve the runtime Agent rather than compare strings.
    const hostedSession = new HostedSession({ id: "task-completed-plan-owner", cwd: TASK_PROJECT_ROOT });
    hostedSession.setActiveExecutionWorkflow({
        planName: "backend-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
    });

    const quickFixEngineer = createTaskCompletedTool({ hostedSession, agentName: "engineer" });
    const rejected = await (quickFixEngineer.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(rejected.details, { outcome: "rejected", reason: "wrong_execution_owner" });
    assertStringIncludes(rejected.content[0].text, "active workflow owner is plan-engineer");
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);

    const planEngineer = createTaskCompletedTool({ hostedSession, agentName: "plan-engineer" });
    const accepted = await (planEngineer.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(accepted.details, { outcome: "task_completed", message: "- Done." });
    assertEquals(hostedSession.consumePendingTaskCompletion(null)?.agentName, "plan-engineer");
});

test("a QUICK_FIX is completed by the Quick Fix Engineer, not by Plan Engineer", async () => {
    const hostedSession = new HostedSession({ id: "task-completed-quick-fix-owner", cwd: TASK_PROJECT_ROOT });
    hostedSession.setActiveExecutionWorkflow({
        planName: "quick-fix",
        triageMeta: { classification: "QUICK_FIX" },
        executionAgent: "engineer",
    });

    const planEngineer = createTaskCompletedTool({ hostedSession, agentName: "plan-engineer" });
    const rejected = await (planEngineer.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(rejected.details, { outcome: "rejected", reason: "wrong_execution_owner" });
    assertEquals(hostedSession.consumePendingTaskCompletion(null), null);

    const engineer = createTaskCompletedTool({ hostedSession, agentName: "engineer" });
    const accepted = await (engineer.execute as CompletionTestExecute)("call", { message: "- Done." });

    assertEquals(accepted.details, { outcome: "task_completed", message: "- Done." });
    assertEquals(hostedSession.consumePendingTaskCompletion(null)?.agentName, "engineer");
});

test("Frontend completion requires a report and a recognized preflight outcome at the agent tool boundary", () => {
    const hostedSession = new HostedSession({ id: "preflight-contract", cwd: TASK_PROJECT_ROOT });
    const tool = createTaskCompletedTool({ hostedSession, agentName: "Frontend Engineer" });
    const inputs: Record<string, string>[] = [
        { message: "Done" },
        { message: "", browserPreflightOutcome: "succeeded" },
        { message: "Done", browserPreflightOutcome: "invented" },
    ];
    for (const args of inputs) {
        assertThrows(
            () => validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args }),
            /Validation failed/,
        );
    }
});
