import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defineGitFixture, git } from "../../git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import { getExternalCliPriceModel, getModelRegistry } from "../../models/model-registry.ts";
import { setCustomSetting } from "../../settings.js";
import { getWorkflowMetricsFilePath } from "../../workflow/metrics.js";
import { HostedSession } from "../hosted-session.js";
import { createRootSessionManager } from "../root-session.js";
import type { RuntimeUsage, SessionRuntimeEvent } from "../session-runtime-events.js";
import { ClaudeCliExecutionSession } from "./claude-cli/execution-session.ts";
import { AgyCliExecutionSession } from "./agy-cli/execution-session.ts";

const repository = defineGitFixture(async (root) => {
    await Deno.writeTextFile(join(root, "README.md"), "usage fixture\n");
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
    measurementAvailability: string;
}

interface UsageFixture {
    name: string;
    backend: "claude-cli" | "agy-cli";
    result: string;
    runtime: RuntimeUsage;
    saved?: SavedUsage;
    nativeTool?: boolean;
    assistantUsage?: { input_tokens: number; output_tokens: number };
    alternatives?: boolean;
    vendorStream?: string;
    modelId?: string;
    journal?: JournalUsageMeasurement;
    availability?: "partial" | "unavailable";
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
        const previousHome = Deno.env.get("HOME");
        const previousPath = Deno.env.get("PATH");
        try {
            await Deno.mkdir(home);
            await Deno.mkdir(bin);
            const streamPath = join(root, "stream.jsonl");
            const nativeTool = fixture.nativeTool
                ? JSON.stringify({
                    type: "step_update",
                    step_update: {
                        step_type: "tool",
                        step_index: 1,
                        state: "DONE",
                        tool_info: { name: "read_file", parameters: { path: "README.md" }, output: "usage fixture" },
                    },
                }) + "\n"
                : "";
            await Deno.writeTextFile(streamPath, fixture.vendorStream ?? nativeTool + fixture.result + "\n");
            const script = join(bin, "fixture.js");
            await Deno.writeTextFile(
                script,
                `
const args = Deno.args;
if (args.includes("/agents")) {
    const names = [];
    for await (const entry of Deno.readDir(${JSON.stringify(join(home, ".gemini/config/agents"))})) {
        if (entry.isDirectory) names.push({ name: entry.name });
    }
    console.log(JSON.stringify({ agents: names }));
} else {
    if (args.includes("--agent")) {
        console.log(JSON.stringify({ type: "init", agent: args[args.indexOf("--agent") + 1], model: ${
                    JSON.stringify((fixture.modelId || "gemini-3.8-flash") + "-low")
                } }));
    } else {
        await new Response(Deno.stdin.readable).text();
        if (!${
                    Boolean(fixture.vendorStream)
                }) console.log(JSON.stringify({ type: "assistant", message: { id: "cli-assistant", content: [{ type: "text", text: "reply" }], usage: ${
                    JSON.stringify(fixture.assistantUsage)
                } } }));
    }
    console.log(await Deno.readTextFile(${JSON.stringify(streamPath)}));
    if (${Boolean(fixture.vendorStream)}) await new Promise((resolve) => setTimeout(resolve, 30));
}
`,
            );
            for (const command of ["claude", "agy"]) {
                const executable = join(bin, command);
                await Deno.writeTextFile(executable, `#!/bin/sh\nexec deno run -A ${JSON.stringify(script)} "$@"\n`);
                await Deno.chmod(executable, 0o755);
            }
            Deno.env.set("HOME", home);
            Deno.env.set("PATH", `${bin}:${previousPath || ""}`);
            await setCustomSetting("workflowMetrics", true, "project", root);
            await callback(root);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            await Deno.remove(root, { recursive: true });
        }
    });
}

const fixtures: UsageFixture[] = [
    {
        name: "Claude preserves the top-level cost fallback",
        backend: "claude-cli",
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
        backend: "claude-cli",
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
        name: "agy input-only measurement remains partial in the journal",
        backend: "agy-cli",
        result: JSON.stringify({ type: "result", result: "reply", usage: { input_tokens: 7 } }),
        runtime: { ...absent, inputTokens: 7 },
        saved: { input: 7 },
        availability: "partial",
    },
    {
        name: "agy output-only measured zero remains partial in the journal",
        backend: "agy-cli",
        result: JSON.stringify({ type: "result", result: "reply", usage: { output_tokens: 0 } }),
        runtime: { ...absent, outputTokens: 0 },
        saved: { output: 0 },
        availability: "partial",
    },
    {
        name: "Claude preserves reported tokens and total cost without inventing cost components",
        backend: "claude-cli",
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
        backend: "claude-cli",
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
        backend: "claude-cli",
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
        backend: "claude-cli",
        result: JSON.stringify({ type: "result", result: "reply", usage: { input_tokens: 3, output_tokens: 0 } }),
        runtime: { ...absent, inputTokens: 3, outputTokens: 0 },
        saved: { input: 3, output: 0 },
    },
    {
        name: "Claude omits usage when the CLI reports no measurements",
        backend: "claude-cli",
        result: JSON.stringify({ type: "result", result: "reply" }),
        runtime: absent,
    },
    {
        name: "agy preserves measured tokens without reporting cache or subscription cost",
        backend: "agy-cli",
        result: JSON.stringify({ type: "result", result: "reply", usage: { input_tokens: 7, output_tokens: 2 } }),
        runtime: { ...absent, inputTokens: 7, outputTokens: 2 },
        saved: { input: 7, output: 2 },
    },
    {
        name: "agy preserves measured zero tokens without reporting cache or subscription cost",
        backend: "agy-cli",
        result: JSON.stringify({ type: "result", result: "reply", usage: { input_tokens: 0, output_tokens: 0 } }),
        runtime: { ...absent, inputTokens: 0, outputTokens: 0 },
        saved: { input: 0, output: 0 },
    },
    {
        name: "agy omits usage when the CLI reports no measurements",
        backend: "agy-cli",
        result: JSON.stringify({ type: "result", result: "reply" }),
        runtime: absent,
    },
    {
        name: "agy native tool assistant entries carry no fabricated usage",
        backend: "agy-cli",
        nativeTool: true,
        result: JSON.stringify({ type: "result", result: "reply", usage: { input_tokens: 7, output_tokens: 2 } }),
        runtime: { ...absent, inputTokens: 7, outputTokens: 2 },
        saved: { input: 7, output: 2 },
    },
];

const claudeVendor = await Deno.readTextFile(
    new URL("./claude-cli/fixtures/claude-2.1.284-read-tool-stream.jsonl", import.meta.url),
);
const agyVendor = await Deno.readTextFile(new URL("./agy-cli/fixtures/agy-1.2.12-tool-stream.jsonl", import.meta.url));
const agyThinkingVendor = await Deno.readTextFile(
    new URL("./agy-cli/fixtures/agy-1.2.12-model-read-tool-stream.jsonl", import.meta.url),
);
fixtures.push({
    name: "Claude vendor tool stream stores cache-exclusive aggregate and unmeasured request alternatives",
    backend: "claude-cli",
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
        measurementAvailability: "complete",
    },
});
for (const modelId of ["gemini-3.8-flash", "gemini-3.1-pro"]) {
    fixtures.push({
        name: `agy vendor tool stream stores measured timing and exact catalog cost for ${modelId}`,
        backend: "agy-cli",
        result: "",
        vendorStream: agyVendor,
        modelId,
        runtime: { ...absent, inputTokens: 19529, outputTokens: 155, cacheReadTokens: 16511 },
        saved: { input: 19529, output: 155, cacheRead: 16511 },
        journal: {
            inputTokens: 19529,
            outputTokens: 155,
            cacheReadTokens: 16511,
            cacheWriteTokens: null,
            reasoningTokens: 0,
            costAmount: modelId === "gemini-3.8-flash"
                ? 19529 * 0.75 / 1_000_000 + 155 * 3.75 / 1_000_000 + 16511 * 0.075 / 1_000_000
                : null,
            costSource: modelId === "gemini-3.8-flash" ? "calculated" : "unavailable",
            measurementAvailability: "partial",
        },
    });
}
fixtures.push({
    name: "agy vendor thinking tokens remain a subset of unchanged output",
    backend: "agy-cli",
    result: "",
    vendorStream: agyThinkingVendor,
    runtime: { ...absent, inputTokens: 31817, outputTokens: 320, cacheReadTokens: 0 },
    saved: { input: 31817, output: 320, cacheRead: 0 },
    journal: {
        inputTokens: 31817,
        outputTokens: 320,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: 205 + 51,
        costAmount: 31817 * 0.75 / 1_000_000 + 320 * 3.75 / 1_000_000,
        costSource: "calculated",
        measurementAvailability: "partial",
    },
});

for (const fixture of fixtures) {
    Deno.test(`${fixture.name}, including saved replay`, async () => {
        await withCliFixture(fixture, async (root) => {
            const model = getModelRegistry().find(
                fixture.backend,
                fixture.modelId || (fixture.backend === "claude-cli" ? "sonnet" : "gemini-3.8-flash"),
            );
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
            const session = fixture.backend === "claude-cli"
                ? new ClaudeCliExecutionSession(options)
                : await AgyCliExecutionSession.create(options);
            try {
                const beforeTurn = Date.now();
                const messages = await session.runTurn({ userRequest: "hello" });
                const afterTurn = Date.now();
                assertEquals(observed, [fixture.runtime]);
                if (fixture.journal) {
                    const metrics = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n")
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
                    if (fixture.backend === "agy-cli") assert(Date.parse(turn.endedAt) < Date.parse(turn.ts));
                    for (const alternative of rows.filter((record) => record.aggregationBasis === "alternative")) {
                        assertEquals(alternative.inputCacheBasis, "excludes_cache");
                        assertEquals([alternative.startedAt, alternative.endedAt, alternative.reasoningTokens], [
                            null,
                            null,
                            null,
                        ]);
                    }
                    if (fixture.backend === "claude-cli") {
                        assertEquals(
                            rows.filter((record) => record.aggregationBasis === "alternative").map((
                                record,
                            ) => [
                                record.inputTokens,
                                record.outputTokens,
                                record.cacheReadTokens,
                                record.cacheWriteTokens,
                            ]),
                            [[2, 8, 1448, 2430], [2, 2, 3878, 3604], [null, null, null, null]],
                        );
                    }
                }
                if (fixture.availability) {
                    const metrics = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n").map((
                        line,
                    ) => JSON.parse(line));
                    const usage = metrics.find((record) => record.event === "model_usage");
                    assertEquals(usage?.measurementAvailability, fixture.availability);
                    assertEquals(usage?.inputTokens, fixture.runtime.inputTokens);
                    assertEquals(usage?.outputTokens, fixture.runtime.outputTokens);
                    const price = getExternalCliPriceModel(model);
                    assertAlmostEquals(
                        usage?.costAmount,
                        price
                            ? ((fixture.runtime.inputTokens ?? 0) * price.cost.input +
                                (fixture.runtime.outputTokens ?? 0) * price.cost.output) / 1_000_000
                            : 0,
                        1e-12,
                    );
                }
                if (fixture.alternatives) {
                    const metrics = (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n").map((
                        line,
                    ) => JSON.parse(line));
                    const observations = metrics.filter((record) => record.event === "model_usage");
                    assertEquals(observations.map((record) => [record.aggregationBasis, record.inputTokens]), [
                        ["alternative", 3],
                        ["turn", 10],
                        ["alternative", 7],
                    ]);
                    assertEquals(new Set(observations.map((record) => record.sourceId)).size, 3);
                }
                const reply = messages.at(-1);
                assert(reply?.role === "assistant");
                assertEquals(reply.usage, fixture.saved);
                assertEquals("usage" in reply, fixture.saved !== undefined);
                if (fixture.nativeTool) {
                    const tool = messages.find((message) =>
                        message.role === "assistant" && message.stopReason === "toolUse"
                    );
                    assert(tool);
                    assertEquals("usage" in tool, false);
                }
                const path = manager.getSessionFile();
                assert(path);
                const reloaded = SessionManager.open(path);
                const replayOptions = { ...options, sessionManager: reloaded };
                const replay = fixture.backend === "claude-cli"
                    ? new ClaudeCliExecutionSession(replayOptions)
                    : await AgyCliExecutionSession.create(replayOptions);
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
