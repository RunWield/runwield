import { assertEquals, assertStringIncludes } from "@std/assert";

import { loadPlan, savePlan } from "../../plan-store.js";
import {
    makeRecordedSession,
    makeUi,
    makeValidationProjectRoot,
    NO_ISOLATED_AGENT_PORT,
    runValidationLoop,
} from "./validation-test-helpers.js";

function makeValidationUi() {
    const uiAPI = makeUi();
    return { uiAPI, hostedSession: makeRecordedSession("validation-delivery-test", uiAPI) };
}

Deno.test("runValidationLoop does not preserve a nonexistent Plan path for quick-fix worktrees", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "verified");
    assertEquals(plan?.attrs.status, "verified");
    assertEquals(plan?.attrs.deliveryEvidence, { version: 1, mode: "non_git_in_place" });
});

Deno.test("runValidationLoop publishes only from reviewed after human review is durably complete", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta: {
            classification: "QUICK_FIX",
            status: "reviewed",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    const plan = await loadPlan(projectRoot, "p");
    assertEquals(result.kind, "verified");
    assertEquals(plan?.attrs.status, "verified");
    assertEquals(plan?.attrs.deliveryEvidence?.mode, "non_git_in_place");
    assertEquals(plan?.attrs.humanReviewDecision, "not_required");
});

Deno.test("Epic child delivery commits its Manual QA artifact with verified metadata", async () => {
    const projectRoot = await makeValidationProjectRoot("epic/01-one", {
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        parentPlan: "epic",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    await savePlan(projectRoot, "epic", "# Epic", {
        classification: "PROJECT",
        status: "ready_for_work",
        summary: "Epic",
    });
    const { hostedSession } = makeValidationUi();
    hostedSession.setActiveExecutionWorkflow({
        planName: "epic/01-one",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            parentPlan: "epic",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "epic/01-one",
        planContent: "# One\n\nimplemented child",
        triageMeta: {
            classification: "PLANNED_CHANGE",
            status: "reviewed",
            parentPlan: "epic",
            humanReviewMode: "none",
            humanReviewDecision: "not_required",
        },
        semanticReviewPort: {
            runIsolatedAgentSession: async (options) => {
                const qaTool = options.customTools?.find((tool) => tool.name === "qa_checklist_generated");
                if (!qaTool) throw new Error("qa_checklist_generated tool missing");
                const toolResult = await qaTool.execute(
                    "call",
                    { checklistMarkdown: "Manual verification steps for epic/01-one\n\n- [ ] Check delivered child" },
                    undefined,
                    undefined,
                    /** @type {import('@earendil-works/pi-coding-agent').ExtensionToolContext} */ ({}),
                );
                return [{
                    role: "toolResult",
                    toolCallId: "call",
                    toolName: "qa_checklist_generated",
                    content: toolResult.content,
                    isError: false,
                    timestamp: Date.now(),
                }];
            },
        },
    });

    assertEquals(result.kind, "verified");
    assertEquals(result.epicContinuation?.completedPlanName, "epic/01-one");
    assertEquals(result.epicContinuation?.projectRoot, projectRoot);
    assertEquals((await loadPlan(projectRoot, "epic/01-one"))?.attrs.status, "verified");
    const artifact = await Deno.readTextFile(`${projectRoot}/docs/plans/epic/manual-qa.md`);
    assertStringIncludes(artifact, "# Manual QA for epic");
    assertStringIncludes(artifact, "This checklist is advisory. It does not change RunWield verification status.");
    assertStringIncludes(artifact, '<!-- runwield:manual-qa:start child="epic/01-one" -->');
    assertStringIncludes(artifact, "Manual verification steps for epic/01-one");
    assertStringIncludes(artifact, "- [ ] Check delivered child");
    assertStringIncludes(artifact, '<!-- runwield:manual-qa:end child="epic/01-one" -->');
});

Deno.test("Epic child publication stops when the Manual QA Agent has a fatal failure", async () => {
    const projectRoot = await makeValidationProjectRoot("epic/01-one", {
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        parentPlan: "epic",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    await savePlan(projectRoot, "epic", "# Epic", {
        classification: "PROJECT",
        status: "ready_for_work",
        summary: "Epic",
    });
    const { hostedSession } = makeValidationUi();
    /** @type {import('../../tools/plan-written.ts').TriageMeta} */
    const triageMeta = {
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        parentPlan: "epic",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    };
    hostedSession.setActiveExecutionWorkflow({
        planName: "epic/01-one",
        triageMeta,
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "epic/01-one",
        planContent: "# One\n\nimplemented child",
        triageMeta,
        semanticReviewPort: {
            runIsolatedAgentSession: () => Promise.reject(new Error("Agent policy denied this operation")),
        },
    });

    assertEquals(result.kind, "failed");
    assertEquals((await loadPlan(projectRoot, "epic/01-one"))?.attrs.status, "reviewed");
});

Deno.test("publication pauses on missing target branch metadata without recording validation failure", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    });
    const { hostedSession } = makeValidationUi();
    /** @type {import('../../tools/plan-written.ts').TriageMeta} */
    const triageMeta = {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "none",
        humanReviewDecision: "not_required",
    };
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta,
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        worktreeBranch: "runwield/worktree/p-wt1",
    });

    const result = await runValidationLoop({
        hostedSession,
        planName: "p",
        planContent: "# p",
        triageMeta,
        semanticReviewPort: NO_ISOLATED_AGENT_PORT,
    });

    assertEquals(result.kind, "paused");
    assertEquals((await loadPlan(projectRoot, "p"))?.attrs.status, "reviewed");
});
