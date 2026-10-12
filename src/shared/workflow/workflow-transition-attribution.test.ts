import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import type { WorkflowMetricFixtureRecord } from "../../testing/workflow-metrics-fixture.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "./metrics.js";
import { git } from "../git-test-fixture.ts";
import { resolveValidationExecutionContext } from "./execution-context.ts";
import {
    runArchiveTransition,
    runEpicDecompositionFinalizeTransition,
    runExecutionPreparationTransition,
    runImplementationCheckpointTransition,
    runPlanLifecycleEventTransition,
    runPlanReviewDecisionTransition,
    runRecoveryTransition,
    runReviewReopenTransition,
    runSequenceReviewTransition,
    runValidationOutcomeTransition,
} from "./state-transition.ts";
import { makePublicationOutcomeFixture } from "./testing/publication-outcome-fixture.ts";

const options = { planName: "demo", worktreeId: "attempt-demo" };
const transitions = [
    {
        name: "implementation checkpoint",
        run: (projectRoot: string) =>
            runImplementationCheckpointTransition({ ...options, projectRoot, checkpoint: () => Promise.resolve() }),
    },
    {
        name: "Plan review decision",
        run: (projectRoot: string) =>
            runPlanReviewDecisionTransition({
                ...options,
                projectRoot,
                approved: true,
                decide: () => Promise.resolve(),
            }),
    },
    {
        name: "Plan lifecycle event",
        run: (projectRoot: string) =>
            runPlanLifecycleEventTransition({
                ...options,
                projectRoot,
                event: "test",
                record: () => Promise.resolve(),
            }),
    },
    {
        name: "multi-resource Plan lifecycle event",
        run: (projectRoot: string) =>
            runPlanLifecycleEventTransition({
                ...options,
                projectRoot,
                event: "test",
                resources: [{ kind: "plan", id: "demo" }, { kind: "attempt", id: "attempt-demo" }],
                record: () => Promise.resolve(),
            }),
    },
    {
        name: "execution preparation",
        run: (projectRoot: string) =>
            runExecutionPreparationTransition({
                ...options,
                projectRoot,
                expectedPlanEvent: false,
                prepare: () => Promise.resolve(),
            }),
    },
    {
        name: "Sequence review",
        run: (projectRoot: string) =>
            runSequenceReviewTransition({
                ...options,
                projectRoot,
                approved: true,
                planNames: ["demo"],
                decide: async (ctx) => {
                    await ctx.markEffect("sequence_review_prepared", {});
                    await ctx.markEffect("sequence_review_accepted", {});
                },
            }),
    },
    {
        name: "review reopen",
        run: (projectRoot: string) =>
            runReviewReopenTransition({
                ...options,
                projectRoot,
                reopen: async (ctx) => {
                    await ctx.markEffect("plan_event_recorded", {});
                },
            }),
    },
    {
        name: "validation outcome",
        run: (projectRoot: string) =>
            runValidationOutcomeTransition({
                ...options,
                projectRoot,
                outcome: "passed",
                settle: () => Promise.resolve(),
            }),
    },
    {
        name: "Epic decomposition",
        run: (projectRoot: string) =>
            runEpicDecompositionFinalizeTransition({
                ...options,
                projectRoot,
                resources: [{ kind: "plan", id: "demo" }],
                finalize: () => Promise.resolve({ childNames: [] }),
            }),
    },
    {
        name: "recovery",
        run: (projectRoot: string) =>
            runRecoveryTransition({ ...options, projectRoot, action: "recover", recover: () => Promise.resolve() }),
    },
    {
        name: "archive",
        run: (projectRoot: string) =>
            runArchiveTransition({ ...options, projectRoot, action: "archive", move: () => Promise.resolve() }),
    },
];

for (const transition of transitions) {
    Deno.test(`${transition.name} observation retains its committed attempt Plan association`, async () => {
        await withWorkflowMetricsFixture(async (metrics) => {
            const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
            try {
                const result = await transition.run(metrics.projectRoot);
                assertEquals(result.status, "committed");
                // Archive transitions use the Plan document root as their observation directory.
                await drainWorkflowMetrics();
                const observationRoot = transition.name === "archive" ? fixture.executionCwd : metrics.projectRoot;
                const contents = await Deno.readTextFile(getWorkflowMetricsFilePath(observationRoot));
                const records: WorkflowMetricFixtureRecord[] = contents.trim().split("\n").map((line) =>
                    JSON.parse(line)
                );
                const rows = records.filter((row) => row.event === "workflow_transition_committed");
                assertEquals(rows.length, 1);
                assertEquals([rows[0].attemptId, rows[0].planId], ["attempt-demo", "plan-demo"]);
            } finally {
                await fixture.dispose();
            }
        });
    });
}

Deno.test("restored execution Plan observation retains its committed attempt Plan association", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const fixture = await makePublicationOutcomeFixture(metrics.projectRoot);
        try {
            await Deno.remove(join(fixture.executionCwd, "docs/plans/demo.md"));
            await Deno.writeTextFile(join(fixture.executionCwd, "feature.txt"), "implemented feature\n");
            await git(fixture.executionCwd, ["add", "."]);
            await git(fixture.executionCwd, ["commit", "-m", "Implementation without Plan copy"]);
            const result = await resolveValidationExecutionContext({
                projectRoot: metrics.projectRoot,
                planName: "demo",
            });
            assertEquals(result.kind, "ok");
            assert(result.kind === "ok");
            assertEquals(result.restoredPlanFile, { relativePath: "docs/plans/demo.md" });
            const rows = (await metrics.readMetrics()).filter((row) =>
                row.event === "execution_context_resolution" && row.v === 2
            );
            assertEquals(rows.length, 1);
            assertEquals([rows[0].attemptId, rows[0].planId], ["attempt-demo", "plan-demo"]);
        } finally {
            await fixture.dispose();
        }
    });
});
