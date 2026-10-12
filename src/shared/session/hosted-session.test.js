import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { HostedSession } from "./hosted-session.js";
import { WORKFLOW_CONTEXT_CUSTOM_TYPE } from "./workflow-context-session.js";
import { TUTORIAL_CONTEXT_CUSTOM_TYPE } from "./tutorial-context-session.ts";

/**
 * @param {string} id
 * @param {Array<Record<string, unknown>>} [entries]
 * @returns {{ getSessionId: () => string, getCwd: () => string, getBranch: () => Array<Record<string, unknown>>, appendCustomEntry: (customType: string, data: unknown) => void, dispose: () => void, disposed: boolean }}
 */
function makeSessionManager(id, entries = []) {
    return {
        getSessionId: () => id,
        getCwd: () => `/tmp/${id}`,
        getBranch: () => entries,
        appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
        disposed: false,
        dispose() {
            this.disposed = true;
        },
    };
}

/** @param {string} id */
function makeDisposableSession(id) {
    return {
        id,
        disposed: false,
        dispose() {
            this.disposed = true;
        },
    };
}

test("HostedSession requires an absolute project root", () => {
    assertThrows(
        () => new HostedSession({ id: "missing-root" }),
        Error,
        "requires an absolute project root",
    );
    assertThrows(
        () => new HostedSession({ id: "relative-root", cwd: "relative/project" }),
        Error,
        "project root must be absolute",
    );
});

test("HostedSession accepts max as a thinking level", () => {
    const session = new HostedSession({ id: "max-thinking", cwd: getCwd() });
    session.setThinkingLevel("max");
    assertEquals(session.getThinkingLevel(), "max");
});

test("HostedSession stores mutable root runtime state per session", () => {
    const sessionManager = makeSessionManager("alpha-manager");
    const eventSink = { name: "sink-alpha" };
    const activeHandler = () => {};
    const rootAgentSession = makeDisposableSession("root-alpha");
    const subAgentSession = makeDisposableSession("sub-alpha");
    const session = new HostedSession({ id: "alpha", cwd: "/work/alpha", sessionManager, eventSink });

    session.pushAgentInfo("Router", "openai/gpt-4.1", "openai");
    session.pushAgentInfo("Engineer", "anthropic/claude", "anthropic");
    session.setActiveOnMessage(activeHandler);
    session.setRootAgentName("engineer");
    session.setRootAgentSession(rootAgentSession);
    session.addSubAgentSession(subAgentSession);
    session.setThinkingLevel("high");
    session.setProjectStateContext("project note");
    session.setActiveExecutionWorkflow({
        planName: "plan-a",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionCwd: "/exec/a",
    });

    assertEquals(session.id, "alpha");
    assertEquals(session.cwd, "/tmp/alpha-manager");
    assertStrictEquals(session.getRootSessionManager(), sessionManager);
    assertStrictEquals(session.getEventSink(), eventSink);
    assertEquals(session.getActiveAgentName(), "Engineer");
    assertEquals(session.getActiveModelState(), { model: "anthropic/claude", provider: "anthropic" });
    assertStrictEquals(session.getActiveOnMessage(), activeHandler);
    assertEquals(session.getRootAgentName(), "engineer");
    assertStrictEquals(session.getRootAgentSession(), rootAgentSession);
    assert(session.getSubAgentSessions().has(subAgentSession));
    assertEquals(session.getThinkingLevel(), "high");
    assertEquals(session.getProjectStateContext(), "project note");
    assertEquals(session.getActiveExecutionWorkflow(), {
        planName: "plan-a",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionCwd: "/exec/a",
    });
    assertEquals(session.getActiveExecutionCwd(), "/exec/a");
});

test("HostedSession keeps user model overrides independent from agent model state", () => {
    const session = new HostedSession({
        id: "models",
        cwd: "/work/models",
        sessionManager: makeSessionManager("models"),
    });

    session.resetAgentInfoStack("Router", "openai/default", "openai");
    session.setActiveModelState("openai/user-choice", "openai", true);

    assertEquals(session.isUserModelOverride(), true);
    assertEquals(session.getActiveModelState(), { model: "openai/user-choice", provider: "openai" });

    session.clearUserModelOverride();

    assertEquals(session.isUserModelOverride(), false);
    assertEquals(session.getActiveModelState(), { model: "openai/default", provider: "openai" });
});

test("HostedSession treats managed metadata as projection cache, not live runtime authority", () => {
    const session = new HostedSession({
        id: "managed-cache",
        cwd: "/work/managed-cache",
        sessionManager: makeSessionManager("managed-cache-manager"),
    });

    session.resetAgentInfoStack("Engineer", "live-model", "live-provider", "engineer");
    session.setRootAgentName("engineer");
    session.setThinkingLevel("high");
    session.setWorkflowTriageContext({ routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" });
    session.setManagedMetadata({
        runwieldSessionId: "rw-managed-cache",
        projectId: "project-managed-cache",
        piSessionId: "pi-managed-cache",
        transcriptPath: "/work/managed-cache/session.jsonl",
        generation: 4,
        name: "Managed Cache",
        activeAgent: "router",
        model: "cached-model",
        provider: "cached-provider",
        thinkingLevel: "low",
        workflowContext: { routingIntent: "INQUIRY", complexity: "LOW" },
        syncState: null,
    });

    assertEquals(session.getManagedMetadata()?.activeAgent, "router");
    assertEquals(session.getRootAgentName(), "engineer");
    assertEquals(session.getActiveModelState(), { model: "live-model", provider: "live-provider" });
    assertEquals(session.getThinkingLevel(), "high");
    assertEquals(session.getWorkflowContext(), { routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" });
});

test("HostedSession dehydrates managed sessions by clearing live activation state", () => {
    const rootManager = makeSessionManager("managed-dehydrate-manager");
    const rootAgentSession = makeDisposableSession("managed-root-agent");
    const subAgentSession = makeDisposableSession("managed-sub-agent");
    const session = new HostedSession({
        id: "managed-dehydrate",
        cwd: "/work/managed-dehydrate",
        sessionManager: rootManager,
        managed: {
            runwieldSessionId: "rw-managed-dehydrate",
            projectId: "project-managed-dehydrate",
            piSessionId: "pi-managed-dehydrate",
            transcriptPath: "/work/managed-dehydrate/session.jsonl",
            generation: 5,
            name: "Managed Dehydrate",
            activeAgent: "router",
            model: "cached-model",
            provider: "cached-provider",
            thinkingLevel: "medium",
            workflowContext: { routingIntent: "PLANNED_CHANGE", complexity: "HIGH" },
            syncState: null,
        },
    });

    const capability = makeManagedCapability();
    session.setManagedOperationCapability(capability);
    session.resetAgentInfoStack("Engineer", "live-model", "live-provider", "engineer");
    session.setRootAgentName("engineer", capability);
    session.setRootAgentSession(rootAgentSession, capability);
    session.addSubAgentSession(subAgentSession, capability);
    session.setActiveOnMessage(() => {});
    session.setThinkingLevel("xhigh");
    session.setWorkflowTriageContext({ routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" });
    session.setActiveExecutionWorkflow({
        planName: "managed-dehydrate-plan",
        triageMeta: {},
        executionAgent: "engineer",
    });

    session.dehydrateManagedSession();

    assertEquals(rootManager.disposed, true);
    assertEquals(rootAgentSession.disposed, true);
    assertEquals(subAgentSession.disposed, true);
    assertEquals(session.getRootSessionManager(), null);
    assertEquals(session.getRootAgentName(), null);
    assertEquals(session.getActiveAgentName(), "");
    assertEquals(session.getActiveModelState(), { model: "", provider: "" });
    assertEquals(session.getThinkingLevel(), "off");
    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
    });
    assertEquals(session.getActiveExecutionWorkflow(), {
        planName: "managed-dehydrate-plan",
        triageMeta: {},
        executionAgent: "engineer",
    });
    assertEquals(session.getManagedMetadata()?.activeAgent, "router");
});

test("two Hosted Sessions do not share session-scoped runtime state", () => {
    const alphaRoot = makeDisposableSession("alpha-root");
    const betaRoot = makeDisposableSession("beta-root");
    const alphaSub = makeDisposableSession("alpha-sub");
    const betaSub = makeDisposableSession("beta-sub");
    const alphaHandler = () => "alpha";
    const betaHandler = () => "beta";
    const alpha = new HostedSession({
        id: "alpha",
        cwd: "/work/alpha",
        sessionManager: makeSessionManager("alpha-manager"),
        eventSink: { session: "alpha-sink" },
    });
    const beta = new HostedSession({
        id: "beta",
        cwd: "/work/beta",
        sessionManager: makeSessionManager("beta-manager"),
        eventSink: { session: "beta-sink" },
    });

    alpha.resetAgentInfoStack("Router", "openai/a", "openai");
    beta.resetAgentInfoStack("Planner", "anthropic/b", "anthropic");
    alpha.setActiveOnMessage(alphaHandler);
    beta.setActiveOnMessage(betaHandler);
    alpha.setRootAgentName("router");
    beta.setRootAgentName("planner");
    alpha.setRootAgentSession(alphaRoot);
    beta.setRootAgentSession(betaRoot);
    alpha.addSubAgentSession(alphaSub);
    beta.addSubAgentSession(betaSub);
    alpha.setThinkingLevel("low");
    beta.setThinkingLevel("xhigh");
    alpha.setProjectStateContext("alpha context");
    beta.setProjectStateContext("beta context");
    alpha.setActiveExecutionWorkflow({
        planName: "alpha-plan",
        triageMeta: {},
        executionAgent: "engineer",
        executionCwd: "/exec/alpha",
    });
    beta.setActiveExecutionWorkflow({
        planName: "beta-plan",
        triageMeta: {},
        executionAgent: "engineer",
        executionCwd: "/exec/beta",
    });

    assertEquals(alpha.getActiveAgentName(), "Router");
    assertEquals(beta.getActiveAgentName(), "Planner");
    assertEquals(alpha.getActiveModelState(), { model: "openai/a", provider: "openai" });
    assertEquals(beta.getActiveModelState(), { model: "anthropic/b", provider: "anthropic" });
    assertStrictEquals(alpha.getActiveOnMessage(), alphaHandler);
    assertStrictEquals(beta.getActiveOnMessage(), betaHandler);
    assertEquals(alpha.getRootAgentName(), "router");
    assertEquals(beta.getRootAgentName(), "planner");
    assertStrictEquals(alpha.getRootAgentSession(), alphaRoot);
    assertStrictEquals(beta.getRootAgentSession(), betaRoot);
    assertEquals(alpha.getSubAgentSessions().has(alphaSub), true);
    assertEquals(alpha.getSubAgentSessions().has(betaSub), false);
    assertEquals(beta.getSubAgentSessions().has(betaSub), true);
    assertEquals(beta.getSubAgentSessions().has(alphaSub), false);
    assertEquals(alpha.getThinkingLevel(), "low");
    assertEquals(beta.getThinkingLevel(), "xhigh");
    assertEquals(alpha.getProjectStateContext(), "alpha context");
    assertEquals(beta.getProjectStateContext(), "beta context");
    assertEquals(alpha.getActiveExecutionCwd(), "/exec/alpha");
    assertEquals(beta.getActiveExecutionCwd(), "/exec/beta");
    assertEquals(alpha.id, "alpha");
    assertEquals(beta.id, "beta");
    assertEquals(alpha.cwd, "/tmp/alpha-manager");
    assertEquals(beta.cwd, "/tmp/beta-manager");
    assertEquals(alpha.getRootSessionManager()?.getSessionId?.(), "alpha-manager");
    assertEquals(beta.getRootSessionManager()?.getSessionId?.(), "beta-manager");
    assertEquals(alpha.getEventSink(), { session: "alpha-sink" });
    assertEquals(beta.getEventSink(), { session: "beta-sink" });
});

test("HostedSession rejects ownerless active execution workflows", () => {
    const session = new HostedSession({ id: "owner-invariant", cwd: "/work/owner-invariant" });

    assertThrows(
        () =>
            session.setActiveExecutionWorkflow(
                /** @type {any} */ ({ planName: "p", triageMeta: { classification: "FEATURE" } }),
            ),
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
            session.setActiveExecutionWorkflow(
                /** @type {any} */ ({
                    planName: "visual-plan",
                    triageMeta: {},
                    executionAgent: "frontend-engineer",
                    collaborationStyle: "live",
                }),
            ),
        Error,
        "collaborationStyle must be autonomous or pair",
    );
    assertThrows(
        () =>
            session.setActiveExecutionWorkflow(
                /** @type {any} */ ({
                    planName: "visual-plan",
                    triageMeta: {},
                    executionAgent: "frontend-engineer",
                    collaborationStyle: "pair",
                    pairCheckpointCount: -1,
                }),
            ),
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
            session.setActiveExecutionWorkflow(
                /** @type {any} */ ({
                    planName: "visual-plan",
                    triageMeta: {},
                    executionAgent: "frontend-engineer",
                    executionAttemptStartedAtMs: -1,
                }),
            ),
        Error,
        "executionAttemptStartedAtMs must be a non-negative number",
    );
    assertThrows(
        () =>
            session.setActiveExecutionWorkflow(
                /** @type {any} */ ({
                    planName: "visual-plan",
                    triageMeta: {},
                    executionAgent: "frontend-engineer",
                    executionAttemptStartedAtMs: Infinity,
                }),
            ),
        Error,
        "executionAttemptStartedAtMs must be a non-negative number",
    );
});

test("HostedSession hydrates and persists workflow context defensively", () => {
    /** @type {Array<Record<string, unknown>>} */
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

test("HostedSession stores internal agent names in active agent stack", () => {
    const session = new HostedSession({ id: "agent-info", cwd: getCwd() });

    session.resetAgentInfoStack("Planner", "model", "provider", "planner");
    session.pushAgentInfo("Engineer", "model2", "provider2", "engineer");

    assertEquals(session.getActiveAgentInfo(), {
        displayName: "Engineer",
        model: "model2",
        provider: "provider2",
        agentName: "engineer",
    });
    assertEquals(session.getAgentInfoStack()[0], {
        displayName: "Planner",
        model: "model",
        provider: "provider",
        agentName: "planner",
    });
});

test("HostedSession removes delegated agent display entries by id when completion order differs", () => {
    const session = new HostedSession({ id: "agent-info-concurrent", cwd: getCwd() });

    session.resetAgentInfoStack("Router", "model", "provider", "router");
    const readerA = session.pushAgentInfo("Reader A", "model-a", "provider", "reader");
    const readerB = session.pushAgentInfo("Reader B", "model-b", "provider", "reader");

    session.popAgentInfo(readerA);

    assertEquals(session.getAgentInfoStack().map((agentInfo) => agentInfo.displayName), ["Router", "Reader B"]);
    assertEquals(session.getActiveAgentName(), "Reader B");

    session.popAgentInfo(readerB);

    assertEquals(session.getAgentInfoStack().map((agentInfo) => agentInfo.displayName), ["Router"]);
    assertEquals(session.getActiveAgentName(), "Router");
});

test("HostedSession consumes pending task completion once and clears it on new workflow start", () => {
    const session = new HostedSession({ id: "task-completion-state", cwd: "/tmp/task-completion-state" });
    const rootAgentSession = makeDisposableSession("root");
    const isolatedAgentSession = makeDisposableSession("isolated");
    session.setRootAgentSession(rootAgentSession);
    const targetId = session.pushSteeringTargetSession(rootAgentSession);
    try {
        session.recordPendingTaskCompletion("engineer", "- Done.", 1234);
    } finally {
        session.popSteeringTargetSession(targetId);
    }

    assertEquals(session.consumePendingTaskCompletion(isolatedAgentSession), null);
    assertEquals(session.consumePendingTaskCompletion(rootAgentSession), {
        agentName: "engineer",
        report: "- Done.",
        timestampMs: 1234,
        owningSession: rootAgentSession,
    });
    assertEquals(session.consumePendingTaskCompletion(rootAgentSession), null);

    session.recordPendingTaskCompletion("engineer", "- Stale.", 1235);
    session.setActiveExecutionWorkflow({
        planName: "next",
        triageMeta: {},
        executionAgent: "engineer",
    });
    assertEquals(session.consumePendingTaskCompletion(null), null);
});

test("HostedSession preserves steering received during an Agent transition", () => {
    const session = new HostedSession({ id: "agent-transition-steering", cwd: "/tmp/agent-transition-steering" });
    const transitionId = session.beginAgentTransition();
    const images = [{ base64: "abc123", mimeType: "image/png" }];

    assertEquals(session.isAgentTransitioning(), true);
    assertEquals(session.queueAgentTransitionSteering("keep this direction", images), true);
    session.completeAgentTransition(transitionId);

    assertEquals(session.isAgentTransitioning(), false);
    assertEquals(session.consumeAgentTransitionSteering(), [{ text: "keep this direction", images }]);
    assertEquals(session.consumeAgentTransitionSteering(), []);
    session.dispose();
});

test("two Hosted Sessions do not share workflow context", () => {
    const alpha = new HostedSession({ id: "workflow-alpha", sessionManager: makeSessionManager("workflow-alpha") });
    const beta = new HostedSession({ id: "workflow-beta", sessionManager: makeSessionManager("workflow-beta") });

    alpha.setWorkflowTriageContext({ routingIntent: "PLANNED_CHANGE", complexity: "LOW" });
    beta.setWorkflowPlanName("beta-plan");

    assertEquals(alpha.getWorkflowContext(), { routingIntent: "PLANNED_CHANGE", complexity: "LOW" });
    assertEquals(beta.getWorkflowContext(), { planName: "beta-plan" });
});

test("HostedSession dispose clears owned runtime references and rejects later mutation", async () => {
    const sessionManager = makeSessionManager("disposing-manager");
    const root = makeDisposableSession("root");
    const sub = makeDisposableSession("sub");
    const session = new HostedSession({ id: "disposing", cwd: "/work/disposing", sessionManager });

    session.resetAgentInfoStack("Engineer", "model", "provider");
    session.setRootAgentName("engineer");
    session.setRootAgentSession(root);
    session.addSubAgentSession(sub);
    session.setActiveExecutionWorkflow({
        planName: "plan",
        triageMeta: {},
        executionAgent: "engineer",
        executionCwd: "/exec",
    });
    session.setWorkflowPlanName("disposing-plan");

    await session.dispose();

    assertEquals(session.disposed, true);
    assertEquals(root.disposed, true);
    assertEquals(sub.disposed, true);
    assertEquals(sessionManager.disposed, true);
    assertEquals(session.id, "disposing");
    assertEquals(session.cwd, "/tmp/disposing-manager");
    assertEquals(session.getActiveAgentName(), "");
    assertEquals(session.getRootAgentName(), null);
    assertEquals(session.getRootAgentSession(), null);
    assertEquals(session.getRootSessionManager(), null);
    assertEquals(session.getSubAgentSessions().size, 0);
    assertEquals(session.getActiveExecutionWorkflow(), null);
    assertEquals(session.getWorkflowContext(), null);
    assertThrows(
        () => session.setThinkingLevel("medium"),
        Error,
        'HostedSession "disposing" is disposed',
    );
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
    const firstEntries = /** @type {Array<Record<string, unknown>>} */ ([]);
    const secondEntries = /** @type {Array<Record<string, unknown>>} */ ([]);
    const session = new HostedSession({
        id: "context-swap",
        cwd: "/work/context-swap",
        sessionManager: makeSessionManager("context-swap-a", firstEntries),
    });
    session.setWorkflowExecutionContext({
        planName: "epic-name/footer-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM", parentPlan: "epic-name" },
    });

    session.setRootSessionManager(makeSessionManager("context-swap-b", secondEntries));

    assertEquals(session.getWorkflowContext(), {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "epic-name/footer-plan",
        parentPlan: "epic-name",
    });
    assertEquals(secondEntries, [{
        type: "custom",
        customType: WORKFLOW_CONTEXT_CUSTOM_TYPE,
        data: {
            routingIntent: "PLANNED_CHANGE",
            complexity: "MEDIUM",
            planName: "epic-name/footer-plan",
            parentPlan: "epic-name",
        },
    }]);
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

/** @returns {import('./managed-operation.ts').ManagedOperationCapability} */
function makeManagedCapability() {
    return {
        runtimeSessionId: "runtime-managed",
        runwieldSessionId: "runwield-managed",
        operationId: "operation-managed",
        proof: {
            runwieldSessionId: "runwield-managed",
            projectId: "project-managed",
            ownerInstanceId: "owner-managed",
            ownerProcessKind: "test",
            operationId: "operation-managed",
            fence: 1,
            phase: "preparing",
            expectedGeneration: 0,
        },
        settled: false,
        registerArtifact: () => ({
            artifactId: "artifact-managed",
            kind: "report",
            path: "artifact.md",
            title: "Artifact",
            registeredAt: "2026-01-01T00:00:00.000Z",
            registeredBy: "test",
            sourceSegmentId: null,
        }),
        stagePlanAssociation: (entry) => ({ ...entry, committedGeneration: null }),
        getCurrentSegmentKind: () => "planning",
        updateProof: () => {},
        assertLive: () => {},
        settle: () => {},
    };
}

test("HostedSession requires the current managed operation capability for writable managed state", () => {
    const session = new HostedSession({
        id: "managed-capability",
        cwd: "/work/managed-capability",
        managed: {
            runwieldSessionId: "runwield-managed",
            projectId: "project-managed",
            piSessionId: "pi-managed",
            transcriptPath: "/work/managed-capability/session.jsonl",
            generation: 0,
            acknowledgedGeneration: 0,
            acknowledgedEventId: null,
            name: "Managed",
            activeAgent: null,
            workflowContext: null,
            syncState: null,
        },
    });
    const capability = makeManagedCapability();
    const sessionManager = makeSessionManager("managed-capability-manager");
    const rootAgentSession = makeDisposableSession("managed-root");

    assertThrows(() => session.setRootSessionManager(sessionManager), Error, "managed_operation_required");
    assertThrows(() => session.setRootAgentSession(rootAgentSession), Error, "managed_operation_required");
    assertThrows(
        () => session.addSubAgentSession(makeDisposableSession("managed-sub")),
        Error,
        "managed_operation_required",
    );

    session.setManagedOperationCapability(capability);
    session.setRootSessionManager(sessionManager, capability);
    session.setRootAgentSession(rootAgentSession, capability);
    session.setRootAgentName("engineer", capability);
    session.addSubAgentSession(makeDisposableSession("managed-sub"), capability);

    assertStrictEquals(session.getRootSessionManager(), sessionManager);
    assertStrictEquals(session.getRootAgentSession(), rootAgentSession);
    assertEquals(session.getRootAgentName(), "engineer");

    session.dehydrateManagedSession();

    assertEquals(session.getManagedOperationCapability(), null);
    assertEquals(session.getRootSessionManager(), null);
    assertEquals(session.getRootAgentSession(), null);
    assertEquals(session.getRootAgentName(), null);
    assertEquals(session.getSubAgentSessions().size, 0);
});

test("HostedSession restores tutorial context and requires managed writer ownership", () => {
    /** @type {Array<Record<string, unknown>>} */
    const entries = [{
        type: "custom",
        customType: TUTORIAL_CONTEXT_CUSTOM_TYPE,
        data: {
            version: 1,
            guidanceEnabled: true,
            shownExplanationIds: ["welcome"],
            recapShown: false,
            planId: null,
        },
    }];
    const manager = makeSessionManager("tutorial-context-session", entries);
    const session = new HostedSession({
        id: "tutorial-context-runtime",
        cwd: "/work/tutorial-context",
        sessionManager: manager,
        managed: {
            runwieldSessionId: "runwield-managed",
            projectId: "project-managed",
            piSessionId: "tutorial-context-session",
            transcriptPath: "/work/tutorial-context/session.jsonl",
            currentSegmentId: "segment-1",
            generation: 0,
            name: null,
            activeAgent: null,
            workflowContext: null,
        },
    });
    assertEquals(session.getTutorialContext()?.shownExplanationIds, ["welcome"]);
    assertThrows(
        () => session.updateTutorialContext({ shownExplanationIds: ["welcome", "plans"] }),
        Error,
        "managed_operation_required",
    );

    const capability = makeManagedCapability();
    session.setManagedOperationCapability(capability);
    session.setRootSessionManager(manager, capability);
    assertThrows(
        () => session.updateTutorialContext({ planId: "plan-1" }),
        Error,
        "tutorial_context_plan_association_required",
    );
    const updated = session.updateTutorialContext(
        { guidanceEnabled: false, shownExplanationIds: ["welcome", "plans", "plans"], planId: "plan-1" },
        [{
            planId: "plan-1",
            planName: "example-plan",
            purpose: "planning",
            segmentId: "segment-1",
            segmentKind: "planning",
            recordedAt: "2026-01-01T00:00:00.000Z",
            committedGeneration: 0,
        }],
    );

    assertEquals(updated, {
        version: 1,
        guidanceEnabled: false,
        shownExplanationIds: ["welcome", "plans"],
        recapShown: false,
        planId: "plan-1",
    });
    assertEquals(entries.at(-1)?.customType, TUTORIAL_CONTEXT_CUSTOM_TYPE);
});

test("HostedSession records Plan Association through the managed capability", () => {
    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const manager = makeSessionManager("plan-association-session", entries);
    const session = new HostedSession({
        id: "plan-association-runtime",
        cwd: "/work/plan-association",
        sessionManager: manager,
        managed: {
            runwieldSessionId: "runwield-managed",
            projectId: "project-managed",
            piSessionId: "plan-association-session",
            transcriptPath: "/work/plan-association/session.jsonl",
            currentSegmentId: "segment-1",
            generation: 0,
            name: null,
            activeAgent: null,
            workflowContext: null,
        },
    });
    /** @type {import('./plan-association.ts').PlanAssociation[]} */
    const staged = [];
    const capability = makeManagedCapability();
    capability.stagePlanAssociation = (entry) => {
        staged.push(entry);
        return { ...entry, committedGeneration: null };
    };
    session.setManagedOperationCapability(capability);
    session.setRootSessionManager(manager, capability);

    const entry = session.recordPlanAssociation({ planId: "plan-1", planName: "example-plan", purpose: "planning" });

    assertEquals(entry.segmentId, "segment-1");
    assertEquals(entry.segmentKind, "planning");
    assertEquals(staged, [entry]);
    assertEquals(entries.at(-1)?.customType, "runwield.plan_association");
    assertEquals(entries.at(-1)?.data, entry);
});

test("HostedSession rejects Plan Association recording without a writable manager", () => {
    const session = new HostedSession({ id: "plan-association-nowrite", cwd: "/work/plan-association-nowrite" });
    assertThrows(
        () => session.recordPlanAssociation({ planId: "plan-1", planName: "example-plan", purpose: "planning" }),
        Error,
        "plan_association_not_writable",
    );
});
