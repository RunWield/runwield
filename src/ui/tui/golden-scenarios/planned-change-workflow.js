/**
 * @module ui/tui/golden-scenarios/planned-change-workflow
 * Composed Golden PLANNED_CHANGE workflow scenarios.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";
import { assertRuntimeEvent, assertsGoldenCoverage } from "../testing/portfolio-assertions.js";

/** @typedef {import('../testing/scenario-runner.js').GoldenScenarioResult} GoldenScenarioResult */
/** @typedef {{ shownExplanationIds?: string[], recapShown?: boolean }} TutorialContextSnapshot */
/** @typedef {{ runtimeSnapshot?: { tutorialContext?: TutorialContextSnapshot } }} TutorialCapturedState */
/** @typedef {{ remoteHead?: string, remotePlanStatus?: string, deliveredText?: string }} TutorialPublicationState */
/**
 * @typedef {object} TutorialScenarioState
 * @property {{ head?: string }} [publicationBaseline]
 * @property {TutorialCapturedState} [tutorialPausedState]
 * @property {TutorialCapturedState} [tutorialRepairedState]
 * @property {TutorialCapturedState} [projectState]
 * @property {TutorialCapturedState} [tutorialCompletedState]
 * @property {TutorialCapturedState} [tutorialReloadedCompletedState]
 * @property {TutorialPublicationState} [tutorialPublicationBeforeReload]
 * @property {TutorialPublicationState} [tutorialPublicationAfterReload]
 */

/**
 * @param {GoldenScenarioResult} result
 * @param {string} text
 * @returns {number}
 */
function countVisibleOccurrences(result, text) {
    const haystack = `${result.scrollbackText || ""}\n${result.screenText || ""}`;
    return haystack.split(text).length - 1;
}

/** @param {GoldenScenarioResult} result */
function assertRealPlanReviewRevisionAndApproval(result) {
    assertEventIncludes(result, "interaction:PLAN_REVIEW:feedback");
    assertEventIncludes(result, "interaction:PLAN_REVIEW:approved");
    assertEventIncludes(result, "review_feedback");
    assertEventIncludes(result, "review_approved");
    const planReview =
        /** @type {{ lifecycleEvents?: Array<{ event: string, status?: unknown }>, plan?: string } | undefined} */ (result
            .state.planReview);
    assert(planReview, "Expected production Plan Review transaction state.");
    assert(
        planReview.lifecycleEvents?.map((event) => `${event.event}:${event.status}`).join(",") ===
            "review_feedback:feedback,review_approved:approved",
        `Expected persisted feedback then approval; got ${JSON.stringify(planReview.lifecycleEvents)}`,
    );
    assert(
        String(planReview.plan || "").includes("Golden PLANNED_CHANGE revised content."),
        "Expected reviewed revised Plan content to persist.",
    );
    assertScreenIncludes(result, 'Plan "plan" approved');
    assertEventIncludes(result, "runtime:tool:start:write");
    assertEventIncludes(result, "runtime:tool:start:task_completed");
    assertEventIncludes(result, "runtime:tool:start:review_complete");
    assertEventIncludes(result, "runtime:tool:start:review_complete");
    assertScreenIncludes(result, "Published commit confirmed on main.");
    assertEventIncludes(result, "runtime:tool:start:review_complete");
    assertScreenIncludes(result, "found no need for a fix");
    assertScreenIncludes(result, "Merging work into main");
    assertEventIncludes(result, "workflow:durability:delivery-checked");
    assertEventIncludes(result, "workflow:durability:registry-clean");
    assertEventIncludes(result, "workflow:durability:ancestry-checked");
    assertEventIncludes(result, "workflow:durability:evidence-recorded");
    assertEventIncludes(result, "workflow:durability:terminal-ready");
    const durability =
        /** @type {{ goldenFileExists?: boolean, trackedFiles?: string, deliveryLog?: string, deliveryEvidence?: string, status?: string, validatedExecutionCommit?: string, executionCommitPublished?: boolean, editorUsable?: boolean } | undefined} */ (result
            .state.workflowDurability);
    assert(durability?.goldenFileExists === true, "Expected delivered Golden file to exist after Workflow Validation.");
    assert(
        String(durability?.trackedFiles || "").includes("golden-planned-change.txt"),
        "Expected delivered file tracked in Git.",
    );
    assert(String(durability?.deliveryLog || "").length > 0, "Expected Git ancestry evidence for delivery commit.");
    assert(
        String(durability?.validatedExecutionCommit || "").length > 0,
        "Expected validated execution commit evidence.",
    );
    assert(
        durability?.executionCommitPublished === true,
        "Expected validated execution commit published to delivered HEAD.",
    );
    assert(
        String(durability?.deliveryEvidence || "").includes("golden"),
        "Expected recorded delivery evidence content.",
    );
    const statusLines = String(durability?.status || "").split("\n").filter(Boolean);
    assert(
        // Plus the Work Record the post-verification handoff writes under docs/, which
        // is a product output the user keeps or discards, not publication residue.
        statusLines.every((line) => {
            const path = line.slice(3).trim();
            return line.endsWith("docs/plans/plan.md") || line.endsWith(".wld/internal/worktrees.json") ||
                line.endsWith("docs/") || line.includes("docs/work-records/") || path === ".gitignore" ||
                path === ".wld/settings.json";
        }),
        `Expected only lifecycle/registry status after Direct Delivery publication; got ${statusLines.join("; ")}`,
    );
    assert(durability?.editorUsable === true, "Expected terminal/editor ready after verification.");
}

export const plannedChangeReviewRepairValidationScenario = {
    // This scenario tests direct target delivery; human policy gates have dedicated journeys.
    globalSettings: {
        defaultProvider: "golden",
        defaultModel: "faux",
        codereview: "none",
        plans: { autoMergeIntoTargetBranch: true },
    },
    name: "planned-change-review-repair-validation-delivery",
    composedTui: true,
    initialAgentName: "planner",
    terminal: { columns: 100, rows: 30 },
    // The whole journey — real Git, real transactions, real Agent turns — takes ~55s on
    // its own. `deno task ci` runs 12 files at a time, and this bounds the child process,
    // so it is sized for the contended case rather than the standalone one.
    timeoutMs: 420000,
    captureModelTurns: true,
    interactiveSelectPrompts: ["What would you like to do next?"],
    coverage: [
        "workflow:PLANNED_CHANGE",
        "context:plan-engineer-identity",
        "recovery:reviewer-rejection",
        "recovery:workflow-validation",
        "durable:plan-lifecycle",
        "durable:worktree-publication",
        "durable:registry-cleanup",
        "terminal:post-publication-input",
        "block:review-result",
        "block:validation-handoff",
    ],
    reviewDecisions: [
        { approved: false, feedback: "Reviewer-style feedback: narrow the implementation and resubmit." },
        { approved: true, feedback: "Approved to run.", approvalAction: "run" },
    ],
    reviewedPlan: "# Golden PLANNED_CHANGE\n\nGolden PLANNED_CHANGE revised content.\n",
    scriptedInteractions: [
        { type: "text", promptIncludes: "Enter the command that runs this project's tests", value: "true" },
    ],
    script: [
        {
            id: "planner-submit-feedback-round",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            thinking: "Submit draft for Plan Review feedback.",
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "plan",
                },
            }],
        },
        {
            id: "planner-submit-approval-round",
            agent: "planner",
            phase: "plan_review",
            ordinal: 2,
            requiredTools: ["plan_written"],
            thinking: "Resubmit revised Plan for approval and execution.",
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "plan",
                },
            }],
        },
        {
            id: "engineer-implements-plan",
            agent: "engineer",
            phase: "engineer",
            ordinal: 1,
            requiredTools: ["write"],
            thinking: "Implement the approved PLANNED_CHANGE in the execution worktree.",
            toolCalls: [{ name: "write", arguments: { path: "golden-planned-change.txt", content: "golden" } }],
        },
        {
            // `task_completed` terminates its Agent turn. Keeping it in the same
            // model response as a mutating tool lets the runtime cancel that sibling
            // while it has opened the file but not written it yet; under parallel CI
            // validation then checkpoints an empty implementation. A real completion
            // report comes after the implementation tool has settled, so the Golden
            // actor models that ordering in a separate turn too.
            id: "engineer-reports-plan-complete",
            agent: "engineer",
            phase: "engineer",
            ordinal: 2,
            requiredTools: ["task_completed"],
            thinking: "Report the completed and verified implementation.",
            toolCalls: [{
                name: "task_completed",
                arguments: { message: "- Implemented Golden PLANNED_CHANGE and verified with true." },
            }],
        },
        {
            id: "semantic-reviewer-rejects-implementation-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 1,
            // Workflow Validation rejects a verdict reached without opening the
            // diff, so the scripted Reviewer must read it exactly as a real one
            // does before calling review_complete.
            requiredTools: ["review_diff"],
            thinking: "Inspect every changed file before deciding.",
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "golden-planned-change.txt" },
                },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".wld/settings.json" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: "docs/plans/plan.md" } },
            ],
        },
        {
            id: "semantic-reviewer-rejects-implementation",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 2,
            // Workflow Validation rejects a verdict reached without opening the
            // diff, so the scripted Reviewer must read it exactly as a real one
            // does before calling review_complete.
            requiredTools: ["review_complete"],
            toolCalls: [
                {
                    name: "review_complete",
                    arguments: {
                        approved: false,
                        feedback: "Repair required: add durable evidence.",
                        findings: [{
                            status: "new",
                            title: "Missing durable evidence",
                            requirement: "Plan",
                            evidence: "golden-planned-change.txt",
                        }],
                    },
                },
            ],
        },
        {
            id: "engineer-repairs-after-reviewer-rejection",
            agent: "engineer",
            phase: "engineer",
            ordinal: 3,
            requiredTools: ["write"],
            thinking: "Repair in the same active PLANNED_CHANGE workflow after reviewer rejection.",
            toolCalls: [{
                name: "write",
                arguments: { path: "golden-planned-change.txt", content: "goldenrepaired" },
            }],
        },
        {
            id: "engineer-reports-review-repair-complete",
            agent: "engineer",
            phase: "engineer",
            ordinal: 4,
            requiredTools: ["task_completed"],
            thinking: "Report the completed semantic-review repair.",
            toolCalls: [{
                name: "task_completed",
                arguments: { message: "- Repaired Golden PLANNED_CHANGE after Reviewer rejection." },
            }],
        },
        {
            id: "semantic-reviewer-approves-repair-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 3,
            requiredTools: ["review_diff"],
            thinking: "Inspect every changed file before deciding.",
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "golden-planned-change.txt" },
                },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".wld/settings.json" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: "docs/plans/plan.md" } },
            ],
        },
        {
            id: "semantic-reviewer-approves-repair",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 4,
            requiredTools: ["review_complete"],
            toolCalls: [
                {
                    name: "review_complete",
                    arguments: {
                        approved: true,
                        feedback: "Approved after repair.",
                        findings: [{ id: "R1-1", resolved: true, title: "Missing durable evidence" }],
                    },
                },
            ],
        },
    ],
    actions: [
        {
            type: "writeProjectFile",
            path: "docs/plans/plan.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Golden PLANNED_CHANGE\naffectedPaths: []\nstatus: draft\n---\n# Golden PLANNED_CHANGE\n\nDraft content.\n",
        },
        { type: "type", text: "submit the planned change for review" },
        { type: "enter" },
        // The whole PLANNED_CHANGE journey runs inside these waits: plan review,
        // execution, CI, two semantic rounds with a repair between them, the merge,
        // and the post-verification handoffs. It takes about 60s on its own, and the 12s
        // budget it used to carry only ever fit because the run died at the repair.
        //
        // The budget is deliberately several times the standalone cost. `deno task ci`
        // runs 12 files at a time, and a scenario this heavy — real Git worktrees, real
        // transactions, real agent turns — stretches by more than 50% under that load. A
        // ceiling sized to the standalone run fails on contention rather than on defects.
        { type: "waitForIdle", timeoutMs: 240000 },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        { type: "waitForRemotePlanStatus", planName: "plan", statuses: ["verified"], timeoutMs: 240000 },
        { type: "waitForWorktreeRegistryStatus", planName: "plan", statuses: ["absent"], timeoutMs: 90000 },
        { type: "waitForIdle", timeoutMs: 90000 },
        { type: "assertWorkflowDurability" },
        { type: "waitForScreen", text: "What would you like to do next?", timeoutMs: 15000 },
        { type: "escape" },
        { type: "setNextModelResponse", text: "Post-publication follow-up accepted in the completed workflow." },
        { type: "type", text: "confirm the completed workflow is still interactive" },
        { type: "enter" },
        {
            type: "waitForScreen",
            text: "Post-publication follow-up accepted in the completed workflow.",
            timeoutMs: 60000,
        },
        { type: "waitForIdle", timeoutMs: 60000 },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:PLANNED_CHANGE", assertRealPlanReviewRevisionAndApproval),
        assertsGoldenCoverage("context:plan-engineer-identity", (result) => {
            assertEventIncludes(result, "runtime:agent:plan-engineer");
            const turns = Array.isArray(result.state.modelTurns) ? result.state.modelTurns : [];
            const executionTurn = turns.find((turn) =>
                turn?.runtimeAgent === "plan-engineer" &&
                String(turn?.systemPrompt || "").includes("You are the Plan Engineer")
            );
            assert(
                executionTurn,
                `Expected actual Plan Engineer system prompt in model turns; got ${
                    JSON.stringify(turns.map((turn) => ({ agent: turn?.agent, runtimeAgent: turn?.runtimeAgent })))
                }`,
            );
            assert(
                !String(executionTurn.systemPrompt || "").includes("Quick Fix Checklist"),
                "Plan execution must not use Quick Fix prompt context.",
            );
        }),
        assertsGoldenCoverage("recovery:reviewer-rejection", (result) => {
            assertEventIncludes(result, "runtime:tool:start:review_complete");
            assertScreenIncludes(result, "found no need for a fix");
        }),
        assertsGoldenCoverage("recovery:workflow-validation", (result) => {
            assertScreenIncludes(result, "Published commit confirmed on main.");
            assertEventIncludes(result, "workflow:durability:terminal-ready");
            const transcript = `${result.scrollbackText || ""}\n${result.screenText || ""}`;
            assertEquals(
                transcript.includes("Objective-Failing Check"),
                false,
                "The full Plan journey must not request or run the retired Objective Check phase.",
            );
        }),
        assertsGoldenCoverage("durable:plan-lifecycle", (result) => {
            const planReview =
                /** @type {{ lifecycleEvents?: Array<{ event: string, status?: unknown }> } | undefined} */ (result
                    .state.planReview);
            assert(planReview?.lifecycleEvents?.some((event) => event.event === "review_feedback"));
            assert(planReview?.lifecycleEvents?.some((event) => event.event === "review_approved"));
        }),
        assertsGoldenCoverage("durable:worktree-publication", (result) => {
            const durability =
                /** @type {{ executionCommitPublished?: boolean } | undefined} */ (result.state.workflowDurability);
            assert(durability?.executionCommitPublished === true, "Expected validated commit publication.");
        }),
        assertRuntimeEvent("durable:registry-cleanup", "workflow:durability:registry-clean"),
        assertsGoldenCoverage("terminal:post-publication-input", (result) => {
            assertScreenIncludes(result, "confirm the completed workflow is still interactive");
            assertScreenIncludes(result, "Post-publication follow-up accepted in the completed workflow.");
            assert(result.state.editorUsable === true, "Expected input to remain ready after the follow-up.");
        }),
        // The inline verdict block, asserted where it renders. `Reviewer:` is its own
        // header — the pinned panel titles the same report "Reviewer latest AI review" —
        // and the verdict line is the body it exists to show.
        assertsGoldenCoverage("block:review-result", (result) => {
            const transcript = `${result.scrollbackText || ""}\n${result.screenText || ""}`;
            assertStringIncludes(transcript, "reviewer:");
            assertStringIncludes(transcript, "Semantic review rejected — 1 issue open:");
        }),
        // The pinned panel, asserted on the screen it is supposed to be pinned to.
        // This capability used to be claimed by a runtime-event assertion, which is
        // why the panel could disappear from every PLANNED_CHANGE run — the status
        // lines stopped carrying `validationProgress` — with the matrix still green.
        assertsGoldenCoverage("block:validation-handoff", (result) => {
            // These strings exist only inside the live panel's own rendering. An earlier
            // attempt asserted "Workflow Validation", which the Engineer's handoff
            // line also contains — it passed with the panel fully disabled.
            const transcript = `${result.scrollbackText || ""}\n${result.screenText || ""}`;
            assertStringIncludes(transcript, "AI review running");
            assertStringIncludes(transcript, "reviewer latest AI review");
        }),
    ],
};

export const onboardingTutorialDeliveryScenario = {
    ...plannedChangeReviewRepairValidationScenario,
    name: "onboarding-tutorial-real-change-delivery",
    // Publication may finish before reload. Drive either the live completion
    // prompt or the already-verified Plan menu through the real terminal.
    interactiveSelectPrompts: ["What would you like to do next?", "What would you like to do?"],
    slashCommands: ["onboard"],
    onboardingOfferHandled: false,
    committedProjectFiles: [
        {
            path: "tutorial-behavior.test.ts",
            text:
                'import { tutorialLabel } from "./tutorial-behavior.ts";\nDeno.test("tutorial behavior", () => { if (tutorialLabel() !== "ready") throw new Error("not ready"); });\n',
        },
    ],
    coverage: [...plannedChangeReviewRepairValidationScenario.coverage, "tutorial:onboarding"],
    scriptedInteractions: [
        { type: "select", promptIncludes: "This tutorial makes a real change", value: "start" },
        { type: "select", promptIncludes: "Tutorial guidance", value: "continue" },
        ...plannedChangeReviewRepairValidationScenario.scriptedInteractions.map((interaction) =>
            interaction.type === "text" && interaction.promptIncludes.includes("runs this project's tests")
                ? { ...interaction, value: "sleep 5; deno test tutorial-behavior.test.ts" }
                : interaction
        ),
        { type: "select", promptIncludes: "were stopped before they finished", value: "stop" },
        { type: "select", promptIncludes: "Resume tutorial guidance", value: "resume" },
        { type: "select", promptIncludes: "Plan recovery", value: "validate" },
    ],
    script: [
        {
            id: "tutorial-planner-suggests-small-changes",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            thinking: "Inspect a bounded area and offer a small set of real improvements.",
            text:
                "Choose one small improvement: clarify the Quickstart tutorial, tighten one validation message, or improve one command description.",
        },
        ...plannedChangeReviewRepairValidationScenario.script.map((turn) => {
            if (turn.agent === "planner" && turn.phase === "plan_review") {
                return { ...turn, ordinal: Number(turn.ordinal) + 1 };
            }
            if (turn.id === "engineer-implements-plan") {
                return {
                    ...turn,
                    toolCalls: [
                        ...turn.toolCalls,
                        {
                            name: "write",
                            arguments: {
                                path: "tutorial-behavior.ts",
                                content: 'export function tutorialLabel() { return "ready"; }\n',
                            },
                        },
                    ],
                };
            }
            if (turn.agent === "reviewer" && turn.requiredTools?.includes("review_diff")) {
                return {
                    ...turn,
                    toolCalls: [
                        ...turn.toolCalls,
                        {
                            name: "review_diff",
                            arguments: { command: "show", scope: "full", path: "tutorial-behavior.ts" },
                        },
                        {
                            name: "review_diff",
                            arguments: { command: "show", scope: "full", path: "tutorial-behavior.test.ts" },
                        },
                    ],
                };
            }
            return turn;
        }),
    ],
    actions: [
        plannedChangeReviewRepairValidationScenario.actions[0],
        { type: "capturePublicationBaseline" },
        { type: "type", text: "Use the documentation clarification and submit it for Plan Review" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        { type: "waitForScreen", text: "Running the tests in", timeoutMs: 60000 },
        { type: "escape" },
        { type: "waitForIdle", timeoutMs: 60000 },
        { type: "captureProjectState", planNames: ["plan"], key: "tutorialPausedState" },
        { type: "restartTui", sessionStartMode: "continue" },
        { type: "type", text: "/load-plan plan" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEventCount", event: "runtime:tool:end:task_completed", count: 2, timeoutMs: 240000 },
        { type: "waitForEventCount", event: "runtime:turn_end", count: 9, timeoutMs: 60000 },
        { type: "escape" },
        { type: "waitForIdle", timeoutMs: 60000 },
        { type: "captureProjectState", planNames: ["plan"], key: "tutorialRepairedState" },
        { type: "restartTui", sessionStartMode: "continue" },
        { type: "type", text: "/load-plan plan" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForRemotePlanStatus", planName: "plan", statuses: ["verified"], timeoutMs: 240000 },
        { type: "waitForWorktreeRegistryStatus", planName: "plan", statuses: ["absent"], timeoutMs: 90000 },
        { type: "waitForScreen", text: "What would you like to do", timeoutMs: 15000 },
        { type: "escape" },
        { type: "waitForIdle", timeoutMs: 90000 },
        { type: "assertWorkflowDurability" },
        {
            type: "capturePublicationState",
            planName: "plan",
            deliveredPath: "tutorial-behavior.ts",
            key: "tutorialPublicationBeforeReload",
        },
        // Confirmed publication and its retained receipt must supply verified
        // completion even while the primary checkout still trails the remote.
        { type: "setNextModelResponse", text: "The verified tutorial Session remains interactive after reload." },
        { type: "type", text: "show the verified tutorial recap" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 60000 },
        { type: "captureProjectState", planNames: ["plan"] },
        { type: "waitForScreen", text: "Tutorial complete", timeoutMs: 90000 },
        { type: "captureProjectState", planNames: ["plan"], key: "tutorialCompletedState" },
        { type: "restartTui", sessionStartMode: "continue" },
        { type: "captureProjectState", planNames: ["plan"], key: "tutorialReloadedCompletedState" },
        ...plannedChangeReviewRepairValidationScenario.actions.slice(11),
        {
            type: "capturePublicationState",
            planName: "plan",
            deliveredPath: "tutorial-behavior.ts",
            key: "tutorialPublicationAfterReload",
        },
    ],
    assertions: [
        ...plannedChangeReviewRepairValidationScenario.assertions,
        assertsGoldenCoverage("tutorial:onboarding", (result) => {
            const transcript = `${result.scrollbackText || ""}\n${result.screenText || ""}`;
            assertStringIncludes(transcript, "Tutorial complete");
            assertStringIncludes(transcript, "Plan:");
            assertEventIncludes(result, "runtime:cancellation");
            assertEquals(
                result.events.filter((event) => event === "tui:restarted").length,
                3,
                "The tutorial must reload during CI, after semantic repair, and after verified delivery.",
            );
            for (const id of ["engineer-implements-plan", "engineer-repairs-after-reviewer-rejection"]) {
                assertEquals(
                    result.actor.consumed.filter((consumed) => consumed === id).length,
                    1,
                    `Reload must preserve ${id} instead of running it again.`,
                );
            }
            const tutorialState = /** @type {TutorialScenarioState} */ (result.state);
            const pausedContext = tutorialState.tutorialPausedState?.runtimeSnapshot?.tutorialContext;
            const repairedContext = tutorialState.tutorialRepairedState?.runtimeSnapshot?.tutorialContext;
            const tutorialContext = tutorialState.projectState?.runtimeSnapshot?.tutorialContext;
            const completedContext = tutorialState.tutorialCompletedState?.runtimeSnapshot?.tutorialContext;
            const reloadedContext = tutorialState.tutorialReloadedCompletedState?.runtimeSnapshot?.tutorialContext;
            const publicationBeforeReload = tutorialState.tutorialPublicationBeforeReload;
            const publicationAfterReload = tutorialState.tutorialPublicationAfterReload;
            assertEquals(pausedContext?.recapShown, false, "Pause must settle before verification and publication.");
            assert(
                repairedContext?.shownExplanationIds?.includes("ai-review"),
                "Semantic repair teaching must persist before its reload.",
            );
            assertEquals(completedContext?.recapShown, true, "Verified recap must persist after it is displayed.");
            assertEquals(reloadedContext?.recapShown, true, "Verified recap must remain complete after reload.");
            assertEquals(
                reloadedContext?.shownExplanationIds?.filter((shown) => shown === "verified-recap").length,
                1,
                "Verified recap must persist once after reload.",
            );
            assert(
                publicationBeforeReload?.remoteHead !== tutorialState.publicationBaseline?.head,
                "The tutorial must publish a new remote commit.",
            );
            assertEquals(publicationBeforeReload?.remotePlanStatus, "verified");
            assertEquals(
                publicationBeforeReload?.deliveredText,
                'export function tutorialLabel() { return "ready"; }',
                "Publication must preserve the implemented tutorial work.",
            );
            assertEquals(
                publicationAfterReload?.remoteHead,
                publicationBeforeReload?.remoteHead,
                "Reload after verified delivery must not publish again.",
            );
            for (
                const id of [
                    "choose-improvement",
                    "plan-review",
                    "implementation",
                    "project-checks",
                    "ai-review",
                    "delivery",
                ]
            ) {
                assertEquals(
                    tutorialContext?.shownExplanationIds?.filter((shown) => shown === id).length,
                    1,
                    `${id} teaching must persist once across execution and repair rollover.`,
                );
            }
        }),
    ],
};

/**
 * Reuse a turn from the main PLANNED_CHANGE script by name.
 *
 * @param {string} id
 */
function plannedChangeTurn(id) {
    const turn = plannedChangeReviewRepairValidationScenario.script.find((entry) => entry.id === id);
    if (!turn) throw new Error(`Golden PLANNED_CHANGE script has no turn "${id}".`);
    return turn;
}

/**
 * CI fails, the Engineer repairs it, and the workflow carries on from where it was.
 *
 * Every other scenario in this portfolio commits `verification_command: "true"`, so CI
 * has never once failed in a Golden run. That left the entire mechanical repair loop —
 * the most-used recovery path in the product — covered only by unit tests, while
 * `recovery:workflow-validation` was claimed by a scenario that exercises the *reviewer*
 * repair instead. This is the missing half.
 *
 * The question it answers is not "does the repair Agent run", which unit tests can show.
 * It is whether RunWield keeps its place: after a dispatched repair the loop has to
 * re-run CI, and only once CI passes may it move on to Semantic Review and delivery.
 * Losing that position is how a change reaches the target branch without ever having a
 * passing build.
 *
 * The failing command is `test -f ci-fix.txt`, so CI fails until the repair creates that
 * file and passes afterwards — the same command throughout, deciding differently because
 * the worktree changed. Nothing in the harness switches it.
 */
export const plannedChangeCiRepairReentryScenario = {
    ...plannedChangeReviewRepairValidationScenario,
    name: "planned-change-ci-failure-repair-reentry",
    coverage: ["recovery:ci-repair"],
    committedProjectFiles: [
        {
            path: ".wld/settings.json",
            text: `${JSON.stringify({ verification_command: "test -f ci-fix.txt" }, null, 4)}\n`,
        },
    ],
    scriptedInteractions: [],
    // The Reviewer approves first time. Reviewer rejection already has its own scenario,
    // and mixing both would leave it ambiguous which loop re-entry the assertions prove.
    reviewDecisions: [
        { approved: false, feedback: "Reviewer-style feedback: narrow the implementation and resubmit." },
        { approved: true, feedback: "Approved to run.", approvalAction: "run" },
    ],
    script: [
        plannedChangeTurn("planner-submit-feedback-round"),
        plannedChangeTurn("planner-submit-approval-round"),
        plannedChangeTurn("engineer-implements-plan"),
        plannedChangeTurn("engineer-reports-plan-complete"),
        {
            // Dispatched by Mechanical Validation after the build fails. Creating
            // `ci-fix.txt` is what makes the next CI run pass.
            id: "engineer-repairs-failing-ci",
            agent: "engineer",
            phase: "engineer",
            ordinal: 3,
            requiredTools: ["write"],
            thinking: "Fix the failing build, then report the repair complete.",
            toolCalls: [{ name: "write", arguments: { path: "ci-fix.txt", content: "fixed" } }],
        },
        {
            id: "engineer-reports-ci-repair-complete",
            agent: "engineer",
            phase: "engineer",
            ordinal: 4,
            requiredTools: ["task_completed"],
            thinking: "Report the completed build repair.",
            toolCalls: [{ name: "task_completed", arguments: { message: "- Fixed the failing build." } }],
        },
        {
            // Reached only if the loop re-entered Mechanical Validation, re-ran CI, and
            // passed. If it lost its place this turn is never requested.
            id: "semantic-reviewer-approves-after-ci-repair-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 1,
            requiredTools: ["review_diff"],
            thinking: "Inspect every changed file before deciding.",
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "golden-planned-change.txt" },
                },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: "ci-fix.txt" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: "docs/plans/plan.md" } },
            ],
        },
        {
            // Reached only if the loop re-entered Mechanical Validation, re-ran CI, and
            // passed. If it lost its place this turn is never requested.
            id: "semantic-reviewer-approves-after-ci-repair",
            agent: "reviewer",
            phase: "semantic_review",
            ordinal: 2,
            requiredTools: ["review_complete"],
            toolCalls: [
                { name: "review_complete", arguments: { approved: true, feedback: "Approved after the build fix." } },
            ],
        },
        {
            id: "engineer-idle-after-ci-repair-delivery",
            agent: "engineer",
            phase: "engineer",
            ordinal: 6,
            optional: true,
            text: "Engineer idle after delivery.",
        },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:ci-repair", (result) => {
            // CI really failed and the repair was really dispatched.
            assertScreenIncludes(result, "Tests and CI failed");
            // ...and then the loop went back and ran CI again, rather than moving on or
            // starting the Plan over.
            assertScreenIncludes(result, "Running the tests in");
            // Semantic Review is only reachable once Mechanical Validation passes, so
            // this is the proof that re-entry landed in the right place.
            assertScreenIncludes(result, "found no need for a fix");
            assertScreenIncludes(result, "Merging work into main");
            const durability =
                /** @type {{ goldenFileExists?: boolean, trackedFiles?: string, executionCommitPublished?: boolean } | undefined} */ (result
                    .state.workflowDurability);
            assert(
                durability?.executionCommitPublished === true,
                "Expected delivery only after a passing CI run and an approved review.",
            );
            // The repair's own work is part of what shipped, which is only true if the
            // run continued from the repair instead of restarting without it.
            assert(
                String(durability?.trackedFiles || "").includes("ci-fix.txt"),
                `Expected the build fix to be delivered; tracked=${durability?.trackedFiles}`,
            );
            assert(
                String(durability?.trackedFiles || "").includes("golden-planned-change.txt"),
                "Expected the original implementation to survive the repair.",
            );
        }),
    ],
};

/** @type {import('../testing/scenario-runner.js').GoldenScenario} */
export const plannedChangeNonGitInPlaceScenario = {
    globalSettings: { defaultProvider: "golden", defaultModel: "faux", codereview: "none" },
    name: "planned-change-non-git-in-place-delivery",
    composedTui: true,
    initialAgentName: "planner",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 150000,
    nonGitProject: true,
    coverage: ["durable:non-git-in-place"],
    reviewDecisions: [{ approved: true, feedback: "Approved for non-Git execution.", approvalAction: "run" }],
    reviewedPlan: "# Non-Git PLANNED_CHANGE\n\nGolden non-Git content.\n",
    initialProjectFiles: [
        { path: "deno.json", text: '{"tasks":{"test":"deno eval \\"true\\""}}\n' },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "Git is not available for this project", value: "proceed" },
        { type: "text", promptIncludes: "Enter the command that runs this project's tests", value: "deno task test" },
    ],
    script: [
        {
            id: "planner-submit-non-git-plan",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            thinking: "Submit non-Git Plan for approval.",
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "non-git-plan",
                },
            }],
        },
        {
            id: "engineer-implements-non-git-plan",
            agent: "engineer",
            phase: "engineer",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            thinking: "Implement directly in the non-Git project root.",
            toolCalls: [
                { name: "bash", arguments: { command: "printf non-git > golden-non-git.txt" } },
                { name: "task_completed", arguments: { message: "- Implemented non-Git Golden change." } },
            ],
        },
        {
            id: "engineer-closes-non-git-plan",
            agent: "engineer",
            phase: "engineer",
            ordinal: 2,
            text: "Non-Git implementation awaits validation.",
        },
    ],
    actions: [
        {
            type: "writeProjectFile",
            path: "docs/plans/non-git-plan.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Golden non-Git PLANNED_CHANGE\naffectedPaths: []\nstatus: draft\n---\n# Non-Git PLANNED_CHANGE\n\nDraft content.\n",
        },
        { type: "type", text: "submit the non-git planned change for review" },
        { type: "enter" },
        {
            type: "waitForPlanStatus",
            planName: "non-git-plan",
            statuses: ["verified", "user_verified"],
            timeoutMs: 70000,
        },
        { type: "assertProjectFile", path: "golden-non-git.txt", exists: true },
        { type: "captureProjectFileText", path: "golden-non-git.txt", key: "nonGitDeliveredFileText" },
        { type: "captureProjectState", planNames: ["non-git-plan"] },
    ],
    assertions: [
        assertsGoldenCoverage("durable:non-git-in-place", (result) => {
            const interactions = /** @type {Array<{ interaction?: { value?: string } }> | undefined} */ (result.state
                .scriptedInteractions);
            assert(
                interactions?.some((entry) => entry.interaction?.value === "proceed"),
                "Expected non-Git execution prompt to be handled through production interaction.",
            );
            const projectState =
                /** @type {{ plans?: Array<{ attrs?: Record<string, unknown> | null }>, registryEntries?: unknown[] } | undefined} */ (result
                    .state.projectState);
            const attrs = projectState?.plans?.[0]?.attrs;
            assert(
                attrs?.executionMode === "non_git_in_place",
                `Expected non_git_in_place; got ${attrs?.executionMode}`,
            );
            const deliveryEvidence = /** @type {{ mode?: string } | undefined} */ (attrs?.deliveryEvidence);
            assert(deliveryEvidence?.mode === "non_git_in_place", "Expected non-Git Delivery Evidence.");
            assert(
                result.state.nonGitDeliveredFileText === "non-git",
                `Expected delivered non-Git file contents; got ${result.state.nonGitDeliveredFileText}`,
            );
            assert((projectState?.registryEntries || []).length === 0, "Expected no worktree registry entries.");
        }),
    ],
};

/** @type {import('../testing/scenario-runner.js').GoldenScenario} */
export const plannedChangeValidationFailureRetryScenario = {
    globalSettings: {
        defaultProvider: "golden",
        defaultModel: "faux",
        codereview: "none",
        plans: { autoMergeIntoTargetBranch: true },
    },
    name: "planned-change-validation-ci-failure-repair-retry-success",
    composedTui: true,
    initialAgentName: "planner",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 180000,
    coverage: ["recovery:validation-failure-retry"],
    committedProjectFiles: [
        {
            path: ".wld/settings.json",
            text: `${
                JSON.stringify(
                    { verification_command: 'test "$(cat golden-validation-retry.txt)" = repaired' },
                    null,
                    4,
                )
            }\n`,
        },
    ],
    reviewDecisions: [{ approved: true, feedback: "Approved for retry coverage.", approvalAction: "run" }],
    reviewedPlan: "# Validation retry\n\nGolden validation retry content.\n",
    script: [
        {
            id: "planner-submits-validation-retry-plan",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "validation-retry",
                },
            }],
        },
        {
            id: "engineer-implements-validation-retry-failing",
            agent: "engineer",
            phase: "engineer",
            planName: "validation-retry",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            toolCalls: [
                { name: "bash", arguments: { command: "printf broken > golden-validation-retry.txt" } },
                {
                    name: "task_completed",
                    arguments: { message: "- Implemented retry fixture with a failing CI state." },
                },
            ],
        },
        {
            id: "engineer-closes-validation-retry-first",
            agent: "engineer",
            phase: "engineer",
            planName: "validation-retry",
            ordinal: 2,
            text: "Awaiting CI.",
        },
        {
            id: "engineer-repairs-validation-retry",
            agent: "engineer",
            phase: "engineer",
            planName: "validation-retry",
            ordinal: 3,
            requiredTools: ["bash"],
            toolCalls: [
                { name: "bash", arguments: { command: "printf repaired > golden-validation-retry.txt" } },
            ],
        },
        {
            id: "engineer-closes-validation-retry-repair",
            agent: "engineer",
            phase: "engineer",
            planName: "validation-retry",
            ordinal: 4,
            requiredTools: ["task_completed"],
            toolCalls: [{
                name: "task_completed",
                arguments: { message: "- Repaired retry fixture after CI failure." },
            }],
        },
        {
            id: "reviewer-approves-validation-retry-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "validation-retry",
            ordinal: 1,
            requiredTools: ["review_diff"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "golden-validation-retry.txt" },
                },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "docs/plans/validation-retry.md" },
                },
            ],
        },
        {
            id: "reviewer-approves-validation-retry",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "validation-retry",
            ordinal: 2,
            requiredTools: ["review_complete"],
            toolCalls: [
                { name: "review_complete", arguments: { approved: true, feedback: "Retry repair approved." } },
            ],
        },
    ],
    actions: [
        {
            type: "writeProjectFile",
            path: "docs/plans/validation-retry.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Validation retry\naffectedPaths: []\nstatus: draft\n---\n# Validation retry\n\nDraft content.\n",
        },
        { type: "type", text: "submit validation retry plan for review" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        {
            type: "waitForExecutionPlanStatus",
            planName: "validation-retry",
            statuses: ["implemented"],
            timeoutMs: 90000,
        },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 90000 },
        { type: "waitForRemotePlanStatus", planName: "validation-retry", statuses: ["verified"], timeoutMs: 90000 },
        {
            type: "waitForWorktreeRegistryStatus",
            planName: "validation-retry",
            statuses: ["absent"],
            timeoutMs: 90000,
        },
        { type: "capturePublicationState", planName: "validation-retry", deliveredPath: "ci-fix.txt" },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:validation-failure-retry", (result) => {
            assertScreenIncludes(result, "Running the tests in");
            assertScreenIncludes(result, "Repaired retry fixture after CI failure.");
            const publication =
                /** @type {{ remotePlanAttrs?: Record<string, unknown>, controllerState?: import('../../../shared/workflow/controller-state.ts').WorkflowControllerState, registryEntries?: Array<unknown> }} */ (result
                    .state.publication);
            const attrs = publication.remotePlanAttrs;
            const ciRuns = countVisibleOccurrences(result, "Running the tests in");
            assert(ciRuns >= 2, `Expected failed CI plus retry CI; saw ${ciRuns} CI runs.`);
            const completedTurns = result.events.filter((event) =>
                event === "runtime:tool:start:task_completed"
            ).length;
            assert(
                completedTurns >= 2,
                `Expected initial implementation and repair task_completed turns; saw ${completedTurns}.`,
            );
            assert(
                attrs?.status === "verified",
                `Expected retry scenario verified after repair; got ${attrs?.status}`,
            );
            assert(attrs?.planId, "Expected Plan identity to remain populated after validation retry.");
            assert(
                publication.controllerState?.validationCiAttempts === 0,
                `Expected controller CI attempts reset after success; got ${publication.controllerState?.validationCiAttempts}`,
            );
            assertEquals(
                attrs?.validationCiAttempts,
                undefined,
                "retry counters must not be written into the published Plan",
            );
            assertEquals(publication.registryEntries?.length, 0, "Expected successful publication cleanup.");
        }),
    ],
};

/** @type {import('../testing/scenario-runner.js').GoldenScenario} */
export const plannedChangeValidationExhaustedScenario = {
    globalSettings: { defaultProvider: "golden", defaultModel: "faux", codereview: "none" },
    name: "planned-change-validation-ci-exhausted-recoverable",
    composedTui: true,
    initialAgentName: "planner",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 180000,
    coverage: ["recovery:validation-exhausted"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "false" }, null, 4)}\n` },
    ],
    reviewDecisions: [{
        approved: true,
        feedback: "Approved for exhausted validation coverage.",
        approvalAction: "run",
    }],
    reviewedPlan: "# Validation exhausted\n\nGolden exhausted validation content.\n",
    scriptedInteractions: [{ type: "select", promptIncludes: "tests for", value: "stop" }],
    script: [
        {
            id: "planner-submits-validation-exhausted-plan",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "validation-exhausted",
                },
            }],
        },
        // The first pair is the implementation Engineer. The next three pairs
        // are the three focused CI repair cycles.
        ...[1, 2, 3, 4].flatMap((attempt) => [
            {
                id: `engineer-validation-exhausted-attempt-${attempt}`,
                agent: "engineer",
                phase: "engineer",
                planName: "validation-exhausted",
                ordinal: attempt * 2 - 1,
                requiredTools: ["bash"],
                toolCalls: [
                    {
                        name: "bash",
                        arguments: { command: `printf attempt-${attempt} > golden-validation-exhausted.txt` },
                    },
                ],
            },
            {
                id: `engineer-validation-exhausted-closes-${attempt}`,
                agent: "engineer",
                phase: "engineer",
                planName: "validation-exhausted",
                ordinal: attempt * 2,
                requiredTools: ["task_completed"],
                toolCalls: [{
                    name: "task_completed",
                    arguments: { message: `- Attempt ${attempt} still cannot satisfy CI.` },
                }],
            },
        ]),
    ],
    actions: [
        {
            type: "writeProjectFile",
            path: "docs/plans/validation-exhausted.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Validation exhausted\naffectedPaths: []\nstatus: draft\n---\n# Validation exhausted\n\nDraft content.\n",
        },
        { type: "type", text: "submit validation exhausted plan for review" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        {
            type: "waitForExecutionPlanStatus",
            planName: "validation-exhausted",
            statuses: ["implemented"],
            timeoutMs: 90000,
        },
        { type: "waitForEventCount", event: "runtime:tool:start:task_completed", count: 4, timeoutMs: 150000 },
        { type: "waitForEventCount", event: "runtime:interaction_resolved", count: 2, timeoutMs: 150000 },
        {
            type: "waitForExecutionPlanStatus",
            planName: "validation-exhausted",
            statuses: ["implemented"],
            timeoutMs: 90000,
        },
        { type: "sleep", ms: 1000 },
        { type: "captureExecutionPlanState", planName: "validation-exhausted" },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:validation-exhausted", (result) => {
            assertScreenIncludes(result, "Tests and CI failed");
            assertScreenIncludes(result, "tests for");
            const executionPlan =
                /** @type {{ attrs?: Record<string, unknown> | null, registryEntry?: { status?: string } | null }} */ (result
                    .state.executionPlan);
            const attrs = executionPlan.attrs;
            const completedTurns = result.events.filter((event) =>
                event === "runtime:tool:start:task_completed"
            ).length;
            assert(
                completedTurns >= 4,
                `Expected all exhausted implementation attempts before recoverability capture; saw ${completedTurns}.`,
            );
            assert(
                attrs?.status === "implemented",
                `Expected exhausted validation to remain implemented/recoverable; got ${attrs?.status}`,
            );
            assert(
                String(executionPlan.registryEntry?.status || "") === "completed",
                `Expected the completed worktree to remain available for validation recovery; got ${executionPlan.registryEntry?.status}`,
            );
            assert(attrs?.planId, "Expected exhausted recoverable state to preserve Plan identity.");
            const ciRuns = countVisibleOccurrences(result, "Running the tests in");
            assert(ciRuns >= 3, `Expected exhausted scenario to show at least three CI attempts; saw ${ciRuns}.`);
        }),
    ],
};

/** @type {import('../testing/scenario-runner.js').GoldenScenario} */
export const plannedChangeFrontendIdentityScenario = {
    globalSettings: {
        defaultProvider: "golden",
        defaultModel: "faux",
        codereview: "none",
        plans: { autoMergeIntoTargetBranch: true },
    },
    name: "planned-change-frontend-engineer-context-identity",
    composedTui: true,
    initialAgentName: "planner",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 180000,
    captureModelTurns: true,
    coverage: ["context:frontend-engineer-identity"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
    ],
    reviewDecisions: [{
        approved: true,
        feedback: "Approved for Frontend execution.",
        approvalAction: "run",
        executionAgent: "frontend-engineer",
        collaborationRecommendation: "autonomous",
    }],
    reviewedPlan: "# Frontend identity\n\nGolden frontend identity content.\n",
    script: [
        {
            id: "planner-submits-frontend-plan",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "frontend-identity",
                    executionAgent: "frontend-engineer",
                },
            }],
        },
        {
            id: "frontend-engineer-implements-plan",
            agent: "engineer",
            phase: "engineer",
            planName: "frontend-identity",
            ordinal: 1,
            requiredTools: ["write"],
            toolCalls: [
                { name: "write", arguments: { path: "golden-frontend-identity.txt", content: "frontend" } },
            ],
        },
        {
            id: "frontend-engineer-reports-plan-complete",
            agent: "engineer",
            phase: "engineer",
            planName: "frontend-identity",
            ordinal: 2,
            requiredTools: ["task_completed"],
            toolCalls: [{
                name: "task_completed",
                arguments: {
                    message: "- Verified the frontend identity fixture with headed browser evidence.",
                    browserPreflightOutcome: "externally_blocked",
                },
            }],
        },
        {
            id: "reviewer-approves-frontend-identity-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "frontend-identity",
            ordinal: 1,
            requiredTools: ["review_diff"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "golden-frontend-identity.txt" },
                },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "docs/plans/frontend-identity.md" },
                },
            ],
        },
        {
            id: "reviewer-approves-frontend-identity",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "frontend-identity",
            ordinal: 2,
            requiredTools: ["review_complete"],
            toolCalls: [
                { name: "review_complete", arguments: { approved: true, feedback: "Frontend identity approved." } },
            ],
        },
    ],
    actions: [
        {
            type: "writeProjectFile",
            path: "docs/plans/frontend-identity.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Frontend identity\naffectedPaths: []\nstatus: draft\nexecutionAgent: frontend-engineer\n---\n# Frontend identity\n\nDraft content.\n",
        },
        { type: "type", text: "submit frontend identity plan for review" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:agent:frontend-engineer", timeoutMs: 90000 },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 90000 },
        { type: "waitForRemotePlanStatus", planName: "frontend-identity", statuses: ["verified"], timeoutMs: 90000 },
    ],
    assertions: [
        assertsGoldenCoverage("context:frontend-engineer-identity", (result) => {
            assertEventIncludes(result, "runtime:agent:frontend-engineer");
            const turns = Array.isArray(result.state.modelTurns) ? result.state.modelTurns : [];
            const executionTurn = turns.find((turn) =>
                turn?.runtimeAgent === "frontend-engineer" &&
                String(turn?.systemPrompt || "").includes("You are the Frontend Engineer")
            );
            assert(
                executionTurn,
                `Expected actual Frontend Engineer system prompt in model turns; got ${
                    JSON.stringify(turns.map((turn) => ({ agent: turn?.agent, runtimeAgent: turn?.runtimeAgent })))
                }`,
            );
            assertStringIncludes(String(executionTurn.systemPrompt || ""), "browserPreflightOutcome");
            assert(
                !String(executionTurn.systemPrompt || "").includes("Quick Fix Checklist"),
                "Frontend Plan execution must not use Quick Fix prompt context.",
            );
        }),
    ],
};

export const plannedChangeWorkflowScenarios = [
    plannedChangeReviewRepairValidationScenario,
    onboardingTutorialDeliveryScenario,
    plannedChangeFrontendIdentityScenario,
    plannedChangeCiRepairReentryScenario,
    plannedChangeNonGitInPlaceScenario,
    plannedChangeValidationFailureRetryScenario,
    plannedChangeValidationExhaustedScenario,
];
