import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, writeFile, access, cp, mkdir, symlink, unlink } from "node:fs/promises";
import { load, JSON_SCHEMA } from "js-yaml";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../src/cmd/testing/runtime-command-fixture.ts";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";
import { openNativeFileLock } from "../../src/shared/native-file-lock.ts";
import type { FixtureOracle } from "./fixtures.ts";
import { checkoutRoot } from "./configuration.ts";
import { loadFixture } from "./fixtures.ts";
import { materializeFixture } from "./materialize.ts";
import { latestResults, readRun } from "./records.ts";
import { runBenchmark, selectCases } from "./run.ts";
import type { SelectedCase } from "./run.ts";
import { scoreRun } from "./score.ts";
import { corpusPath, inspectionSteps, withFixtureCopy } from "./test-fixtures.ts";

const finding = {
    title: "Cache escapes its project",
    requirement: "Project isolation",
    evidence: "src/browser.ts: shared key omits project scope",
    resolved: false,
    status: "new" as const,
    rejectionReason: "",
};
const advisory = { title: "Cache lifetime", detail: "State its lifetime in the public contract." };

async function responses(entry: SelectedCase): Promise<FauxResponseFactory[]> {
    const project = await materializeFixture(entry.fixture, entry.variant);
    try {
        return [
            ...inspectionSteps(project.diffText),
            () =>
                fauxAssistantMessage(
                    fauxToolCall("review_complete", {
                        approved: entry.variant === "B",
                        feedback: "",
                        findings: entry.variant === "A" ? [finding] : [],
                        advisories: [advisory],
                    }),
                ),
        ];
    } finally {
        await project.cleanup();
    }
}

test("selection expands the nine smoke cases and accepts explicit subsets", async () => {
    assert.deepEqual(
        (await selectCases()).map((entry) => `${entry.fixture.manifest.scenarioId}/${entry.variant}`),
        ["RV-D04/A", "RV-D04/B", "RV-D05/A", "RV-D05/B", "RV-D12/A", "RV-D12/B", "RV-D13/A", "RV-D13/B", "RV-M01/A"],
    );
    assert.deepEqual(
        (await selectCases("RV-D05/B,RV-M01")).map((entry) => entry.variant),
        ["B", "A"],
    );
});
test("all selects every package and oracle variant in scenario and variant order", async () => {
    const expected: string[] = [];
    for (const entry of (await readdir(corpusPath, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
    )) {
        if (!entry.isDirectory() || !(await readdir(join(corpusPath, entry.name))).includes("scenario.yaml")) continue;
        const oracle = load(await readFile(join(corpusPath, entry.name, "evaluation/oracle.yaml"), "utf8"), {
            schema: JSON_SCHEMA,
        }) as FixtureOracle;
        for (const variant of Object.keys(oracle.variants).sort()) expected.push(`${entry.name}/${variant}`);
    }
    assert.deepEqual(
        (await selectCases("all")).map((entry) => `${entry.fixture.manifest.scenarioId}/${entry.variant}`),
        expected,
    );
});

test("directory discovery admits an extra package for all and explicit selection but keeps smoke fixed", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        const root = resolve(packageDir, "../..");
        const corpus = join(root, "evals/reviewer");
        await cp(join(packageDir, ".."), corpus, { recursive: true });
        await cp(packageDir, join(corpus, "RV-D97"), { recursive: true });
        for (const file of ["scenario.yaml", "evaluation/oracle.yaml"]) {
            const path = join(corpus, "RV-D97", file);
            await writeFile(path, (await readFile(path, "utf8")).replace("scenarioId: RV-D04", "scenarioId: RV-D97"));
        }
        // The discovery order must not depend on the variant keys' order in YAML.
        const oraclePath = join(corpus, "RV-D97/evaluation/oracle.yaml");
        const oracle = load(await readFile(oraclePath, "utf8"), { schema: JSON_SCHEMA }) as FixtureOracle;
        oracle.variants = { B: oracle.variants.B, A: oracle.variants.A };
        await writeFile(oraclePath, JSON.stringify(oracle));
        await mkdir(join(corpus, "RV-D98"));
        await cp(join(checkoutRoot, "scripts/reviewer-benchmark"), join(root, "scripts/reviewer-benchmark"), {
            recursive: true,
        });
        await symlink(join(checkoutRoot, "src"), join(root, "src"), "dir");
        await symlink(join(checkoutRoot, "node_modules"), join(root, "node_modules"), "dir");
        const result = await captureForegroundProcess("bun", {
            cwd: root,
            args: [
                "-e",
                `import { selectCases } from "./scripts/reviewer-benchmark/run.ts";
                const selections = {};
                for (const name of ["all", "smoke", "RV-D97/B", "RV-D97"])
                    selections[name] = (await selectCases(name)).map(({ fixture, variant }) => fixture.manifest.scenarioId + "/" + variant);
                console.log(JSON.stringify(selections));`,
            ],
            timeoutMs: 30000,
        });
        assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
        const selections = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, string[]>;
        const smoke = [
            "RV-D04/A",
            "RV-D04/B",
            "RV-D05/A",
            "RV-D05/B",
            "RV-D12/A",
            "RV-D12/B",
            "RV-D13/A",
            "RV-D13/B",
            "RV-M01/A",
        ];
        const existing = (await selectCases("all")).map(
            ({ fixture, variant }) => `${fixture.manifest.scenarioId}/${variant}`,
        );
        assert.deepEqual(selections.all, [...existing, "RV-D97/A", "RV-D97/B"].sort());
        assert.deepEqual(selections.smoke, smoke);
        assert.deepEqual(selections["RV-D97/B"], ["RV-D97/B"]);
        assert.deepEqual(selections["RV-D97"], ["RV-D97/A", "RV-D97/B"]);
    });
});

for (const selection of ["RV-D99", "RV-D99/A", "RV-M01/B", "RV-D04/C", "RV-D04/A/extra", "RV-D04,RV-D04/A", ""]) {
    test(`reject invalid selection ${JSON.stringify(selection)} before spending`, async () => {
        await assert.rejects(selectCases(selection), /Unknown|missing variant|Duplicate/);
    });
}

test("a batch saves exact production findings and actual configuration, then refuses an accidental overwrite", async () => {
    await withRuntimeCommandFixture("benchmark-batch-", async (runtime) => {
        const selected = await selectCases("RV-D04");
        runtime.setModelResponseFactories([...(await responses(selected[0])), ...(await responses(selected[1]))]);
        const out = join(runtime.projectRoot, "results");
        const run = await runBenchmark(selected, { out });
        const saved = await readRun(run.directory);
        assert.equal(saved.results.length, 2);
        assert.equal(saved.manifest.cases[0].patch, selected[0].fixture.oracle.variants.A!.patch);
        assert.equal(saved.manifest.cases[1].patch, selected[1].fixture.oracle.variants.B!.patch);
        assert.deepEqual(saved.results[0].outcome!.findings, [finding]);
        assert.deepEqual(saved.results[0].outcome!.advisories, [advisory]);
        assert.deepEqual(
            saved.results.map((row) => [row.caseId, row.kind, row.observedDecision]),
            [
                ["RV-D04/A", "complete", "reject"],
                ["RV-D04/B", "complete", "approve"],
            ],
        );
        assert.match(saved.manifest.configuration.revision, /^[a-f0-9]{40,64}$/);
        assert.equal(typeof saved.manifest.configuration.dirty, "boolean");
        assert.equal(saved.manifest.configuration.model, "fixture-model");
        assert.equal(saved.manifest.configuration.provider, "runtime-command-fixture");
        assert.equal(Object.keys(saved.manifest.configuration.promptHashes).length, 3);
        for (const hash of Object.values(saved.manifest.configuration.promptHashes))
            assert.match(hash, /^[a-f0-9]{64}$/);
        for (const row of saved.results) {
            assert.deepEqual(row.configuration, saved.manifest.configuration);
            assert.equal(row.model, "fixture-model");
            assert.equal(row.provider, "runtime-command-fixture");
            assert.equal(row.trial, 1);
            assert.equal(row.attempt, 1);
            assert.equal(typeof row.tokens.input, "number");
            assert.equal(typeof row.toolCallCount, "number");
        }
        const original = await readFile(join(out, "results.jsonl"), "utf8");
        await assert.rejects(runBenchmark(selected, { out }), /EEXIST/);
        assert.equal(await readFile(join(out, "results.jsonl"), "utf8"), original);
        runtime.setModelResponseFactory(() => {
            throw new Error("Completed cases must not call a model again");
        });
        assert.equal((await runBenchmark(selected, { out, resume: true })).results.length, 2);
    });
});

test("a timed-out case settles before a fresh case and resume retries only the unfinished case", async () => {
    await withRuntimeCommandFixture("benchmark-batch-resume-", async (runtime) => {
        const selected = await selectCases("RV-D04");
        // The stalled provider determines timeout behavior. Healthy reviews still run the real inspection tools.
        const timeoutMs = 10000;
        let settled = false;
        const stall: FauxResponseFactory = async (_context, options) => {
            await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            settled = true;
            return fauxAssistantMessage(fauxText("Canceled"));
        };
        const clean = await responses(selected[1]);
        runtime.setModelResponseFactories([
            stall,
            ...clean.map<FauxResponseFactory>((factory) => (context, ...rest) => {
                assert.equal(settled, true);
                return factory(context, ...rest);
            }),
        ]);
        const out = join(runtime.projectRoot, "resume-results");
        const first = await runBenchmark(selected, { out, timeoutMs });
        assert.deepEqual(
            first.results.map((row) => row.kind),
            ["timeout", "complete"],
        );
        assert.equal(first.results[0].observedDecision, "unavailable");
        const before = await scoreRun(out);
        assert.deepEqual(before.decisionAccuracy, { numerator: 1, denominator: 2, value: 0.5 });
        assert.match(before.cases[0].cause!, /exceeded/);
        runtime.setModelResponseFactories(await responses(selected[0]));
        const resumed = await runBenchmark(selected, { out, resume: true, timeoutMs });
        assert.deepEqual(
            resumed.results.map((row) => [row.caseId, row.attempt, row.kind]),
            [
                ["RV-D04/A", 1, "timeout"],
                ["RV-D04/B", 1, "complete"],
                ["RV-D04/A", 2, "complete"],
            ],
        );
        const latest = latestResults(await readRun(out));
        assert.equal(latest.get("RV-D04/A")!.attempt, 2);
        assert.equal(latest.get("RV-D04/B")!.attempt, 1);
        assert.equal((await scoreRun(out)).decisionAccuracy.numerator, 2);
    });
});

test("failed fixture admission stops the whole batch before any model turn", async () => {
    await withRuntimeCommandFixture("benchmark-batch-admission-", async (runtime) => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            await writeFile(join(packageDir, "evaluation/proofs.ts"), 'console.log("no assertion");\n');
            const fixture = await loadFixture(packageDir);
            let calls = 0;
            runtime.setModelResponseFactory(() => {
                calls++;
                return fauxAssistantMessage(fauxText("Must not start"));
            });
            const out = join(runtime.projectRoot, "rejected");
            const earlier = (await selectCases("RV-D05/B"))[0];
            await assert.rejects(
                runBenchmark([earlier, { fixture, variant: "A" }], { out }),
                /expected AssertionError/,
            );
            assert.equal(calls, 0);
            await assert.rejects(access(join(out, "run.json")), /ENOENT/);
        });
    });
});

test("a protocol pause remains visible and does not prevent the next case", async () => {
    await withRuntimeCommandFixture("benchmark-batch-pause-", async (runtime) => {
        const selected = await selectCases("RV-D04");
        runtime.setModelResponseFactories([
            ...Array.from({ length: 4 }, () => () => fauxAssistantMessage(fauxText("Cannot complete"))),
            ...(await responses(selected[1])),
        ]);
        const run = await runBenchmark(selected, { out: join(runtime.projectRoot, "paused") });
        assert.deepEqual(
            run.results.map((row) => row.kind),
            ["paused", "complete"],
        );
        assert.equal(run.results[0].nudgeAttempts, 3);
        assert.match(run.results[0].reason!, /Protocol correction budget/);
        assert.equal((await scoreRun(run.directory)).decisionAccuracy.denominator, 2);
    });
});

test("resume refuses changed configuration, fixture truth, selection, and timeout, and keeps saved results", async () => {
    await withRuntimeCommandFixture("benchmark-batch-mismatch-", async (runtime) => {
        const selected = await selectCases("RV-D04/B");
        runtime.setModelResponseFactories(await responses(selected[0]));
        const out = join(runtime.projectRoot, "existing");
        await runBenchmark(selected, { out });
        const original = await readFile(join(out, "results.jsonl"), "utf8");
        const manifestText = await readFile(join(out, "run.json"), "utf8");
        for (const change of ["configuration", "fixture"] as const) {
            const run = await readRun(out);
            if (change === "configuration")
                run.manifest.configuration.promptHashes[Object.keys(run.manifest.configuration.promptHashes)[0]] =
                    "0".repeat(64);
            else run.manifest.cases[0].fixtureHash = "0".repeat(64);
            for (const result of run.results) result.configuration = run.manifest.configuration;
            await writeFile(join(out, "run.json"), JSON.stringify(run.manifest));
            await writeFile(join(out, "results.jsonl"), run.results.map((result) => JSON.stringify(result)).join("\n"));
            await assert.rejects(runBenchmark(selected, { out, resume: true }), /different configuration/);
            await writeFile(join(out, "run.json"), manifestText);
            await writeFile(join(out, "results.jsonl"), original);
        }
        await assert.rejects(
            runBenchmark(await selectCases("RV-D04"), { out, resume: true }),
            /different configuration/,
        );
        await assert.rejects(runBenchmark(selected, { out, resume: true, timeoutMs: 100 }), /different configuration/);
        assert.equal(await readFile(join(out, "results.jsonl"), "utf8"), original);
        const lock = openNativeFileLock(join(out, ".lock"));
        try {
            assert.equal(lock.tryLockSync(true), true);
            await assert.rejects(runBenchmark(selected, { out, resume: true }), /in use/);
        } finally {
            lock.close();
        }
    });
});

test("missing model fails preflight before any results or model turn", async () => {
    await withRuntimeCommandFixture(
        "benchmark-batch-model-",
        async (runtime) => {
            let calls = 0;
            runtime.setModelResponseFactory(() => {
                calls++;
                return fauxAssistantMessage(fauxText("Must not start"));
            });
            const out = join(runtime.projectRoot, "no-model");
            await assert.rejects(runBenchmark(await selectCases("RV-D04/B"), { out }), /No configured model/);
            assert.equal(calls, 0);
            await assert.rejects(access(out), /ENOENT/);
        },
        { providerState: "provider-no-model" },
    );
});

test("resume requires an explicit directory and timeout must be positive", async () => {
    const selected = await selectCases("RV-D04/B");
    await assert.rejects(runBenchmark(selected, { resume: true }), /requires --out/);
    await assert.rejects(runBenchmark(selected, { timeoutMs: 0 }), /positive/);
    await assert.rejects(runBenchmark([]), /at least one/);
});

test("a materialization failure is saved and the following independent case still runs", async () => {
    await withRuntimeCommandFixture("benchmark-batch-harness-", async (runtime) => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            const fixture = await loadFixture(packageDir);
            const third = (await selectCases("RV-D05/B"))[0];
            const first: SelectedCase = { fixture, variant: "A" };
            const steps = await responses(first);
            steps[steps.length - 1] = async () => {
                await unlink(join(packageDir, "source/src/browser.ts"));
                return fauxAssistantMessage(
                    fauxToolCall("review_complete", { approved: false, findings: [finding], advisories: [] }),
                );
            };
            runtime.setModelResponseFactories([...steps, ...(await responses(third))]);
            const run = await runBenchmark([first, { fixture, variant: "B" }, third], {
                out: join(runtime.projectRoot, "harness-failure"),
            });
            assert.deepEqual(
                run.results.map((result) => result.kind),
                ["complete", "failed", "complete"],
            );
            assert.match(run.results[1].reason!, /Git|patch/);
            assert.equal(run.results[1].observedDecision, "unavailable");
            assert.equal(run.results[1].tokens.input, "unavailable");
            assert.equal((await scoreRun(run.directory)).decisionAccuracy.denominator, 3);
        });
    });
});

test("reports separate Plan-named containment from correctness beyond the Plan", async () => {
    await withRuntimeCommandFixture("benchmark-coverage-groups-", async (runtime) => {
        const selected = await selectCases("RV-D04/B,RV-D05/B");
        runtime.setModelResponseFactories([...(await responses(selected[0])), ...(await responses(selected[1]))]);
        const run = await runBenchmark(selected, { out: join(runtime.projectRoot, "groups") });
        const summary = await scoreRun(run.directory);
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(summary.groups).map(([group, scores]) => [group, scores.decisionAccuracy]),
            ),
            {
                "correctness-beyond-plan": { numerator: 1, denominator: 1, value: 1 },
                "plan-named-edge-case": { numerator: 1, denominator: 1, value: 1 },
            },
        );
    });
});

test("run records take the coverage group from the fixture manifest", async () => {
    await withRuntimeCommandFixture("benchmark-manifest-group-", async (runtime) => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            const path = join(packageDir, "scenario.yaml");
            await writeFile(
                path,
                (await readFile(path, "utf8")).replace("correctness-beyond-plan", "cross-file-context"),
            );
            const entry: SelectedCase = { fixture: await loadFixture(packageDir), variant: "B" };
            runtime.setModelResponseFactories(await responses(entry));
            const run = await runBenchmark([entry], { out: join(runtime.projectRoot, "manifest-group") });
            assert.equal((await readRun(run.directory)).manifest.cases[0].group, "cross-file-context");
        });
    });
});
