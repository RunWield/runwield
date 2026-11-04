import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import {
    readCurrentPairCheckpoint,
    recordPairCheckpointSnapshot,
    restorePairExecutionState,
} from "../../shared/session/pair-checkpoint-session.ts";
import { createPairCheckpointTool } from "../pair-checkpoint.ts";
import { installPairCheckpointAutoCompactionPreservation } from "../../shared/session/session.js";
import { readRequestAttemptEntries } from "../../shared/session/request-dispatch.ts";
import { makeToolProjectFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

import type {
    AgentSession,
    AgentSessionEventListener,
    SessionManager,
    ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import type { PairCheckpointParameters, PairCheckpointDetails } from "../pair-checkpoint.ts";
import type { RequestDispatchKind, RequestPromptMode } from "../../shared/session/request-dispatch.ts";

type PairCheckpointTool = ReturnType<typeof createPairCheckpointTool>;
interface TestSessionEntry {
    type: "custom";
    customType: string;
    data: Parameters<SessionManager["appendCustomEntry"]>[1];
}
interface TestSessionManager {
    getSessionId(): string;
    getCwd(): string;
    getBranch(): TestSessionEntry[];
    getEntries(): TestSessionEntry[];
    appendCustomEntry(customType: string, data: TestSessionEntry["data"]): number;
}
interface BeginRequestOptions {
    turnId?: string;
    requestId?: string;
    dispatchKind?: RequestDispatchKind;
    promptMode?: RequestPromptMode;
}
interface ConstSchema {
    const: string;
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
interface CompactingSession {
    subscribe(callback: AgentSessionEventListener): () => void;
    _runAutoCompaction(reason?: string, retry?: boolean): Promise<boolean>;
}

const PAIR_PROJECT_ROOT = makeToolProjectFixture("runwield-pair-checkpoint-");

function makeSessionManager(projectRoot: string): TestSessionManager {
    const entries: TestSessionEntry[] = [];
    return {
        getSessionId: () => `pair-session-${crypto.randomUUID()}`,
        getCwd: () => projectRoot,
        getBranch: () => entries,
        getEntries: () => entries,
        appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    };
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
    sessionManager: TestSessionManager,
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

function schemaConst(item: ConstSchema) {
    return item.const;
}

test("pair_checkpoint schema supports report and resolve actions", () => {
    const { session } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });

    assertEquals(tool.parameters.required, undefined);
    assertEquals(tool.parameters.additionalProperties, false);
    assertEquals(tool.parameters.properties.action.anyOf.map(schemaConst), ["report", "resolve"]);
    assertEquals(tool.parameters.properties.decision.anyOf.map(schemaConst), [
        "continue",
        "revise",
        "switch_to_autonomous",
        "stop",
    ]);
});

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

test("automatic compaction preserves Pair state and active user-turn provenance", async () => {
    const { session, sessionManager } = makePairSession();
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    await execute(createPairCheckpointTool({ hostedSession: session }), "checkpoint-1", reportParams);
    let listener: AgentSessionEventListener | undefined;
    const compactingSession: CompactingSession = {
        subscribe: (callback) => {
            listener = callback;
            return () => {
                listener = undefined;
            };
        },
        _runAutoCompaction: () => {
            sessionManager.getBranch().splice(0);
            listener?.({
                type: "compaction_end",
                reason: "threshold",
                result: { summary: "summary", firstKeptEntryId: "recent", tokensBefore: 120_000 },
                aborted: false,
                willRetry: false,
            });
            return Promise.resolve(false);
        },
    };
    installPairCheckpointAutoCompactionPreservation(compactingSession as CompactingSession & AgentSession, session);

    assertEquals(await compactingSession._runAutoCompaction("threshold", false), false);
    assertEquals(readCurrentPairCheckpoint(session)?.report.report.summary, reportParams.summary);
    assertEquals(
        readRequestAttemptEntries(sessionManager as TestSessionManager & SessionManager).at(-1)?.phase,
        "started",
    );
});

test("resolved Pair checkpoint survives a compacted branch snapshot", async () => {
    const { session, sessionManager } = makePairSession();
    const tool = createPairCheckpointTool({ hostedSession: session });
    beginRequest(session, sessionManager, { dispatchKind: "plan_execution" });
    const reported = await execute(tool, "checkpoint-1", reportParams);
    beginRequest(session, sessionManager);
    await execute(tool, "resolve-1", {
        action: "resolve",
        checkpointId: reported.details.checkpointId,
        decision: "revise",
        revisionDirection: "Use the compact layout.",
    });
    const checkpoint = readCurrentPairCheckpoint(session);
    if (!checkpoint) throw new Error("Expected resolved Pair checkpoint");

    sessionManager.getBranch().splice(0);
    recordPairCheckpointSnapshot(session, checkpoint);

    assertEquals(readCurrentPairCheckpoint(session)?.resolution?.decision, "revise");
    assertEquals(readCurrentPairCheckpoint(session)?.resolution?.revisionDirection, "Use the compact layout.");
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
