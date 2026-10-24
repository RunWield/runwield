import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { materializeFixture } from "./materialize.ts";
import { appendResult, latestResults, readRun } from "./records.ts";
import { runBenchmark, selectCases } from "./run.ts";
import { inspectionSteps } from "./test-fixtures.ts";

async function withSavedRun(action: (directory: string) => Promise<void>): Promise<void> {
    await withRuntimeCommandFixture("benchmark-records-", async (runtime) => {
        const selected = await selectCases("RV-D04/B");
        const project = await materializeFixture(selected[0].fixture, "B");
        try {
            runtime.setModelResponseFactories([
                ...inspectionSteps(project.diffText),
                () =>
                    fauxAssistantMessage(
                        fauxToolCall("review_complete", { approved: true, findings: [], advisories: [] }),
                    ),
            ]);
        } finally {
            await project.cleanup();
        }
        const run = await runBenchmark(selected, { out: join(runtime.projectRoot, "run") });
        await action(run.directory);
    });
}

test("append preserves history and latest results never select a better earlier attempt", async () => {
    await withSavedRun(async (directory) => {
        const saved = await readRun(directory);
        const previous = saved.results[0];
        const path = join(directory, "results.jsonl");
        await writeFile(path, (await readFile(path, "utf8")).trimEnd());
        const next = {
            ...previous,
            kind: "paused" as const,
            reason: "Interrupted",
            observedDecision: "unavailable" as const,
            attempt: 2,
            outcome: undefined,
        };
        await appendResult(directory, next);
        const read = await readRun(directory);
        assert.equal(read.results.length, 2);
        assert.equal(read.results[0].kind, "complete");
        assert.equal(latestResults(read).get(previous.caseId)!.kind, "paused");
    });
});

test("unreadable, truncated, mismatched and duplicate records never establish completed work", async () => {
    await withSavedRun(async (directory) => {
        const path = join(directory, "results.jsonl");
        const original = await readFile(path, "utf8");
        const run = await readRun(directory);
        const row = run.results[0];
        const invalid = [
            "{",
            original.slice(0, -10),
            JSON.stringify({ ...row, runId: "a-different-run" }),
            JSON.stringify({ ...row, caseId: "RV-D05/B" }),
            JSON.stringify({ ...row, attempt: 2 }),
            JSON.stringify({ ...row, observedDecision: "reject" }),
            JSON.stringify({ ...row, outcome: undefined }),
            original + original,
        ];
        for (const text of invalid) {
            await writeFile(path, text);
            await assert.rejects(readRun(directory));
            assert.equal(await readFile(path, "utf8"), text);
        }
        await unlink(path);
        await assert.rejects(readRun(directory), /ENOENT/);
        await writeFile(path, "");
        assert.equal(latestResults(await readRun(directory)).size, 0);
    });
});

test("a production finding with omitted evidence stays scoreable instead of being lost", async () => {
    await withSavedRun(async (directory) => {
        const saved = await readRun(directory);
        const result = saved.results[0];
        result.outcome = {
            outcome: "feedback",
            approved: false,
            feedback: "Unsupported observation",
            findings: [{ title: "Claim without a citation", evidence: "", requirement: "", resolved: false }],
            advisories: [],
        };
        result.observedDecision = "reject";
        await writeFile(join(directory, "results.jsonl"), JSON.stringify(result) + "\n");
        assert.equal((await readRun(directory)).results[0].outcome!.findings[0].evidence, "");
    });
});
