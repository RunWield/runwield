import { plannedChangeReviewRepairValidationScenario } from "./planned-change-workflow.js";
import { withValidationBranches } from "./validation-workflow-tree-shared.ts";

function humanReviewSettings(codereview: "none" | "ask" | "always"): string {
    return `${JSON.stringify({ codereview, verification_command: "true" }, null, 4)}\n`;
}

export const validationTreeHumanReviewNoneScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("none"),
            },
        ],
        scriptedInteractions: [],
        actions: plannedChangeReviewRepairValidationScenario.actions.filter((action: { type?: string }) =>
            action.type !== "assertWorkflowDurability"
        ),
        assertions: [],
    },
    "validation-tree-human-review-none",
    ["plan"],
    ["human-review:none"],
);

export const validationTreeHumanReviewAskSkipScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("ask"),
            },
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "code review before merge", value: "skip" },
        ],
        actions: plannedChangeReviewRepairValidationScenario.actions.filter((action: { type?: string }) =>
            action.type !== "assertWorkflowDurability"
        ),
        assertions: [],
    },
    "validation-tree-human-review-ask-skip",
    ["plan"],
    ["human-review:ask-skip"],
);

export const validationTreeHumanReviewAskOpenApproveScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("ask"),
            },
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "code review before merge", value: "open" },
        ],
        humanReviewDecisions: [{ approved: true, feedback: "Human approves the Golden implementation." }],
        actions: plannedChangeReviewRepairValidationScenario.actions.filter((action: { type?: string }) =>
            action.type !== "assertWorkflowDurability"
        ),
        assertions: [],
    },
    "validation-tree-human-review-ask-open-approve",
    ["plan"],
    ["human-review:ask-open-approve"],
);

export const validationTreeHumanReviewAlwaysApproveScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("always"),
            },
        ],
        humanReviewDecisions: [{ approved: true, feedback: "Human always-review approves the Golden implementation." }],
        scriptedInteractions: [],
        actions: plannedChangeReviewRepairValidationScenario.actions.filter((action: { type?: string }) =>
            action.type !== "assertWorkflowDurability"
        ),
        assertions: [],
    },
    "validation-tree-human-review-always-approve",
    ["plan"],
    ["human-review:always-approve"],
);

export const validationTreeHumanReviewNoAnswerRetryScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("always"),
            },
        ],
        humanReviewDecisions: [
            { canceled: true },
            { approved: true, feedback: "Human approves after reopening the review." },
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "Pick Retry to open it again", value: "retry" },
        ],
        actions: plannedChangeReviewRepairValidationScenario.actions.filter((action: { type?: string }) =>
            action.type !== "assertWorkflowDurability"
        ),
        assertions: [],
    },
    "validation-tree-human-review-no-answer-retry",
    ["plan"],
    ["human-review:no-answer-retry"],
);

export const validationTreeHumanReviewNoAnswerStopScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("always"),
            },
        ],
        humanReviewDecisions: [{ canceled: true }],
        script: plannedChangeReviewRepairValidationScenario.script.map((turn: { id?: string }) =>
            turn.id === "engineer-post-repair-turn-before-re-review" ? { ...turn, optional: true } : turn
        ),
        scriptedInteractions: [
            { type: "select", promptIncludes: "Pick Retry to open it again", value: "stop" },
        ],
        actions: [
            ...plannedChangeReviewRepairValidationScenario.actions.slice(0, 3),
            { type: "waitForScreen", text: "Pick Retry to open it again", timeoutMs: 240000 },
            { type: "sleep", ms: 500 },
            { type: "captureProjectState", planNames: ["plan"] },
        ],
        assertions: [],
    },
    "validation-tree-human-review-no-answer-stop",
    ["plan"],
    ["human-review:no-answer-stop"],
);

export const validationTreeHumanReviewAskCloseScenario = withValidationBranches(
    {
        ...validationTreeHumanReviewNoAnswerStopScenario,
        committedProjectFiles: [{ path: ".wld/settings.json", text: humanReviewSettings("ask") }],
        humanReviewDecisions: [],
        scriptedInteractions: [{ type: "select", promptIncludes: "code review before merge", value: "close" }],
        actions: [
            ...plannedChangeReviewRepairValidationScenario.actions.slice(0, 3),
            { type: "waitForScreen", text: "Code review is still waiting for your decision", timeoutMs: 240000 },
            { type: "waitForIdle", timeoutMs: 60000 },
            { type: "captureProjectState", planNames: ["plan"] },
        ],
        assertions: [],
    },
    "validation-tree-human-review-ask-close",
    ["plan"],
    ["human-review:ask-close"],
);

export const validationTreeHumanReviewFeedbackRepairApproveScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        committedProjectFiles: [
            {
                path: ".wld/settings.json",
                text: humanReviewSettings("always"),
            },
        ],
        humanReviewDecisions: [
            { approved: false, feedback: "Code review requests one more durable note." },
            { approved: true, feedback: "Human approves after feedback repair." },
        ],
        script: plannedChangeReviewRepairValidationScenario.script.filter((turn: { id?: string }) =>
            turn.id !== "engineer-post-repair-turn-before-re-review" && turn.id !== "engineer-closes-after-delivery"
        ).concat([
            {
                id: "engineer-repairs-human-review-feedback",
                agent: "engineer",
                phase: "engineer",
                ordinal: 5,
                requiredTools: ["write"],
                thinking: "Repair after Code Review feedback.",
                toolCalls: [{
                    name: "write",
                    arguments: { path: "golden-planned-change.txt", content: "golden-human-review-repaired" },
                }],
            },
            {
                id: "engineer-completes-human-review-feedback-repair",
                agent: "engineer",
                phase: "engineer",
                ordinal: 6,
                requiredTools: ["task_completed"],
                thinking: "Report Code Review feedback repair complete.",
                toolCalls: [{
                    name: "task_completed",
                    arguments: { message: "- Repaired Code Review feedback." },
                }],
            },
        ]),
        scriptedInteractions: [],
        actions: plannedChangeReviewRepairValidationScenario.actions.filter((action: { type?: string }) =>
            action.type !== "assertWorkflowDurability"
        ),
        assertions: [],
    },
    "validation-tree-human-review-feedback-repair-approve",
    ["plan"],
    ["human-review:feedback-repair-approve"],
);

export const validationWorkflowHumanReviewScenarios = [
    validationTreeHumanReviewNoneScenario,
    validationTreeHumanReviewAskSkipScenario,
    validationTreeHumanReviewAskCloseScenario,
    validationTreeHumanReviewAskOpenApproveScenario,
    validationTreeHumanReviewAlwaysApproveScenario,
    validationTreeHumanReviewFeedbackRepairApproveScenario,
    validationTreeHumanReviewNoAnswerRetryScenario,
    validationTreeHumanReviewNoAnswerStopScenario,
];
