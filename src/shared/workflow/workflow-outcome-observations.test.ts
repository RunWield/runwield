import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan } from "../../plan-store.js";
import { git } from "../git-test-fixture.ts";
import { setCustomSetting, setExactProjectCustomSetting } from "../settings.js";
import { HostedSession } from "../session/hosted-session.js";
import { ensureRootAgentSession } from "../session/session.js";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { ExecutionMetricsRecorder } from "./execution-metrics.ts";
import { recordWorkflowOutcome } from "./outcome-observations.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "./metrics.js";
import { cleanupStoredPublication } from "./publication-machine.ts";
import { runLocalCI } from "./validation-local-ci.ts";
import { attachRecorder, makeUi, runValidationPhase } from "./validation-test-helpers.js";
import { makePublicationOutcomeFixture } from "./testing/publication-outcome-fixture.ts";
import type { WorkflowMetricFixtureRecord } from "../../testing/workflow-metrics-fixture.ts";

async function readRows(root: string): Promise<WorkflowMetricFixtureRecord[]> {
    await drainWorkflowMetrics();
    return (await Deno.readTextFile(getWorkflowMetricsFilePath(root))).trim().split("\n").map((line) =>
        JSON.parse(line)
    );
}

for (const completeRepair of [true, false]) {
    Deno.test(`failed validation records distinct repair work that is ${completeRepair ? "completed" : "ongoing"}`, async () => {
        await withRuntimeCommandFixture("workflow-outcomes-", async (runtime) => {
            const fixture = await makePublicationOutcomeFixture(runtime.projectRoot);
            const ui = makeUi();
            const hostedSession = attachRecorder(
                new HostedSession({ id: crypto.randomUUID(), cwd: runtime.projectRoot }),
                ui,
            );
            try {
                await setCustomSetting("workflowMetrics", true, "project", runtime.projectRoot);
                await ensureRootAgentSession({ hostedSession, agentName: "engineer", cwd: fixture.executionCwd });
                setExactProjectCustomSetting("verification_command", "test -f repair-done", fixture.executionCwd);
                const plan = await loadPlan(fixture.executionCwd, "demo");
                assert(plan);
                hostedSession.setActiveExecutionWorkflow({
                    planName: "demo",
                    triageMeta: plan.attrs,
                    executionAgent: "engineer",
                    projectRoot: runtime.projectRoot,
                    executionCwd: fixture.executionCwd,
                    executionMode: "worktree",
                    worktreeId: "attempt-demo",
                    worktreeBranch: "worktree/demo",
                    worktreeBaseBranch: "main",
                    baselineTree: await git(fixture.executionCwd, ["rev-parse", "HEAD^{tree}"]),
                    validationContinuation: true,
                });
                runtime.setModelResponseFactories(
                    completeRepair
                        ? [
                            () => fauxAssistantMessage(fauxToolCall("bash", { command: "touch repair-done" })),
                            () =>
                                fauxAssistantMessage(
                                    fauxToolCall("task_completed", { message: "- Fixed the failed check." }),
                                ),
                        ]
                        : [() =>
                            fauxAssistantMessage(fauxText("The turn was interrupted. Continue this repair later."))],
                );
                const result = await runValidationPhase({
                    hostedSession,
                    planName: "demo",
                    planContent: plan.markdown,
                    triageMeta: plan.attrs,
                    localCI: { run: (args) => runLocalCI({ ...args, settingsPolicy: "exact-project" }) },
                });
                assertEquals(result.kind, "paused");
                const rows = await readRows(runtime.projectRoot);
                const linked = rows.filter((row) => row.v === 2);
                assertEquals(new Set(linked.map((row) => `${row.recorderId}:${row.seq}`)).size, linked.length);
                const validations = rows.filter((row) => row.event === "validation_attempt");
                const repairs = rows.filter((row) => row.event === "repair_round");
                assertEquals(validations.length, completeRepair ? 2 : 1);
                assertEquals(validations[0].outcome, "failed");
                assertEquals(repairs.length, 1);
                assertEquals(repairs[0].outcome, "ongoing");
                const completed = rows.filter((row) => row.event === "repair_round_finished");
                assertEquals(completed.length, completeRepair ? 1 : 0);
                if (completeRepair) {
                    assertEquals(completed[0].outcome, "succeeded");
                    assertEquals(completed[0].roundId, repairs[0].roundId);
                }
                assertEquals(repairs[0].roundId, repairs[0].operationId);
                assert(repairs[0].eventId !== validations[0].eventId);
                assert(repairs[0].operationId !== validations[0].operationId);
                for (const row of [...validations, ...repairs]) {
                    assertEquals(row.v, 2);
                    assertEquals(row.planId, "plan-demo");
                    assertEquals(row.attemptId, "attempt-demo");
                    assertEquals(row.details, undefined);
                }
                assertEquals(rows.filter((row) => row.outcome === "abandoned").length, 0);
                if (completeRepair) {
                    assertEquals(validations[1].outcome, "succeeded");
                    const attempt = await fixture.confirm();
                    assert((await cleanupStoredPublication(runtime.projectRoot, attempt)).complete);
                    const delivered = (await readRows(runtime.projectRoot)).filter((row) =>
                        row.event === "publication_confirmed"
                    );
                    assertEquals(delivered.length, 1);
                    assertEquals(delivered[0].planId, "plan-demo");
                }
            } finally {
                hostedSession.dispose();
                await fixture.dispose();
            }
        });
    });
}

Deno.test("interrupted non-Plan work stays ongoing and tool fan-out creates no model requests", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const recorder = new ExecutionMetricsRecorder({
            projectRoot,
            sessionId: "discussion",
            executionId: "discussion-turn",
            agentName: "engineer",
            provider: "anthropic",
            model: "claude-sonnet",
            backend: "pi",
            sourceSurface: "tui",
            executionKind: "root",
            mode: "foreground",
        });
        await recorder.recordExecutionStart();
        await recorder.recordToolStart("batch", "code_batch", {
            operations: [{ op: "show", target: "Example" }, { op: "outline", file: "src/example.ts" }],
        });
        await recorder.recordToolFinish("batch", "code_batch", {
            outcome: "canceled",
            result: { details: { results: [{ status: "success" }] } },
        });
        await recorder.settleExecution("canceled");
        await recordWorkflowOutcome(projectRoot, {
            category: "execution",
            event: "plan_execution_result",
            operationId: "discussion-turn",
            outcome: "ongoing",
        });
        const rows = await readMetrics();
        assertEquals(rows.filter((row) => row.event === "tool_operation").length, 2);
        assertEquals(rows.filter((row) => row.event === "model_usage").length, 0);
        assertEquals(rows.some((row) => row.modelRequestId), false);
        assertEquals(rows.find((row) => row.event === "plan_execution_result")?.outcome, "ongoing");
        assertEquals(rows.some((row) => row.planId || row.attemptId || row.outcome === "abandoned"), false);
        assertEquals(rows.filter((row) => row.event === "publication_confirmed").length, 0);
    });
});

Deno.test("a missing validation command records incomplete checks rather than a failed verdict", async () => {
    await withRuntimeCommandFixture("workflow-operational-outcome-", async (runtime) => {
        const fixture = await makePublicationOutcomeFixture(runtime.projectRoot);
        const ui = makeUi();
        ui.promptText = () => Promise.resolve(null);
        const hostedSession = attachRecorder(
            new HostedSession({ id: crypto.randomUUID(), cwd: runtime.projectRoot }),
            ui,
        );
        try {
            await setCustomSetting("workflowMetrics", true, "project", runtime.projectRoot);
            await ensureRootAgentSession({ hostedSession, agentName: "engineer", cwd: fixture.executionCwd });
            const plan = await loadPlan(fixture.executionCwd, "demo");
            assert(plan);
            hostedSession.setActiveExecutionWorkflow({
                planName: "demo",
                triageMeta: plan.attrs,
                executionAgent: "engineer",
                projectRoot: runtime.projectRoot,
                executionCwd: fixture.executionCwd,
                executionMode: "worktree",
                worktreeId: "attempt-demo",
                worktreeBranch: "worktree/demo",
                worktreeBaseBranch: "main",
                baselineTree: await git(fixture.executionCwd, ["rev-parse", "HEAD^{tree}"]),
                validationContinuation: true,
            });
            await runValidationPhase({
                hostedSession,
                planName: "demo",
                planContent: plan.markdown,
                triageMeta: plan.attrs,
                localCI: { run: (args) => runLocalCI({ ...args, settingsPolicy: "exact-project" }) },
            });
            const attempts = (await readRows(runtime.projectRoot)).filter((row) => row.event === "validation_attempt");
            assertEquals(attempts.map((row) => row.outcome), ["incomplete"]);
            assertEquals(ui.toolCalls.length, 0);
        } finally {
            hostedSession.dispose();
            await fixture.dispose();
        }
    });
});
