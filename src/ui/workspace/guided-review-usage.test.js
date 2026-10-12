import { setCustomSetting } from "../../shared/settings.js";
import { assertEquals } from "@std/assert";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import {
    cleanupReviewAgentState,
    createReviewAgentState,
    reviewAgentApi,
    runConfiguredGuideCommand,
} from "./routes/api/review-agent-handlers.js";

const absent = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null };
const guide = JSON.stringify({
    schemaVersion: "1.0",
    title: "Usage guide",
    sections: [{
        title: "Core",
        role: "core",
        blocks: [{ type: "diff", file: "src/a.js", summary: "Review export." }],
    }],
    everythingElse: [],
});
const reviewPayload = {
    rawPatch:
        "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n",
};

/**
 * @typedef {import('../../cmd/guided-review/protocol.ts').GuidedReviewUsage} Usage
 * @typedef {Object} JobScenario
 * @property {Usage[]} frames
 * @property {boolean} [internal]
 * @property {boolean} [fails]
 * @property {Usage} [resultUsage]
 * @property {string} [command]
 */
/** @param {string} cwd @param {JobScenario} scenario */
async function runJob(cwd, scenario) {
    const previous = Deno.env.get("RUNWIELD_GUIDED_REVIEW_COMMAND");
    if (scenario.internal) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
    else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", scenario.command || "fixture-external-command");
    const state = createReviewAgentState({
        cwd,
        token: "usage-fixture",
        reviewPayload,
        runGuideCommand: scenario.command ? runConfiguredGuideCommand : (_prompt, _signal, _cwd, progress) => {
            for (const frame of scenario.frames) progress?.onUsage?.(frame);
            if (scenario.fails) return Promise.reject(new Error("provider failed"));
            return Promise.resolve({
                stdout: guide,
                provider: scenario.internal ? "wld" : "fixture-provider",
                model: "fixture-model",
                ...(scenario.resultUsage ? { usage: scenario.resultUsage } : {}),
            });
        },
    });
    try {
        const response = await reviewAgentApi(
            new Request("http://localhost/api/agents/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: "guide" }),
            }),
            new URL("http://localhost/api/agents/jobs"),
            state,
        );
        if (!response) throw new Error("job launch missing");
        const { job } = await response.json();
        await state.jobs.get(job.id)?.done;
        const snapshot = await reviewAgentApi(
            new Request("http://localhost/api/agents/jobs"),
            new URL("http://localhost/api/agents/jobs"),
            state,
        );
        return (await snapshot?.json()).jobs[0];
    } finally {
        await cleanupReviewAgentState(state);
        if (previous === undefined) Deno.env.delete("RUNWIELD_GUIDED_REVIEW_COMMAND");
        else Deno.env.set("RUNWIELD_GUIDED_REVIEW_COMMAND", previous);
    }
}

Deno.test("external Guided Review records one aggregate without counting its result twice", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const frame = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 };
        const job = await runJob(projectRoot, { frames: [frame, frame], resultUsage: frame });
        assertEquals(job.status, "done");
        assertEquals(job.tokens.inputTokens, 24);
        const records = await readMetrics();
        const usages = records.filter((record) => record.event === "model_usage");
        assertEquals(usages.length, 1);
        assertEquals(usages[0].inputTokens, 24);
        assertEquals(usages[0].costAmount, 0.5);
        assertEquals(usages[0].provider, "fixture-provider");
        assertEquals(usages[0].model, "fixture-model");
        assertEquals(usages[0].aggregationBasis, "turn");
        assertEquals(usages[0].usageKind, "turn");
        assertEquals(usages[0].measurementAvailability, "complete");
        assertEquals(records.filter((record) => record.event === "guided_review_generation_result").length, 1);
    });
});

Deno.test("external Guided Review keeps measured zero and missing cost distinct", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const job = await runJob(projectRoot, { frames: [{ ...absent, inputTokens: 12, outputTokens: 0 }] });
        assertEquals(job.tokens.outputTokens, 0);
        assertEquals(job.tokens.cacheReadTokens, null);
        assertEquals(job.cost, null);
        assertEquals(job.costUnavailable, true);
        const usage = (await readMetrics()).find((record) => record.event === "model_usage");
        assertEquals(usage?.outputTokens, 0);
        assertEquals(usage?.costAmount, null);
        assertEquals(usage?.costSource, "unavailable");
        assertEquals(usage?.measurementAvailability, "partial");
    });
});

Deno.test("external Guided Review without usage records unavailable, not zero", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const job = await runJob(projectRoot, { frames: [] });
        assertEquals(job.usageState, "unavailable");
        const usage = (await readMetrics()).find((record) => record.event === "model_usage");
        assertEquals(usage?.inputTokens, null);
        assertEquals(usage?.measurementAvailability, "unavailable");
    });
});

Deno.test("Guided Review marks aggregate coverage partial after an unmeasured frame", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const full = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
        const job = await runJob(projectRoot, { frames: [full, absent] });
        assertEquals(job.tokens.inputTokens, 0);
        assertEquals(job.usageAvailability.inputTokens, "partial");
        const usage = (await readMetrics()).find((record) => record.event === "model_usage");
        assertEquals(usage?.measurementAvailability, "partial");
        assertEquals(usage?.costAmount, 0);
    });
});

Deno.test("Guided Review journals partial cost coverage even when token coverage is complete", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const full = { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1 };
        const job = await runJob(projectRoot, { frames: [full, { ...full, costUsd: null }] });
        assertEquals(job.usageAvailability.inputTokens, "complete");
        assertEquals(job.usageAvailability.costUsd, "partial");
        const usages = (await readMetrics()).filter((record) => record.event === "model_usage");
        assertEquals(usages.length, 1);
        assertEquals(usages[0].inputTokens, 24);
        assertEquals(usages[0].costAmount, 1);
        assertEquals(usages[0].costSource, "reported");
        assertEquals(usages[0].measurementAvailability, "partial");
    });
});

Deno.test("wld Guided Review keeps its outcome but does not duplicate runtime usage", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await runJob(projectRoot, { frames: [{ ...absent, inputTokens: 12 }], internal: true });
        const records = await readMetrics();
        assertEquals(records.filter((record) => record.event === "model_usage").length, 0);
        assertEquals(records.filter((record) => record.event === "guided_review_generation_result").length, 1);
    });
});

Deno.test("failed external Guided Review retains observed usage and its failure outcome", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const job = await runJob(projectRoot, { frames: [{ ...absent, inputTokens: 12 }], fails: true });
        assertEquals(job.status, "failed");
        const records = await readMetrics();
        assertEquals(records.filter((record) => record.event === "model_usage").length, 1);
        assertEquals(records.find((record) => record.event === "model_usage")?.inputTokens, 12);
        assertEquals(
            records.find((record) => record.event === "guided_review_generation_result")?.outcome,
            "failed",
        );
    });
});

Deno.test("external Guided Review accepts result-only usage without zero filling", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const job = await runJob(projectRoot, { frames: [], resultUsage: { ...absent, inputTokens: 12, costUsd: 0 } });
        assertEquals(job.tokens.inputTokens, 12);
        assertEquals(job.tokens.outputTokens, null);
        assertEquals(job.cost.usd, 0);
        assertEquals((await readMetrics()).find((record) => record.event === "model_usage")?.inputTokens, 12);
    });
});

Deno.test("external Guided Review respects metrics opt-out", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        await runJob(projectRoot, { frames: [{ ...absent, inputTokens: 12 }] });
        assertEquals((await readMetrics()).filter((record) => record.event === "model_usage").length, 0);
    });
});

Deno.test("configured external guide subprocess forwards version 2 measurements to one journal aggregate", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const script = `${projectRoot}/external-guide.js`;
        const frame = { version: 2, type: "usage", usage: { ...absent, inputTokens: 12, outputTokens: 0 } };
        await Deno.writeTextFile(
            script,
            `await new Response(Deno.stdin.readable).text();\nconsole.error(${
                JSON.stringify("RUNWIELD_GUIDED_REVIEW_EVENT " + JSON.stringify(frame))
            });\nconsole.log(${JSON.stringify(guide)});\n`,
        );
        const job = await runJob(projectRoot, {
            frames: [],
            command: `${JSON.stringify(Deno.execPath())} run -A ${JSON.stringify(script)}`,
        });
        assertEquals(job.status, "done");
        assertEquals(job.tokens.inputTokens, 12);
        assertEquals(job.tokens.outputTokens, 0);
        assertEquals(job.tokens.cacheReadTokens, null);
        const usages = (await readMetrics()).filter((record) => record.event === "model_usage");
        assertEquals(usages.length, 1);
        assertEquals(usages[0].inputTokens, 12);
        assertEquals(usages[0].measurementAvailability, "partial");
        assertEquals(usages[0].costAmount, null);
    });
});

Deno.test("a Guided Review capacity hint does not make absent measurements available", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const job = await runJob(projectRoot, { frames: [{ ...absent, contextWindow: 128000 }] });
        assertEquals(job.usageState, "unavailable");
        assertEquals(job.tokens.inputTokens, null);
        const records = await readMetrics();
        assertEquals(records.find((record) => record.event === "model_usage")?.measurementAvailability, "unavailable");
        assertEquals(
            records.find((record) => record.event === "guided_review_generation_result")?.outcome,
            "succeeded",
        );
    });
});
