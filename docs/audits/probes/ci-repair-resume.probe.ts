import { rm } from "node:fs/promises";
import { test } from "node:test";
// Historical audit probe; run explicitly through scripts/run-tests.js.
// See ../2026-09-07-plan-workflow-transitions.md. This is a controlled interruption,
// not an OS process-kill test: a fresh Session consumes a real saved adapter state.
import { assertEquals, assertExists } from "../../../src/testing/assertions.ts";
import { loadPlan } from "../../../src/plan-store.js";
import { HostedSession } from "../../../src/shared/session/hosted-session.js";
import type { SemanticReviewPort } from "../../../src/shared/workflow/validation-session-adapter.ts";
import { continueWorkflowValidation } from "../../../src/shared/workflow/validation-supervisor.ts";
import { makeStubGitPort, makeValidationProjectRoot } from "../../../src/shared/workflow/validation-test-helpers.js";

type ValidationArgs = Parameters<typeof continueWorkflowValidation>[0];
type LocalCI = NonNullable<ValidationArgs["localCI"]>;

function attachWorkflow(hostedSession: HostedSession, projectRoot: string) {
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
}

function runValidation(hostedSession: HostedSession, localCI: LocalCI, semanticReviewPort?: SemanticReviewPort) {
    return continueWorkflowValidation({
        trigger: "session_resume",
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: { classification: "PLANNED_CHANGE", status: "implemented", humanReviewMode: "none" },
        git: makeStubGitPort(),
        localCI,
        semanticReviewPort: semanticReviewPort || {
            runIsolatedAgentSession: () => Promise.reject(new Error("unexpected isolated Agent turn")),
        },
        workRecordMnemotecaPort: {
            run: () => Promise.reject(new Error("publication must not run in this probe")),
        },
    });
}

test("AUDIT A3: actual CI repair checkpoint resumes at mechanical validation", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "PLANNED_CHANGE",
        status: "implemented",
        humanReviewMode: "none",
        executionMode: "non_git_in_place",
    });
    const firstSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(firstSession, projectRoot);
    let releaseRepair = () => {};
    let enteredRepair = () => {};
    const entered = new Promise<void>((resolve) => {
        enteredRepair = resolve;
    });
    const release = new Promise<void>((resolve) => {
        releaseRepair = resolve;
    });
    const firstRun = runValidation(
        firstSession,
        { run: () => Promise.resolve({ kind: "completed", exitCode: 1, output: "broken" }) },
        {
            runIsolatedAgentSession: async () => {
                enteredRepair();
                await release;
                return [];
            },
        },
    );
    await entered;
    const saved = await loadPlan(projectRoot, "p");
    assertExists(saved);
    assertEquals(saved.attrs.validationCheckpoint?.state, "awaiting_repair");
    assertEquals(saved.attrs.validationCheckpoint?.repairKind, "ci");
    console.log("AUDIT A3 live checkpoint", JSON.stringify(saved.attrs.validationCheckpoint));
    const resumedSession = new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot });
    attachWorkflow(resumedSession, projectRoot);
    let resumedCiRuns = 0;
    try {
        const resumed = await runValidation(resumedSession, {
            run: () => {
                resumedCiRuns += 1;
                return Promise.resolve({ kind: "canceled", output: "stop after observing check" });
            },
        });
        console.log("AUDIT A3 resumed result", JSON.stringify(resumed), "CI runs", resumedCiRuns);
        assertEquals(resumedCiRuns, 1, "An interrupted CI repair must resume by checking current files.");
    } finally {
        releaseRepair();
        await firstRun;
        firstSession.dispose();
        resumedSession.dispose();
        await rm(projectRoot, { recursive: true });
    }
});
