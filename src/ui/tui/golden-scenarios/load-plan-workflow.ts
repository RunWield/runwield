/**
 * Golden /load-plan workflow scenarios.
 */

import { assert, assertEquals } from "@std/assert";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";
import { assertsGoldenCoverage } from "../testing/portfolio-assertions.js";
interface GoldenScenarioResult {
    name: string;
    state: Record<string, unknown> & { projectState?: CapturedProjectState };
    screenText: string;
    scrollbackText?: string;
    events: string[];
    actor: { consumed: string[]; remaining: string[] };
    artifactDir: string | null;
}

interface CapturedPlan {
    name?: string;
    attrs?: { status?: string; worktreeStatus?: string; planId?: string; failureReason?: string } | null;
}

interface CapturedProjectState {
    runtimeSnapshot?: RuntimeSnapshotState | null;
    plans?: CapturedPlan[];
    registryEntries?: Array<{ status?: string; planName?: string; path?: string }>;
    nonTerminalRegistryEntries?: Array<{ status?: string; planName?: string }>;
    workRecordNames?: string[];
}

interface RuntimeSnapshotState {
    cwd?: string;
    activeAgent?: string;
    activeExecutionWorkflow?: { planName?: string; executionCwd?: string } | null;
}

function projectState(result: GoldenScenarioResult): CapturedProjectState {
    return result.state.projectState as CapturedProjectState;
}

function planStatus(result: GoldenScenarioResult, name: string): string {
    const plan = projectState(result).plans?.find((entry) => entry.name === name);
    return plan?.attrs?.status || "";
}

function recoveryOptionValues(result: GoldenScenarioResult, index = 0): Set<string | undefined> {
    const interactions = result.state.scriptedInteractions as
        | Array<{ request?: { options?: Array<{ value?: string }> } }>
        | undefined;
    return new Set((interactions?.[index]?.request?.options || []).map((option) => option.value));
}

export const loadPlanActionsScenario = {
    name: "load-plan-hold-user-verify-actions",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 60000,
    coverage: ["workflow:load-plan", "durable:plan-lifecycle"],
    initialProjectFiles: [
        {
            path: "docs/plans/load-hold.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Hold through load-plan\naffectedPaths: []\nstatus: ready_for_work\n---\n# Hold\n",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do", value: "hold" },
        { type: "text", promptIncludes: "Optional hold reason", value: "Golden hold." },
        { type: "select", value: "resume" },
        { type: "select", value: "user_verify" },
        { type: "text", value: "Golden user verification work record." },
    ],
    actions: [
        { type: "type", text: "/load-plan load-hold" },
        { type: "enter" },
        { type: "enter" },
        { type: "sleep", ms: 1000 },
        { type: "waitForIdle", timeoutMs: 12000 },
        { type: "type", text: "/load-plan load-hold" },
        { type: "enter" },
        { type: "enter" },
        { type: "sleep", ms: 1000 },
        { type: "waitForIdle", timeoutMs: 12000 },
        { type: "sleep", ms: 5000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["load-hold"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan load-hold");
            assertScreenIncludes(result, "Plan put on hold");
            assertScreenIncludes(result, "User Verification records your attestation");
        }),
        assertsGoldenCoverage("durable:plan-lifecycle", (result: GoldenScenarioResult) => {
            assert(
                planStatus(result, "load-hold") === "user_verified",
                "Expected /load-plan hold/resume/user_verify to persist user_verified.",
            );
            assert(
                (projectState(result).workRecordNames || []).some((name) => name.startsWith("docs/work-records/")),
                "Expected /load-plan user_verify to create a Work Record.",
            );
        }),
    ],
};

export const loadPlanResetReviewArchiveScenario = {
    name: "load-plan-reset-review-and-archive-actions",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 150000,
    coverage: ["workflow:load-plan", "durable:plan-lifecycle"],
    reviewDecisions: [{ approved: true, feedback: "Re-review approved for later.", approvalAction: "later" }],
    script: [
        {
            id: "planner-handles-load-plan-re-review",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "re-review",
                },
            }],
        },
    ],
    initialProjectFiles: [
        {
            path: "docs/plans/reset-held.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Reset held\naffectedPaths: []\nstatus: on_hold\nheldFromStatus: ready_for_work\n---\n# Reset held\n",
        },
        {
            path: "docs/plans/re-review.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Re-review\naffectedPaths: []\nstatus: ready_for_work\n---\n# Re-review\n",
        },
        {
            path: "docs/plans/archive-me.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Archive me\naffectedPaths: []\nstatus: verified\n---\n# Archive me\n",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "This plan is on hold", value: "reset" },
        { type: "select", value: "confirm" },
        { type: "select", promptIncludes: "What would you like to do", value: "cancel" },
        { type: "select", promptIncludes: "What would you like to do", value: "planner_re_review" },
        { type: "select", promptIncludes: "What would you like to do", value: "archive" },
    ],
    actions: [
        { type: "type", text: "/load-plan reset-held" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 12000 },
        { type: "sleep", ms: 1000 },
        { type: "type", text: "/load-plan re-review" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 60000 },
        { type: "sleep", ms: 1000 },
        { type: "waitForIdle", timeoutMs: 60000 },
        { type: "sleep", ms: 1000 },
        { type: "type", text: "/load-plan archive-me" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 12000 },
        { type: "waitForPlanAbsent", planName: "archive-me", timeoutMs: 12000 },
        { type: "captureProjectState", planNames: ["reset-held", "re-review", "archive-me"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan reset-held");
            assertEventIncludes(result, "terminal:type:/load-plan re-review");
            assertEventIncludes(result, "terminal:type:/load-plan archive-me");
            assertScreenIncludes(result, "Plan loaded: reset-held");
            assertScreenIncludes(result, "Plan reset to draft");
            assertEventIncludes(result, "runtime:tool:start:plan_written");
            assertScreenIncludes(result, "Plan saved. Resume later with: wld resume re-review");
            assertScreenIncludes(result, "Plan loaded: archive-me");
            assertScreenIncludes(result, "Archived archive-me to");
        }),
        assertsGoldenCoverage("durable:plan-lifecycle", (result: GoldenScenarioResult) => {
            assert(
                planStatus(result, "reset-held") === "draft",
                `Expected reset-held to durably reset to draft; got ${planStatus(result, "reset-held")}`,
            );
            assert(
                planStatus(result, "re-review") === "ready_for_work",
                `Expected /load-plan planner re-review to leave durable ready_for_work Front Matter; got ${
                    planStatus(result, "re-review")
                }`,
            );
            const archived = projectState(result).plans?.find((entry) => entry.name === "archive-me");
            assert(
                archived?.attrs === null,
                `Expected archive-me to be removed from active Plan storage; got ${JSON.stringify(archived?.attrs)}`,
            );
        }),
    ],
};

export const loadPlanCanceledExecutionThenPlannerReviewScenario = {
    name: "load-plan-cancel-stale-execution-then-planner-re-review",
    composedTui: true,
    initialAgentName: "guide",
    globalSettings: {
        defaultProvider: "golden",
        defaultModel: "faux",
        activeModelPreset: "unavailable-planner",
        modelPresets: {
            "unavailable-planner": {
                agents: { planner: { model: "missing/planner-model" } },
            },
            "available-planner": {
                agents: { planner: { model: "golden/faux" } },
            },
        },
    },
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    coverage: ["workflow:load-plan", "durable:plan-lifecycle"],
    reviewDecisions: [{ approved: true, feedback: "Re-review approved for later.", approvalAction: "later" }],
    script: [
        {
            id: "planner-reviews-after-canceled-execution",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{
                name: "plan_written",
                arguments: {
                    planName: "stale-then-review",
                },
            }],
        },
    ],
    committedProjectFiles: [
        { path: "app.ts", text: "export const changedAfterPlanning = true;\n" },
        {
            path: "docs/plans/stale-then-review.md",
            text:
                '---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Cancel stale execution then review\naffectedPaths:\n  - app.ts\nupdatedAt: "2020-01-01T00:00:00.000Z"\nstatus: ready_for_work\n---\n# Cancel stale execution then review\n',
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do", value: "proceed" },
        { type: "select", promptIncludes: "Proceed with execution", value: "cancel" },
        { type: "select", promptIncludes: "Settings", value: "model-presets" },
        { type: "select", promptIncludes: "Model Presets", value: "preset:available-planner" },
        { type: "select", promptIncludes: "Model Presets", value: "back" },
        { type: "select", promptIncludes: "Settings", value: "done" },
        { type: "select", promptIncludes: "What would you like to do", value: "planner_re_review" },
    ],
    actions: [
        { type: "type", text: "/load-plan stale-then-review" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 20000 },
        { type: "sleep", ms: 1000 },
        { type: "type", text: "/settings" },
        { type: "enter" },
        { type: "waitForScreen", text: "Active model preset set to available-planner", timeoutMs: 20000 },
        { type: "waitForIdle", timeoutMs: 20000 },
        { type: "type", text: "/load-plan stale-then-review" },
        { type: "enter" },
        { type: "enter" },
        {
            type: "waitForScreen",
            text: "Plan saved. Resume later with: wld resume stale-then-review",
            timeoutMs: 60000,
        },
        { type: "waitForIdle", timeoutMs: 60000 },
        { type: "sleep", ms: 1000 },
        { type: "waitForPlanStatus", planName: "stale-then-review", statuses: ["ready_for_work"], timeoutMs: 12000 },
        { type: "captureProjectState", planNames: ["stale-then-review"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertScreenIncludes(result, "Execution canceled.");
            assertScreenIncludes(result, "Active model preset set to available-planner");
            assertEventIncludes(result, "runtime:tool:start:plan_written");
            assertScreenIncludes(result, "Plan saved. Resume later with: wld resume stale-then-review");
            const output = `${result.scrollbackText || ""}\n${result.screenText}`;
            assert(
                !output.includes("managed_operation_in_progress"),
                "Planner re-review must start after cancellation.",
            );
        }),
        assertsGoldenCoverage("durable:plan-lifecycle", (result: GoldenScenarioResult) => {
            assert(
                planStatus(result, "stale-then-review") === "ready_for_work",
                `Expected the re-reviewed Plan to remain ready_for_work; got ${
                    planStatus(result, "stale-then-review")
                }`,
            );
        }),
    ],
};

export const loadPlanInterruptedRecoveryScenario = {
    name: "load-plan-interrupted-child-recovery-options",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    coverage: [
        "recovery:interrupted-execution",
        "recovery:load-plan-worktree",
    ],
    initialProjectFiles: [
        {
            path: "docs/plans/epic.md",
            text:
                "---\nclassification: PROJECT\ncomplexity: MEDIUM\nsummary: Interrupted Epic\naffectedPaths: []\nstatus: ready_for_decomposition\n---\n# Epic\n",
        },
        {
            path: "docs/plans/epic/01-child.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Interrupted child\naffectedPaths: []\nstatus: ready_for_work\nparentPlan: epic\norder: 1\n---\n# Child\n",
        },
    ],
    script: [
        {
            id: "engineer-starts-child-without-completion",
            agent: "engineer",
            phase: "engineer",
            planName: "epic/01-child",
            ordinal: 1,
            requiredTools: ["bash"],
            thinking: "Start the child in its real execution worktree, but do not call task_completed.",
            toolCalls: [{ name: "bash", arguments: { command: "printf interrupted > interrupted-child.txt" } }],
        },
        {
            id: "engineer-stops-before-task-completed",
            agent: "engineer",
            phase: "engineer",
            planName: "epic/01-child",
            ordinal: 2,
            text: "Interrupted before task_completed.",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do", value: "proceed" },
        { type: "select", value: "pick_child" },
        { type: "select", value: "epic/01-child" },
        { type: "select", value: "load" },
        { type: "select", value: "inspect" },
    ],
    actions: [
        { type: "type", text: "/load-plan epic/01-child" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:bash", timeoutMs: 30000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "restartTui", initialAgentName: "guide" },
        { type: "type", text: "/load-plan epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScriptedInteractions", timeoutMs: 30000 },
        { type: "waitForIdle", timeoutMs: 20000 },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:interrupted-execution", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "runtime:tool:start:bash");
            assertEventIncludes(result, "tui:restarted");
            assertScreenIncludes(result, "active/implemented");
        }),
        assertsGoldenCoverage("recovery:load-plan-worktree", (result: GoldenScenarioResult) => {
            const childOptions = recoveryOptionValues(result, 1);
            assert(childOptions.has("pick_child"), `Expected active child choice; got ${[...childOptions].join(", ")}`);
            const planRecoveryOptions = recoveryOptionValues(result, 4);
            for (
                const expected of ["inspect", "continue", "reset", "abandon", "review", "user_verify", "hold", "cancel"]
            ) {
                assert(
                    planRecoveryOptions.has(expected),
                    `Expected interrupted child Plan Recovery option ${expected}; got ${
                        [...planRecoveryOptions].join(", ")
                    }`,
                );
            }
            assert(
                !result.screenText.includes("No execution baseline tree is recorded") &&
                    !result.screenText.includes("Plan changed underneath"),
                "Expected current active-worktree recovery options without stale snapshot/precondition text.",
            );
        }),
    ],
};

export const loadPlanWorktreeInspectResetScenario = {
    name: "load-plan-worktree-recovery-inspect-and-reset",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 240000,
    coverage: ["recovery:load-plan-worktree"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
    ],
    initialProjectFiles: [{
        path: "docs/plans/recover-reset.md",
        text:
            "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Reset recovery\naffectedPaths: []\nstatus: ready_for_work\nplanId: recover-reset-plan\n---\n# Recover reset\n",
    }],
    script: [
        {
            id: "engineer-completes-recover-reset-after-recreate",
            agent: "engineer",
            phase: "engineer",
            planName: "recover-reset",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            toolCalls: [
                { name: "bash", arguments: { command: "printf after-reset > recover-reset.txt" } },
                { name: "task_completed", arguments: { message: "- Completed after recovery reset." } },
            ],
        },
        {
            id: "engineer-closes-recover-reset-after-recreate",
            agent: "engineer",
            phase: "engineer",
            planName: "recover-reset",
            ordinal: 2,
            text: "Recovery reset completed.",
        },
        {
            id: "reviewer-approves-recover-reset-after-recreate",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "recover-reset",
            ordinal: 1,
            requiredTools: ["review_diff", "review_complete"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list" } },
                { name: "review_diff", arguments: { command: "show", path: "recover-reset.txt" } },
                { name: "review_diff", arguments: { command: "show", path: "docs/plans/recover-reset.md" } },
                { name: "review_complete", arguments: { approved: true, feedback: "Recovery reset approved." } },
            ],
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "Plan recovery", value: "inspect" },
        { type: "select", promptIncludes: "Plan recovery", value: "reset" },
        { type: "select", promptIncludes: "Delete/recreate", value: "confirm" },
        { type: "select", promptIncludes: "code review before merge", value: "skip" },
    ],
    actions: [
        { type: "seedActiveWorktree", planName: "recover-reset" },
        { type: "sleep", ms: 1000 },
        { type: "type", text: "/load-plan recover-reset" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        {
            type: "waitForPlanStatus",
            planName: "recover-reset",
            statuses: ["verified"],
            timeoutMs: 60000,
        },
        {
            type: "waitForWorktreeRegistryStatus",
            planName: "recover-reset",
            statuses: ["absent"],
            timeoutMs: 60000,
        },
        { type: "captureProjectState", planNames: ["recover-reset"] },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:load-plan-worktree", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "project:worktree-seeded:recover-reset");
            assertScreenIncludes(result, "Completed after recovery reset.");
            assert(
                planStatus(result, "recover-reset") === "verified",
                `Expected recovery reset to re-run and validate the Plan; got ${planStatus(result, "recover-reset")}`,
            );
            assert(
                (projectState(result).nonTerminalRegistryEntries || []).length === 0,
                `Expected recovery reset completion to drain live registry entries; got ${
                    JSON.stringify(projectState(result).nonTerminalRegistryEntries || [])
                }`,
            );
        }),
    ],
};

export const loadPlanAbandonProgressScenario = {
    name: "load-plan-abandon-worktree-shows-progress",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    coverage: ["block:abandon-progress", "recovery:load-plan-worktree"],
    initialProjectFiles: [{
        path: "docs/plans/recover-abandon.md",
        text:
            "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Abandon recovery\naffectedPaths: []\nstatus: ready_for_work\nplanId: recover-abandon-plan\n---\n# Recover abandon\n",
    }],
    scriptedInteractions: [
        { type: "select", promptIncludes: "Plan recovery (in_progress)", value: "abandon" },
        { type: "select", promptIncludes: "Delete/abandon worktree", value: "confirm" },
        { type: "select", promptIncludes: "Plan recovery (in_progress)", value: "cancel" },
    ],
    actions: [
        { type: "seedActiveWorktree", planName: "recover-abandon" },
        { type: "type", text: "/load-plan recover-abandon" },
        { type: "enter" },
        { type: "enter" },
        { type: "sleep", ms: 1000 },
        { type: "waitForScreen", text: "The recorded worktree and branch were deleted.", timeoutMs: 40000 },
        { type: "waitForIdle", timeoutMs: 40000 },
        { type: "captureProjectState", planNames: ["recover-abandon"] },
    ],
    assertions: [
        assertsGoldenCoverage("block:abandon-progress", (result: GoldenScenarioResult) => {
            assertScreenIncludes(result, "RunWield will now take out the worktree for recover-abandon.");
            assertScreenIncludes(result, "The recorded worktree and branch were deleted.");
        }),
        assertsGoldenCoverage("recovery:load-plan-worktree", (result: GoldenScenarioResult) => {
            assert(
                planStatus(result, "recover-abandon") === "in_progress",
                "Expected abandon to leave lifecycle status for explicit recovery.",
            );
            assert(
                (projectState(result).nonTerminalRegistryEntries || []).length === 0,
                "Expected abandon to drain live worktree registry entries.",
            );
        }),
    ],
};

export const loadPlanImplementedFollowUpRepaintsScenario = {
    name: "load-plan-implemented-follow-up-repaints-execution-session",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 120, rows: 34 },
    timeoutMs: 150000,
    coverage: ["recovery:load-plan-worktree", "durable:session-replaced", "workflow:follow-up-validation"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        {
            path: "docs/plans/follow-up-repaint.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Follow up repaint\naffectedPaths: []\nstatus: ready_for_work\nplanId: follow-up-repaint-plan\nhumanReviewMode: none\nhumanReviewDecision: not_required\n---\n# Follow up repaint\n",
        },
    ],
    script: [
        {
            id: "engineer-completes-follow-up-repaint",
            agent: "engineer",
            phase: "engineer",
            planName: "follow-up-repaint",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            toolCalls: [
                { name: "bash", arguments: { command: "printf follow-up > follow-up-repaint-validation.txt" } },
                { name: "task_completed", arguments: { message: "- Completed follow-up validation trigger." } },
            ],
        },
        {
            id: "engineer-closes-follow-up-repaint",
            agent: "engineer",
            phase: "engineer",
            planName: "follow-up-repaint",
            ordinal: 2,
            text: "Follow-up completed.",
        },
        {
            id: "reviewer-approves-follow-up-repaint",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "follow-up-repaint",
            ordinal: 1,
            requiredTools: ["review_diff", "review_complete"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list" } },
                { name: "review_diff", arguments: { command: "show", path: "follow-up-repaint.txt" } },
                { name: "review_diff", arguments: { command: "show", path: "follow-up-repaint-validation.txt" } },
                { name: "review_diff", arguments: { command: "show", path: "docs/plans/follow-up-repaint.md" } },
                { name: "review_complete", arguments: { approved: true, feedback: "Follow-up approved." } },
            ],
        },
    ],
    scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "follow_up" }],
    actions: [
        {
            type: "seedActiveWorktree",
            planName: "follow-up-repaint",
            status: "implemented",
            attrs: {
                executionMode: "worktree",
                humanReviewMode: "none",
                humanReviewDecision: "not_required",
            },
            files: [{ path: "follow-up-repaint.txt", text: "implemented\n" }],
        },
        { type: "type", text: "/load-plan follow-up-repaint" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:session-replaced:execution_follow_up", timeoutMs: 30000 },
        { type: "waitForScreen", text: "Plan Engineer", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["follow-up-repaint"], key: "afterFollowUpReplacement" },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "type", text: "Please finish the follow-up." },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        { type: "waitForRemotePlanStatus", planName: "follow-up-repaint", statuses: ["verified"], timeoutMs: 90000 },
        { type: "waitForIdle", timeoutMs: 90000 },
        { type: "captureProjectState", planNames: ["follow-up-repaint"] },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:load-plan-worktree", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan follow-up-repaint");
            assertEventIncludes(result, "runtime:session-replaced:execution_follow_up");
            assertEventIncludes(result, "runtime:tool:start:task_completed");
            assertScreenIncludes(result, "Plan Engineer");
            assertScreenIncludes(result, "follow-up-repaint");
        }),
        assertsGoldenCoverage("durable:session-replaced", (result: GoldenScenarioResult) => {
            const replacementState = result.state.afterFollowUpReplacement as CapturedProjectState | undefined;
            const snapshot = replacementState?.runtimeSnapshot;
            const entry = replacementState?.registryEntries?.find((candidate) =>
                candidate.planName === "follow-up-repaint"
            );
            assert(entry?.path, "Expected the seeded worktree registry entry to record its path.");
            assertEquals(snapshot?.cwd, entry.path);
            assertEquals(snapshot?.activeExecutionWorkflow?.planName, "follow-up-repaint");
            assertEquals(planStatus(result, "follow-up-repaint"), "verified");
        }),
        assertsGoldenCoverage("workflow:follow-up-validation", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "runtime:tool:start:task_completed");
            assertEventIncludes(result, "publication:remote-plan-status:follow-up-repaint:verified");
            assertEquals(planStatus(result, "follow-up-repaint"), "verified");
        }),
    ],
};

export const loadPlanContinueUsesExecutionPlanAuthorityScenario = {
    // This scenario isolates automated delivery; human policy gates have dedicated journeys.
    globalSettings: { defaultProvider: "golden", defaultModel: "faux", codereview: "none" },
    name: "load-plan-continue-uses-execution-plan-authority",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 150000,
    coverage: ["workflow:load-plan", "recovery:load-plan-worktree"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        {
            path: "docs/plans/continue-authority.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Continue from the execution Plan\naffectedPaths: []\nstatus: ready_for_work\nplanId: continue-authority-plan\n---\n# Continue authority\n",
        },
    ],
    script: [
        {
            id: "engineer-continues-authoritative-worktree",
            agent: "engineer",
            phase: "engineer",
            planName: "continue-authority",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            toolCalls: [
                { name: "bash", arguments: { command: "printf resumed > continue-authority.txt" } },
                { name: "task_completed", arguments: { message: "- Continued the existing worktree." } },
            ],
        },
        {
            id: "engineer-closes-authoritative-worktree",
            agent: "engineer",
            phase: "engineer",
            planName: "continue-authority",
            ordinal: 2,
            text: "Existing worktree continued.",
        },
        {
            id: "reviewer-approves-authoritative-worktree",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "continue-authority",
            ordinal: 1,
            requiredTools: ["review_diff", "review_complete"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list" } },
                { name: "review_diff", arguments: { command: "show", path: "continue-authority.txt" } },
                { name: "review_diff", arguments: { command: "show", path: "docs/plans/continue-authority.md" } },
                { name: "review_complete", arguments: { approved: true, feedback: "Continuation approved." } },
            ],
        },
    ],
    scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (in_progress)", value: "continue" }],
    actions: [
        {
            type: "seedActiveWorktree",
            planName: "continue-authority",
            status: "in_progress",
            attrs: {
                executionMode: "worktree",
                humanReviewMode: "none",
                humanReviewDecision: "not_required",
            },
        },
        {
            type: "setPrimaryPlanStatus",
            planName: "continue-authority",
            status: "draft",
            clearPrimaryWorktreeEvidence: true,
        },
        {
            type: "writeProjectFile",
            path: "docs/plans/continue-authority.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Main checkout edit\naffectedPaths: []\nstatus: draft\nplanId: continue-authority-plan\n---\n# Main checkout edit\n\nKeep this local text.\n",
        },
        { type: "type", text: "/load-plan continue-authority" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
        { type: "waitForRemotePlanStatus", planName: "continue-authority", statuses: ["verified"], timeoutMs: 90000 },
        { type: "waitForIdle", timeoutMs: 90000 },
        { type: "captureProjectState", planNames: ["continue-authority"] },
        {
            type: "captureProjectFileText",
            path: "docs/plans/continue-authority.md",
            key: "primaryPlanAfterExecutionAuthority",
        },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "project:primary-plan-status:continue-authority:draft");
            assertEventIncludes(result, "runtime:tool:start:task_completed");
            assert(
                !`${result.scrollbackText || ""}\n${result.screenText}`.includes("Plan text in the main checkout"),
                "The primary document is not execution authority and must not produce a mismatch warning.",
            );
            assert(`${result.scrollbackText || ""}\n${result.screenText}`.includes("Status: in_progress"));
            assert(
                typeof result.state.primaryPlanAfterExecutionAuthority === "string" &&
                    result.state.primaryPlanAfterExecutionAuthority.includes("Keep this local text."),
                "Expected remote publication to leave the edited main-checkout Plan intact.",
            );
            assert(
                !`${result.scrollbackText || ""}\n${result.screenText}`.includes("old status data"),
                "Continuation must not expose a mismatch between the primary and execution Plan copies.",
            );
        }),
        assertsGoldenCoverage("recovery:load-plan-worktree", (result: GoldenScenarioResult) => {
            const captured = projectState(result);
            assert(
                (captured.nonTerminalRegistryEntries || []).length === 0,
                "Expected the continued worktree to publish and leave no live attempt.",
            );
        }),
    ],
};

export const loadPlanMalformedFrontMatterScenario = {
    name: "load-plan-malformed-front-matter-fails-closed",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 20000,
    coverage: ["recovery:malformed-plan-front-matter"],
    initialProjectFiles: [{
        path: "docs/plans/broken.md",
        text:
            "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Broken\naffectedPaths: []\nstatus: draft\n---\n# Broken\n",
    }],
    actions: [
        { type: "type", text: "/load-plan broken" },
        {
            type: "writeProjectFile",
            path: "docs/plans/broken.md",
            text: "---\nclassification: [PLANNED_CHANGE\nstatus: draft\n---\n# Broken\n",
        },
        { type: "captureProjectFileText", path: "docs/plans/broken.md", key: "brokenPlanTextBefore" },
        { type: "enter" },
        { type: "enter" },
        { type: "sleep", ms: 1000 },
        { type: "waitForIdle", timeoutMs: 10000 },
        { type: "captureProjectFileText", path: "docs/plans/broken.md", key: "brokenPlanTextAfter" },
        { type: "captureProjectState", planNames: ["broken"] },
    ],
    assertions: [
        assertsGoldenCoverage("recovery:malformed-plan-front-matter", (result: GoldenScenarioResult) => {
            assert(
                result.screenText.includes("Plan Front Matter could not be parsed") ||
                    result.screenText.includes("Plan not found: broken"),
                "Expected malformed or missing Plan Front Matter to fail closed on screen.",
            );
            assert(
                result.state.brokenPlanTextBefore === result.state.brokenPlanTextAfter,
                "Malformed Plan content must remain unchanged after /load-plan failure.",
            );
            const captured = projectState(result);
            assert(
                captured.plans?.[0]?.attrs === null,
                "Malformed Plan must not be parsed as a mutated lifecycle Plan.",
            );
            assert(
                (captured.registryEntries || []).length === 0,
                "Malformed Front Matter must not write registry entries.",
            );
            assert(
                (captured.workRecordNames || []).length === 0,
                "Malformed Front Matter must not write Work Records.",
            );
        }),
    ],
};

export const loadPlanValidateWithoutCustomChecksScenario = {
    name: "load-plan-validate-without-custom-checks-reaches-semantic-failure",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    coverage: ["workflow:load-plan", "recovery:workflow-validation"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        {
            path: "docs/plans/no-custom-checks.md",
            text:
                "---\nplanId: no-custom-checks-plan\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Validation without custom checks\naffectedPaths: []\nstatus: draft\n---\n# Validate without custom checks\n",
        },
    ],
    scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery", value: "validate" }],
    actions: [
        {
            type: "seedActiveWorktree",
            planName: "no-custom-checks",
            status: "implemented",
            attrs: { executionMode: "worktree" },
        },
        {
            type: "setPrimaryPlanStatus",
            planName: "no-custom-checks",
            status: "ready_for_work",
            clearPrimaryWorktreeEvidence: true,
        },
        { type: "type", text: "/load-plan no-custom-checks" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Status: implemented", timeoutMs: 30000 },
        { type: "waitForScreen", text: "Tests and CI passed.", timeoutMs: 90000 },
        { type: "waitForIdle", timeoutMs: 90000 },
        { type: "captureProjectState", planNames: ["no-custom-checks"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan no-custom-checks");
            assertScreenIncludes(result, "Tests and CI passed.");
            assertScreenIncludes(result, "Validation failed");
        }),
        assertsGoldenCoverage("recovery:workflow-validation", (result: GoldenScenarioResult) => {
            const plan = projectState(result).plans?.find((entry) => entry.name === "no-custom-checks");
            assert(plan?.attrs?.status === "implemented");
            assert(String(plan?.attrs?.failureReason || "").includes("No implementation changes detected"));
        }),
    ],
};

export const loadPlanDirectReviewScenario = {
    name: "load-plan-direct-review-from-draft",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    coverage: ["workflow:load-plan", "durable:plan-lifecycle"],
    reviewDecisions: [{ approved: true, feedback: "Direct review approved for later.", approvalAction: "later" }],
    initialProjectFiles: [
        {
            path: "docs/plans/direct-review.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Direct review\naffectedPaths: []\nstatus: draft\n---\n# Direct review\n",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do", value: "review" },
    ],
    actions: [
        { type: "type", text: "/load-plan direct-review" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForPlanStatus", planName: "direct-review", statuses: ["ready_for_work"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["direct-review"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan direct-review");
            assertScreenIncludes(result, "Plan saved. Resume later with: wld load-plan direct-review");
            assert(
                !result.events.some((event) => event.includes("runtime:tool:start:plan_written")),
                "Direct review must not start Planner and plan_written before opening review.",
            );
        }),
        assertsGoldenCoverage("durable:plan-lifecycle", (result: GoldenScenarioResult) => {
            assert(
                planStatus(result, "direct-review") === "ready_for_work",
                `Expected direct review to leave ready_for_work; got ${planStatus(result, "direct-review")}`,
            );
        }),
    ],
};

export const loadPlanDirectReviewRunScenario = {
    name: "load-plan-direct-review-approves-and-runs",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    coverage: ["workflow:load-plan", "durable:plan-lifecycle"],
    reviewDecisions: [{ approved: true, feedback: "Direct review approved to run.", approvalAction: "run" }],
    initialProjectFiles: [
        {
            path: "docs/plans/direct-review-run.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Direct review run\naffectedPaths: []\nstatus: draft\n---\n# Direct review run\n",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do", value: "review" },
    ],
    script: [
        {
            id: "direct-review-run-engineer-completes",
            agent: "engineer",
            phase: "engineer",
            ordinal: 1,
            requiredTools: ["task_completed"],
            toolCalls: [{ name: "task_completed", arguments: { message: "- direct run complete" } }],
        },
    ],
    actions: [
        { type: "type", text: "/load-plan direct-review-run" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:agent:plan-engineer", timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["direct-review-run"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan direct-review-run");
            assertEventIncludes(result, "runtime:agent:plan-engineer");
            assertEventIncludes(result, "runtime:tool:start:task_completed");
            assertScreenIncludes(result, "Starting Plan Engineer");
            assert(
                !result.events.some((event) => event.includes("runtime:tool:start:plan_written")),
                "Direct review Approve & Run must not start Planner before execution.",
            );
        }),
        assertsGoldenCoverage("durable:plan-lifecycle", (result: GoldenScenarioResult) => {
            assert(
                planStatus(result, "direct-review-run") !== "draft",
                `Expected direct review run to move out of draft; got ${planStatus(result, "direct-review-run")}`,
            );
        }),
    ],
};

export const loadPlanReadOnlyPickerScenario = {
    name: "load-plan-picker-cancel-preserves-project",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 20000,
    coverage: ["workflow:load-plan"],
    initialProjectFiles: [{ path: "docs/plans/plain.md", text: "# Plain user-authored Plan\n" }],
    scriptedInteractions: [{ type: "select", promptIncludes: "Load plan:", value: null }],
    actions: [
        // The harness enters runtime storage at startup. Model a subsequent user
        // edit so that another implicit runtime entry cannot hide behind that setup.
        { type: "writeProjectFile", path: ".gitignore", text: "# User-owned Git settings\n" },
        { type: "captureProjectFileText", path: ".gitignore", key: "ignoreBeforePicker" },
        { type: "type", text: "/load-plan" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 10000 },
        { type: "captureProjectFileText", path: ".gitignore", key: "ignoreAfterPicker" },
        { type: "assertOnlyProjectChanges", paths: [".gitignore"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:load-plan", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan");
            assertEquals(result.state.ignoreAfterPicker, result.state.ignoreBeforePicker);
            assertEquals([...recoveryOptionValues(result)], ["plain"]);
            assertEquals(result.actor.consumed, []);
            assert(!result.screenText.includes("Error:"));
            assert(!result.screenText.includes("Plan loaded:"));
        }),
    ],
};

export const loadPlanWorkflowScenarios = [
    loadPlanReadOnlyPickerScenario,
    loadPlanActionsScenario,
    loadPlanDirectReviewScenario,
    loadPlanDirectReviewRunScenario,
    loadPlanResetReviewArchiveScenario,
    loadPlanCanceledExecutionThenPlannerReviewScenario,
    loadPlanInterruptedRecoveryScenario,
    loadPlanWorktreeInspectResetScenario,
    loadPlanAbandonProgressScenario,
    loadPlanImplementedFollowUpRepaintsScenario,
    loadPlanContinueUsesExecutionPlanAuthorityScenario,
    loadPlanMalformedFrontMatterScenario,
    loadPlanValidateWithoutCustomChecksScenario,
];
