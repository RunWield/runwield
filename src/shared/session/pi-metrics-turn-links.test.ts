import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert, notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";
import { createSessionRuntime } from "./session-runtime.ts";

test("one Pi execution links usage from successive model turns to its own turn", async () => {
    await withRuntimeCommandFixture("metrics-pi-multi-turn-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await fsWriteFile(`${projectRoot}/fixture.txt`, "safe fixture\n");
        setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" })),
            () => fauxAssistantMessage(fauxText("Finished.")),
        ]);
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Read fixture." })).ok, true);
            await drainWorkflowMetrics();
            const rows = (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            const turns = rows.filter((row) => row.event === "response_latency");
            assertEquals(turns.length, 2);
            assertNotEquals(turns[0].turnId, turns[1].turnId);
            const usage = rows.filter((row) => row.event === "model_usage" && row.usageKind === "turn");
            assertEquals(usage.length, 2);
            assertEquals(
                usage.map((row) => row.turnId),
                turns.map((row) => row.turnId),
            );
            assert(usage.every((row) => row.executionId === turns[0].executionId));
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("Pi assistant usage keeps observed message timing before settlement", async () => {
    await withRuntimeCommandFixture("metrics-pi-timing-", async ({ projectRoot, setModelResponseFactories }) => {
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        await fsWriteFile(`${projectRoot}/fixture.txt`, "safe fixture\n");
        setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" })),
            async () => {
                // The first assistant finished before this second model request and settlement.
                await new Promise((resolve) => setTimeout(resolve, 30));
                return fauxAssistantMessage(fauxText("Finished."));
            },
        ]);
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            assertEquals((await runtime.promptUserTurn(sessionId, { initialRequest: "Read fixture." })).ok, true);
            await drainWorkflowMetrics();
            const rows = (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            const turns = rows.filter((row) => row.event === "response_latency");
            const usage = rows.filter((row) => row.event === "model_usage" && row.usageKind === "turn");
            assertEquals(usage.length, 2);
            assertEquals(usage[0].reasoningTokens, null);
            assertEquals(usage[1].reasoningTokens, null);
            for (const [index, row] of usage.entries()) {
                assertEquals(Date.parse(row.startedAt), turns[index].requestStartedAt);
                assert(Date.parse(row.endedAt) >= Date.parse(row.startedAt));
                assert(Date.parse(row.endedAt) <= turns[index].completedAt);
                assertNotEquals(row.startedAt, row.ts);
            }
            assert(Date.parse(usage[0].endedAt) < Date.parse(usage[0].ts));
            assert(Date.parse(usage[0].endedAt) <= turns[1].requestStartedAt);
            assertNotEquals(usage[0].startedAt, usage[1].startedAt);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});
