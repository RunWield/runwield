import { writeRuntimeExecutableFixture } from "../../../testing/runtime-executable-fixture.ts";
import { writeFile as fsWriteFile, mkdir as fsMkdir, rm as fsRm, readFile as fsReadFile } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
function assertAlmostEquals(actual: number, expected: number, tolerance = 1e-7): void {
    assert(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}
import { assertEquals } from "../../../testing/assertions.ts";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defineGitFixture, git } from "../../git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import { getNativeModelRegistry } from "@runwield/pi-ai/models";
import { setCustomSetting } from "../../settings.ts";
import { getWorkflowMetricsFilePath } from "../../workflow/metrics.ts";
import { HostedSession } from "@runwield/session-runtime/host";
import { createRootSessionManager } from "../root-session.ts";
import type { RuntimeUsage, SessionRuntimeEvent } from "@runwield/session-runtime/events";
import { ClaudeCliExecutionSession } from "./claude-cli/execution-session.ts";

const repository = defineGitFixture(async (root) => {
    await fsWriteFile(join(root, "README.md"), "usage fixture\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
});

interface SavedUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total: number };
}

interface JournalUsageMeasurement {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    costAmount: number | null;
    costSource: string;
    costAvailability: string;
    measurementAvailability: string;
}

interface UsageFixture {
    name: string;
    result: string;
    runtime: RuntimeUsage;
    saved?: SavedUsage;
    assistantUsage?: { input_tokens: number; output_tokens: number };
    alternatives?: boolean;
    vendorStream?: string;
    journal?: JournalUsageMeasurement;
}

const absent: RuntimeUsage = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
};

async function withCliFixture(fixture: UsageFixture, callback: (root: string) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const root = await repository.checkout();
        const home = join(root, "home");
        const bin = join(root, "bin");
        const previousHome = process.env["HOME"];
        const previousPath = process.env["PATH"];
        try {
            await fsMkdir(home);
            await fsMkdir(bin);
            const streamPath = join(root, "stream.jsonl");
            await fsWriteFile(streamPath, fixture.vendorStream ?? fixture.result + "\n");
            const script = join(bin, "fixture.js");
            await fsWriteFile(
                script,
                `
const lines = (await import("node:readline")).createInterface({ input: (await import("node:process")).stdin });
await new Promise((resolve) => lines.once("line", resolve));
lines.close();
if (!${Boolean(fixture.vendorStream)}) console.log(JSON.stringify({ type: "assistant", message: { id: "cli-assistant", content: [{ type: "text", text: "reply" }], usage: ${JSON.stringify(fixture.assistantUsage)} } }));
console.log(await (await import("node:fs/promises")).readFile(${JSON.stringify(streamPath)}, "utf8"));
if (${Boolean(fixture.vendorStream)}) await new Promise((resolve) => setTimeout(resolve, 30));
`,
            );
            await writeRuntimeExecutableFixture(join(bin, "claude"), script);
            process.env["HOME"] = home;
            process.env["PATH"] = `${bin}:${previousPath || ""}`;
            await setCustomSetting("workflowMetrics", true, "project", root);
            await callback(root);
        } finally {
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = previousPath;
            await fsRm(root, { recursive: true });
        }
    });
}

const fixtures: UsageFixture[] = [
    {
        name: "Claude preserves the top-level cost fallback",
        result: JSON.stringify({
            type: "result",
            result: "reply",
            cost: 0.1,
            usage: { input_tokens: 7, output_tokens: 2 },
        }),
        runtime: { ...absent, inputTokens: 7, outputTokens: 2, costUsd: 0.1 },
        saved: { input: 7, output: 2, cost: { total: 0.1 } },
    },
    {
        name: "Claude retains alternatives once without adding them to saved turn totals",
        assistantUsage: { input_tokens: 3, output_tokens: 1 },
        alternatives: true,
        result: JSON.stringify({
            type: "result",
            result: "reply",
            total_cost_usd: 0.25,
            usage: { input_tokens: 10, output_tokens: 5 },
            modelUsage: { sonnet: { inputTokens: 7, outputTokens: 5, costUSD: 0.1 } },
        }),
        runtime: { ...absent, inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
        saved: { input: 10, output: 5, cost: { total: 0.25 } },
    },
    {
        name: "Claude preserves reported tokens and total cost without inventing cost components",
        result: JSON.stringify({
            type: "result",
            result: "reply",
            total_cost_usd: 0.25,
            usage: { input_tokens: 7, output_tokens: 2 },
        }),
        runtime: { ...absent, inputTokens: 7, outputTokens: 2, costUsd: 0.25 },
        saved: { input: 7, output: 2, cost: { total: 0.25 } },
    },
    {
        name: "Claude preserves measured zero cache and cost separately from absent cache",
        result: JSON.stringify({
            type: "result",
            result: "reply",
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 0 },
        }),
        runtime: { ...absent, inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, costUsd: 0 },
        saved: { input: 0, output: 2, cacheRead: 0, cost: { total: 0 } },
    },
    {
        name: "Claude preserves fallback cost and fully observed token totals",
        result: JSON.stringify({
            type: "result",
            result: "reply",
            usage: {
                input_tokens: 3,
                output_tokens: 2,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 4,
                cost: { total: 0.1 },
            },
        }),
        runtime: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 4, costUsd: 0.1 },
        saved: { input: 3, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 9, cost: { total: 0.1 } },
    },
    {
        name: "Claude leaves absent cost and cache unavailable",
        result: JSON.stringify({ type: "result", result: "reply", usage: { input_tokens: 3, output_tokens: 0 } }),
        runtime: { ...absent, inputTokens: 3, outputTokens: 0 },
        saved: { input: 3, output: 0 },
    },
    {
        name: "Claude omits usage when the CLI reports no measurements",
        result: JSON.stringify({ type: "result", result: "reply" }),
        runtime: absent,
    },
];

const claudeVendor = await fsReadFile(
    new URL("./claude-cli/fixtures/claude-2.1.284-read-tool-stream.jsonl", import.meta.url),
    "utf8",
);
fixtures.push({
    name: "Claude vendor tool stream stores cache-exclusive aggregate and unmeasured request alternatives",
    result: "",
    vendorStream: claudeVendor,
    runtime: { inputTokens: 4, outputTokens: 507, cacheReadTokens: 5326, cacheWriteTokens: 6034, costUsd: 0.0594932 },
    saved: { input: 4, output: 507, cacheRead: 5326, cacheWrite: 6034, totalTokens: 11871, cost: { total: 0.0594932 } },
    journal: {
        inputTokens: 4,
        outputTokens: 507,
        cacheReadTokens: 5326,
        cacheWriteTokens: 6034,
        reasoningTokens: null,
        costAmount: 0.0594932,
        costSource: "reported",
        costAvailability: "complete",
        measurementAvailability: "complete",
    },
});
for (const fixture of fixtures) {
    test(`${fixture.name}, including saved replay`, async () => {
        await withCliFixture(fixture, async (root) => {
            const model = getNativeModelRegistry().find("claude-cli", "sonnet");
            assert(model);
            const manager = await createRootSessionManager("new", root);
            const hostedSession = new HostedSession({ id: "usage-fixture", cwd: root, sessionManager: manager });
            const observed: RuntimeUsage[] = [];
            hostedSession.setEventSink((event: SessionRuntimeEvent) => {
                if (event.type === "usage") observed.push(event.usage);
            });
            const options = {
                cwd: root,
                agentName: "Guide",
                agentDisplayName: "Guide",
                finalSystemPrompt: "Fixture system instructions",
                model,
                sessionManager: manager,
                hostedSession,
            };
            const session = new ClaudeCliExecutionSession(options);
            try {
                const beforeTurn = Date.now();
                const messages = await session.runTurn({ userRequest: "hello" });
                const afterTurn = Date.now();
                assertEquals(observed, [fixture.runtime]);
                if (fixture.journal) {
                    const metrics = (await fsReadFile(getWorkflowMetricsFilePath(root), "utf8"))
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    const rows = metrics.filter((record) => record.event === "model_usage");
                    const turn = rows.find((record) => record.aggregationBasis === "turn");
                    assert(turn);
                    for (const [field, expected] of Object.entries(fixture.journal)) {
                        if (field === "costAmount" && typeof expected === "number") {
                            assert(typeof turn[field] === "number");
                            assertAlmostEquals(turn[field], expected, 1e-12);
                        } else assertEquals(turn[field], expected, field);
                    }
                    assertEquals(turn.inputCacheBasis, "excludes_cache");
                    const latency = metrics.find((record) => record.event === "response_latency");
                    assertEquals(Date.parse(turn.startedAt), latency.requestStartedAt);
                    assert(Date.parse(turn.startedAt) >= beforeTurn);
                    assert(Date.parse(turn.startedAt) <= Date.parse(turn.endedAt));
                    assert(Date.parse(turn.endedAt) <= afterTurn);
                    assert(Date.parse(turn.endedAt) <= Date.parse(turn.ts));
                    for (const alternative of rows.filter((record) => record.aggregationBasis === "alternative")) {
                        assertEquals(alternative.inputCacheBasis, "excludes_cache");
                        assertEquals(
                            [alternative.startedAt, alternative.endedAt, alternative.reasoningTokens],
                            [null, null, null],
                        );
                    }
                    {
                        assertEquals(
                            rows
                                .filter((record) => record.aggregationBasis === "alternative")
                                .map((record) => [
                                    record.inputTokens,
                                    record.outputTokens,
                                    record.cacheReadTokens,
                                    record.cacheWriteTokens,
                                ]),
                            [
                                [2, 8, 1448, 2430],
                                [2, 2, 3878, 3604],
                                [null, null, null, null],
                            ],
                        );
                    }
                }
                if (fixture.alternatives) {
                    const metrics = (await fsReadFile(getWorkflowMetricsFilePath(root), "utf8"))
                        .trim()
                        .split("\n")
                        .map((line) => JSON.parse(line));
                    const observations = metrics.filter((record) => record.event === "model_usage");
                    assertEquals(
                        observations.map((record) => [record.aggregationBasis, record.inputTokens]),
                        [
                            ["alternative", 3],
                            ["turn", 10],
                            ["alternative", 7],
                        ],
                    );
                    assertEquals(new Set(observations.map((record) => record.sourceId)).size, 3);
                }
                const reply = messages.at(-1);
                assert(reply?.role === "assistant");
                assertEquals(reply.usage, fixture.saved);
                assertEquals("usage" in reply, fixture.saved !== undefined);
                const path = manager.getSessionFile();
                assert(path);
                const reloaded = SessionManager.open(path);
                const replayOptions = { ...options, sessionManager: reloaded };
                const replay = new ClaudeCliExecutionSession(replayOptions);
                try {
                    assertEquals(replay.getMessages(), messages);
                } finally {
                    await replay.dispose();
                }
            } finally {
                await session.dispose();
            }
        });
    });
}
