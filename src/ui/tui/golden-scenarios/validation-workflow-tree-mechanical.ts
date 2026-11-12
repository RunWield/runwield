import {
    plannedChangeCiRepairReentryScenario,
    plannedChangeValidationExhaustedScenario,
    plannedChangeValidationFailureRetryScenario,
} from "./planned-change-workflow.js";
import { withValidationBranches } from "./validation-workflow-tree-shared.ts";

export const validationTreeCiLoopScenario = withValidationBranches(
    plannedChangeCiRepairReentryScenario,
    "validation-tree-ci-loop",
    ["plan"],
    ["mechanical:ci:pass", "mechanical:ci:repair-completed"],
);

export const validationTreeCiRetrySuccessScenario = withValidationBranches(
    plannedChangeValidationFailureRetryScenario,
    "validation-tree-ci-retry-success",
    ["validation-retry"],
    ["semantic:approval:first-round"],
);

function ciCancellationScenario(choice: "engineer_follow_up" | "retry" | "stop") {
    const planName = `ci-cancel-${choice === "stop" ? "stop" : choice === "retry" ? "retry" : "follow-up"}`;
    return {
        ...plannedChangeValidationFailureRetryScenario,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "sleep 30" }, null, 4)}\n` },
        ],
        reviewDecisions: [
            {
                approved: true,
                feedback: "Approved for CI cancellation coverage.",
                approvalAction: "run",
            },
        ],
        reviewedPlan: `# ${planName}\n\nGolden CI cancellation content.\n`,
        scriptedInteractions: [{ type: "select", promptIncludes: "tests for", value: choice }],
        script: [
            {
                id: `planner-submits-${planName}`,
                agent: "planner",
                phase: "plan_review",
                ordinal: 1,
                requiredTools: ["plan_written"],
                toolCalls: [
                    {
                        name: "plan_written",
                        arguments: { planName },
                    },
                ],
            },
            {
                id: `engineer-implements-${planName}`,
                agent: "engineer",
                phase: "engineer",
                planName,
                ordinal: 1,
                requiredTools: ["bash", "task_completed"],
                toolCalls: [
                    { name: "bash", arguments: { command: "printf cancel > golden-ci-cancel.txt" } },
                    { name: "task_completed", arguments: { message: "- Implemented CI cancellation fixture." } },
                ],
            },
            {
                id: `engineer-closes-${planName}`,
                agent: "engineer",
                phase: "engineer",
                planName,
                ordinal: 2,
                text: "Awaiting canceled CI decision.",
            },
        ],
        actions: [
            {
                type: "savePlan",
                planName,
                text: `---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: CI cancel\naffectedPaths: []\nstatus: draft\n---\n# CI cancel\n\nDraft content.\n`,
            },
            { type: "type", text: `submit ${planName} plan for review` },
            { type: "enter" },
            { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
            { type: "waitForPlanStatus", planName, statuses: ["implemented"], timeoutMs: 90000 },
            { type: "waitForEventCount", event: "runtime:tool:start:bash", count: 2, timeoutMs: 90000 },
            { type: "sleep", ms: 1000 },
            { type: "escape" },
            { type: "sleep", ms: 1000 },
        ],
        assertions: [],
    };
}

export const validationTreeCiCancelRetryScenario = withValidationBranches(
    {
        ...ciCancellationScenario("retry"),
        scriptedInteractions: [
            {
                type: "select",
                promptIncludes: "tests for",
                value: "retry",
                userFixesFirst: {
                    target: "execution",
                    planName: "ci-cancel-retry",
                    path: ".wld/settings.json",
                    text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n`,
                },
            },
        ],
    },
    "validation-tree-ci-cancel-retry",
    ["ci-cancel-retry"],
    ["mechanical:ci:cancel-retry"],
);

export const validationTreeCiCancelFollowUpScenario = withValidationBranches(
    ciCancellationScenario("engineer_follow_up"),
    "validation-tree-ci-cancel-follow-up",
    ["ci-cancel-follow-up"],
    ["mechanical:ci:cancel-follow-up"],
);

export const validationTreeCiCancelStopScenario = withValidationBranches(
    ciCancellationScenario("stop"),
    "validation-tree-ci-cancel-stop",
    ["ci-cancel-stop"],
    ["mechanical:ci:cancel-stop"],
);

export const validationTreeCiRepairIncompleteScenario = withValidationBranches(
    {
        ...plannedChangeValidationFailureRetryScenario,
        script: [
            ...(plannedChangeValidationFailureRetryScenario.script ?? []).slice(0, 3),
            {
                id: "engineer-ci-repair-without-completion",
                agent: "engineer",
                phase: "engineer",
                planName: "validation-retry",
                ordinal: 3,
                requiredTools: ["bash"],
                toolCalls: [
                    {
                        name: "bash",
                        arguments: { command: "printf repaired > golden-validation-retry.txt" },
                    },
                ],
            },
            {
                id: "engineer-ci-repair-stops-before-completion",
                agent: "engineer",
                phase: "engineer",
                planName: "validation-retry",
                ordinal: 4,
                text: "CI repair stopped before task_completed.",
            },
        ],
        actions: [
            {
                type: "savePlan",
                planName: "validation-retry",
                text: "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Validation retry\naffectedPaths: []\nstatus: draft\n---\n# Validation retry\n\nDraft content.\n",
            },
            { type: "type", text: "submit validation retry plan for review" },
            { type: "enter" },
            { type: "waitForEvent", event: "runtime:tool:start:task_completed", timeoutMs: 60000 },
            { type: "waitForPlanStatus", planName: "validation-retry", statuses: ["implemented"], timeoutMs: 90000 },
            { type: "sleep", ms: 1000 },
        ],
        assertions: [],
    },
    "validation-tree-ci-repair-incomplete",
    ["validation-retry"],
    ["mechanical:ci:repair-incomplete"],
);

export const validationTreeValidationExhaustedRetryScenario = withValidationBranches(
    {
        ...plannedChangeValidationExhaustedScenario,
        scriptedInteractions: [
            {
                type: "select",
                promptIncludes: "tests for",
                value: "retry",
                userFixesFirst: {
                    target: "execution",
                    planName: "validation-exhausted",
                    path: ".wld/settings.json",
                    text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n`,
                },
            },
        ],
        script: [
            ...(plannedChangeValidationExhaustedScenario.script ?? []),
            {
                id: "reviewer-approves-validation-exhausted-retry-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "validation-exhausted",
                ordinal: 1,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "golden-validation-exhausted.txt" },
                    },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".wld/settings.json" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "docs/plans/validation-exhausted.md" },
                    },
                ],
            },
            {
                id: "reviewer-approves-validation-exhausted-retry",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "validation-exhausted",
                ordinal: 2,
                requiredTools: ["review_complete"],
                toolCalls: [
                    { name: "review_complete", arguments: { approved: true, feedback: "Exhausted retry approved." } },
                ],
            },
        ],
        actions: [
            ...(plannedChangeValidationExhaustedScenario.actions ?? []).filter(
                (action: { type?: string }) => action.type !== "captureProjectState",
            ),
            { type: "waitForPlanStatus", planName: "validation-exhausted", statuses: ["verified"], timeoutMs: 90000 },
        ],
        assertions: [],
    },
    "validation-tree-validation-exhausted-retry",
    ["validation-exhausted"],
    ["mechanical:ci:exhausted-retry"],
);

export const validationTreeValidationExhaustedFollowUpScenario = withValidationBranches(
    {
        ...plannedChangeValidationExhaustedScenario,
        scriptedInteractions: [
            { type: "select", promptIncludes: "tests for", value: "engineer_follow_up" },
            {
                type: "text",
                promptIncludes: "Validation Repair Engineer",
                value: "Inspect why the verification command still fails, then try the smallest safe repair.",
            },
        ],
        script: [
            ...(plannedChangeValidationExhaustedScenario.script ?? []),
            {
                id: "validation-exhausted-follow-up-pauses",
                agent: "engineer",
                phase: "engineer",
                planName: "validation-exhausted",
                ordinal: 9,
                text: "I need more user guidance before changing the verification setup.",
            },
        ],
        actions: (plannedChangeValidationExhaustedScenario.actions ?? []).map(
            (action: { type?: string; event?: string }) =>
                action.type === "waitForEventCount" && action.event === "runtime:interaction_resolved"
                    ? { ...action, count: 3 }
                    : action,
        ),
    },
    "validation-tree-validation-exhausted-follow-up",
    ["validation-exhausted"],
    ["mechanical:ci:exhausted-follow-up"],
);

export const validationTreeValidationExhaustedStopScenario = withValidationBranches(
    plannedChangeValidationExhaustedScenario,
    "validation-tree-validation-exhausted-stop",
    ["validation-exhausted"],
    ["mechanical:ci:exhausted-stop"],
);

export const validationWorkflowMechanicalScenarios = [
    validationTreeCiLoopScenario,
    validationTreeCiRetrySuccessScenario,
    validationTreeCiCancelRetryScenario,
    validationTreeCiCancelFollowUpScenario,
    validationTreeCiCancelStopScenario,
    validationTreeCiRepairIncompleteScenario,
    validationTreeValidationExhaustedRetryScenario,
    validationTreeValidationExhaustedFollowUpScenario,
    validationTreeValidationExhaustedStopScenario,
];
