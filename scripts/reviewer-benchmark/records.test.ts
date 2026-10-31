import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { materializeFixture } from "./materialize.ts";
import { FIXTURE_GROUPS } from "./fixtures.ts";
import type { BenchmarkCase, RunManifest } from "./records.ts";
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

async function withManifestCase(entry: BenchmarkCase, action: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "benchmark-manifest-"));
    const manifest: RunManifest = {
        schemaVersion: 1,
        runId: "saved-october-run",
        createdAt: "2026-10-13T00:00:00.000Z",
        configuration: {
            revision: "1".repeat(40),
            dirty: false,
            promptHashes: { reviewer: "2".repeat(64), verify: "3".repeat(64) },
            model: "saved-model",
            provider: "saved-provider",
            bunVersion: "1.4.3",
        },
        cases: [entry],
    };
    try {
        await writeFile(join(directory, "run.json"), JSON.stringify(manifest));
        await writeFile(join(directory, "results.jsonl"), "");
        await action(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const savedCase: BenchmarkCase = {
    caseId: "RV-D04/B",
    scenarioId: "RV-D04",
    variant: "B",
    fixtureRevision: 2,
    fixtureHash: "4".repeat(64),
    trial: 1,
    expectedDecision: "approve",
    group: "correctness-beyond-plan",
    defects: [],
};

for (const group of FIXTURE_GROUPS) {
    test(`saved runs accept allowed group ${group} without an ID registry or corpus package`, async () => {
        const entry = { ...savedCase, caseId: "RV-D99/B", scenarioId: "RV-D99", group };
        await withManifestCase(entry, async (directory) => {
            assert.deepEqual((await readRun(directory)).manifest.cases, [entry]);
        });
    });
}

for (const [scenarioId, group] of [
    ["RV-D04", "correctness-beyond-plan"],
    ["RV-D05", "plan-named-edge-case"],
    ["RV-D12", "architecture"],
    ["RV-D13", "plan-adherence"],
    ["RV-M01", "multiple-defects"],
]) {
    test(`the October saved-run format still loads ${scenarioId}`, async () => {
        const variant = scenarioId === "RV-M01" ? "A" : "B";
        const entry: BenchmarkCase = {
            ...savedCase,
            caseId: `${scenarioId}/${variant}`,
            scenarioId,
            variant,
            group,
            expectedDecision: variant === "A" ? "reject" : "approve",
            defects:
                variant === "A"
                    ? [
                          {
                              defectId: "RV-M01-A",
                              severity: "medium",
                              category: "correctness",
                              trigger: "Explicit false",
                              expectedBehavior: "Keep false",
                              wrongBehavior: "Default replaces false",
                              evidence: ["src/config.ts"],
                              acceptableConcepts: ["absence-aware default"],
                              proofCommand: "bun run test:oracle explicit-false",
                              expectedFailureMarker: "RV-M01-EXPLICIT-FALSE",
                          },
                      ]
                    : [],
        };
        await withManifestCase(entry, async (directory) => {
            assert.deepEqual((await readRun(directory)).manifest.cases, [entry]);
        });
    });
}

for (const group of ["", "custom-plan-group"]) {
    test(`saved runs reject invalid group ${JSON.stringify(group)}`, async () => {
        await withManifestCase({ ...savedCase, group }, async (directory) => {
            await assert.rejects(readRun(directory), /case identity/);
        });
    });
}

for (const scenarioId of ["RV-D4", "RV-D004", "RV-X01", "../RV-D04"]) {
    test(`saved runs reject malformed scenario ID ${scenarioId}`, async () => {
        const entry = { ...savedCase, scenarioId, caseId: `${scenarioId}/B` };
        await withManifestCase(entry, async (directory) => {
            await assert.rejects(readRun(directory), /case identity/);
        });
    });
}

for (const patch of ["", 42]) {
    test(`saved runs reject invalid patch snapshot ${JSON.stringify(patch)}`, async () => {
        await withManifestCase(savedCase, async (directory) => {
            const path = join(directory, "run.json");
            const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
            await writeFile(path, JSON.stringify({ ...manifest, cases: [{ ...savedCase, patch }] }));
            await assert.rejects(readRun(directory), /case identity/);
        });
    });
}
