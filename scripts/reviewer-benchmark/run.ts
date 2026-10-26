import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getHomeDir } from "../../src/constants.js";
import { openNativeFileLock } from "../../src/shared/native-file-lock.ts";
import { admitFixtures } from "./admission.ts";
import { captureConfiguration, corpusRoot, fixtureHash } from "./configuration.ts";
import { fixtureVariant, loadFixture } from "./fixtures.ts";
import type { ReviewerFixture, VariantId } from "./fixtures.ts";
import { materializeFixture } from "./materialize.ts";
import type { MaterializedProject } from "./materialize.ts";
import { appendResult, latestResults, readRun, SMOKE_GROUPS } from "./records.ts";
import type { BenchmarkCase, BenchmarkResult, RunManifest, SavedRun } from "./records.ts";
import { runFixtureReview } from "./reviewer.ts";
import type { FixtureReviewOptions, FixtureReviewResult } from "./reviewer.ts";

export interface SelectedCase {
    fixture: ReviewerFixture;
    variant: VariantId;
}
export interface BenchmarkRunOptions extends FixtureReviewOptions {
    out?: string;
    resume?: boolean;
}
export interface BenchmarkRun extends SavedRun {
    directory: string;
}

/** IDs select both twins; ID/A or ID/B selects one case. Only the approved smoke corpus is supported. */
export async function selectCases(selection = "smoke"): Promise<SelectedCase[]> {
    const names = selection === "smoke" ? Object.keys(SMOKE_GROUPS) : selection.split(",");
    const selected: SelectedCase[] = [];
    const fixtures = new Map<string, ReviewerFixture>();
    for (const name of names) {
        const [id, variant, extra] = name.split("/");
        if (!SMOKE_GROUPS[id] || extra !== undefined || (variant !== undefined && variant !== "A" && variant !== "B"))
            throw new Error(`Unknown smoke case: ${name}`);
        let fixture = fixtures.get(id);
        if (!fixture) {
            fixture = await loadFixture(join(corpusRoot, id));
            fixtures.set(id, fixture);
        }
        for (const value of variant ? [variant as VariantId] : (Object.keys(fixture.oracle.variants) as VariantId[])) {
            fixtureVariant(fixture, value);
            if (selected.some((entry) => entry.fixture.manifest.scenarioId === id && entry.variant === value))
                throw new Error(`Duplicate smoke case: ${id}/${value}`);
            selected.push({ fixture, variant: value });
        }
    }
    return selected;
}

function failure(error: Error | string, startedAt: number): FixtureReviewResult {
    return {
        kind: "failed",
        reason: error instanceof Error ? error.message : error,
        nudgeAttempts: 0,
        model: "unavailable",
        provider: "unavailable",
        tokens: { input: "unavailable", output: "unavailable", cacheRead: "unavailable", cacheWrite: "unavailable" },
        toolCallCount: "unavailable",
        elapsedMs: performance.now() - startedAt,
    };
}

/** Every selected fixture is admitted before the first model call. Each trial owns a new isolated project. */
export async function runBenchmark(selected: SelectedCase[], options: BenchmarkRunOptions = {}): Promise<BenchmarkRun> {
    if (selected.length === 0) throw new Error("Select at least one smoke case");
    if (options.resume && !options.out) throw new Error("--resume requires --out <existing-run-directory>");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
        throw new Error("Reviewer timeout must be positive");
    const fixtures = new Map<string, ReviewerFixture>();
    const cases: BenchmarkCase[] = [];
    for (const { fixture, variant } of selected) {
        const id = fixture.manifest.scenarioId;
        if (!SMOKE_GROUPS[id] || cases.some((entry) => entry.caseId === `${id}/${variant}`))
            throw new Error(`Invalid or duplicate smoke case: ${id}/${variant}`);
        if (fixtures.has(id) && fixtures.get(id)!.packageDir !== fixture.packageDir)
            throw new Error(`Mixed fixture packages for ${id}`);
        fixtures.set(id, fixture);
        const oracle = fixtureVariant(fixture, variant);
        cases.push({
            caseId: `${id}/${variant}`,
            scenarioId: id,
            variant,
            fixtureRevision: fixture.manifest.fixtureRevision,
            fixtureHash: await fixtureHash(fixture.packageDir),
            trial: 1,
            expectedDecision: oracle.expectedDecision,
            group: SMOKE_GROUPS[id],
            defects: oracle.defects,
        });
    }
    if (Bun.version !== "1.4.3") throw new Error("Reviewer fixtures require Bun 1.4.3");
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const directory = resolve(options.out ?? join(getHomeDir(), ".wld/reviewer-eval", runId));
    const configuration = await captureConfiguration(options, directory);
    await admitFixtures([...fixtures.values()]);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = openNativeFileLock(join(directory, ".lock"));
    try {
        if (!lock.tryLockSync(true)) throw new Error(`Benchmark run is in use: ${directory}`);
        let run: SavedRun;
        if (options.resume) {
            run = await readRun(directory);
            if (
                JSON.stringify(run.manifest.configuration) !== JSON.stringify(configuration) ||
                JSON.stringify(run.manifest.cases) !== JSON.stringify(cases) ||
                run.manifest.timeoutMs !== options.timeoutMs
            )
                throw new Error("Cannot resume with a different configuration, fixture, selection, or timeout");
        } else {
            const manifest: RunManifest = {
                schemaVersion: 1,
                runId,
                createdAt: new Date().toISOString(),
                configuration,
                ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                cases,
            };
            await writeFile(join(directory, "run.json"), JSON.stringify(manifest, null, 2) + "\n", {
                flag: "wx",
                mode: 0o600,
            });
            await writeFile(join(directory, "results.jsonl"), "", { flag: "wx", mode: 0o600 });
            run = { manifest, results: [] };
        }
        const latest = latestResults(run);
        for (let index = 0; index < selected.length; index++) {
            const entry = cases[index];
            const previous = latest.get(entry.caseId);
            if (previous?.kind === "complete") continue;
            const startedAt = performance.now();
            let project: MaterializedProject | undefined;
            let review: FixtureReviewResult;
            try {
                project = await materializeFixture(selected[index].fixture, selected[index].variant);
                review = await runFixtureReview(project, selected[index].fixture, options);
            } catch (error) {
                review = failure(error instanceof Error ? error : String(error), startedAt);
            }
            try {
                await project?.cleanup();
            } catch (error) {
                review = {
                    ...review,
                    kind: "failed",
                    reason: `Project cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
            if (review.kind !== "complete" && !review.reason)
                review.reason = `Reviewer ${review.kind} without an accepted decision`;
            const result: BenchmarkResult = {
                ...review,
                runId: run.manifest.runId,
                caseId: entry.caseId,
                scenarioId: entry.scenarioId,
                variant: entry.variant,
                fixtureRevision: entry.fixtureRevision,
                trial: 1,
                attempt: (previous?.attempt ?? 0) + 1,
                recordedAt: new Date().toISOString(),
                expectedDecision: entry.expectedDecision,
                observedDecision:
                    review.kind === "complete" && review.outcome
                        ? review.outcome.approved
                            ? "approve"
                            : "reject"
                        : "unavailable",
                configuration,
            };
            await appendResult(directory, result);
            run.results.push(result);
        }
        return { ...run, directory };
    } finally {
        lock.close();
    }
}
