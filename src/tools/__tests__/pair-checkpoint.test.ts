import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "../../shared/session/hosted-session.ts";
import { readCurrentPairCheckpoint, restorePairExecutionState } from "../../shared/session/pair-checkpoint-session.ts";
import { createPairCheckpointTool } from "../pair-checkpoint.ts";
import { attachSessionEventSubscribers, buildAgentSession, runPrompt } from "../../shared/session/session.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import { readExecutionWorkflowSnapshot } from "../../shared/session/execution-workflow-session.ts";
import { readRequestAttemptEntries } from "../../shared/session/request-dispatch.ts";
import { makeToolProjectFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import type { PairCheckpointParameters, PairCheckpointDetails } from "../pair-checkpoint.ts";
import type { RequestDispatchKind, RequestPromptMode } from "../../shared/session/request-dispatch.ts";

type PairCheckpointTool = ReturnType<typeof createPairCheckpointTool>;

interface BeginRequestOptions {
    turnId?: string;
    requestId?: string;
    dispatchKind?: RequestDispatchKind;
    promptMode?: RequestPromptMode;
}
interface TestCheckpointDetails {
    outcome: PairCheckpointDetails["outcome"];
    checkpointId?: string;
    checkpointNumber?: number;
    reason?: string;
    decision?: Extract<PairCheckpointDetails, { outcome: "resolved" }>["decision"];
}
interface TestCheckpointResult {
    terminate: boolean;
    details: TestCheckpointDetails;
    content: TextContent[];
}

const PAIR_PROJECT_ROOT = makeToolProjectFixture("runwield-pair-checkpoint-");

function makeSessionManager(projectRoot: string): SessionManager {
    const manager = SessionManager.create(projectRoot, join(projectRoot, ".test-sessions", crypto.randomUUID()));
    manager.appendMessage({ role: "user", content: "Begin the task.", timestamp: Date.now() });
    manager.appendMessage(fauxAssistantMessage(fauxText("Ready for the task.")));
    return manager;
}

function makePairSession(projectRoot = PAIR_PROJECT_ROOT) {
    const sessionManager = makeSessionManager(projectRoot);
    const session = new HostedSession({
        id: `pair-checkpoint-${crypto.randomUUID()}`,
        cwd: projectRoot,
        sessionManager,
    });
    session.setActiveExecutionWorkflow({
        planName: "visual-plan",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "frontend-engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 1234,
        collaborationStyle: "pair",
        collaborationRecommendation: "pair",
        pairCheckpointCount: 0,
        projectRoot,
        executionCwd: projectRoot,
    });
    return { session, sessionManager };
}

function beginRequest(
    session: HostedSession,
    sessionManager: SessionManager,
    {
        turnId = `turn:${crypto.randomUUID()}`,
        requestId = `request:${crypto.randomUUID()}`,
        dispatchKind = "interactive",
        promptMode = "original",
    }: BeginRequestOptions = {},
) {
    const activeTurnId = session.getActiveTurnId();
    if (activeTurnId) session.endTurn(activeTurnId);
    session.beginTurn(turnId);
    sessionManager.appendCustomEntry("runwield.request_attempt", {
        version: 1,
        requestId,
        attemptId: `attempt:${crypto.randomUUID()}`,
        requestHash: "hash",
        dispatchKind,
        backend: "test",
        phase: "started",
        promptMode,
        requestRecorded: false,
    });
    return { turnId, requestId };
}

const reportParams: PairCheckpointParameters = {
    action: "report",
    summary: "Rendered settings form",
    route: "/settings",
    state: "populated form",
    viewport: "1280x800",
    evidence: ["settings form visible"],
    diagnostics: "No console or network errors",
    nextIncrement: "Polish validation states",
};

function execute(
    tool: PairCheckpointTool,
    id: string,
    params: PairCheckpointParameters,
): Promise<TestCheckpointResult> {
    // The fixture supplies only the context and text result fields exercised by these tests.
    return tool.execute(id, params, undefined, undefined, {} as ExtensionToolContext) as Promise<TestCheckpointResult>;
}

test("pair_checkpoint report is durable and ends the turn without a form", async () => {
    const { session, sessionManager } = makePairSession();
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const result = await execute(createPairCheckpointTool({ hostedSession: session }), "checkpoint-1", reportParams);
    const checkpoint = readCurrentPairCheckpoint(session);

    assertEquals(result.terminate, true);
    assertEquals(result.details.outcome, "reported");
    assertEquals(result.details.checkpointNumber, 1);
    assertEquals(checkpoint?.report.report.summary, reportParams.summary);
    assertEquals(checkpoint?.resolution, null);
    assertStringIncludes(result.content[0].text, "Reply normally");
    assertEquals(session.getActiveExecutionWorkflow()?.pairCheckpointCount, 1);
});

test("pair_checkpoint resolves from a later original user turn", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager);

    const resolved = await execute(tool, "resolve-1", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });

    assertEquals(resolved.details, {
        outcome: "resolved",
        checkpointId: reported.details.checkpointId,
        checkpointNumber: 1,
        decision: "continue",
    });
    assertEquals(resolved.terminate, false);
    assertEquals(readCurrentPairCheckpoint(session)?.resolution?.decision, "continue");
});

test("Pair restoration does not replace a different active attempt", async () => {
    const { session, sessionManager } = makePairSession();
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    await execute(createPairCheckpointTool({ hostedSession: session }), "checkpoint-1", reportParams);
    const activeWorkflow = session.getActiveExecutionWorkflow();
    if (!activeWorkflow) throw new Error("Expected active Pair workflow");
    session.setActiveExecutionWorkflow({
        ...activeWorkflow,
        executionAttemptStartedAtMs: 9999,
    });

    assertEquals(restorePairExecutionState(session), null);
    assertEquals(session.getActiveExecutionWorkflow()?.executionAttemptStartedAtMs, 9999);
});

test("pair_checkpoint rejects same-turn resolution", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager);
    const reported = await execute(tool, "checkpoint-1", reportParams);

    const resolved = await execute(tool, "resolve-1", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });

    assertEquals(resolved.details.reason, "later_user_turn_required");
    assertEquals(readCurrentPairCheckpoint(session)?.resolution, null);
});

test("pair_checkpoint rejects generated continuation as user assent", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager, { dispatchKind: "interactive", promptMode: "continuation" });

    const resolved = await execute(tool, "resolve-1", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });

    assertEquals(resolved.details.reason, "user_turn_required");
});

test("pair_checkpoint rejects a background result as user assent", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager, { dispatchKind: "background_task_result" });

    const resolved = await execute(tool, "resolve-background", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });
    assertEquals(resolved.details.reason, "user_turn_required");
    assertEquals(readCurrentPairCheckpoint(session)?.resolution, null);
});

test("pair_checkpoint rejects stale and consumed decisions", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager);

    const stale = await execute(tool, "resolve-stale", {
        action: "resolve",
        checkpointId: "old-checkpoint",
        decision: "continue",
    });
    const first = await execute(tool, "resolve-1", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });
    beginRequest(session, sessionManager);
    const repeated = await execute(tool, "resolve-2", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });

    assertEquals(stale.details.reason, "checkpoint_stale");
    assertEquals(first.details.outcome, "resolved");
    assertEquals(repeated.details.reason, "checkpoint_already_resolved");
});

test("pair_checkpoint requires a revision direction", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager);

    const result = await execute(tool, "resolve-1", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "revise",
    });

    assertEquals(result.details.reason, "revision_direction_required");
    assertEquals(readCurrentPairCheckpoint(session)?.resolution, null);
});

test("Pair Stop preserves the checkpoint and a later user turn can resume", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager);
    const stopped = await execute(tool, "resolve-stop", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "stop",
    });
    assertEquals(stopped.terminate, true);
    assertEquals(session.getActiveExecutionWorkflow()?.pairPauseReason, "stop");
    beginRequest(session, sessionManager);
    const resumed = await execute(tool, "resolve-resume", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "continue",
    });

    assertEquals(session.getActiveExecutionWorkflow()?.pairPauseReason, undefined);
    assertEquals(resumed.details.decision, "continue");
    assertEquals(readCurrentPairCheckpoint(session)?.resolution?.decision, "continue");
});

test("pair_checkpoint switches to autonomous and records content-free metrics", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const { session, sessionManager } = makePairSession(projectRoot);
        const tool = createPairCheckpointTool({ hostedSession: session });
        beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
        const reported = await execute(tool, "checkpoint-1", reportParams);
        beginRequest(session, sessionManager);
        const switched = await execute(tool, "resolve-1", {
            action: "resolve",
            checkpointId: reported.details.checkpointId,
            decision: "switch_to_autonomous",
        });

        assertEquals(switched.details.decision, "switch_to_autonomous");
        assertEquals(session.getActiveExecutionWorkflow()?.collaborationStyle, "autonomous");
        assertEquals(session.getActiveExecutionWorkflow()?.pairSwitchedToAutonomous, true);
        const metrics = await readMetrics();
        assertEquals(
            metrics.map((entry) => entry.details),
            [{ checkpointNumber: 1, decision: "switch_to_autonomous" }],
        );
        const serialized = JSON.stringify(metrics);
        assertEquals(serialized.includes("settings form"), false);
        assertEquals(serialized.includes("/settings"), false);
    });
});

for (const resolved of [false, true]) {
    test(`Pair checkpoint survives real automatic compaction and transcript reload (resolved=${resolved})`, async () => {
        await withRuntimeCommandFixture(
            "pair-compaction-",
            async (fixture) => {
                const settings = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
                settings.compaction = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 };
                await writeFile(fixture.settingsPath, JSON.stringify(settings));
                const { session: hostedSession, sessionManager } = makePairSession(fixture.projectRoot);
                beginRequest(hostedSession, sessionManager, { dispatchKind: "plan_execution" });
                const tool = createPairCheckpointTool({ hostedSession });
                const reported = await execute(tool, "report", reportParams);
                if (resolved) {
                    beginRequest(hostedSession, sessionManager);
                    await execute(tool, "resolve", {
                        action: "resolve",
                        checkpointId: reported.details.checkpointId,
                        decision: "revise",
                        revisionDirection: "Use the compact layout.",
                    });
                }
                sessionManager.appendMessage({
                    role: "user",
                    content: "Earlier implementation",
                    timestamp: Date.now(),
                });
                const response = fauxAssistantMessage(fauxText("Implementation details."));
                response.usage.input = 120_100;
                response.usage.totalTokens = 120_100 + response.usage.output;
                sessionManager.appendMessage(response);
                sessionManager.appendMessage({ role: "user", content: "Recent task", timestamp: Date.now() });
                fixture.setModelResponse("Summary and continuation.");
                const built = await buildAgentSession({
                    agentName: "engineer",
                    cwd: fixture.projectRoot,
                    toolNames: [],
                    sessionManager,
                    hostedSession,
                });
                const subscriber = attachSessionEventSubscribers(
                    built.session,
                    built.agentDef,
                    undefined,
                    hostedSession,
                );
                try {
                    await runPrompt({
                        ...built,
                        agentName: "engineer",
                        userRequest: "Continue",
                        subscriberState: subscriber,
                        finalSystemPrompt: built.agentDef.systemPrompt,
                        hostedSession,
                    });
                    assertEquals(sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
                    const reopened = SessionManager.open(sessionManager.getSessionFile()!);
                    const restored = new HostedSession({
                        id: crypto.randomUUID(),
                        cwd: fixture.projectRoot,
                        sessionManager: reopened,
                    });
                    restored.setActiveExecutionWorkflow(readExecutionWorkflowSnapshot(reopened)?.workflow ?? null);
                    const checkpoint = restorePairExecutionState(restored);
                    assertEquals(checkpoint?.report.report.summary, "Rendered settings form");
                    assertEquals(checkpoint?.resolution?.decision ?? null, resolved ? "revise" : null);
                    if (resolved) assertEquals(checkpoint?.resolution?.revisionDirection, "Use the compact layout.");
                    else {
                        beginRequest(restored, reopened);
                        const accepted = await execute(
                            createPairCheckpointTool({ hostedSession: restored }),
                            "resume-resolve",
                            {
                                action: "resolve",
                                checkpointId: reported.details.checkpointId,
                                decision: "continue",
                            },
                        );
                        assertEquals(accepted.details.outcome, "resolved");
                    }
                    assertEquals(
                        readRequestAttemptEntries(reopened).some((entry) => entry.phase === "started"),
                        true,
                    );
                    await restored.dispose();
                } finally {
                    subscriber.unsubscribe();
                    built.session.dispose();
                    await hostedSession.dispose();
                }
            },
            { contextWindow: 272_000 },
        );
    });
}
