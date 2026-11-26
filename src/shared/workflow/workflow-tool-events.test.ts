import { test } from "node:test";
import { join } from "node:path";
import { assertEquals, assertExists, assertThrows } from "../../testing/assertions.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeToolProjectFixture } from "../../testing/workflow-metrics-fixture.ts";
import { HostedSession } from "@runwield/session-runtime/host";
import { workflowEvents, WORKFLOW_TOOL_EVENT_CUSTOM_TYPE } from "@runwield/workflow/events";
import { createManualQaCompletedTool } from "../../tools/manual-qa-completed.ts";

const PROJECT_ROOT = makeToolProjectFixture("runwield-workflow-tool-events-");
type HostedSessionManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;
type ChecklistToolExecute = (
    id: string,
    params: { checklistMarkdown: string },
) => ReturnType<ReturnType<typeof createManualQaCompletedTool>["execute"]>;

function hostedSessionManager(sessionManager: SessionManager): HostedSessionManager {
    return sessionManager as HostedSessionManager;
}

function makeHostedSession(id: string, sessionManager = SessionManager.inMemory(PROJECT_ROOT)) {
    const hostedSession = new HostedSession({
        id,
        cwd: PROJECT_ROOT,
        sessionManager: hostedSessionManager(sessionManager),
    });
    const root = { dispose: () => {} };
    hostedSession.setRootAgentSession(root);
    return { hostedSession, sessionManager, root };
}

test("concurrent isolated completion keeps its caller even when another Agent owns the footer", async () => {
    const { hostedSession } = makeHostedSession("concurrent-tool-source");
    const first = { sessionManager: SessionManager.inMemory(PROJECT_ROOT), dispose() {} };
    const second = { sessionManager: SessionManager.inMemory(PROJECT_ROOT), dispose() {} };
    const firstToken = hostedSession.pushSteeringTargetSession(first);
    let releaseFirst = () => {};
    const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const tool = createManualQaCompletedTool({ hostedSession, name: "plan", classification: "PLANNED_CHANGE" });
    const execute = tool.execute as ChecklistToolExecute;
    const firstRun = workflowEvents(hostedSession).withSource(first, async () => {
        await gate;
        await execute("first-qa", { checklistMarkdown: "- [ ] First checklist" });
    });
    const secondToken = hostedSession.pushSteeringTargetSession(second);
    await workflowEvents(hostedSession).withSource(second, async () => {
        await execute("second-qa", { checklistMarkdown: "- [ ] Second checklist" });
        releaseFirst();
        await firstRun;
    });
    for (const owner of [first, second]) {
        const event = workflowEvents(hostedSession).claim({
            kinds: ["manual_qa_completed"],
            owningSession: owner,
            sourceSessionId: owner.sessionManager.getSessionId(),
        });
        assertExists(event);
        assertEquals(event.owningSession, owner);
        workflowEvents(hostedSession).settle(event);
    }
    hostedSession.popSteeringTargetSession(secondToken);
    hostedSession.popSteeringTargetSession(firstToken);
    assertEquals(workflowEvents(hostedSession).pending(), []);
});

test("Workflow Tool Event is consume-once and settled through the root outbox", () => {
    const { hostedSession, sessionManager, root } = makeHostedSession("workflow-event-root");
    hostedSession.beginTurn("turn-1");
    workflowEvents(hostedSession).publish({
        toolCallId: "triage-call",
        kind: "triage_report",
        payload: {
            routingIntent: "QUICK_FIX",
            complexity: "LOW",
            summary: "Fix it.",
        },
    });

    const claimed = workflowEvents(hostedSession).claim({ kinds: ["triage_report"], owningSession: root });
    assertExists(claimed);
    assertEquals(claimed.turnId, "turn-1");
    assertEquals(workflowEvents(hostedSession).claim({ kinds: ["triage_report"], owningSession: root }), null);

    workflowEvents(hostedSession).settle(claimed, 1234);
    assertEquals(workflowEvents(hostedSession).pending().length, 0);
    const journalEntries = sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_TOOL_EVENT_CUSTOM_TYPE);
    assertEquals(journalEntries.length, 2);
});

test("write-only and read-only transcript adapters preserve workflow report journaling", () => {
    const sessionDir = join(PROJECT_ROOT, "partial-journal-sessions");
    const manager = SessionManager.create(PROJECT_ROOT, sessionDir);
    manager.appendMessage({ role: "user", content: "Run workflow QA.", timestamp: 1 });
    const transcript = manager.getSessionFile();
    assertExists(transcript);
    const writerOnly = new HostedSession({
        id: "writer-only",
        cwd: PROJECT_ROOT,
        sessionManager: { appendCustomEntry: manager.appendCustomEntry.bind(manager) },
    });
    const report = {
        toolCallId: "transcript-capabilities",
        kind: "manual_qa_completed" as const,
        payload: { checklistMarkdown: "- [ ] Try" },
    };
    const written = workflowEvents(writerOnly);
    const published = written.publish(report);
    const alreadySettled = written.publish({ ...report, toolCallId: "settled-by-writer" });
    written.settle(alreadySettled);
    assertEquals(writerOnly.getWorkflowEventJournalReader(), null);

    const reopened = SessionManager.open(transcript, sessionDir, PROJECT_ROOT);
    const getEntries = reopened.getEntries.bind(reopened);
    const readerOnly = new HostedSession({ id: "reader-only", cwd: PROJECT_ROOT, sessionManager: { getEntries } });
    assertEquals(readerOnly.getWorkflowEventJournalWriter(), null);
    assertEquals(
        workflowEvents(readerOnly)
            .pending()
            .map((event) => event.eventId),
        [published.eventId],
    );

    const readerWriter = new HostedSession({
        id: "reader-writer",
        cwd: PROJECT_ROOT,
        sessionManager: { appendCustomEntry: reopened.appendCustomEntry.bind(reopened), getEntries },
    });
    const queue = workflowEvents(readerWriter);
    const replayed = queue.claim({ kinds: [report.kind], owningSession: null });
    assertExists(replayed);
    assertEquals(replayed.eventId, published.eventId);
    queue.settle(replayed);
    const { hostedSession: settled } = makeHostedSession(
        "journal-settled",
        SessionManager.open(transcript, sessionDir),
    );
    assertEquals(workflowEvents(settled).pending(), []);
});

test("Workflow Tool Event waiters receive events published before turn completion", async () => {
    const { hostedSession, root } = makeHostedSession("workflow-event-waiter");
    const waited = workflowEvents(hostedSession).wait({ kinds: ["plan_written"], owningSession: root });
    workflowEvents(hostedSession).publish({
        toolCallId: "plan-call",
        kind: "plan_written",
        payload: { outcome: "approved_execute", planName: "event-plan" },
    });

    const claimed = await waited;
    assertEquals(claimed.kind, "plan_written");
    const payload = claimed.payload as import("@runwield/workflow/events").PlanWrittenEventPayload;
    assertEquals(payload.planName, "event-plan");
    assertEquals(workflowEvents(hostedSession).claim({ kinds: ["plan_written"], owningSession: root }), null);
});

test("Workflow Tool Event rejects duplicate tool calls after settlement", () => {
    const { hostedSession, root } = makeHostedSession("workflow-event-duplicate-settled");
    hostedSession.beginTurn("turn-1");
    const event = workflowEvents(hostedSession).publish({
        toolCallId: "duplicate-call",
        kind: "plan_written",
        payload: { outcome: "approved_execute", planName: "event-plan" },
    });
    const claimed = workflowEvents(hostedSession).claim({ kinds: ["plan_written"], owningSession: root });
    assertExists(claimed);
    workflowEvents(hostedSession).settle(claimed);

    assertThrows(
        () =>
            workflowEvents(hostedSession).publish({
                toolCallId: "duplicate-call",
                kind: "triage_report",
                payload: {
                    routingIntent: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Fix it.",
                },
            }),
        Error,
        "Duplicate Workflow Tool Event tool call: duplicate-call",
    );
    assertEquals(event.eventId, "plan_written:turn-1:duplicate-call");
});

test("Workflow Tool Event rejects stale workflow attempts", () => {
    const { hostedSession, root } = makeHostedSession("workflow-event-stale-attempt");
    hostedSession.setActiveExecutionWorkflow({
        planName: "same-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 1,
    });
    workflowEvents(hostedSession).publish({
        toolCallId: "completion-call",
        kind: "task_completed",
        payload: { outcome: "task_completed", agentName: "plan-engineer", message: "done" },
    });
    hostedSession.setActiveExecutionWorkflow({
        planName: "same-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 2,
    });

    assertEquals(workflowEvents(hostedSession).claim({ kinds: ["task_completed"], owningSession: root }), null);
});

test("in-place Workflow Tool Events replay only for their canonical attempt", () => {
    const sessionDir = join(PROJECT_ROOT, "in-place-sessions");
    const sessionId = "in-place-workflow-event";
    const manager = SessionManager.create(PROJECT_ROOT, sessionDir, { id: sessionId });
    manager.appendMessage({ role: "user", content: "Implement the plan in place.", timestamp: 1 });
    const transcript = manager.getSessionFile();
    assertExists(transcript);
    const { hostedSession } = makeHostedSession(sessionId, manager);
    const workflow = {
        planName: "same-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionStarted: true,
        executionMode: "non_git_in_place",
        packageAttemptId: "attempt-one",
    } satisfies NonNullable<Parameters<HostedSession["setActiveExecutionWorkflow"]>[0]>;
    hostedSession.setActiveExecutionWorkflow(workflow);
    const accepted = workflowEvents(hostedSession).publish({
        toolCallId: "in-place-completion",
        kind: "task_completed",
        payload: { outcome: "task_completed", agentName: "plan-engineer", message: "done" },
    });
    assertEquals(accepted.workflowAttemptKey, "package:attempt-one");
    // Older journals stored the ID in the workflow snapshot with an empty key.
    manager.appendCustomEntry(WORKFLOW_TOOL_EVENT_CUSTOM_TYPE, {
        version: accepted.version,
        state: "accepted",
        eventId: "task_completed:legacy-in-place-completion",
        toolCallId: "legacy-in-place-completion",
        kind: accepted.kind,
        owner: accepted.owner,
        turnId: accepted.turnId,
        acceptedAtMs: accepted.acceptedAtMs,
        payload: accepted.payload,
        workflow: accepted.workflow,
        workflowAttemptKey: "",
    });

    const restored = makeHostedSession(sessionId, SessionManager.open(transcript!, sessionDir, PROJECT_ROOT));
    const events = workflowEvents(restored.hostedSession);
    const options = { kinds: ["task_completed" as const], owningSession: restored.root };
    restored.hostedSession.setActiveExecutionWorkflow({ ...workflow, packageAttemptId: "attempt-two" });
    assertEquals(events.claim(options), null);

    restored.hostedSession.setActiveExecutionWorkflow(workflow);
    assertEquals(events.claim(options)?.toolCallId, "legacy-in-place-completion");
    assertEquals(events.claim(options)?.eventId, accepted.eventId);
});

test("an event settles only in its owning Session, once, even when another Session has the same tool call", () => {
    const first = makeHostedSession("first-owner");
    const second = makeHostedSession("second-owner");
    const firstEvents = workflowEvents(first.hostedSession);
    const secondEvents = workflowEvents(second.hostedSession);
    for (const queue of [firstEvents, secondEvents]) {
        queue.publish({
            toolCallId: "same-call",
            kind: "manual_qa_completed",
            payload: { checklistMarkdown: "- [ ] Try" },
        });
    }
    const [snapshot] = firstEvents.pending();
    assertExists(snapshot);
    assertThrows(() => secondEvents.settle(snapshot), Error, "different Session");
    assertEquals(secondEvents.pending().length, 1);
    firstEvents.settle(snapshot);
    firstEvents.settle(snapshot);
    assertEquals(firstEvents.pending().length, 0);
    assertEquals(
        first.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === WORKFLOW_TOOL_EVENT_CUSTOM_TYPE).length,
        2,
    );
    assertEquals(secondEvents.pending().length, 1);
});

test("a restarted root Session can claim and settle a report whose previous handler stopped before settlement", () => {
    const sessionDir = join(PROJECT_ROOT, "sessions");
    const sessionId = "recover-workflow-event";
    const manager = SessionManager.create(PROJECT_ROOT, sessionDir, { id: sessionId });
    manager.appendMessage({ role: "user", content: "Implement the plan.", timestamp: 1 });
    const transcript = manager.getSessionFile();
    assertExists(transcript);
    const { hostedSession, root } = makeHostedSession(sessionId, manager);
    const events = workflowEvents(hostedSession);
    hostedSession.beginTurn("original-turn");
    const accepted = events.publish({
        toolCallId: "interrupted-call",
        kind: "task_completed",
        payload: { outcome: "task_completed", agentName: "engineer", message: "Ran the suite" },
    });
    assertExists(events.claim({ kinds: ["task_completed"], owningSession: root }));
    function restart() {
        const { hostedSession: restored, root: newRoot } = makeHostedSession(
            sessionId,
            SessionManager.open(transcript!, sessionDir, PROJECT_ROOT),
        );
        return { events: workflowEvents(restored), root: newRoot };
    }
    const resumed = restart();
    const recovered = resumed.events.claim({ kinds: ["task_completed"], owningSession: resumed.root });
    assertExists(recovered);
    assertEquals(recovered.eventId, accepted.eventId);
    assertEquals(recovered.payload, accepted.payload);
    resumed.events.settle(recovered);
    assertEquals(restart().events.pending(), []);
});
