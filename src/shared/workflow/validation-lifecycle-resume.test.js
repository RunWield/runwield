import { assertEquals, assertThrows } from "@std/assert";
import { makeValidationProjectRoot, NO_ISOLATED_AGENT_PORT, runValidationPhase } from "./validation-test-helpers.js";

/** @param {string} projectRoot */
function makeHostedSession(projectRoot) {
    return /** @type {import('../session/hosted-session.js').HostedSession} */ (/** @type {unknown} */ ({
        cwd: projectRoot,
        getActiveExecutionWorkflow: () => null,
        clearActiveExecutionWorkflow: () => {},
        setActiveExecutionWorkflow: () => {},
    }));
}

Deno.test("validated_ci resumes at semantic review without rerunning CI", async () => {
    const projectRoot = await makeValidationProjectRoot("demo", {
        status: "validated_ci",
        executionMode: "non_git_in_place",
    });
    try {
        let ciCalls = 0;
        const result = await runValidationPhase({
            planName: "demo",
            planContent: "---\nstatus: implemented\nclassification: FEATURE\n---\n# Demo\n",
            triageMeta: { classification: "FEATURE" },
            sessionManager: undefined,
            hostedSession: makeHostedSession(projectRoot),
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
            localCI: {
                run: () => {
                    ciCalls += 1;
                    return Promise.reject(new Error("CI must not run"));
                },
            },
        });

        assertEquals(ciCalls, 0);
        assertEquals(result.kind, "paused");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("reviewed with no human decision runs only the human review phase", async () => {
    const projectRoot = await makeValidationProjectRoot("demo", {
        status: "reviewed",
        humanReviewDecision: null,
        executionMode: "non_git_in_place",
    });
    try {
        let ciCalls = 0;
        const result = await runValidationPhase({
            planName: "demo",
            planContent: "---\nstatus: reviewed\nhumanReviewDecision: null\nclassification: FEATURE\n---\n# Demo\n",
            triageMeta: { status: "reviewed", humanReviewDecision: null, classification: "FEATURE" },
            sessionManager: undefined,
            hostedSession: makeHostedSession(projectRoot),
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
            localCI: {
                run: () => {
                    ciCalls += 1;
                    return Promise.reject(new Error("CI must not run"));
                },
            },
        });

        assertEquals(result.kind, "paused");
        assertEquals(
            result.reason,
            "Code review is still waiting for your decision. Resume with /load-plan demo to choose again.",
        );
        assertEquals(ciCalls, 0);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("semantic_review_passed is illegal from implemented and verified", async () => {
    const { buildPlanEventUpdates } = await import("./plan-lifecycle.js");
    assertThrows(
        () => buildPlanEventUpdates("semantic_review_passed", "implemented"),
        Error,
        'semantic_review_passed cannot apply to status "implemented"',
    );
    assertThrows(
        () => buildPlanEventUpdates("semantic_review_passed", "verified"),
        Error,
        'semantic_review_passed cannot apply to status "verified"',
    );
});
