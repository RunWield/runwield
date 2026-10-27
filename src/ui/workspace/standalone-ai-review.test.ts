import { test } from "node:test";
import process from "node:process";
import { delimiter, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { type WorkflowMetricsFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { encodeGuidedReviewMetadata, encodeGuidedReviewUsageEvent } from "../../cmd/guided-review/protocol.ts";
import { createReviewWorkspaceApp } from "./server.js";
import {
    cleanupReviewAgentState,
    createReviewAgentState,
    reviewAgentApi,
    runWldJobCommand,
} from "./routes/api/review-agent-handlers.js";

import type { StandaloneReviewPayload } from "../review/review-launcher.ts";
import type { AiReviewValue } from "../../shared/standalone-review/ai-review.ts";
import type { GuidedReviewJobStatus } from "./react/guided-review-status.ts";

interface CommandFixture {
    output?: string;
    error?: string;
    exitCode?: number;
    wait?: boolean;
    frames?: string[];
    gatePath?: string;
}

type ReviewFixturePayload = {
    rawPatch: string;
    gitRef?: string;
    standaloneReview?: StandaloneReviewPayload;
    agentCwd?: string;
};

type StandaloneReviewFixturePayload = ReviewFixturePayload & Required<Pick<ReviewFixturePayload, "standaloneReview">>;

interface ReviewLaunchBody {
    provider: string;
}

interface ReviewJob extends GuidedReviewJobStatus {
    id: string;
    cwd: string;
    status: string;
    elapsedMs: number;
}

interface ReviewLaunchResponse {
    job: ReviewJob;
}

interface ReviewJobsResponse {
    jobs: ReviewJob[];
}

interface ReviewProvider {
    id: string;
    available: boolean;
}

interface ReviewCapabilities {
    providers: ReviewProvider[];
}

type AiFixtureRun = (fixture: WorkflowMetricsFixture) => Promise<void>;
type ReviewFixtureApp = ReturnType<typeof createApp>;

const PATCH =
    "diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n";
const RESULT = {
    schemaVersion: 1,
    specSource: "PR description",
    findings: [
        {
            axis: "tests",
            severity: "issue",
            file: "src/a.js",
            side: "new",
            lineStart: 2,
            lineEnd: 2,
            title: "Test the new export",
            body: "The spec requires coverage of b.",
        },
    ],
};

function shellQuote(value: string) {
    return process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

async function commandScript(root: string, fixture: CommandFixture = {}) {
    const script = join(root, `command-${crypto.randomUUID()}.mjs`);
    await writeFile(
        script,
        `
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
const fixture = ${JSON.stringify(fixture)};
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
await writeFile(${JSON.stringify(join(root, "prompt.txt"))}, prompt);
await writeFile(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(process.argv.slice(2)));
for (const frame of fixture.frames || []) process.stderr.write(frame);
while (fixture.gatePath && !existsSync(fixture.gatePath)) await new Promise(resolve => setTimeout(resolve, 10));
if (fixture.wait) await new Promise(() => setInterval(() => {}, 1000));
if (fixture.error) process.stderr.write(fixture.error);
process.stdout.write(fixture.output ?? ${JSON.stringify(JSON.stringify(RESULT))});
process.exitCode = fixture.exitCode || 0;
`,
    );
    return script;
}

async function withAiFixture(run: AiFixtureRun) {
    await withWorkflowMetricsFixture(async (fixture) => {
        const keys = ["RUNWIELD_AI_REVIEW_COMMAND", "RUNWIELD_AI_REVIEW_MODEL", "PATH"];
        const previous = keys.map((key) => process.env[key]);
        try {
            const script = await commandScript(fixture.projectRoot);
            process.env.RUNWIELD_AI_REVIEW_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
            delete process.env.RUNWIELD_AI_REVIEW_MODEL;
            await run(fixture);
        } finally {
            keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key];
                else process.env[key] = previous[index];
            });
        }
    });
}

async function waitForFile(path: string) {
    for (let attempt = 0; attempt < 500; attempt++) {
        try {
            return await readFile(path, "utf8");
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw new Error(`Fixture did not write ${path}`);
}

function reviewPayload(): StandaloneReviewFixturePayload {
    return {
        rawPatch: PATCH,
        gitRef: "topic",
        standaloneReview: {
            mode: "branch",
            headRef: "topic",
            baseLabel: "main",
            reviewContext: "PR description: test b.",
        },
    };
}

function createApp(cwd: string, payload: ReviewFixturePayload = reviewPayload()) {
    const app = createReviewWorkspaceApp({ cwd, token: "ai-review-token", reviewType: "code", reviewPayload: payload });
    const handler = app.handler();
    return {
        cleanup: app.cleanup,
        request(path: string, method = "GET", body?: ReviewLaunchBody) {
            return handler(
                new Request(`http://localhost${path}`, {
                    method,
                    headers: { "content-type": "application/json", "x-runwield-review-token": "ai-review-token" },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                }),
            );
        },
        handler,
    };
}

async function waitForResult(app: ReviewFixtureApp, id: string) {
    for (let attempt = 0; attempt < 500; attempt++) {
        const response = await app.request(`/api/ai-review/${id}`);
        if (response.status !== 202) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("AI review fixture did not finish");
}

test("standalone AI review is authenticated and returns placed annotations and a result metric", async () => {
    await withAiFixture(async ({ projectRoot, readMetrics }) => {
        const app = createApp(projectRoot);
        try {
            assertEquals((await app.handler(new Request("http://localhost/api/ai-review/missing"))).status, 401);
            assertEquals((await app.request("/api/ai-review/missing")).status, 404);
            const capabilities: ReviewCapabilities = await (await app.request("/api/agents/capabilities")).json();
            assertEquals(capabilities.providers.find((provider) => provider.id === "ai-review")?.available, true);
            assertEquals(
                capabilities.providers.some((provider) => provider.id === "guide"),
                true,
            );
            const launch = await app.request("/api/agents/jobs", "POST", { provider: "ai-review" });
            assertEquals(launch.status, 202);
            const { job }: ReviewLaunchResponse = await launch.json();
            const response = await waitForResult(app, job.id);
            assertEquals(response.status, 200);
            const result: AiReviewValue = await response.json();
            assertEquals(result.specSource, "PR description");
            assertEquals(result.counts, { standards: 0, spec: 0, tests: 1 });
            assertEquals(result.annotations[0].scope, "line");
            assertEquals(result.annotations[0].filePath, "src/a.js");
            assertEquals(result.annotations[0].lineStart, 2);
            assertEquals(result.annotations[0].side, "new");
            assertEquals(result.annotations[0].source, "ai-review");
            assertEquals(result.annotations[0].author, "AI review");
            const prompt = await readFile(join(projectRoot, "prompt.txt"), "utf8");
            assertStringIncludes(prompt, "git show topic:<path>");
            assertStringIncludes(prompt, "Base: main");
            assertStringIncludes(prompt, "PR description: test b.");
            const { jobs }: ReviewJobsResponse = await (await app.request("/api/agents/jobs")).json();
            assertEquals(jobs[0].status, "done");
            assertEquals(jobs[0].elapsedMs >= 0, true);
            assertEquals(jobs[0].usageState, "unavailable");
        } finally {
            await app.cleanup();
        }
        const metrics = await readMetrics();
        const metric = metrics.find((entry) => entry.event === "ai_review_generation_result");
        assertEquals(metric?.details?.status, "done");
        assertEquals(metric?.details?.annotationCount, 1);
    });
});

test("AI review uses the lazy worktree checkout and reports no findings without a spec", async () => {
    await withAiFixture(async ({ projectRoot }) => {
        const worktree = join(projectRoot, "worktree");
        await mkdir(worktree);
        const script = await commandScript(projectRoot, {
            output: JSON.stringify({ schemaVersion: 1, specSource: null, findings: [] }),
        });
        process.env.RUNWIELD_AI_REVIEW_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
        const payload = reviewPayload();
        delete payload.standaloneReview.headRef;
        payload.agentCwd = worktree;
        const app = createApp(projectRoot, payload);
        try {
            const { job }: ReviewLaunchResponse = await (
                await app.request("/api/agents/jobs", "POST", { provider: "ai-review" })
            ).json();
            assertEquals(job.cwd, worktree);
            const response = await waitForResult(app, job.id);
            assertEquals(response.status, 200);
            assertEquals(await response.json(), {
                specSource: null,
                counts: { standards: 0, spec: 0, tests: 0 },
                annotations: [],
            });
            const prompt = await readFile(join(projectRoot, "prompt.txt"), "utf8");
            assertStringIncludes(prompt, "Read head files in the current checkout.");
            assertStringIncludes(prompt, "Target: worktree HEAD");
        } finally {
            await app.cleanup();
        }
    });
});

test("validation review excludes AI review and rejects its launch and unknown providers", async () => {
    await withAiFixture(async ({ projectRoot }) => {
        const app = createApp(projectRoot, { rawPatch: PATCH });
        try {
            const capabilities: ReviewCapabilities = await (await app.request("/api/agents/capabilities")).json();
            assertEquals(
                capabilities.providers.some((provider) => provider.id === "ai-review"),
                false,
            );
            for (const provider of ["ai-review", "unknown"]) {
                assertEquals((await app.request("/api/agents/jobs", "POST", { provider })).status, 400);
            }
        } finally {
            await app.cleanup();
        }
    });
});

for (const failure of [
    {
        name: "provider failure",
        fixture: { error: "Model access failed", exitCode: 1, output: "" },
        message: "Model access failed",
    },
    { name: "malformed output", fixture: { output: "not JSON" }, message: "JSON" },
    {
        name: "wrong schema",
        fixture: { output: '{"schemaVersion":2,"specSource":null,"findings":[]}' },
        message: "schemaVersion",
    },
]) {
    test(`AI review reports ${failure.name} as a recoverable failed job`, async () => {
        await withAiFixture(async ({ projectRoot, readMetrics }) => {
            const script = await commandScript(projectRoot, failure.fixture);
            process.env.RUNWIELD_AI_REVIEW_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
            const app = createApp(projectRoot);
            try {
                const { job }: ReviewLaunchResponse = await (
                    await app.request("/api/agents/jobs", "POST", { provider: "ai-review" })
                ).json();
                const response = await waitForResult(app, job.id);
                assertEquals(response.status, 422);
                assertStringIncludes((await response.json()).error, failure.message);
            } finally {
                await app.cleanup();
            }
            assertEquals(
                (await readMetrics()).find((entry) => entry.event === "ai_review_generation_result")?.details?.status,
                "failed",
            );
        });
    });
}

test("a running AI review returns 202 and DELETE cancels it", async () => {
    await withAiFixture(async ({ projectRoot, readMetrics }) => {
        const script = await commandScript(projectRoot, { wait: true });
        process.env.RUNWIELD_AI_REVIEW_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
        const app = createApp(projectRoot);
        try {
            const { job }: ReviewLaunchResponse = await (
                await app.request("/api/agents/jobs", "POST", { provider: "ai-review" })
            ).json();
            assertEquals((await app.request(`/api/ai-review/${job.id}`)).status, 202);
            await waitForFile(join(projectRoot, "prompt.txt"));
            assertEquals((await app.request(`/api/agents/jobs/${job.id}`, "DELETE")).status, 200);
            const { jobs }: ReviewJobsResponse = await (await app.request("/api/agents/jobs")).json();
            assertEquals(jobs[0].status, "killed");
        } finally {
            await app.cleanup();
        }
        assertEquals(
            (await readMetrics()).find((entry) => entry.event === "ai_review_generation_result")?.details?.status,
            "killed",
        );
    });
});

test("AI review snapshots the launch patch and uses wld ai-review with usage and model frames", async () => {
    await withAiFixture(async ({ projectRoot, readMetrics }) => {
        delete process.env.RUNWIELD_AI_REVIEW_COMMAND;
        const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 2, costUsd: 0.03 };
        const gatePath = join(projectRoot, "release");
        const script = await commandScript(projectRoot, {
            gatePath,
            frames: [
                encodeGuidedReviewUsageEvent(usage),
                encodeGuidedReviewMetadata({
                    provider: "fixture-model-host",
                    model: "review-model",
                    thinkingLevel: "high",
                }),
            ],
        });
        const bin = join(projectRoot, "bin");
        await mkdir(bin);
        await writeRuntimeExecutableFixture(join(bin, "wld"), script);
        process.env.PATH = `${bin}${delimiter}${process.env.PATH || ""}`;
        const payload = reviewPayload();
        const state = createReviewAgentState({
            cwd: projectRoot,
            token: "snapshot",
            reviewPayload: payload,
            runGuideCommand: runWldJobCommand,
        });
        try {
            const url = new URL("http://localhost/api/agents/jobs");
            const response = await reviewAgentApi(
                new Request(url, { method: "POST", body: JSON.stringify({ provider: "ai-review" }) }),
                url,
                state,
            );
            const { job }: ReviewLaunchResponse = await response.json();
            payload.rawPatch = "";
            const info = state.jobs.get(job.id).info;
            for (let attempt = 0; attempt < 500 && info.usageState !== "available"; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(info.status, "running");
            assertEquals(info.usageState, "available");
            assertEquals(info.tokens, usage);
            assertEquals(info.cost, { usd: 0.03 });
            await writeFile(gatePath, "release");
            await state.jobs.get(job.id).done;
            const resultUrl = new URL(`http://localhost/api/ai-review/${job.id}`);
            const result: AiReviewValue = await (await reviewAgentApi(new Request(resultUrl), resultUrl, state)).json();
            assertEquals(result.annotations[0].scope, "line");
            assertEquals(JSON.parse(await readFile(join(projectRoot, "args.json"), "utf8")), ["ai-review"]);
            assertEquals(info.status, "done");
            assertEquals(info.model, "review-model");
            assertEquals(info.providerName, "fixture-model-host");
            assertEquals(info.thinkingLevel, "high");
            assertEquals(info.tokens, usage);
            assertEquals(info.cost, { usd: 0.03 });
            assertEquals(info.usageState, "available");
        } finally {
            await cleanupReviewAgentState(state);
        }
        const metric = (await readMetrics()).find((entry) => entry.event === "ai_review_generation_result");
        assertEquals(metric?.details?.status, "done");
        assertEquals(metric?.details?.costAvailable, true);
    });
});
