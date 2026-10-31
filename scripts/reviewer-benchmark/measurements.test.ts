import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { setExactProjectCustomSetting } from "../../src/shared/settings.js";
import { ExecutionMetricsRecorder } from "../../src/shared/workflow/execution-metrics.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../../src/shared/workflow/metrics.js";
import { readReviewMeasurements } from "./measurements.ts";

interface TestObservation {
    v: number;
    executionId: string;
    event: string;
    agent: string;
    parentExecutionId?: string;
    model: string;
    provider: string;
    aggregationBasis?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    callCount?: number;
    coverage?: TestCoverage;
}
interface TestCoverage {
    tools: string;
    usage: string;
}

function journal(executionId = "review", agent = "reviewer", parentExecutionId?: string): TestObservation[] {
    const links = { v: 2, executionId, agent, parentExecutionId, model: agent + "-model", provider: "provider" };
    return [
        { ...links, event: "execution_started" },
        {
            ...links,
            event: "model_usage",
            aggregationBasis: "turn",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
        },
        { ...links, event: "execution_finished", callCount: 2, coverage: { tools: "complete", usage: "complete" } },
    ];
}
const toText = (records: ReturnType<typeof journal>) => records.map((record) => JSON.stringify(record)).join("\n");
const unavailable = {
    input: "unavailable",
    output: "unavailable",
    cacheRead: "unavailable",
    cacheWrite: "unavailable",
};

test("usage includes linked descendants but keeps the Reviewer model identity", () => {
    const records = [
        ...journal(),
        ...journal("child", "delegated-agent", "review"),
        ...journal("grandchild", "delegated-agent", "child"),
        ...journal("unrelated", "engineer"),
    ];
    const result = readReviewMeasurements(toText(records));
    assert.deepEqual(result.tokens, { input: 30, output: 6, cacheRead: 9, cacheWrite: 3 });
    assert.equal(result.toolCallCount, 6);
    assert.equal(result.model, "reviewer-model");
});

test("overlapping request and alternative observations do not add to turn totals or change identity", () => {
    const records = journal();
    records.push({ ...records[1], aggregationBasis: "alternative", model: "different-native-model", inputTokens: 500 });
    records.push({ ...records[1], aggregationBasis: "request", inputTokens: 250 });
    const result = readReviewMeasurements(toText(records));
    assert.deepEqual(result.tokens, { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 });
    assert.equal(result.model, "reviewer-model");
});

test("request observations are additive only when the execution has no turn observations", () => {
    const records = journal();
    records[1].aggregationBasis = "request";
    records.push({ ...records[1] });
    assert.equal(readReviewMeasurements(toText(records)).tokens.input, 20);
});

for (const text of [
    "",
    "{",
    toText(journal().slice(0, 2)),
    toText([...journal(), ...journal("child", "delegated-agent", "review").slice(0, 2)]),
]) {
    test(`incomplete evidence does not establish complete measurements (${JSON.stringify(text).slice(0, 50)})`, () => {
        const result = readReviewMeasurements(text);
        assert.deepEqual(result.tokens, unavailable);
        assert.equal(result.toolCallCount, "unavailable");
    });
}

test("alternative-only usage is unavailable, not zero", () => {
    const records = journal();
    records[1].aggregationBasis = "alternative";
    assert.deepEqual(readReviewMeasurements(toText(records)).tokens, unavailable);
});

test("partial coverage cannot establish totals even when numeric observations exist", () => {
    const records = journal();
    records[2].coverage = { tools: "partial", usage: "partial" };
    const result = readReviewMeasurements(toText(records));
    assert.deepEqual(result.tokens, unavailable);
    assert.equal(result.toolCallCount, "unavailable");
});

test("missing token observations do not become a zero measurement", () => {
    const records = journal();
    delete records[1].inputTokens;
    const result = readReviewMeasurements(toText(records));
    assert.equal(result.tokens.input, "unavailable");
    assert.equal(result.tokens.output, 2);
});

test("the production recorder's native turn and alternative records yield one usage total", async () => {
    await withRuntimeCommandFixture("benchmark-measurements-", async ({ projectRoot }) => {
        setExactProjectCustomSetting("workflowMetrics", true, projectRoot);
        const recorder = new ExecutionMetricsRecorder({
            projectRoot,
            agent: "reviewer",
            model: "claude",
            provider: "claude-cli",
        });
        await recorder.recordExecutionStart();
        await recorder.recordToolExposure([]);
        const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 };
        await recorder.recordModelUsage({ ...usage, sourceId: "claude_turn_total", aggregationBasis: "turn" });
        await recorder.recordModelUsage({
            ...usage,
            sourceId: "claude_model_0",
            model: "native-claude-id",
            aggregationBasis: "alternative",
        });
        const child = new ExecutionMetricsRecorder({
            projectRoot,
            agent: "delegated-agent",
            parentExecutionId: recorder.executionId,
            model: "child-model",
            provider: "provider",
        });
        await child.recordExecutionStart();
        await child.recordToolExposure([]);
        await child.recordModelUsage({ ...usage, sourceId: "child-total", aggregationBasis: "turn" });
        await child.settleExecution();
        await recorder.settleExecution();
        await drainWorkflowMetrics();
        const result = readReviewMeasurements(await readFile(getWorkflowMetricsFilePath(projectRoot), "utf8"));
        assert.deepEqual(result.tokens, { input: 20, output: 4, cacheRead: 6, cacheWrite: 2 });
        assert.equal(result.toolCallCount, 0);
        assert.equal(result.model, "claude");
        assert.equal(result.provider, "claude-cli");
    });
});
