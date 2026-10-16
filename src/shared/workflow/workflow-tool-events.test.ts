import { test } from "node:test";
import { assertEquals, assertExists, assertThrows } from "../../testing/assertions.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { makeToolProjectFixture } from "../../testing/workflow-metrics-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import {
    claimWorkflowToolEvent,
    listPendingWorkflowToolEvents,
    publishWorkflowToolEvent,
    settleWorkflowToolEvent,
    waitForWorkflowToolEvent,
    withWorkflowToolEventSource,
    WORKFLOW_TOOL_EVENT_CUSTOM_TYPE,
} from "./workflow-tool-events.ts";
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

function makeHostedSession(id: string) {
    const sessionManager = SessionManager.inMemory(PROJECT_ROOT);
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
    const firstRun = withWorkflowToolEventSource(hostedSession, first, async () => {
        await gate;
        await execute("first-qa", { checklistMarkdown: "- [ ] First checklist" });
    });
    const secondToken = hostedSession.pushSteeringTargetSession(second);
    await withWorkflowToolEventSource(hostedSession, second, async () => {
        await execute("second-qa", { checklistMarkdown: "- [ ] Second checklist" });
        releaseFirst();
        await firstRun;
    });
    for (const owner of [first, second]) {
        const event = claimWorkflowToolEvent(hostedSession, {
            kinds: ["manual_qa_completed"],
            owningSession: owner,
            sourceSessionId: owner.sessionManager.getSessionId(),
        });
        assertExists(event);
        assertEquals(event.owningSession, owner);
        settleWorkflowToolEvent(hostedSession, event);
    }
    hostedSession.popSteeringTargetSession(secondToken);
    hostedSession.popSteeringTargetSession(firstToken);
    assertEquals(listPendingWorkflowToolEvents(hostedSession), []);
});

test("Workflow Tool Event is consume-once and settled through the root outbox", () => {
    const { hostedSession, sessionManager, root } = makeHostedSession("workflow-event-root");
    hostedSession.beginTurn("turn-1");
    publishWorkflowToolEvent({
        hostedSession,
        toolCallId: "triage-call",
        kind: "triage_report",
        payload: {
            routingIntent: "QUICK_FIX",
            complexity: "LOW",
            summary: "Fix it.",
            classification: "QUICK_FIX",
        },
    });

    const claimed = claimWorkflowToolEvent(hostedSession, { kinds: ["triage_report"], owningSession: root });
    assertExists(claimed);
    assertEquals(claimed.turnId, "turn-1");
    assertEquals(claimWorkflowToolEvent(hostedSession, { kinds: ["triage_report"], owningSession: root }), null);

    settleWorkflowToolEvent(hostedSession, claimed, 1234);
    assertEquals(listPendingWorkflowToolEvents(hostedSession).length, 0);
    const journalEntries = sessionManager.getBranch().filter((entry) =>
        entry.type === "custom" && entry.customType === WORKFLOW_TOOL_EVENT_CUSTOM_TYPE
    );
    assertEquals(journalEntries.length, 2);
});

test("Workflow Tool Event waiters receive events published before turn completion", async () => {
    const { hostedSession, root } = makeHostedSession("workflow-event-waiter");
    const waited = waitForWorkflowToolEvent(hostedSession, { kinds: ["plan_written"], owningSession: root });
    publishWorkflowToolEvent({
        hostedSession,
        toolCallId: "plan-call",
        kind: "plan_written",
        payload: { outcome: "approved_execute", planName: "event-plan" },
    });

    const claimed = await waited;
    assertEquals(claimed.kind, "plan_written");
    const payload = claimed.payload as import("./workflow-tool-events.ts").PlanWrittenEventPayload;
    assertEquals(payload.planName, "event-plan");
    assertEquals(claimWorkflowToolEvent(hostedSession, { kinds: ["plan_written"], owningSession: root }), null);
});

test("Workflow Tool Event rejects duplicate tool calls after settlement", () => {
    const { hostedSession, root } = makeHostedSession("workflow-event-duplicate-settled");
    hostedSession.beginTurn("turn-1");
    const event = publishWorkflowToolEvent({
        hostedSession,
        toolCallId: "duplicate-call",
        kind: "plan_written",
        payload: { outcome: "approved_execute", planName: "event-plan" },
    });
    const claimed = claimWorkflowToolEvent(hostedSession, { kinds: ["plan_written"], owningSession: root });
    assertExists(claimed);
    settleWorkflowToolEvent(hostedSession, claimed);

    assertThrows(
        () =>
            publishWorkflowToolEvent({
                hostedSession,
                toolCallId: "duplicate-call",
                kind: "triage_report",
                payload: {
                    routingIntent: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Fix it.",
                    classification: "QUICK_FIX",
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
    publishWorkflowToolEvent({
        hostedSession,
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

    assertEquals(claimWorkflowToolEvent(hostedSession, { kinds: ["task_completed"], owningSession: root }), null);
});
