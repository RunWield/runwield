import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { ensureRootAgentSession } from "../session/session.js";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import {
    attachRecorder,
    makeUi,
    makeValidationProjectRoot,
    NO_ISOLATED_AGENT_PORT,
    runValidationLoop,
    runValidationPhase,
} from "./validation-test-helpers.js";

/** @returns {import("./validation-session-adapter.ts").SemanticReviewPort} */
function repairPort(outcomes = ["completed"]) {
    let call = 0;
    return {
        runIsolatedAgentSession: async (options) => {
            const outcome = outcomes[Math.min(call, outcomes.length - 1)];
            call += 1;
            if (outcome === "completed") {
                await executeWorkflowTestTools(options, [{
                    name: "task_completed",
                    arguments: { message: `Repair turn ${call} completed.` },
                }]);
            }
            return Promise.resolve(
                /** @type {any} */ (
                    outcome === "completed"
                        ? [{
                            role: "toolResult",
                            toolName: "task_completed",
                            toolCallId: `repair-${call}`,
                            content: [],
                            isError: false,
                            timestamp: Date.now(),
                            details: { outcome: "task_completed", message: `Repair turn ${call} completed.` },
                        }]
                        : []
                ),
            );
        },
    };
}

function makeValidationUi(cwd = Deno.cwd()) {
    const uiAPI = makeUi();
    return { uiAPI, hostedSession: attachRecorder(new HostedSession({ id: "validation-repair-test", cwd }), uiAPI) };
}

/** @typedef {{ label: string }} PromptOption */
/** @typedef {{ promptSelections: string[], promptSelect: (prompt: string, options: PromptOption[]) => Promise<string> }} ValidationPromptUi */

/**
 * @param {ValidationPromptUi} uiAPI
 * @param {string[]} labels
 * @param {string} value
 */
function selectAndCaptureOptions(uiAPI, labels, value) {
    uiAPI.promptSelect = (_prompt, options) => {
        uiAPI.promptSelections.push("prompted");
        labels.splice(0, labels.length, ...options.map((option) => option.label));
        return Promise.resolve(value);
    };
}

/**
 * @param {import("../session/hosted-session.js").HostedSession} hostedSession
 * @param {"engineer" | "frontend-engineer"} agentName
 * @param {string} cwd
 */
async function primeRepairAgentRoot(hostedSession, agentName, cwd) {
    await ensureRootAgentSession({
        hostedSession,
        agentName,
        cwd,
    });
}

/**
 * @param {{ executionAgent?: "engineer" | "frontend-engineer" } & Record<string, unknown>} [attrs]
 */
async function makeImplementedRun(attrs = {}) {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "implemented",
        ...attrs,
    });
    const { hostedSession, uiAPI } = makeValidationUi(projectRoot);
    const executionAgent = attrs.executionAgent || "engineer";
    await primeRepairAgentRoot(hostedSession, executionAgent, projectRoot);
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented", ...attrs },
        executionAgent,
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    return { projectRoot, hostedSession, uiAPI };
}

/**
 * @typedef {Awaited<ReturnType<typeof makeImplementedRun>> & { prompts: string[] }} IncompleteRepairFixture
 */

/**
 * @param {string} prefix
 * @param {{ executionAgent?: "engineer" | "frontend-engineer" } & Record<string, unknown>} attrs
 * @param {(fixture: IncompleteRepairFixture) => Promise<void>} run
 */
async function withIncompleteRepairModel(prefix, attrs, run) {
    await withRuntimeCommandFixture(prefix, async ({ setModelResponseFactory }) => {
        const prompts = /** @type {string[]} */ ([]);
        setModelResponseFactory((context) => {
            prompts.push(JSON.stringify(context));
            return fauxAssistantMessage(fauxText("Repair remains incomplete."));
        });
        const fixture = await makeImplementedRun(attrs);
        try {
            await run({ ...fixture, prompts });
        } finally {
            fixture.hostedSession.dispose();
        }
    });
}

Deno.test("runValidationLoop preserves Frontend Engineer owner when CI repair pauses", async () => {
    await withIncompleteRepairModel(
        "validation-repair-frontend-",
        { executionAgent: "frontend-engineer" },
        async ({ projectRoot, hostedSession, prompts }) => {
            const result = await runValidationPhase({
                hostedSession,
                planName: "p",
                planContent: "# p",
                triageMeta: { classification: "QUICK_FIX", status: "implemented" },
                localCI: {
                    run: () => Promise.resolve({ kind: "completed", exitCode: 1, output: "css failed" }),
                },
            });

            const plan = await loadPlan(projectRoot, "p");
            assertEquals(result.kind, "paused");
            assertEquals(hostedSession.getRootAgentName(), "frontend-engineer");
            assertStringIncludes(prompts[0], "css failed");
            assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAgent, "frontend-engineer");
            assertEquals(plan?.attrs.validationCiAttempts, 1);
        },
    );
});

Deno.test("runValidationLoop offers a way out when the repair rounds for CI are spent", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "implemented",
        validationCiAttempts: 2,
    });
    const { hostedSession, uiAPI } = makeValidationUi();
    const offeredOptions = /** @type {string[]} */ ([]);
    selectAndCaptureOptions(uiAPI, offeredOptions, "stop");
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented", validationCiAttempts: 2 },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented", validationCiAttempts: 2 },
        semanticReviewPort: repairPort(),
        localCI: {
            run: () => Promise.resolve({ kind: "completed", exitCode: 1, output: "type error" }),
        },
    });

    const plan = await loadPlan(projectRoot, "p");
    // The user is asked before RunWield gives up, and told what would help.
    assertEquals(uiAPI.promptSelections.length, 1);
    assertEquals(result.kind, "paused");
    assertStringIncludes(result.reason || "", "still failing");
    assertStringIncludes(result.reason || "", "Pick Engineer follow-up");
    assertEquals(offeredOptions, ["Engineer follow-up", "Retry", "Stop"]);
    assertEquals(plan?.attrs.status, "implemented");
    // Exhaustion must survive a pause, not grant three more automatic repairs.
    assertEquals(plan?.attrs.validationCiAttempts, 3);
});

Deno.test("Retry after the CI rounds run out runs the tests again and carries on", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "implemented",
        validationCiAttempts: 2,
    });
    const { hostedSession, uiAPI } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented", validationCiAttempts: 2 },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    // The user fixes the tests, then picks Retry — exactly what the pause told them
    // to do. RunWield must run them again in the same breath, not make the user
    // start the whole Plan over.
    let ciRuns = 0;
    uiAPI.promptSelect = () => {
        uiAPI.promptSelections.push("prompted");
        return Promise.resolve("retry");
    };

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented", validationCiAttempts: 2 },
        semanticReviewPort: repairPort(),
        localCI: {
            run: () => {
                ciRuns += 1;
                return Promise.resolve(
                    ciRuns <= 2
                        ? { kind: "completed", exitCode: 1, output: "type error" }
                        : { kind: "completed", exitCode: 0, output: "ok" },
                );
            },
        },
    });

    assertEquals(uiAPI.promptSelections.length, 1);
    assertEquals(ciRuns, 3);
    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "implemented");
});

Deno.test("a stopped test run asks rather than reporting the work as broken", async () => {
    const projectRoot = await makeValidationProjectRoot("p", { classification: "QUICK_FIX", status: "implemented" });
    const { hostedSession, uiAPI } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        localCI: {
            run: () => Promise.resolve({ kind: "canceled", output: "" }),
        },
    });

    assertEquals(uiAPI.promptSelections.length, 1);
    assertEquals(result.kind, "paused");
    assertStringIncludes(result.reason || "", "stopped before they finished");
    // Nothing was learned, so nothing is recorded: the Plan stays where it was.
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "implemented");
});

Deno.test("stopped validation can return control to the Engineer session", async () => {
    const projectRoot = await makeValidationProjectRoot("p", { classification: "QUICK_FIX", status: "implemented" });
    const { hostedSession, uiAPI } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented" },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    const offeredOptions = /** @type {string[]} */ ([]);
    selectAndCaptureOptions(uiAPI, offeredOptions, "engineer_follow_up");

    const result = await runValidationPhase({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "QUICK_FIX", status: "implemented" },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        localCI: {
            run: () => Promise.resolve({ kind: "canceled", output: "" }),
        },
    });

    assertEquals(result.kind, "paused");
    assertStringIncludes(result.reason || "", "Engineer follow-up");
    assertEquals(offeredOptions, ["Engineer follow-up", "Retry", "Stop"]);
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.executionAgent, "engineer");
    assertEquals(hostedSession.getActiveExecutionWorkflow()?.validationContinuation, true);
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "implemented");
});

Deno.test("runValidationPhase keeps canonical progress when a stale checkpoint still names Mechanical Validation", async () => {
    await withIncompleteRepairModel("validation-repair-rerun-", {}, async ({ projectRoot, hostedSession }) => {
        /** @type {number[]} */
        const ciExitCodes = [];
        /** @type {import("./validation-local-ci.ts").LocalCIPort} */
        const localCI = {
            run: () => {
                ciExitCodes.push(1);
                return Promise.resolve({ kind: "completed", exitCode: 1, output: "type error" });
            },
        };

        const first = await runValidationPhase({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "QUICK_FIX", status: "implemented" },
            localCI,
        });
        assertEquals(first.kind, "paused");
        assertEquals(ciExitCodes.length, 1);

        // Simulate a process boundary where Mechanical Validation passed and recorded
        // its status, but the durable checkpoint stopped before it could settle and
        // still names the mechanical phase.
        await recordPlanEvent({
            cwd: projectRoot,
            planName: "p",
            event: "mechanical_validation_passed",
            currentStatus: "implemented",
            details: { triageMeta: { classification: "QUICK_FIX", status: "implemented" } },
        });
        const advanced = await loadPlan(projectRoot, "p");
        assertExists(advanced);
        assertEquals(advanced.attrs.status, "implemented");
        const checkpoint = makeValidationCheckpoint({
            attemptId: "in-place",
            generation: crypto.randomUUID(),
            status: "implemented",
            phase: "mechanical",
            state: "running",
        });
        await savePlan(projectRoot, "p", advanced.body, {
            ...advanced.attrs,
            validationCheckpoint: checkpoint,
        }, { expectedRevision: advanced.revision });

        // The lifecycle event is the durable proof that CI passed, so the lagging
        // checkpoint cannot send the Plan back to the build. Validation carries on at
        // the phase the canonical status asks for.
        const second = await runValidationPhase({
            hostedSession,
            planName: "p",
            planContent: "# p",
            triageMeta: { classification: "QUICK_FIX", status: "validated_ci", validationCheckpoint: checkpoint },
            continuationPhase: checkpoint.nextPhase,
            validationCheckpoint: checkpoint,
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
            localCI,
        });

        assertEquals(second.kind, "paused");
        assertEquals(ciExitCodes.length, 1, "Expected CI not to run again for checks the Plan already records.");
        const settled = await loadPlan(projectRoot, "p");
        assertExists(settled);
        assertEquals(settled.attrs.status, "reviewed");
    });
});
