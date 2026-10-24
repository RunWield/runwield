import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../../src/shared/workflow/metrics.js";
import { runStandaloneReviewerRound } from "../../src/shared/workflow/standalone-reviewer.ts";
import type {
    ReviewerConfigurationOptions,
    StandaloneReviewerResult,
} from "../../src/shared/workflow/standalone-reviewer.ts";
import type { ReviewerFixture } from "./fixtures.ts";
import type { MaterializedProject } from "./materialize.ts";
import { readReviewMeasurements } from "./measurements.ts";
import type { ReviewMeasurements } from "./measurements.ts";

export interface FixtureReviewOptions extends ReviewerConfigurationOptions {
    timeoutMs?: number;
}

export interface FixtureReviewResult extends ReviewMeasurements, StandaloneReviewerResult {
    elapsedMs: number;
}

async function readJournal(cwd: string): Promise<string> {
    try {
        return await readFile(getWorkflowMetricsFilePath(cwd), "utf8");
    } catch {
        return "";
    }
}

/** One production discovery round. Admission and project cleanup remain the caller's responsibility. */
export async function runFixtureReview(
    project: MaterializedProject,
    fixture: ReviewerFixture,
    options: FixtureReviewOptions = {},
): Promise<FixtureReviewResult> {
    const startedAt = performance.now();
    const timeoutMs = options.timeoutMs ?? fixture.manifest.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Reviewer timeout must be positive");
    await drainWorkflowMetrics();
    const journalBefore = await readJournal(project.cwd);
    const result = await runStandaloneReviewerRound({
        ...options,
        cwd: project.cwd,
        planName: basename(fixture.manifest.planPath, ".md"),
        planContent: project.planContent,
        diffText: project.diffText,
        timeoutMs,
    });
    await drainWorkflowMetrics();
    const journal = await readJournal(project.cwd);
    return {
        ...result,
        ...readReviewMeasurements(journal.startsWith(journalBefore) ? journal.slice(journalBefore.length) : ""),
        elapsedMs: performance.now() - startedAt,
    };
}
