import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FixtureDefect } from "./fixtures.ts";
import type { BenchmarkCase, BenchmarkResult, SavedRun } from "./records.ts";
import { scoreRun } from "./score.ts";
import type { Adjudication, AdjudicationsFile, RunSummary } from "./score.ts";

type Finding = NonNullable<BenchmarkResult["outcome"]>["findings"][number];

function defect(defectId: string, severity: string): FixtureDefect {
    return {
        defectId,
        severity,
        category: "correctness",
        trigger: "Two callers share state",
        expectedBehavior: "Keep callers separate",
        wrongBehavior: "Return another caller's state",
        evidence: ["src/cache.ts"],
        acceptableConcepts: ["isolation"],
        proofCommand: "bun run test:oracle isolation",
        expectedFailureMarker: "RV-ISOLATION",
    };
}
function finding(title: string, evidence = "src/cache.ts:12 leaks a caller's cache"): Finding {
    return { title, evidence, requirement: "Isolate callers", resolved: false };
}
function result(
    entry: BenchmarkCase,
    findings: Finding[] = [],
    approved = entry.expectedDecision === "approve",
): BenchmarkResult {
    return {
        runId: "fixed-run",
        caseId: entry.caseId,
        scenarioId: entry.scenarioId,
        variant: entry.variant,
        fixtureRevision: entry.fixtureRevision,
        trial: 1,
        attempt: 1,
        recordedAt: "2026-10-19T12:00:00Z",
        expectedDecision: entry.expectedDecision,
        observedDecision: approved ? "approve" : "reject",
        configuration: configuration(),
        kind: "complete",
        outcome: {
            outcome: approved ? "approved" : "feedback",
            approved,
            feedback: "Accepted review feedback",
            findings,
            advisories: [{ title: "Naming suggestion", detail: "Non-blocking exact advisory." }],
        },
        model: "actual-model",
        provider: "actual-provider",
        tokens: { input: 10, output: 3, cacheRead: "unavailable", cacheWrite: 0 },
        toolCallCount: "unavailable",
        elapsedMs: 15,
        nudgeAttempts: 2,
    };
}
function configuration(): SavedRun["manifest"]["configuration"] {
    return {
        revision: "fixture-revision",
        dirty: true,
        promptHashes: { "reviewer-prompt.md": "a".repeat(64), "shared-practice/review-practice.md": "b".repeat(64) },
        model: "selected-model",
        provider: "selected-provider",
        bunVersion: "1.4.3",
    };
}
function corpus(): SavedRun {
    const specs = [
        ["RV-D04", "correctness-beyond-plan"],
        ["RV-D05", "plan-named-edge-case"],
        ["RV-D12", "architecture"],
        ["RV-D13", "plan-adherence"],
        ["RV-M01", "multiple-defects"],
    ];
    const cases: BenchmarkCase[] = specs.flatMap(([scenarioId, group]) =>
        (scenarioId === "RV-M01" ? ["A" as const] : ["A" as const, "B" as const]).map((variant) => ({
            caseId: `${scenarioId}/${variant}`,
            scenarioId,
            variant,
            fixtureRevision: 1,
            fixtureHash: "c".repeat(64),
            trial: 1,
            expectedDecision: variant === "A" ? "reject" : "approve",
            group,
            defects:
                variant === "B"
                    ? []
                    : scenarioId === "RV-M01"
                      ? [defect("multi-high", "high"), defect("multi-medium", "medium")]
                      : [
                            defect(
                                scenarioId,
                                { "RV-D04": "high", "RV-D05": "critical", "RV-D12": "medium", "RV-D13": "low" }[
                                    scenarioId
                                ]!,
                            ),
                        ],
        })),
    );
    const results = cases.filter((entry) => entry.caseId !== "RV-D12/A").map((entry) => result(entry));
    const byId = (id: string) => results.find((entry) => entry.caseId === id)!;
    byId("RV-D04/A").outcome!.findings = [finding("Primary exact title"), finding("Duplicate"), finding("Unsupported")];
    byId("RV-M01/A").outcome!.findings = [finding("Second independent defect")];
    byId("RV-D13/A").outcome!.approved = true;
    byId("RV-D13/A").outcome!.outcome = "approved";
    byId("RV-D13/A").observedDecision = "approve";
    byId("RV-D05/B").outcome!.approved = false;
    byId("RV-D05/B").outcome!.outcome = "feedback";
    byId("RV-D05/B").outcome!.findings = [finding("Clean false positive", "src/clean.ts:3")];
    byId("RV-D05/B").observedDecision = "reject";
    for (const [id, kind, reason] of [
        ["RV-D05/A", "timeout", "Reviewer exceeded deadline"],
        ["RV-D12/B", "paused", "Reviewer paused without completion"],
        ["RV-D13/B", "failed", "Provider disconnected"],
    ] as const) {
        const row = byId(id);
        row.kind = kind;
        row.reason = reason;
        row.observedDecision = "unavailable";
        delete row.outcome;
    }
    return {
        manifest: {
            schemaVersion: 1,
            runId: "fixed-run",
            createdAt: "2026-10-19T12:00:00Z",
            configuration: configuration(),
            cases,
        },
        results,
    };
}
function labels(): AdjudicationsFile {
    return {
        schemaVersion: 1,
        runId: "fixed-run",
        oracleVerdicts: corpus().manifest.cases.map(({ caseId }) => ({ caseId, verdict: "confirmed" })),
        adjudications: [
            { caseId: "RV-D04/A", attempt: 1, findingIndex: 0, state: "matched", defectId: "RV-D04" },
            { caseId: "RV-D04/A", attempt: 1, findingIndex: 1, state: "duplicate", defectId: "RV-D04" },
            { caseId: "RV-D04/A", attempt: 1, findingIndex: 2, state: "unsupported" },
            { caseId: "RV-M01/A", attempt: 1, findingIndex: 0, state: "matched", defectId: "multi-medium" },
            { caseId: "RV-D05/B", attempt: 1, findingIndex: 0, state: "unsupported" },
        ],
    };
}
async function withRun(
    run: SavedRun,
    action: (directory: string) => Promise<void>,
    adjudications?: AdjudicationsFile,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "reviewer-score-"));
    try {
        await writeFile(join(directory, "run.json"), JSON.stringify(run.manifest));
        await writeFile(join(directory, "results.jsonl"), run.results.map((entry) => JSON.stringify(entry)).join("\n"));
        if (adjudications) await writeFile(join(directory, "adjudications.json"), JSON.stringify(adjudications));
        await action(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("all nine cases determine total, variant, group, and clean approval denominators", async () => {
    const run = corpus();
    // The manifest group is authoritative, not the scenario lookup table.
    run.manifest.cases
        .filter((entry) => entry.scenarioId === "RV-D13")
        .forEach((entry) => {
            entry.group = "cross-file-context";
        });
    await withRun(run, async (directory) => {
        const summary = await scoreRun(directory);
        assert.deepEqual(summary.decisionAccuracy, { numerator: 3, denominator: 9, value: 1 / 3 });
        assert.deepEqual(summary.cleanApproval, { numerator: 1, denominator: 4, value: 1 / 4 });
        assert.deepEqual(summary.variants, {
            A: {
                decisionAccuracy: { numerator: 2, denominator: 5, value: 2 / 5 },
                cleanApproval: { numerator: 0, denominator: 0, value: null },
            },
            B: {
                decisionAccuracy: { numerator: 1, denominator: 4, value: 1 / 4 },
                cleanApproval: { numerator: 1, denominator: 4, value: 1 / 4 },
            },
        });
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(summary.groups).map(([group, scores]) => [group, scores.decisionAccuracy]),
            ),
            {
                "correctness-beyond-plan": { numerator: 2, denominator: 2, value: 1 },
                "plan-named-edge-case": { numerator: 0, denominator: 2, value: 0 },
                architecture: { numerator: 0, denominator: 2, value: 0 },
                "cross-file-context": { numerator: 0, denominator: 2, value: 0 },
                "multiple-defects": { numerator: 1, denominator: 1, value: 1 },
            },
        );
        assert.deepEqual(
            summary.cases.map((entry) => [entry.caseId, entry.decisionCorrect]),
            [
                ["RV-D04/A", true],
                ["RV-D04/B", true],
                ["RV-D05/A", false],
                ["RV-D05/B", false],
                ["RV-D12/A", false],
                ["RV-D12/B", false],
                ["RV-D13/A", false],
                ["RV-D13/B", false],
                ["RV-M01/A", true],
            ],
        );
    });
});

test("group semantic scores retain failed cases and count only adjudicated findings", async () => {
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            const correctness = summary.groups["correctness-beyond-plan"].semantic;
            assert.deepEqual(correctness.recall, { numerator: 1, denominator: 1, value: 1 });
            assert.deepEqual(correctness.severeRecall, { numerator: 1, denominator: 1, value: 1 });
            assert.deepEqual(correctness.precision, { numerator: 1, denominator: 3, value: 1 / 3 });
            const namedEdge = summary.groups["plan-named-edge-case"].semantic;
            assert.deepEqual(namedEdge.recall, { numerator: 0, denominator: 1, value: 0 });
            assert.deepEqual(namedEdge.severeRecall, { numerator: 0, denominator: 1, value: 0 });
            assert.deepEqual(namedEdge.precision, { numerator: 0, denominator: 1, value: 0 });
            const architecture = summary.groups.architecture.semantic;
            assert.deepEqual(architecture.recall, { numerator: 0, denominator: 1, value: 0 });
            assert.deepEqual(architecture.precision, { numerator: 0, denominator: 0, value: null });
        },
        labels(),
    );
});

test("complete labels give exact recall, severe recall and precision with duplicate and unsupported false positives", async () => {
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.deepEqual(summary.semantic, {
                status: "scored",
                adjudicationsPresent: true,
                labels: {
                    matched: 2,
                    duplicate: 1,
                    unsupported: 2,
                    novel_valid: 0,
                    labeled: 5,
                    unlabeled: 0,
                    falsePositives: 3,
                },
                oracleDefects: 6,
                severeOracleDefects: 3,
                blockingFindings: 5,
                recall: { numerator: 2, denominator: 6, value: 1 / 3 },
                severeRecall: { numerator: 1, denominator: 3, value: 1 / 3 },
                precision: { numerator: 2, denominator: 5, value: 2 / 5 },
            });
        },
        labels(),
    );
});

test("path-only suggestions never earn recall and absent labels leave semantic scores pending", async () => {
    await withRun(corpus(), async (directory) => {
        const summary = await scoreRun(directory);
        assert.deepEqual(summary.cases[0].findings[0].suggestedEvidencePathDefectIds, ["RV-D04"]);
        assert.equal(summary.cases[0].findings[0].adjudication, null);
        assert.equal(summary.semantic.status, "pending adjudication");
        assert.equal(summary.semantic.adjudicationsPresent, false);
        assert.equal(summary.semantic.labels.labeled, 0);
        assert.equal(summary.semantic.labels.unlabeled, 5);
        assert.equal(summary.semantic.recall, null);
        assert.equal(summary.semantic.severeRecall, null);
        assert.equal(summary.semantic.precision, null);
    });
});

test("partial labels report counts, not inferred semantic scores", async () => {
    const file = labels();
    file.adjudications = file.adjudications.slice(0, 1);
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.equal(summary.semantic.status, "pending adjudication");
            assert.equal(summary.semantic.adjudicationsPresent, true);
            assert.deepEqual(summary.semantic.labels, {
                matched: 1,
                duplicate: 0,
                unsupported: 0,
                novel_valid: 0,
                labeled: 1,
                unlabeled: 4,
                falsePositives: 0,
            });
            assert.equal(summary.semantic.recall, null);
            assert.equal(summary.semantic.precision, null);
            assert.equal(summary.semantic.severeRecall, null);
        },
        file,
    );
});

test("missing, paused, failed, and timed-out cases retain causes and full oracle denominators", async () => {
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.deepEqual(
                summary.cases
                    .filter((entry) => entry.status !== "complete")
                    .map((entry) => [entry.caseId, entry.status, entry.cause, entry.decisionCorrect]),
                [
                    ["RV-D05/A", "timeout", "Reviewer exceeded deadline", false],
                    ["RV-D12/A", "missing", "No saved result", false],
                    ["RV-D12/B", "paused", "Reviewer paused without completion", false],
                    ["RV-D13/B", "failed", "Provider disconnected", false],
                ],
            );
            assert.equal(summary.semantic.oracleDefects, 6);
            assert.equal(summary.semantic.severeOracleDefects, 3);
            assert.equal(summary.decisionAccuracy.denominator, 9);
        },
        labels(),
    );
});

test("the latest attempt wins even when it replaces a correct decision with a timeout", async () => {
    const run = corpus();
    const earlier = run.results[0];
    const latest: BenchmarkResult = {
        ...earlier,
        attempt: 2,
        kind: "timeout",
        observedDecision: "unavailable",
        reason: "Second attempt timed out",
    };
    delete latest.outcome;
    run.results.push(latest);
    await withRun(run, async (directory) => {
        const summary = await scoreRun(directory);
        assert.deepEqual(summary.decisionAccuracy, { numerator: 2, denominator: 9, value: 2 / 9 });
        assert.equal(summary.cases[0].result?.attempt, 2);
        assert.equal(summary.cases[0].status, "timeout");
        assert.deepEqual(summary.cases[0].findings, []);
        assert.equal(summary.semantic.blockingFindings, 2);
    });
});

test("bad fixtures and novel valid findings leave every score while unaffected cases score", async () => {
    const file = labels();
    file.oracleVerdicts = file.oracleVerdicts!.filter((entry) => entry.caseId !== "RV-D04/A");
    file.oracleVerdicts!.find((entry) => entry.caseId === "RV-D05/B")!.verdict = "fixture_needs_repair";
    file.oracleVerdicts!.find((entry) => entry.caseId === "RV-D05/B")!.note = "The clean twin has a real defect";
    file.adjudications[2].state = "novel_valid";
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.deepEqual(summary.fixturesNeedingRepair, [
                { caseId: "RV-D04/A", reasons: ["novel_valid findings: 2"] },
                { caseId: "RV-D05/B", reasons: ["The clean twin has a real defect"] },
            ]);
            assert.equal(summary.semantic.status, "scored");
            assert.deepEqual(summary.decisionAccuracy, { numerator: 2, denominator: 7, value: 2 / 7 });
            assert.deepEqual(summary.cleanApproval, { numerator: 1, denominator: 3, value: 1 / 3 });
            assert.deepEqual(summary.semantic.recall, { numerator: 1, denominator: 5, value: 1 / 5 });
            assert.deepEqual(summary.semantic.severeRecall, { numerator: 0, denominator: 2, value: 0 });
            assert.deepEqual(summary.semantic.precision, { numerator: 1, denominator: 1, value: 1 });
            assert.equal(summary.variants.A.decisionAccuracy.denominator, 4);
            assert.equal(summary.variants.B.cleanApproval.denominator, 3);
            assert.equal(summary.groups["correctness-beyond-plan"].decisionAccuracy.denominator, 1);
            assert.equal(summary.groups["correctness-beyond-plan"].semantic.oracleDefects, 0);
            assert.equal(summary.groups["plan-named-edge-case"].cleanApproval.denominator, 0);
            assert.equal(summary.cases.length, 9);
            const report = await readFile(join(directory, "summary.md"), "utf8");
            assert.match(report, /## Fixtures needing repair\n\n- RV-D04\/A: novel_valid findings: 2/);
            assert.ok(report.includes("RV-D05/B: The clean twin has a real defect"));
            assert.equal(report.includes("oracle correction required"), false);
        },
        file,
    );
});

test("zero denominators are null, never perfect scores", async () => {
    const run = corpus();
    run.manifest.cases = [run.manifest.cases[1]];
    run.results = [run.results[1]];
    await withRun(
        run,
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.equal(summary.semantic.status, "scored");
            for (const metric of [summary.semantic.recall, summary.semantic.severeRecall, summary.semantic.precision]) {
                assert.deepEqual(metric, { numerator: 0, denominator: 0, value: null });
            }
        },
        {
            schemaVersion: 1,
            runId: "fixed-run",
            adjudications: [],
            oracleVerdicts: [{ caseId: "RV-D04/B", verdict: "confirmed" }],
        },
    );
});

test("reports preserve identity, accepted decisions, exact evidence/advisories, usage and stable finding references", async () => {
    const run = corpus();
    await withRun(
        run,
        async (directory) => {
            const summary = await scoreRun(directory);
            const saved = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")) as RunSummary;
            assert.deepEqual(saved, summary);
            assert.deepEqual(saved.configuration, run.manifest.configuration);
            assert.deepEqual(saved.cases[0].result, run.results[0]);
            assert.deepEqual(saved.cases[0].findings[0], {
                caseId: "RV-D04/A",
                attempt: 1,
                findingIndex: 0,
                finding: run.results[0].outcome!.findings[0],
                suggestedEvidencePathDefectIds: ["RV-D04"],
                adjudication: labels().adjudications[0],
            });
            const report = await readFile(join(directory, "summary.md"), "utf8");
            for (const text of [
                "3/9",
                "1/4",
                "2/6",
                "2/5",
                "1/3",
                "suggestions only",
                "cannot establish stability",
                "actual-model",
                "actual-provider",
                "selected-model",
                "selected-provider",
                "unavailable",
                "Primary exact title",
                "Non-blocking exact advisory.",
                "Reviewer exceeded deadline",
                "No saved result",
                "nudgeAttempts",
                "promptHashes",
                "fixture-revision",
                "Package: evals/reviewer/RV-D04/",
                "Patch: evals/reviewer/RV-D04/variants/defective.patch",
                "#### Oracle defect RV-D04 (high)",
                "Trigger: Two callers share state",
                "Expected behavior: Keep callers separate",
                "Wrong behavior: Return another caller's state",
                "Proof: bun run test:oracle isolation",
                "Oracle: no defect",
                "#### Blocking finding 0: Primary exact title",
                "Suggested path matches: RV-D04",
                "Label: matched (RV-D04)",
                "Oracle verdict: confirmed",
            ]) {
                assert.ok(report.includes(text), `report must include ${text}`);
            }
        },
        labels(),
    );
});

test("duplicate labels may precede their matched primary", async () => {
    const file = labels();
    file.adjudications.reverse();
    await withRun(
        corpus(),
        async (directory) => {
            assert.equal((await scoreRun(directory)).semantic.status, "scored");
        },
        file,
    );
});

interface InvalidLabelCase {
    name: string;
    change: Partial<Adjudication>;
}
for (const { name, change } of [
    { name: "unlisted case", change: { caseId: "RV-D99/A" } },
    { name: "non-integer attempt", change: { attempt: 1.5 } },
    { name: "unlisted attempt", change: { attempt: 2 } },
    { name: "negative index", change: { findingIndex: -1 } },
    { name: "non-integer index", change: { findingIndex: 0.5 } },
    { name: "unlisted index", change: { findingIndex: 99 } },
    { name: "advisory index", change: { caseId: "RV-D04/B", findingIndex: 0 } },
    { name: "failed case", change: { caseId: "RV-D13/B" } },
    { name: "timeout case", change: { caseId: "RV-D05/A" } },
    { name: "paused case", change: { caseId: "RV-D12/B" } },
    { name: "missing case result", change: { caseId: "RV-D12/A" } },
    { name: "missing matched defect", change: { defectId: undefined } },
    { name: "nonexistent defect", change: { defectId: "absent-defect" } },
    { name: "defect from another case", change: { defectId: "multi-medium" } },
    { name: "empty defect", change: { defectId: "" } },
] satisfies InvalidLabelCase[]) {
    test(`rejects adjudication with ${name}`, async () => {
        const file = labels();
        file.adjudications = [{ ...file.adjudications[0], ...change }];
        await withRun(
            corpus(),
            async (directory) => {
                await assert.rejects(scoreRun(directory), /Invalid adjudications:/);
            },
            file,
        );
    });
}

for (const [name, contents] of [
    ["wrong run", JSON.stringify({ ...labels(), runId: "another-run" })],
    ["wrong schema", JSON.stringify({ ...labels(), schemaVersion: 2 })],
    [
        "invalid state",
        JSON.stringify({ ...labels(), adjudications: [labels().adjudications[0]] }).replace(
            '"state":"matched"',
            '"state":"accepted"',
        ),
    ],
    [
        "invalid defect type",
        JSON.stringify({ ...labels(), adjudications: [labels().adjudications[0]] }).replace(
            '"defectId":"RV-D04"',
            '"defectId":42',
        ),
    ],
    ["null envelope", "null"],
    ["null label", JSON.stringify({ ...labels(), adjudications: [null] })],
    ["missing label array", JSON.stringify({ schemaVersion: 1, runId: "fixed-run" })],
    ["malformed JSON", "{"],
]) {
    test(`rejects ${name} instead of producing semantic scores`, async () => {
        await withRun(corpus(), async (directory) => {
            await writeFile(join(directory, "adjudications.json"), contents);
            await assert.rejects(scoreRun(directory));
        });
    });
}

test("rejects duplicate finding references", async () => {
    const file = labels();
    file.adjudications.push({ ...file.adjudications[0] });
    await withRun(
        corpus(),
        async (directory) => {
            await assert.rejects(scoreRun(directory), /duplicate reference/);
        },
        file,
    );
});

test("rejects two matched findings for the same case defect", async () => {
    const file = labels();
    file.adjudications[1].state = "matched";
    await withRun(
        corpus(),
        async (directory) => {
            await assert.rejects(scoreRun(directory), /already matched; use duplicate/);
        },
        file,
    );
});

test("rejects duplicates without a matched primary in the same case and defect", async () => {
    const file = labels();
    file.adjudications[0] = { ...file.adjudications[0], state: "unsupported" };
    await withRun(
        corpus(),
        async (directory) => {
            await assert.rejects(scoreRun(directory), /duplicate requires matched primary/);
        },
        file,
    );
});

test("rejects stale labels from an earlier completed attempt", async () => {
    const run = corpus();
    run.results.push({ ...run.results[0], attempt: 2 });
    await withRun(
        run,
        async (directory) => {
            await assert.rejects(scoreRun(directory), /latest completed attempt/);
        },
        labels(),
    );
});

test("new labels use the latest attempt in each stable reference", async () => {
    const run = corpus();
    run.results.push({ ...run.results[0], attempt: 2 });
    const file = labels();
    file.adjudications
        .filter((label) => label.caseId === "RV-D04/A")
        .forEach((label) => {
            label.attempt = 2;
        });
    await withRun(
        run,
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.deepEqual(
                summary.cases[0].findings.map((entry) => entry.attempt),
                [2, 2, 2],
            );
            assert.deepEqual(summary.semantic.precision, { numerator: 2, denominator: 5, value: 2 / 5 });
        },
        file,
    );
});

test("legacy smoke run and labels without oracle verdicts remain readable and pending", async () => {
    const file = labels();
    delete file.oracleVerdicts;
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.equal(summary.semantic.status, "pending adjudication");
            assert.equal(summary.semantic.labels.unlabeled, 0);
            assert.equal(summary.semantic.recall, null);
            assert.equal(summary.decisionAccuracy.denominator, 9);
        },
        file,
    );
});

test("one missing case verdict keeps semantic scores pending even with all finding labels", async () => {
    const file = labels();
    file.oracleVerdicts = file.oracleVerdicts!.filter((entry) => entry.caseId !== "RV-D04/B");
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.equal(summary.semantic.status, "pending adjudication");
            assert.equal(summary.semantic.labels.unlabeled, 0);
            assert.equal(summary.semantic.precision, null);
            assert.equal(summary.groups["multiple-defects"].semantic.status, "scored");
        },
        file,
    );
});

test("all cases can be excluded without manufacturing perfect scores", async () => {
    const file = labels();
    file.oracleVerdicts!.forEach((entry) => {
        entry.verdict = "fixture_needs_repair";
    });
    file.adjudications = [];
    await withRun(
        corpus(),
        async (directory) => {
            const summary = await scoreRun(directory);
            assert.equal(summary.fixturesNeedingRepair.length, 9);
            assert.equal(summary.semantic.status, "scored");
            for (const metric of [
                summary.decisionAccuracy,
                summary.cleanApproval,
                summary.semantic.recall,
                summary.semantic.severeRecall,
                summary.semantic.precision,
            ])
                assert.deepEqual(metric, { numerator: 0, denominator: 0, value: null });
        },
        file,
    );
});

test("worksheet uses the snapshotted patch path rather than assuming a filename", async () => {
    const run = corpus();
    run.manifest.cases[0].patch = "variants/change-a.patch";
    await withRun(run, async (directory) => {
        await scoreRun(directory);
        const report = await readFile(join(directory, "summary.md"), "utf8");
        assert.ok(report.includes("Patch: evals/reviewer/RV-D04/variants/change-a.patch"));
    });
});

for (const [name, oracleVerdicts] of [
    ["unknown case", [{ caseId: "RV-D99/A", verdict: "confirmed" }]],
    [
        "duplicate case",
        [
            { caseId: "RV-D04/A", verdict: "confirmed" },
            { caseId: "RV-D04/A", verdict: "confirmed" },
        ],
    ],
    ["unknown verdict", [{ caseId: "RV-D04/A", verdict: "valid" }]],
    ["null verdict", [null]],
    ["invalid note", [{ caseId: "RV-D04/A", verdict: "confirmed", note: 42 }]],
    ["null list", null],
    ["non-list", {}],
] as const) {
    test(`rejects oracle verdicts with ${name}`, async () => {
        await withRun(corpus(), async (directory) => {
            await writeFile(join(directory, "adjudications.json"), JSON.stringify({ ...labels(), oracleVerdicts }));
            await assert.rejects(scoreRun(directory), /Invalid adjudications:/);
        });
    });
}

test("confirmed oracle cannot coexist with a novel_valid finding", async () => {
    const file = labels();
    file.adjudications[2].state = "novel_valid";
    await withRun(
        corpus(),
        async (directory) => {
            await assert.rejects(scoreRun(directory), /confirmed oracle has novel_valid findings for RV-D04\/A/);
        },
        file,
    );
});
