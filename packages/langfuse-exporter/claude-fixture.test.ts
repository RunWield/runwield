import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../src/testing/process-global-lock.ts";
import { defineGitFixture, git } from "../../src/shared/git-test-fixture.ts";
import { getModelRegistry } from "../../src/shared/models/model-registry.ts";
import { setCustomSetting } from "../../src/shared/settings.js";
import { getWorkflowMetricsFilePath } from "../../src/shared/workflow/metrics.js";
import {
    buildMetricsExportObservation,
    isExportableMetric,
    type MetricsJournalRow,
} from "../../src/shared/workflow/metrics-export-record.ts";
import { HostedSession } from "../../src/shared/session/hosted-session.js";
import { createRootSessionManager } from "../../src/shared/session/root-session.js";
import { ClaudeCliExecutionSession } from "../../src/shared/session/backends/claude-cli/execution-session.ts";
import { deliver } from "./exporter.ts";
import { attributes, metadata, native, span, withServer } from "./test-fixture.ts";

const repository = defineGitFixture(async (root) => {
    await Deno.writeTextFile(join(root, "README.md"), "usage fixture\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
});

Deno.test("Claude fixture keeps local alternatives but exports one aggregate generation with exact totals", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await repository.checkout();
        const previousHome = Deno.env.get("HOME");
        const previousPath = Deno.env.get("PATH");
        try {
            const home = join(root, "home"), bin = join(root, "bin");
            await Deno.mkdir(home);
            await Deno.mkdir(bin);
            const stream = join(root, "stream.jsonl");
            await Deno.copyFile(
                new URL(
                    "../../src/shared/session/backends/claude-cli/fixtures/claude-2.1.284-read-tool-stream.jsonl",
                    import.meta.url,
                ),
                stream,
            );
            const script = join(bin, "fixture.js");
            await Deno.writeTextFile(
                script,
                `
await new Response(Deno.stdin.readable).text();
console.log(await Deno.readTextFile(${JSON.stringify(stream)}));
await new Promise((resolve) => setTimeout(resolve, 30));
`,
            );
            const executable = join(bin, "claude");
            await Deno.writeTextFile(executable, `#!/bin/sh\nexec deno run -A ${JSON.stringify(script)} "$@"\n`);
            await Deno.chmod(executable, 0o755);
            Deno.env.set("HOME", home);
            Deno.env.set("PATH", `${bin}:${previousPath || ""}`);
            await setCustomSetting("workflowMetrics", true, "project", root);
            const model = getModelRegistry().find("claude-cli", "sonnet");
            assert(model);
            const manager = await createRootSessionManager("new", root);
            const hostedSession = new HostedSession({ id: "usage-fixture", cwd: root, sessionManager: manager });
            const session = new ClaudeCliExecutionSession({
                cwd: root,
                agentName: "Guide",
                finalSystemPrompt: "Fixture system instructions",
                model,
                sessionManager: manager,
                hostedSession,
            });
            try {
                await session.runTurn({ userRequest: "hello" });
            } finally {
                await session.dispose();
            }
            const rows: MetricsJournalRow[] = (await Deno.readTextFile(getWorkflowMetricsFilePath(root)))
                .trim().split("\n").map((line) => JSON.parse(line));
            const localUsage = rows.filter((row) => row.event === "model_usage");
            assertEquals(
                localUsage.filter((row) => row.aggregationBasis === "alternative").map((row) => [
                    row.inputTokens,
                    row.outputTokens,
                    row.cacheReadTokens,
                    row.cacheWriteTokens,
                ]),
                [[2, 8, 1448, 2430], [2, 2, 3878, 3604], [null, null, null, null]],
            );
            const identity = { ownerRef: "owner", referenceKey: "ab".repeat(32) };
            await withServer(async ({ context, requests }) => {
                for (const row of rows.filter(isExportableMetric)) {
                    const observation = await buildMetricsExportObservation(row, root, identity);
                    assert(observation);
                    assertEquals((await deliver(observation, context)).outcome, "accepted");
                }
                const generations = requests.map(span).filter((s) =>
                    attributes(s)["langfuse.observation.type"] === "generation"
                );
                assertEquals(generations.length, 1);
                const generation = generations[0];
                assertEquals(metadata(generation).aggregationBasis, "turn");
                assertEquals(native(generation, "usage_details"), {
                    input: 4,
                    output: 507,
                    input_cache_read: 5326,
                    input_cache_creation: 6034,
                });
                assertEquals(native(generation, "cost_details"), { total: 0.0594932 });
            });
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", previousPath);
            await Deno.remove(root, { recursive: true });
        }
    });
});
