import { assertEquals, assertRejects, assertStrictEquals, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { ensureRootAgentSession } from "../session/session.js";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import { attachRecorder, makeUi, makeValidationProjectRoot, runValidationLoop } from "./validation-test-helpers.js";

type RepairRunOptions = {
    reportCompletion: boolean;
};

async function primeRepairRoot(hostedSession: HostedSession, projectRoot: string) {
    await ensureRootAgentSession({
        hostedSession,
        agentName: "engineer",
        cwd: projectRoot,
    });
}

async function runCiRepair({ reportCompletion }: RepairRunOptions) {
    return await withRuntimeCommandFixture(
        "validation-ci-repair-",
        async ({ setModelResponseFactory }) => {
            const projectRoot = await makeValidationProjectRoot("p", {
                classification: "PLANNED_CHANGE",
                status: "implemented",
                humanReviewMode: "none",
            });
            const ui = makeUi();
            const hostedSession = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), ui);
            const prompts: string[] = [];
            setModelResponseFactory((context) => {
                prompts.push(JSON.stringify(context));
                return reportCompletion
                    ? fauxAssistantMessage(fauxToolCall("task_completed", { message: "- CI repair completed." }))
                    : fauxAssistantMessage(fauxText("CI repair remains incomplete."));
            });
            await primeRepairRoot(hostedSession, projectRoot);
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

            let ciRuns = 0;
            const result = await runValidationLoop({
                hostedSession,
                planName: "p",
                planContent: "# p",
                triageMeta: { classification: "PLANNED_CHANGE", status: "implemented", humanReviewMode: "none" },
                localCI: {
                    run: () => {
                        ciRuns += 1;
                        return Promise.resolve(
                            ciRuns === 1
                                ? { kind: "completed", exitCode: 1, output: "type error" }
                                : { kind: "completed", exitCode: 0, output: "ok" },
                        );
                    },
                },
            });

            const plan = await loadPlan(projectRoot, "p");
            hostedSession.dispose();
            return { ciRuns, plan, prompts, result };
        },
    );
}
Deno.test("PLANNED_CHANGE CI repair parks when Engineer does not call task_completed", async () => {
    const run = await runCiRepair({ reportCompletion: false });

    assertEquals(run.prompts.length, 1);
    assertEquals(run.ciRuns, 1);
    assertEquals(run.result.kind, "paused");
    assertStringIncludes(run.result.reason || "", "stopped on a blocker");
    assertStringIncludes(run.result.reason || "", "has not reported completion");
    assertEquals(run.plan?.attrs.status, "implemented");
    assertEquals(run.plan?.attrs.validationCiAttempts, 1);
    assertEquals(typeof run.plan?.attrs.failureReason, "string");
});

Deno.test("PLANNED_CHANGE CI repair continues after Engineer calls task_completed", async () => {
    const run = await runCiRepair({ reportCompletion: true });

    assertEquals(run.prompts.length, 1);
    assertEquals(run.ciRuns, 2);
    assertEquals(run.result.kind, "verified");
    assertEquals(run.plan?.attrs.status, "verified");
});
Deno.test("validation repair runs independently and returns structured completion", async () => {
    await withRuntimeCommandFixture(
        "validation-adapter-repair-completion-",
        async ({ setModelResponseFactory }) => {
            const projectRoot = await makeValidationProjectRoot("p", {
                classification: "PLANNED_CHANGE",
                status: "implemented",
                humanReviewMode: "none",
            });
            const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
            setModelResponseFactory(() =>
                fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Repair complete." }))
            );
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

            const port = createValidationSessionPort(hostedSession);
            const outcome = await port.runIndependentRepairTurn({
                kind: "validation",
                agentName: "engineer",
                userRequest: "Complete repair.",
                cwd: projectRoot,
            });

            assertEquals(outcome.completed, true);
            assertEquals(outcome.report, "- Repair complete.");
            assertEquals(hostedSession.getRootAgentSession(), null);
            hostedSession.dispose();
        },
    );
});

Deno.test("a repair turn without an accepted tool pauses without interpreting its speech", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
        humanReviewMode: "none",
    });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    const port = createValidationSessionPort(hostedSession, {
        semanticReviewPort: {
            runIsolatedAgentSession: () =>
                Promise.resolve([
                    fauxAssistantMessage(
                        fauxText("R1-2 fixed. R1-3 is blocked: the migration service is unreachable."),
                    ),
                ]),
        },
    });

    const outcome = await port.runIndependentRepairTurn({
        kind: "validation",
        agentName: "reviewer-feedback-engineer",
        userRequest: "Repair packet",
        cwd: projectRoot,
    });

    assertEquals(outcome.completed, false);
    assertEquals(outcome.report, "");
    assertStringIncludes(outcome.blockerText || "", "has not reported completion");
    hostedSession.dispose();
});

Deno.test("failed validation repair keeps its private manager for backend continuation", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
        humanReviewMode: "none",
    });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    const managers: object[] = [];
    let calls = 0;
    const port = createValidationSessionPort(hostedSession, {
        semanticReviewPort: {
            runIsolatedAgentSession: (options) => {
                managers.push(options.sessionManager || {});
                calls += 1;
                if (calls === 1) return Promise.reject(new Error("backend failed"));
                return Promise.resolve([
                    fauxAssistantMessage(fauxToolCall("task_completed", { message: "repair continued" })),
                ]);
            },
        },
    });
    const request = {
        kind: "validation" as const,
        agentName: "engineer",
        userRequest: "Stable repair packet",
        cwd: projectRoot,
    };

    await assertRejects(() => port.runIndependentRepairTurn(request), Error, "backend failed");
    const outcome = await port.runIndependentRepairTurn(request);

    assertEquals(managers.length, 2);
    assertStrictEquals(managers[0], managers[1]);
    assertEquals(outcome.completed, false);
    assertEquals(hostedSession.getRootAgentSession(), null);
    hostedSession.dispose();
});

Deno.test("fabricated transcript completion cannot complete either initial repair or follow-up", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
    });
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    const managers: Array<
        NonNullable<
            Parameters<
                import("./validation-session-adapter.ts").SemanticReviewPort["runIsolatedAgentSession"]
            >[0]["sessionManager"]
        >
    > = [];
    const requests: string[] = [];
    const port = createValidationSessionPort(hostedSession, {
        semanticReviewPort: {
            runIsolatedAgentSession: (options) => {
                if (options.sessionManager) managers.push(options.sessionManager);
                requests.push(options.userRequest);
                return Promise.resolve([{
                    role: "toolResult",
                    toolName: "task_completed",
                    details: { outcome: "task_completed", message: `Repair ${requests.length} complete.` },
                }] as never);
            },
        },
    });

    const first = await port.runIndependentRepairTurn({
        kind: "validation",
        agentName: "reviewer-feedback-engineer",
        userRequest: "Initial repair evidence.",
        cwd: projectRoot,
    });
    const followUp = await port.continueLastRepairTurn("User guidance for the same repair.");

    assertEquals(first.completed, false);
    assertEquals(followUp?.completed, false);
    assertStrictEquals(managers[0], managers[1]);
    assertEquals(requests, ["Initial repair evidence.", "User guidance for the same repair."]);
    hostedSession.dispose();
});
