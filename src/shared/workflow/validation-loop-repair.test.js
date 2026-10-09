import { assertEquals, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { ensureRootAgentSession } from "../session/session.js";
import { dispatchCiRepair } from "./validation-mechanical.ts";
import { attachRecorder, makeUi, makeValidationProjectRoot, runValidationLoop } from "./validation-test-helpers.js";

/**
 * @param {{ reportCompletion: boolean }} options
 */
async function runCiRepair(options) {
    return await withRuntimeCommandFixture("validation-ci-repair-", async ({ setModelResponseFactory }) => {
        const projectRoot = await makeValidationProjectRoot("p", {
            classification: "PLANNED_CHANGE",
            status: "implemented",
            humanReviewMode: "none",
        });
        const ui = makeUi();
        const hostedSession = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), ui);
        await ensureRootAgentSession({ hostedSession, agentName: "engineer", cwd: projectRoot });
        hostedSession.setActiveExecutionWorkflow({
            planName: "p",
            triageMeta: { classification: "PLANNED_CHANGE", status: "implemented", humanReviewMode: "none" },
            executionAgent: "engineer",
            projectRoot,
            executionCwd: projectRoot,
            executionMode: "non_git_in_place",
            nonGitInPlace: true,
            validationContinuation: true,
        });
        setModelResponseFactory(() =>
            options.reportCompletion
                ? fauxAssistantMessage(fauxToolCall("task_completed", { message: "- CI repair completed." }))
                : fauxAssistantMessage(fauxText("CI repair remains incomplete."))
        );
        let ciRuns = 0;
        const result = await runValidationLoop({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "PLANNED_CHANGE", status: "implemented", humanReviewMode: "none" },
            localCI: {
                run: () => {
                    ciRuns += 1;
                    return Promise.resolve({
                        kind: "completed",
                        exitCode: ciRuns === 1 ? 1 : 0,
                        output: ciRuns === 1 ? "type error" : "ok",
                    });
                },
            },
        });
        const plan = await loadPlan(projectRoot, "p");
        hostedSession.dispose();
        return { ciRuns, plan, result };
    });
}

Deno.test("CI repair pauses when Engineer does not report task completion", async () => {
    const run = await runCiRepair({ reportCompletion: false });
    assertEquals(run.ciRuns, 1);
    assertEquals(run.result.kind, "paused");
    assertStringIncludes(run.result.reason || "", "stopped on a blocker");
    assertStringIncludes(run.result.reason || "", "has not reported completion");
    assertEquals(run.plan?.attrs.status, "implemented");
    assertEquals(run.plan?.attrs.validationCiAttempts, 1);
});

Deno.test("CI repair reruns CI and continues after task completion", async () => {
    const run = await runCiRepair({ reportCompletion: true });
    assertEquals(run.ciRuns, 2);
    assertEquals(run.result.kind, "verified");
    assertEquals(run.plan?.attrs.status, "verified");
});

Deno.test("CI repair prompt verifies the repair without requiring a duplicate full CI run", async () => {
    let capturedRequest = "";
    const context = {
        executionCwd: "/repair-checkout",
        projectRoot: "/primary-project",
        worktreeId: "wt-ci",
        worktreeBranch: "worktree/ci",
        worktreeBaseBranch: "main",
        workflowBase: { planName: "p" },
    };
    const args = {
        session: {
            setActiveWorkflow: () => {},
            getAgentDisplayName: () => "Validation Repair Engineer",
            getCurrentProgress: () => null,
            emitStatus: () => {},
            runIndependentRepairTurn: (/** @type {{ userRequest: string }} */ request) => {
                capturedRequest = request.userRequest;
                return Promise.resolve({ completed: true });
            },
        },
        planName: "p",
        triageMeta: { classification: "PLANNED_CHANGE", status: "implemented" },
    };

    await dispatchCiRepair(
        /** @type {any} */ (args),
        /** @type {any} */ (context),
        { kind: "completed", exitCode: 1, output: "broken command" },
    );

    assertStringIncludes(capturedRequest, "Repair checkout: `/repair-checkout`");
    assertStringIncludes(capturedRequest, ".wld/settings.json");
    assertStringIncludes(capturedRequest, "verification_command");
    assertStringIncludes(capturedRequest, "command can be the thing that is broken");
    assertStringIncludes(capturedRequest, "Run focused checks for the reported failure");
    assertStringIncludes(
        capturedRequest,
        "only when needed to diagnose the failure or explicitly requested by the user",
    );
    assertStringIncludes(capturedRequest, "before you call `task_completed`");
    assertStringIncludes(capturedRequest, "RunWield will independently reload `.wld/settings.json`");
    assertStringIncludes(capturedRequest, "run the complete command after Task Completion");
    assertStringIncludes(capturedRequest, "report that full validation as pending");
    assertStringIncludes(capturedRequest, "broken command");
});
