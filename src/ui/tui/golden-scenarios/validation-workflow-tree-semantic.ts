import { assertEquals } from "@std/assert";
import {
    plannedChangeNonGitInPlaceScenario,
    plannedChangeReviewRepairValidationScenario,
} from "./planned-change-workflow.js";
import { validationEvidenceAssertion } from "../testing/validation-workflow-coverage.ts";
import { withValidationBranches } from "./validation-workflow-tree-shared.ts";

type GoldenScriptValue = string | number | boolean | null | GoldenScriptValue[] | {
    [key: string]: GoldenScriptValue;
};

interface GoldenScriptTurn {
    id: string;
    agent: string;
    phase: string;
    ordinal: number;
    planName?: string;
    optional?: boolean;
    requiredTools?: string[];
    thinking?: string;
    text?: string;
    response?: GoldenScriptValue;
    toolCalls?: Array<{ name: string; arguments: { [key: string]: GoldenScriptValue } }>;
}

export const validationTreeSemanticReviewLoopScenario = withValidationBranches(
    plannedChangeReviewRepairValidationScenario,
    "validation-tree-semantic-review-loop",
    ["plan"],
);

export const validationTreeSemanticRepairIncompleteScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        name: "validation-tree-semantic-repair-incomplete-base",
        script: [
            ...(plannedChangeReviewRepairValidationScenario.script as GoldenScriptTurn[]).slice(0, 6),
            {
                id: "engineer-semantic-repair-without-completion",
                agent: "engineer",
                phase: "engineer",
                ordinal: 3,
                requiredTools: ["write"],
                thinking: "Repair after Semantic Reviewer rejection but do not complete the repair.",
                toolCalls: [{
                    name: "write",
                    arguments: { path: "golden-planned-change.txt", content: "goldenrepaired" },
                }],
            },
            {
                id: "engineer-semantic-repair-stops-before-completion",
                agent: "engineer",
                phase: "engineer",
                ordinal: 4,
                optional: true,
                text: "Semantic Review repair stopped before task_completed.",
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
            { type: "waitForEvent", event: "runtime:tool:start:review_complete", timeoutMs: 120000 },
            { type: "waitForEvent", event: "runtime:agent:plan-engineer", timeoutMs: 120000 },
            {
                type: "waitForPlanStatus",
                planName: "plan",
                statuses: ["implemented"],
                validationPhase: "semantic",
                timeoutMs: 90000,
            },
            { type: "waitForIdle", timeoutMs: 120000 },
        ],
        assertions: [],
    },
    "validation-tree-semantic-repair-incomplete",
    ["plan"],
    ["semantic:repair-incomplete"],
);

export const validationTreeSemanticReviewerIncompletePauseScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-reviewer-incomplete-pause-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/semantic-reviewer-incomplete.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic reviewer incomplete\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-reviewer-incomplete-plan\n---\n# Semantic reviewer incomplete\n\nAlready implemented content.\n",
        }],
        script: [1, 2, 3].map((ordinal) => ({
            id: `reviewer-incomplete-attempt-${ordinal}`,
            agent: "reviewer",
            phase: "semantic_review",
            planName: "semantic-reviewer-incomplete",
            ordinal,
            text: `Reviewer attempt ${ordinal} stopped without review_complete.`,
        })),
        scriptedInteractions: [
            { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
        ],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-reviewer-incomplete",
                status: "validated_ci",
                files: [{ path: "semantic-reviewer-incomplete.txt", text: "implemented\n" }],
                attrs: {},
            },
            { type: "type", text: "/load-plan semantic-reviewer-incomplete" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForScreen", text: "AI review", timeoutMs: 90000 },
            { type: "waitForIdle", timeoutMs: 90000 },
            { type: "captureProjectState", planNames: ["semantic-reviewer-incomplete"] },
        ],
        assertions: [],
    },
    "validation-tree-semantic-reviewer-incomplete-pause",
    ["semantic-reviewer-incomplete"],
    ["semantic:reviewer-incomplete-pause"],
);

export const validationTreeSemanticProviderErrorRetryScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-provider-error-retry-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [{
            path: ".wld/settings.json",
            text: `${
                JSON.stringify(
                    {
                        verification_command: "true",
                        "retry.baseDelayMs": 1,
                        "retry.validation.maxDelayMs": 1,
                    },
                    null,
                    4,
                )
            }\n`,
        }],
        initialProjectFiles: [{
            path: "docs/plans/semantic-provider-error-retry.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic provider error retry\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-provider-error-retry-plan\n---\n# Semantic provider error retry\n\nAlready implemented content.\n",
        }],
        script: [
            {
                id: "semantic-review-provider-404",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-provider-error-retry",
                ordinal: 1,
                response: {
                    role: "assistant",
                    content: [],
                    api: "openai-responses",
                    provider: "faux-provider",
                    model: "golden-faux-model",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {},
                    },
                    stopReason: "error",
                    errorMessage: "404 Not Found",
                    timestamp: 0,
                },
            },
            {
                id: "semantic-review-approves-after-provider-retry-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-provider-error-retry",
                ordinal: 2,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "semantic-provider-error-retry.txt" },
                    },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "docs/plans/semantic-provider-error-retry.md",
                        },
                    },
                ],
            },
            {
                id: "semantic-review-approves-after-provider-retry",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-provider-error-retry",
                ordinal: 3,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Approved after the provider recovered." },
                    },
                ],
            },
        ],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-provider-error-retry",
                status: "validated_ci",
                files: [{ path: "semantic-provider-error-retry.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan semantic-provider-error-retry" },
            { type: "enter" },
            { type: "enter" },
            {
                type: "waitForPlanStatus",
                planName: "semantic-provider-error-retry",
                statuses: ["verified"],
                timeoutMs: 120000,
            },
            { type: "captureProjectState", planNames: ["semantic-provider-error-retry"] },
        ],
        assertions: [],
    },
    "validation-tree-semantic-provider-error-retry",
    ["semantic-provider-error-retry"],
    ["semantic:provider-error-retry"],
);

export const validationTreeSemanticNudgeOmittedPriorFindingScenario = withValidationBranches(
    {
        ...plannedChangeReviewRepairValidationScenario,
        name: "validation-tree-semantic-nudge-omitted-prior-finding-base",
        script: [
            ...plannedChangeReviewRepairValidationScenario.script.slice(0, 4),
            {
                id: "semantic-reviewer-rejects-with-ledger-finding-inspects-diff",
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
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: ".wld/settings.json" },
                    },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "docs/plans/plan.md" },
                    },
                ],
            },
            {
                id: "semantic-reviewer-rejects-with-ledger-finding",
                agent: "reviewer",
                phase: "semantic_review",
                ordinal: 2,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: {
                            approved: false,
                            feedback: "Missing durable evidence.",
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
            ...plannedChangeReviewRepairValidationScenario.script.filter((turn) =>
                turn.agent === "engineer" && turn.ordinal >= 3
            ),
            {
                id: "semantic-reviewer-omits-prior-finding-after-repair-inspects-diff",
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
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: ".wld/settings.json" },
                    },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "docs/plans/plan.md" },
                    },
                ],
            },
            {
                id: "semantic-reviewer-omits-prior-finding-after-repair",
                agent: "reviewer",
                phase: "semantic_review",
                ordinal: 4,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Approved but omitted prior finding.", findings: [] },
                    },
                ],
            },
            {
                id: "semantic-reviewer-accounts-for-prior-finding-after-nudge-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                ordinal: 5,
                requiredTools: ["review_diff"],
                thinking: "Inspect every changed file before deciding.",
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "golden-planned-change.txt" },
                    },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: ".wld/settings.json" },
                    },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "docs/plans/plan.md" },
                    },
                ],
            },
            {
                id: "semantic-reviewer-accounts-for-prior-finding-after-nudge",
                agent: "reviewer",
                phase: "semantic_review",
                ordinal: 6,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: {
                            approved: true,
                            feedback: "Approved after accounting for prior finding.",
                            findings: [{ id: "R1-1", status: "fix_confirmed", title: "Missing durable evidence" }],
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
            { type: "waitForPlanStatus", planName: "plan", statuses: ["verified"], timeoutMs: 300000 },
            { type: "waitForWorktreeRegistryStatus", planName: "plan", statuses: ["absent"], timeoutMs: 90000 },
            { type: "assertWorkflowDurability" },
        ],
        assertions: [],
    },
    "validation-tree-semantic-nudge-omitted-prior-finding",
    ["plan"],
    ["semantic:nudge:omitted-prior-finding"],
);

export const validationTreeNonGitDeliveryScenario = withValidationBranches(
    plannedChangeNonGitInPlaceScenario,
    "validation-tree-non-git-delivery",
    ["non-git-plan"],
    ["semantic:entry:non-git-skip", "publication:non-git-success"],
);

export const validationTreeSemanticNudgeMissingReviewCompleteScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-nudge-missing-review-complete-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/semantic-nudge-missing-review-complete.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic nudge missing review_complete\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-nudge-missing-review-complete-plan\n---\n# Semantic nudge missing review_complete\n\nAlready implemented content.\n",
        }],
        script: [
            {
                id: "reviewer-stops-before-review-complete",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-nudge-missing-review-complete",
                ordinal: 1,
                text: "I inspected the situation but did not call review_complete.",
            },
            {
                id: "reviewer-completes-after-review-complete-nudge-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-nudge-missing-review-complete",
                ordinal: 2,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "semantic-nudge-review-complete-implementation.txt",
                        },
                    },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "docs/plans/semantic-nudge-missing-review-complete.md",
                        },
                    },
                ],
            },
            {
                id: "reviewer-completes-after-review-complete-nudge",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-nudge-missing-review-complete",
                ordinal: 3,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Approved after review_complete nudge." },
                    },
                ],
            },
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
        ],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-nudge-missing-review-complete",
                status: "validated_ci",
                files: [{ path: "semantic-nudge-review-complete-implementation.txt", text: "implemented\n" }],
                attrs: {},
            },
            { type: "type", text: "/load-plan semantic-nudge-missing-review-complete" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForIdle", timeoutMs: 180000 },
            {
                type: "waitForPlanStatus",
                planName: "semantic-nudge-missing-review-complete",
                statuses: ["verified"],
                timeoutMs: 90000,
            },
        ],
        assertions: [],
    },
    "validation-tree-semantic-nudge-missing-review-complete",
    ["semantic-nudge-missing-review-complete"],
    ["semantic:nudge:missing-review-complete"],
);

export const validationTreeSemanticNudgeMissingDiffInspectionScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-nudge-missing-diff-inspection-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/semantic-nudge-missing-diff.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic nudge missing diff\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-nudge-missing-diff-plan\n---\n# Semantic nudge missing diff\n\nAlready implemented content.\n",
        }],
        script: [
            {
                id: "reviewer-decides-without-diff-inspection",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-nudge-missing-diff",
                ordinal: 1,
                requiredTools: ["review_complete"],
                toolCalls: [{
                    name: "review_complete",
                    arguments: { approved: true, feedback: "Approved without inspecting diff." },
                }],
            },
            {
                id: "reviewer-approves-after-diff-inspection-nudge-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-nudge-missing-diff",
                ordinal: 2,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "semantic-nudge-implementation.txt" },
                    },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "docs/plans/semantic-nudge-missing-diff.md",
                        },
                    },
                ],
            },
            {
                id: "reviewer-approves-after-diff-inspection-nudge",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-nudge-missing-diff",
                ordinal: 3,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Approved after diff inspection." },
                    },
                ],
            },
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
        ],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-nudge-missing-diff",
                status: "validated_ci",
                files: [{ path: "semantic-nudge-implementation.txt", text: "implemented\n" }],
                attrs: {},
            },
            { type: "type", text: "/load-plan semantic-nudge-missing-diff" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForIdle", timeoutMs: 180000 },
            {
                type: "waitForPlanStatus",
                planName: "semantic-nudge-missing-diff",
                statuses: ["verified"],
                timeoutMs: 90000,
            },
        ],
        assertions: [],
    },
    "validation-tree-semantic-nudge-missing-diff-inspection",
    ["semantic-nudge-missing-diff"],
    ["semantic:nudge:missing-diff-inspection"],
);

export const validationTreeSemanticRoundLimitStopScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-round-limit-stop-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 240000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/semantic-round-limit-stop.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic round limit stop\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-round-limit-stop-plan\n---\n# Semantic round limit stop\n\nAlready implemented content.\n",
        }],
        script: [
            {
                id: "reviewer-rejects-semantic-round-limit-stop-1-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 1,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "semantic-round-limit-stop.txt" },
                    },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "docs/plans/semantic-round-limit-stop.md",
                        },
                    },
                ],
            },
            {
                id: "reviewer-rejects-semantic-round-limit-stop-1",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 2,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: {
                            approved: false,
                            feedback: "Round 1 still has open work.",
                            findings: [{
                                status: "new",
                                title: "Round-limit issue",
                                requirement: "Semantic review",
                                evidence: "The repair still needs verification.",
                            }],
                        },
                    },
                ],
            },
            {
                id: "engineer-repairs-semantic-round-limit-stop-1",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop",
                ordinal: 1,
                requiredTools: ["write"],
                toolCalls: [{
                    name: "write",
                    arguments: { path: "semantic-round-limit-stop.txt", content: "repair 1\n" },
                }],
            },
            {
                id: "engineer-completes-semantic-round-limit-stop-1",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop",
                ordinal: 2,
                requiredTools: ["task_completed"],
                toolCalls: [{ name: "task_completed", arguments: { message: "- Repaired semantic round 1." } }],
            },
            {
                id: "reviewer-rejects-semantic-round-limit-stop-2-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 3,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "full", path: "semantic-round-limit-stop.txt" },
                    },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "docs/plans/semantic-round-limit-stop.md",
                        },
                    },
                ],
            },
            {
                id: "reviewer-rejects-semantic-round-limit-stop-2",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 4,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: {
                            approved: false,
                            feedback: "Round 2 still has open work.",
                            findings: [{
                                id: "R1-1",
                                status: "fix_rejected",
                                rejectionReason: "The issue remains after repair round 1.",
                                title: "Round-limit issue",
                                requirement: "Semantic review",
                                evidence: "The issue remains after repair round 1.",
                            }],
                        },
                    },
                ],
            },
            {
                id: "engineer-repairs-semantic-round-limit-stop-2",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop",
                ordinal: 3,
                requiredTools: ["write"],
                toolCalls: [{
                    name: "write",
                    arguments: { path: "semantic-round-limit-stop.txt", content: "repair 2\n" },
                }],
            },
            {
                id: "engineer-completes-semantic-round-limit-stop-2",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop",
                ordinal: 4,
                requiredTools: ["task_completed"],
                toolCalls: [{ name: "task_completed", arguments: { message: "- Repaired semantic round 2." } }],
            },
            {
                id: "reviewer-rejects-semantic-round-limit-stop-3-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 5,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "repair" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "repair", path: "semantic-round-limit-stop.txt" },
                    },
                ],
            },
            {
                id: "reviewer-rejects-semantic-round-limit-stop-3",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 6,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: {
                            approved: false,
                            feedback: "Round 3 still has open work.",
                            findings: [{
                                id: "R1-1",
                                status: "fix_rejected",
                                rejectionReason: "The issue remains after repair round 2.",
                                title: "Round-limit issue",
                                requirement: "Semantic review",
                                evidence: "The issue remains after repair round 2.",
                            }],
                        },
                    },
                ],
            },
            {
                id: "engineer-repairs-semantic-round-limit-stop-3",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop",
                ordinal: 5,
                requiredTools: ["write"],
                toolCalls: [{
                    name: "write",
                    arguments: { path: "semantic-round-limit-stop.txt", content: "repair 3\n" },
                }],
            },
            {
                id: "engineer-completes-semantic-round-limit-stop-3",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop",
                ordinal: 6,
                requiredTools: ["task_completed"],
                toolCalls: [{ name: "task_completed", arguments: { message: "- Repaired semantic round 3." } }],
            },
            {
                id: "reviewer-approves-semantic-round-limit-continue-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 7,
                optional: true,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "repair" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", scope: "repair", path: "semantic-round-limit-stop.txt" },
                    },
                ],
            },
            {
                id: "reviewer-approves-semantic-round-limit-continue",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-limit-stop",
                ordinal: 8,
                optional: true,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: {
                            approved: true,
                            feedback: "Focused round-limit recheck approved.",
                            findings: [{ id: "R1-1", status: "fix_confirmed", title: "Round-limit issue" }],
                        },
                    },
                ],
            },
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
            { type: "select", promptIncludes: "Look once more, read it, or stop.", value: "stop" },
        ],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-round-limit-stop",
                status: "validated_ci",
                files: [{ path: "semantic-round-limit-stop.txt", text: "implemented\n" }],
                attrs: {},
            },
            { type: "type", text: "/load-plan semantic-round-limit-stop" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForEventCount", event: "runtime:tool:start:task_completed", count: 3, timeoutMs: 90000 },
            { type: "waitForScreen", text: "Look once more, read it, or stop.", timeoutMs: 180000 },
            { type: "waitForEvent", event: "runtime:interaction_resolved", timeoutMs: 180000 },
            { type: "waitForIdle", timeoutMs: 180000 },
            { type: "captureProjectState", planNames: ["semantic-round-limit-stop"] },
        ],
        assertions: [],
    },
    "validation-tree-semantic-round-limit-stop",
    ["semantic-round-limit-stop"],
    ["semantic:round-limit:stop"],
);

export const validationTreeSemanticRoundLimitStopDirectScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-round-limit-stop-direct-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/semantic-round-limit-stop-direct.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic round limit stop direct\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-round-limit-stop-direct-plan\n---\n# Semantic round limit stop direct\n\nDraft content.\n",
        }],
        script: [
            {
                id: "engineer-finishes-semantic-round-limit-stop-direct",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop-direct",
                ordinal: 1,
                requiredTools: ["write"],
                toolCalls: [{
                    name: "write",
                    arguments: { path: "semantic-round-limit-stop-direct.txt", content: "implementation\n" },
                }],
            },
            {
                id: "engineer-completes-semantic-round-limit-stop-direct",
                agent: "engineer",
                phase: "engineer",
                planName: "semantic-round-limit-stop-direct",
                ordinal: 2,
                requiredTools: ["task_completed"],
                toolCalls: [{
                    name: "task_completed",
                    arguments: { message: "- Finished the implementation before review." },
                }],
            },
            ...(validationTreeSemanticRoundLimitStopScenario.script as GoldenScriptTurn[]).map((turn) => ({
                ...turn,
                id: `direct-${turn.id}`,
                planName: "semantic-round-limit-stop-direct",
                ordinal: turn.agent === "engineer" ? turn.ordinal + 2 : turn.ordinal,
                ...(Array.isArray(turn.toolCalls)
                    ? {
                        toolCalls: turn.toolCalls.map((call) => {
                            if (
                                call.name === "write" ||
                                (call.name === "review_diff" &&
                                    call.arguments?.command === "show" &&
                                    call.arguments?.path === "semantic-round-limit-stop.txt")
                            ) {
                                return {
                                    ...call,
                                    arguments: {
                                        ...call.arguments,
                                        path: "semantic-round-limit-stop-direct.txt",
                                    },
                                };
                            }
                            if (
                                call.name === "review_diff" &&
                                call.arguments?.command === "show" &&
                                call.arguments?.path === "docs/plans/semantic-round-limit-stop.md"
                            ) {
                                return {
                                    ...call,
                                    arguments: {
                                        ...call.arguments,
                                        path: "docs/plans/semantic-round-limit-stop-direct.md",
                                    },
                                };
                            }
                            return call;
                        }),
                    }
                    : {}),
            })),
        ],
        scriptedInteractions: [
            { type: "select", promptIncludes: "Plan recovery (in_progress)", value: "continue" },
            { type: "select", promptIncludes: "Look once more, read it, or stop.", value: "stop" },
        ],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-round-limit-stop-direct",
                status: "in_progress",
                attrs: {
                    validationSemanticRounds: 2,
                },
            },
            { type: "type", text: "/load-plan semantic-round-limit-stop-direct" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForEventCount", event: "runtime:tool:start:task_completed", count: 4, timeoutMs: 180000 },
            { type: "waitForScreen", text: "Look once more, read it, or stop.", timeoutMs: 180000 },
            { type: "waitForEvent", event: "runtime:interaction_resolved", timeoutMs: 180000 },
            { type: "waitForIdle", timeoutMs: 180000 },
            {
                type: "waitForPlanStatus",
                planName: "semantic-round-limit-stop-direct",
                statuses: ["implemented"],
                validationPhase: "semantic",
                timeoutMs: 90000,
            },
            { type: "captureProjectState", planNames: ["semantic-round-limit-stop-direct"] },
        ],
        assertions: [validationEvidenceAssertion("semantic:round-limit:stop-after-execution")],
    },
    "validation-tree-semantic-round-limit-stop-direct",
    ["semantic-round-limit-stop-direct"],
    ["semantic:round-limit:stop-after-execution"],
);

export const validationTreeSemanticRoundLimitContinueScenario = {
    ...validationTreeSemanticRoundLimitStopScenario,
    name: "validation-tree-semantic-round-limit-continue",
    scriptedInteractions: [
        { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
        { type: "select", promptIncludes: "Look once more, read it, or stop.", value: "continue" },
    ],
    actions: validationTreeSemanticRoundLimitStopScenario.actions.flatMap((action: { type?: string }) =>
        action.type === "captureProjectState"
            ? [
                {
                    type: "waitForPlanStatus",
                    planName: "semantic-round-limit-stop",
                    statuses: ["verified"],
                    timeoutMs: 180000,
                },
                action,
            ]
            : [action]
    ),
    validationBranches: ["semantic:round-limit:continue"],
    assertions: [validationEvidenceAssertion("semantic:round-limit:continue")],
};

export const validationTreeSemanticRoundLimitHumanReviewScenario = {
    ...validationTreeSemanticRoundLimitStopScenario,
    name: "validation-tree-semantic-round-limit-human-review",
    scriptedInteractions: [
        { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
        { type: "select", promptIncludes: "Look once more, read it, or stop.", value: "code_review" },
    ],
    humanReviewDecisions: [{ approved: true, feedback: "Human approved after reading the repaired changes." }],
    actions: validationTreeSemanticRoundLimitStopScenario.actions.flatMap((action: { type?: string }) =>
        action.type === "captureProjectState"
            ? [
                { type: "waitForEvent", event: "human-review:captured", timeoutMs: 30000 },
                {
                    type: "waitForPlanStatus",
                    planName: "semantic-round-limit-stop",
                    statuses: ["verified"],
                    timeoutMs: 180000,
                },
                action,
            ]
            : [action]
    ),
    validationBranches: ["semantic:round-limit:human-review"],
    assertions: [validationEvidenceAssertion("semantic:round-limit:human-review")],
};

type FollowUpPublicationResult = {
    state: { publication?: { deliveredText?: string; remotePlanStatus?: string } };
    actor: { consumed: string[] };
};

export const validationTreeSemanticRoundLimitFollowUpScenario = {
    ...validationTreeSemanticRoundLimitContinueScenario,
    name: "validation-tree-semantic-round-limit-follow-up",
    committedProjectFiles: [{
        path: ".wld/settings.json",
        text: JSON.stringify({
            verification_command:
                "if test \"$(cat semantic-round-limit-stop.txt)\" = followup; then printf 'checked followup' > followup-ci.txt; fi",
        }) + "\n",
    }],
    scriptedInteractions: [
        { type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" },
        { type: "select", promptIncludes: "Look once more, read it, or stop.", value: "engineer_follow_up" },
        { type: "text", promptIncludes: "Tell the Repair Engineer", value: "Apply the follow-up change and check it." },
        { type: "select", promptIncludes: "Look once more, read it, or stop.", value: "continue" },
    ],
    script: [
        ...(validationTreeSemanticRoundLimitStopScenario.script as GoldenScriptTurn[]).filter((turn) =>
            turn.id !== "reviewer-approves-semantic-round-limit-continue-inspects-diff" &&
            turn.id !== "reviewer-approves-semantic-round-limit-continue"
        ),
        {
            id: "engineer-applies-round-limit-follow-up",
            agent: "engineer",
            phase: "engineer",
            planName: "semantic-round-limit-stop",
            ordinal: 7,
            requiredTools: ["write"],
            toolCalls: [{ name: "write", arguments: { path: "semantic-round-limit-stop.txt", content: "followup\n" } }],
        },
        {
            id: "engineer-completes-round-limit-follow-up",
            agent: "engineer",
            phase: "engineer",
            planName: "semantic-round-limit-stop",
            ordinal: 8,
            requiredTools: ["task_completed"],
            toolCalls: [{ name: "task_completed", arguments: { message: "Follow-up applied." } }],
        },
        {
            ...(validationTreeSemanticRoundLimitStopScenario.script as GoldenScriptTurn[]).find((turn) =>
                turn.id === "reviewer-approves-semantic-round-limit-continue-inspects-diff"
            ),
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "repair" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "repair", path: "semantic-round-limit-stop.txt" },
                },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "repair", path: "followup-ci.txt" },
                },
            ],
        },
        {
            ...(validationTreeSemanticRoundLimitStopScenario.script as GoldenScriptTurn[]).find((turn) =>
                turn.id === "reviewer-approves-semantic-round-limit-continue"
            ),
            toolCalls: [{
                name: "review_complete",
                arguments: {
                    approved: true,
                    feedback: "Focused round-limit recheck approved.",
                    findings: [{ id: "R1-1", status: "fix_confirmed", title: "Round-limit issue" }],
                },
            }],
        },
    ],
    actions: [
        ...validationTreeSemanticRoundLimitContinueScenario.actions,
        { type: "capturePublicationState", planName: "semantic-round-limit-stop", deliveredPath: "followup-ci.txt" },
    ],
    validationBranches: [],
    assertions: [(result: FollowUpPublicationResult) => {
        assertEquals(result.actor.consumed.includes("engineer-completes-round-limit-follow-up"), true);
        assertEquals(result.actor.consumed.includes("reviewer-approves-semantic-round-limit-continue"), true);
        // Only the real CI subprocess can create this file, and only after
        // the follow-up Engineer changed the implementation.
        assertEquals(result.state.publication?.deliveredText, "checked followup");
        assertEquals(result.state.publication?.remotePlanStatus, "verified");
    }],
};

// A loaded QUICK_FIX can resume a durable semantic phase without requiring an
// implementation diff. OPERATION is deliberately not a Plan classification.
export const validationTreeEmptyDiffSkipScenario = withValidationBranches(
    {
        name: "validation-tree-empty-diff-skip-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/empty-diff-skip.md",
            text:
                "---\nclassification: QUICK_FIX\ncomplexity: LOW\nsummary: Empty diff skip\naffectedPaths: []\nstatus: ready_for_work\nplanId: empty-diff-skip-plan\n---\n# Empty diff skip\n\nAlready complete content.\n",
        }],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "empty-diff-skip",
                status: "validated_ci",
                attrs: {
                    classification: "QUICK_FIX",
                },
            },
            { type: "type", text: "/load-plan empty-diff-skip" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForIdle", timeoutMs: 180000 },
            { type: "waitForPlanStatus", planName: "empty-diff-skip", statuses: ["verified"], timeoutMs: 90000 },
        ],
        assertions: [],
    },
    "validation-tree-empty-diff-skip",
    ["empty-diff-skip"],
    ["semantic:entry:empty-diff-skip"],
);

export const validationTreeSemanticRoundModeDiscoveryToVerifyScenario = withValidationBranches(
    {
        name: "validation-tree-semantic-round-mode-discovery-to-verify-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/semantic-round-mode-discovery-to-verify.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Semantic round mode discovery to verify\naffectedPaths: []\nstatus: ready_for_work\nplanId: semantic-round-mode-discovery-to-verify-plan\n---\n# Semantic round mode discovery to verify\n\nDraft content.\n",
        }],
        script: [
            {
                id: "reviewer-approves-verify-mode-round-inspects-diff",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-mode-discovery-to-verify",
                ordinal: 1,
                requiredTools: ["review_diff"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list", scope: "full" } },
                    { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "semantic-round-mode-discovery-to-verify.txt",
                        },
                    },
                    {
                        name: "review_diff",
                        arguments: {
                            command: "show",
                            scope: "full",
                            path: "docs/plans/semantic-round-mode-discovery-to-verify.md",
                        },
                    },
                ],
            },
            {
                id: "reviewer-approves-verify-mode-round",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "semantic-round-mode-discovery-to-verify",
                ordinal: 2,
                requiredTools: ["review_complete"],
                toolCalls: [
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Focused verification approved." },
                    },
                ],
            },
        ],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "semantic-round-mode-discovery-to-verify",
                status: "validated_ci",
                attrs: { validationSemanticRounds: 2 },
                files: [{ path: "semantic-round-mode-discovery-to-verify.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan semantic-round-mode-discovery-to-verify" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForEvent", event: "runtime:tool:start:review_diff", timeoutMs: 90000 },
            {
                type: "waitForPlanStatus",
                planName: "semantic-round-mode-discovery-to-verify",
                statuses: ["verified"],
                timeoutMs: 120000,
            },
        ],
        assertions: [],
    },
    "validation-tree-semantic-round-mode-discovery-to-verify",
    ["semantic-round-mode-discovery-to-verify"],
    ["semantic:round-mode:discovery-to-verify"],
);

export const validationTreePlanOnlyDiffFailsScenario = withValidationBranches(
    {
        name: "validation-tree-plan-only-diff-fails-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/plan-only-diff.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Plan only diff\naffectedPaths: []\nstatus: ready_for_work\nplanId: plan-only-diff-plan\n---\n# Plan only diff\n\nDraft content.\n",
        }],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            { type: "seedActiveWorktree", planName: "plan-only-diff", status: "validated_ci" },
            { type: "type", text: "/load-plan plan-only-diff" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForIdle", timeoutMs: 180000 },
            { type: "waitForPlanStatus", planName: "plan-only-diff", statuses: ["implemented"], timeoutMs: 90000 },
        ],
        assertions: [],
    },
    "validation-tree-plan-only-diff-fails",
    ["plan-only-diff"],
    ["semantic:entry:plan-only-diff-fails"],
);

export const validationWorkflowSemanticScenarios = [
    validationTreeSemanticRoundLimitFollowUpScenario,
    validationTreeSemanticReviewLoopScenario,
    validationTreeSemanticRepairIncompleteScenario,
    validationTreeSemanticReviewerIncompletePauseScenario,
    validationTreeSemanticProviderErrorRetryScenario,
    validationTreeSemanticNudgeOmittedPriorFindingScenario,
    validationTreeSemanticRoundModeDiscoveryToVerifyScenario,
    validationTreeSemanticNudgeMissingReviewCompleteScenario,
    validationTreeSemanticNudgeMissingDiffInspectionScenario,
    validationTreeSemanticRoundLimitContinueScenario,
    validationTreeSemanticRoundLimitHumanReviewScenario,
    validationTreeSemanticRoundLimitStopDirectScenario,
    validationTreeSemanticRoundLimitStopScenario,
    validationTreeEmptyDiffSkipScenario,
    validationTreeNonGitDeliveryScenario,
    validationTreePlanOnlyDiffFailsScenario,
];
