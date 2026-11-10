import { getCwd } from "../../constants.ts";
import { test } from "node:test";

import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { HostedSession } from "./hosted-session.ts";
import { WORKFLOW_CONTEXT_CUSTOM_TYPE } from "./workflow-context-session.ts";
import { SessionManager, type CustomEntry } from "@earendil-works/pi-coding-agent";
import type { ActiveExecutionWorkflow } from "./execution-workflow-session.ts";

type SessionManagerFixtureEntry = Required<Pick<CustomEntry<Record<string, string>>, "customType" | "data">>;

interface InvalidCollaborationWorkflow extends Omit<ActiveExecutionWorkflow, "collaborationStyle"> {
    collaborationStyle: string;
}

function makeSessionManager(id: string, entries: SessionManagerFixtureEntry[] = []) {
    const manager = SessionManager.inMemory(`/tmp/${id}`);
    for (const entry of entries) manager.appendCustomEntry(entry.customType, entry.data);
    return manager;
}

test("HostedSession requires an absolute project root", () => {
    assertThrows(() => new HostedSession({ id: "missing-root" }), Error, "requires an absolute project root");
    assertThrows(
        () => new HostedSession({ id: "relative-root", cwd: "relative/project" }),
        Error,
        "project root must be absolute",
    );
});

test("HostedSession rejects ownerless active execution workflows", () => {
    const session = new HostedSession({ id: "owner-invariant", cwd: "/work/owner-invariant" });

    assertThrows(
        () =>
            session.setActiveExecutionWorkflow({
                planName: "p",
                triageMeta: { classification: "FEATURE" },
            } as ActiveExecutionWorkflow),
        Error,
        "requires executionAgent",
    );
    assertEquals(session.getActiveExecutionWorkflow(), null);
});

test("HostedSession validates Pair execution runtime state", () => {
    const session = new HostedSession({ id: "pair-state", cwd: "/work/pair-state" });
    session.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        collaborationStyle: "pair",
        collaborationRecommendation: "pair",
        pairCheckpointCount: 2,
        pairPauseReason: "stop",
    });

    assertEquals(session.getActiveExecutionWorkflow()?.collaborationStyle, "pair");
    assertThrows(
        () =>
            session.setActiveExecutionWorkflow({
                planName: "visual-plan",
                triageMeta: {},
                executionAgent: "frontend-engineer",
                collaborationStyle: "live",
            } satisfies InvalidCollaborationWorkflow as ActiveExecutionWorkflow),
        Error,
        "collaborationStyle must be autonomous or pair",
    );
    assertThrows(
        () =>
            session.setActiveExecutionWorkflow({
                planName: "visual-plan",
                triageMeta: {},
                executionAgent: "frontend-engineer",
                collaborationStyle: "pair",
                pairCheckpointCount: -1,
            }),
        Error,
        "pairCheckpointCount must be a non-negative integer",
    );
});

test("HostedSession validates execution attempt timestamp", () => {
    const session = new HostedSession({ id: "attempt-timestamp", cwd: "/work/attempt-timestamp" });
    session.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 1234,
        collaborationStyle: "pair",
    });

    assertEquals(session.getActiveExecutionWorkflow()?.executionAttemptStartedAtMs, 1234);
    assertThrows(
        () =>
            session.setActiveExecutionWorkflow({
                planName: "visual-plan",
                triageMeta: {},
                executionAgent: "frontend-engineer",
                executionAttemptStartedAtMs: -1,
            }),
        Error,
        "executionAttemptStartedAtMs must be a non-negative number",
    );
    assertThrows(
        () =>
            session.setActiveExecutionWorkflow({
                planName: "visual-plan",
                triageMeta: {},
                executionAgent: "frontend-engineer",
                executionAttemptStartedAtMs: Infinity,
            }),
        Error,
        "executionAttemptStartedAtMs must be a non-negative number",
    );
});

test("HostedSession hydrates and persists workflow context defensively", () => {
    const entries = [
        {
            type: "custom",
            customType: WORKFLOW_CONTEXT_CUSTOM_TYPE,
            data: { routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM", planName: "old-plan" },
        },
    ];
    const session = new HostedSession({
        id: "workflow",
        cwd: "/work/workflow",
        sessionManager: makeSessionManager("workflow-manager", entries),
    });

    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "old-plan",
    });

    const context = session.getWorkflowContext();
    if (context) context.planName = "mutated";
    assertEquals(session.getWorkflowContext()?.planName, "old-plan");

    session.setWorkflowTriageContext({ routingIntent: "PROJECT", complexity: "HIGH" });
    assertEquals(session.getWorkflowContext(), { routingIntent: "PROJECT", complexity: "HIGH" });
    session.setWorkflowPlanName("docs/plans/epic/child.md");
    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PROJECT",
        complexity: "HIGH",
        planName: "epic/child",
    });
});

test("HostedSession workflow context setters are fail-open after disposal", async () => {
    const session = new HostedSession({ id: "disposed-workflow", cwd: getCwd() });
    await session.dispose();

    session.setWorkflowTriageContext({ routingIntent: "PLANNED_CHANGE", complexity: "LOW" });
    session.setWorkflowPlanName("plan");

    assertEquals(session.getWorkflowContext(), null);
});

test("HostedSession removes delegated agent display entries by id when completion order differs", () => {
    const session = new HostedSession({ id: "agent-info-concurrent", cwd: getCwd() });

    session.resetAgentInfoStack("Router", "model", "provider", "router");
    const readerA = session.pushAgentInfo("Reader A", "model-a", "provider", "reader");
    const readerB = session.pushAgentInfo("Reader B", "model-b", "provider", "reader");

    session.popAgentInfo(readerA);

    assertEquals(
        session.getAgentInfoStack().map((agentInfo) => agentInfo.displayName),
        ["Router", "Reader B"],
    );
    assertEquals(session.getActiveAgentName(), "Reader B");

    session.popAgentInfo(readerB);

    assertEquals(
        session.getAgentInfoStack().map((agentInfo) => agentInfo.displayName),
        ["Router"],
    );
    assertEquals(session.getActiveAgentName(), "Router");
});

test("HostedSession delegated-agent leases allow three readers and reject a fourth", () => {
    const session = new HostedSession({ id: "delegated-readers", cwd: "/tmp/delegated-readers" });
    const releaseA = session.acquireDelegatedAgentLease("read");
    const releaseB = session.acquireDelegatedAgentLease("read");
    const releaseC = session.acquireDelegatedAgentLease("read");
    assertEquals(session.getDelegatedAgentLeaseState(), { readers: 3, writer: false });
    assertThrows(() => session.acquireDelegatedAgentLease("read"), Error, "Too many delegated readers");
    releaseA();
    releaseB();
    releaseC();
    assertEquals(session.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});

test("HostedSession delegated-agent leases enforce writer exclusivity", () => {
    const session = new HostedSession({ id: "delegated-writer", cwd: "/tmp/delegated-writer" });
    const releaseReader = session.acquireDelegatedAgentLease("read");
    assertThrows(() => session.acquireDelegatedAgentLease("write"), Error, "exclusive access");
    releaseReader();
    const releaseWriter = session.acquireDelegatedAgentLease("write");
    assertEquals(session.getDelegatedAgentLeaseState(), { readers: 0, writer: true });
    assertThrows(() => session.acquireDelegatedAgentLease("read"), Error, "writer is already running");
    releaseWriter();
    assertEquals(session.getDelegatedAgentLeaseState(), { readers: 0, writer: false });
});

test("HostedSession delegated-agent leases are scoped per session and cleared on dispose", () => {
    const sessionA = new HostedSession({ id: "delegated-a", cwd: "/tmp/delegated-a" });
    const sessionB = new HostedSession({ id: "delegated-b", cwd: "/tmp/delegated-b" });
    sessionA.acquireDelegatedAgentLease("write");
    const releaseB = sessionB.acquireDelegatedAgentLease("read");
    assertEquals(sessionA.getDelegatedAgentLeaseState(), { readers: 0, writer: true });
    assertEquals(sessionB.getDelegatedAgentLeaseState(), { readers: 1, writer: false });
    releaseB();
    sessionA.dispose();
});

test("HostedSession preserves workflow context across empty root manager swap and persists it", () => {
    const session = new HostedSession({
        id: "context-swap",
        cwd: "/work/context-swap",
        sessionManager: makeSessionManager("context-swap-a"),
    });
    session.setWorkflowExecutionContext({
        planName: "epic-name/footer-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM", parentPlan: "epic-name" },
    });

    const secondManager = makeSessionManager("context-swap-b");
    session.setRootSessionManager(secondManager);

    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "epic-name/footer-plan",
        parentPlan: "epic-name",
    });
    assertEquals(
        secondManager
            .getBranch()
            .filter((entry) => entry.type === "custom")
            .map(({ type, customType, data }) => ({ type, customType, data })),
        [
            {
                type: "custom",
                customType: WORKFLOW_CONTEXT_CUSTOM_TYPE,
                data: {
                    routingIntent: "PLANNED_CHANGE",
                    complexity: "MEDIUM",
                    planName: "epic-name/footer-plan",
                    parentPlan: "epic-name",
                },
            },
        ],
    );
});

test("HostedSession null root manager does not clear workflow context", () => {
    const session = new HostedSession({
        id: "context-null-manager",
        cwd: "/work/context-null-manager",
        sessionManager: makeSessionManager("context-null-manager-a"),
    });
    session.setWorkflowExecutionContext({
        planName: "footer-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM" },
    });

    session.setRootSessionManager(null);

    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "footer-plan",
    });
});

test("HostedSession triage setter preserves plan name without persistence", () => {
    const session = new HostedSession({
        id: "context-triage-no-manager",
        cwd: "/work/context-triage-no-manager",
        sessionManager: makeSessionManager("context-triage-no-manager-a"),
    });
    session.setWorkflowExecutionContext({
        planName: "footer-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM" },
    });
    session.setRootSessionManager(null);

    session.setWorkflowTriageContext({ routingIntent: "QUICK_FIX", complexity: "LOW" });

    assertEquals(session.getWorkflowContext(), {
        routingIntent: "QUICK_FIX",
        complexity: "LOW",
        planName: "footer-plan",
    });
});

test("HostedSession plan setter preserves triage fields without persistence", () => {
    const session = new HostedSession({
        id: "context-plan-no-manager",
        cwd: "/work/context-plan-no-manager",
        sessionManager: makeSessionManager("context-plan-no-manager-a"),
    });
    session.setWorkflowExecutionContext({
        planName: "footer-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM" },
    });
    session.setRootSessionManager(null);

    session.setWorkflowPlanName("docs/plans/updated-plan.md");

    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "updated-plan",
    });
});

test("HostedSession rejects Plan Association recording without a writable manager", () => {
    const session = new HostedSession({ id: "plan-association-nowrite", cwd: "/work/plan-association-nowrite" });
    assertThrows(
        () => session.recordPlanAssociation({ planId: "plan-1", planName: "example-plan", purpose: "planning" }),
        Error,
        "plan_association_not_writable",
    );
});
