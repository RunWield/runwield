import { test } from "node:test";
import { setSystemTime } from "bun:test";
import { UsageReporter } from "../workflow/usage-reporting.ts";
import { ok as assert } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ExecutionMetricsRecorder } from "../workflow/execution-metrics.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { SessionHost } from "./session-host.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";
import { createSessionRuntime, SessionRuntime } from "./session-runtime.ts";

interface UsageRow {
    event: string;
    sourceId?: string;
    ts: string;
    planId?: string;
    managedSessionId?: string;
    segmentId?: string;
}

async function readUsage(projectRoot: string): Promise<UsageRow[]> {
    await drainWorkflowMetrics();
    const rows: UsageRow[] = (await readFile(getWorkflowMetricsFilePath(projectRoot), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    return rows.filter((row) => row.event === "model_usage");
}

test("production Pi turns link committed implementation, but not earlier or unscoped discussion", async () => {
    await withRuntimeCommandFixture("model-plan-scope-", async ({ projectRoot, setModelResponse }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        setModelResponse("Fixture answer.");
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "General discussion." })).ok, true);
            const before = await readUsage(projectRoot);
            assertEquals(before.length, 1);
            assertEquals(before[0].planId, undefined);
            assertEquals(
                (
                    await runtime.recordPlanAssociation(sessionId, {
                        planId: "plan-implementation",
                        planName: "implementation",
                        purpose: "execution",
                    })
                ).ok,
                true,
            );
            // Association history alone does not make ordinary discussion Plan work.
            assertEquals(
                (await runtime.promptUserTurn(sessionId, { initialRequest: "Still general discussion." })).ok,
                true,
            );
            const discussion = await readUsage(projectRoot);
            assertEquals(discussion[1].planId, undefined);
            assertEquals(
                (
                    await runtime.setActiveExecutionWorkflow(sessionId, {
                        planName: "implementation",
                        executionAgent: "engineer",
                        triageMeta: { classification: "PLANNED_CHANGE" },
                    })
                ).ok,
                true,
            );
            assertEquals(
                (await runtime.promptUserTurn(sessionId, { initialRequest: "Continue implementation." })).ok,
                true,
            );
            const rows = await readUsage(projectRoot);
            assertEquals(rows.length, 3);
            assertEquals(rows[2].planId, "plan-implementation");
            assert(rows[2].managedSessionId && rows[2].segmentId);
            assertEquals(rows.slice(0, 2), discussion);
            assertEquals(rows[1].planId, undefined);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("delayed Pi reconciliation retains the original local day and committed Plan scope", async () => {
    await withRuntimeCommandFixture("delayed-model-plan-", async ({ projectRoot, setModelResponse }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        setModelResponse("Fixture answer.");
        const sessionHost = new SessionHost();
        const store = openFileSessionStore();
        const runtime = new SessionRuntime({
            sessionHost,
            sessionStore: store,
            ownerProcessKind: "test",
            ownerInstanceId: crypto.randomUUID(),
        });
        try {
            setSystemTime(new Date("2026-11-02T04:59:00Z"));
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            const hosted = sessionHost.getSession(sessionId);
            assert(hosted);
            const managed = hosted.getManagedMetadata();
            assert(managed?.currentSegmentId);
            const entries = SessionManager.inMemory(projectRoot);
            const earlierMessage = fauxAssistantMessage(fauxText("Earlier call."));
            earlierMessage.timestamp = 0;
            const oldId = entries.appendMessage(earlierMessage);
            setSystemTime(new Date("2026-11-02T04:59:10Z"));
            assertEquals(
                (
                    await runtime.recordPlanAssociation(sessionId, {
                        planId: "plan-alpha",
                        planName: "alpha",
                        purpose: "execution",
                    })
                ).ok,
                true,
            );
            await runtime.setActiveExecutionWorkflow(sessionId, {
                planName: "alpha",
                executionAgent: "engineer",
                triageMeta: {},
            });
            const recorder = new ExecutionMetricsRecorder({
                projectRoot,
                hostedSession: hosted,
                managedSessionId: managed.runwieldSessionId,
                segmentId: managed.currentSegmentId,
            });
            const alpha = store
                .listSessionPlanAssociations(managed.runwieldSessionId, managed.projectId)
                .find((item) => item.planName === "alpha");
            assert(alpha);
            const message = fauxAssistantMessage(fauxText("Implementation call."));
            message.timestamp = Date.parse(alpha.recordedAt);
            message.usage = {
                input: 10,
                output: 2,
                cacheRead: 3,
                cacheWrite: 4,
                totalTokens: 19,
                cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 },
            };
            recorder.recordPiAssistantMessageEnd(message);
            const alphaId = entries.appendMessage(message);
            setSystemTime(new Date("2026-11-02T05:01:00Z"));
            assertEquals(
                (
                    await runtime.recordPlanAssociation(sessionId, {
                        planId: "plan-beta",
                        planName: "beta",
                        purpose: "execution",
                    })
                ).ok,
                true,
            );
            await runtime.setActiveExecutionWorkflow(sessionId, {
                planName: "beta",
                executionAgent: "engineer",
                triageMeta: {},
            });
            const associations = store.listSessionPlanAssociations(managed.runwieldSessionId, managed.projectId);
            const beta = associations.find((item) => item.planName === "beta");
            assert(beta);
            const beforeBeta = new Date(Date.parse(beta.recordedAt) - 1).toISOString();
            const untimedIds: string[] = [];
            for (const timestamp of [NaN, Infinity, 9e15, undefined]) {
                const untimed = fauxAssistantMessage(fauxText("No valid observation time."));
                if (timestamp === undefined) Reflect.deleteProperty(untimed, "timestamp");
                else untimed.timestamp = timestamp;
                untimedIds.push(entries.appendMessage(untimed));
            }
            await recorder.reconcilePiEntries(entries.getEntries(), new Set());
            await recorder.recordModelUsage({
                sourceId: "call-before-beta",
                startedAt: beforeBeta,
                endedAt: new Date().toISOString(),
                inputTokens: 3,
                outputTokens: 2,
            });
            await recorder.recordModelUsage({
                sourceId: "beta-call",
                startedAt: beta.recordedAt,
                inputTokens: 3,
                outputTokens: 2,
            });
            const rows = await readUsage(projectRoot);
            assertEquals(
                rows.map((row) => [row.sourceId, row.planId]),
                [
                    [oldId, undefined],
                    [alphaId, "plan-alpha"],
                    ...untimedIds.map((id) => [id, undefined]),
                    ["call-before-beta", undefined],
                    ["beta-call", "plan-beta"],
                ],
            );
            assertEquals(rows.find((row) => row.sourceId === alphaId)?.ts, alpha.recordedAt);
            for (const id of untimedIds) {
                // The journal can record collection time, but must not invent an observation time or Plan.
                assertEquals(rows.find((row) => row.sourceId === id)?.ts, "2026-11-02T05:01:00.000Z");
            }
            const report = new UsageReporter().query(
                [projectRoot],
                { start: "2026-11-01", end: "2026-11-03" },
                "America/New_York",
            );
            assertEquals(
                report.daily.map((day) => day.totals.tokens.value),
                [19, 10],
            );
            assertEquals(
                report.daily.map((day) => day.totals.estimatedCostUsd.value),
                [0.5, 0],
            );
            const alphaRow = rows.find((row) => row.sourceId === alphaId);
            assertEquals(
                report.projects[0].links.filter((link) => link.planId === "plan-alpha").map((link) => link.segmentId),
                [alphaRow?.segmentId],
            );
            const wrongSegment = new ExecutionMetricsRecorder({
                projectRoot,
                hostedSession: hosted,
                managedSessionId: managed.runwieldSessionId,
                segmentId: `${managed.currentSegmentId}-wrong`,
            });
            await wrongSegment.recordModelUsage({ sourceId: "wrong-segment", inputTokens: 3, outputTokens: 2 });
            const wrong = (await readUsage(projectRoot)).at(-1);
            assertEquals([wrong?.sourceId, wrong?.planId], ["wrong-segment", undefined]);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
            setSystemTime();
        }
    });
});
