import { loadPlanMalformedFrontMatterScenario } from "./load-plan-workflow.ts";
import { withValidationBranches } from "./validation-workflow-tree-shared.ts";

export const validationTreeMissingPlanScenario = withValidationBranches(
    {
        name: "load-plan-missing-plan-fails-closed",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 30000,
        actions: [
            { type: "type", text: "/load-plan missing-plan" },
            { type: "enter" },
            { type: "enter" },
            { type: "sleep", ms: 1000 },
            { type: "waitForIdle", timeoutMs: 12000 },
        ],
        assertions: [],
    },
    "validation-tree-missing-plan",
    ["missing-plan"],
    ["lifecycle:missing-plan-fails-closed"],
);

export const validationTreeMalformedFrontMatterScenario = withValidationBranches(
    loadPlanMalformedFrontMatterScenario,
    "validation-tree-malformed-front-matter",
    ["broken"],
    ["lifecycle:malformed-front-matter-fails-closed"],
);

export const validationTreeResumeImplementedScenario = withValidationBranches(
    {
        name: "validation-tree-resume-implemented-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/resume-implemented.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Resume implemented\naffectedPaths: []\nstatus: ready_for_work\nplanId: resume-implemented-plan\n---\n# Resume implemented\n\nDraft content.\n",
        }],
        script: [
            {
                id: "reviewer-approves-resume-implemented",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "resume-implemented",
                ordinal: 1,
                requiredTools: ["review_diff", "review_complete"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list" } },
                    { name: "review_diff", arguments: { command: "show", path: "resume-implemented.txt" } },
                    { name: "review_diff", arguments: { command: "show", path: "docs/plans/resume-implemented.md" } },
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Resume from implemented approved." },
                    },
                ],
            },
        ],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "resume-implemented",
                status: "implemented",
                files: [{ path: "resume-implemented.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan resume-implemented" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForEvent", event: "runtime:tool:start:review_diff", timeoutMs: 90000 },
            { type: "waitForPlanStatus", planName: "resume-implemented", statuses: ["verified"], timeoutMs: 120000 },
        ],
        assertions: [],
    },
    "validation-tree-resume-implemented",
    ["resume-implemented"],
    ["lifecycle:resume-implemented"],
);

export const validationTreeResumeValidatedCiScenario = withValidationBranches(
    {
        name: "validation-tree-resume-validated-ci-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/resume-validated-ci.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Resume validated CI\naffectedPaths: []\nstatus: ready_for_work\nplanId: resume-validated-ci-plan\n---\n# Resume validated CI\n\nDraft content.\n",
        }],
        script: [
            {
                id: "reviewer-approves-resume-validated-ci",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "resume-validated-ci",
                ordinal: 1,
                requiredTools: ["review_diff", "review_complete"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list" } },
                    { name: "review_diff", arguments: { command: "show", path: "resume-validated-ci.txt" } },
                    { name: "review_diff", arguments: { command: "show", path: "docs/plans/resume-validated-ci.md" } },
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Resume from validated_ci approved." },
                    },
                ],
            },
        ],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "resume-validated-ci",
                status: "validated_ci",
                files: [{ path: "resume-validated-ci.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan resume-validated-ci" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForEvent", event: "runtime:tool:start:review_diff", timeoutMs: 90000 },
            { type: "waitForPlanStatus", planName: "resume-validated-ci", statuses: ["verified"], timeoutMs: 120000 },
        ],
        assertions: [],
    },
    "validation-tree-resume-validated-ci",
    ["resume-validated-ci"],
    ["lifecycle:resume-validated-ci", "semantic:resume:validated-ci"],
);

export const validationTreeResumeValidatedReviewerScenario = withValidationBranches(
    {
        name: "validation-tree-resume-validated-reviewer-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 180000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/resume-validated-reviewer.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Resume validated reviewer\naffectedPaths: []\nstatus: ready_for_work\nplanId: resume-validated-reviewer-plan\n---\n# Resume validated reviewer\n\nDraft content.\n",
        }],
        scriptedInteractions: [{
            type: "select",
            promptIncludes: "Plan recovery (reviewed)",
            value: "validate",
        }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "resume-validated-reviewer",
                status: "reviewed",
                attrs: { humanReviewMode: "none", humanReviewDecision: "not_required" },
                files: [{ path: "resume-validated-reviewer.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan resume-validated-reviewer" },
            { type: "enter" },
            { type: "enter" },
            {
                type: "waitForPlanStatus",
                planName: "resume-validated-reviewer",
                statuses: ["verified"],
                timeoutMs: 120000,
            },
        ],
        assertions: [],
    },
    "validation-tree-resume-validated-reviewer",
    ["resume-validated-reviewer"],
    ["lifecycle:resume-validated-reviewer"],
);

// An implemented Plan with no recoverable worktree must fail closed after the
// user chooses retry validation from the recovery menu.
export const validationTreeMissingExecutionContextScenario = withValidationBranches(
    {
        name: "validation-tree-missing-execution-context-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 60000,
        initialProjectFiles: [{
            path: "docs/plans/missing-execution-context.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Missing execution context\naffectedPaths: []\nstatus: implemented\nplanId: missing-execution-context-plan\n---\n# Missing execution context\n\nDraft content.\n",
        }],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            { type: "type", text: "/load-plan missing-execution-context" },
            { type: "enter" },
            { type: "sleep", ms: 500 },
            { type: "enter" },
            { type: "sleep", ms: 1000 },
            { type: "waitForIdle", timeoutMs: 12000 },
        ],
        assertions: [],
    },
    "validation-tree-missing-execution-context",
    ["missing-execution-context"],
    ["lifecycle:missing-execution-context-fails-closed"],
);

// A stale mechanical checkpoint must not pull a Plan back. The worktree's Plan
// already records validated_ci, so validation continues from Semantic Review.
export const validationTreeAheadStatusScenario = withValidationBranches(
    {
        name: "validation-tree-ahead-status-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 120000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/ahead-status.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Ahead status\naffectedPaths: []\nstatus: ready_for_work\nplanId: ahead-status-plan\n---\n# Ahead status\n\nDraft content.\n",
        }],
        script: [
            {
                id: "reviewer-approves-ahead-status",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "ahead-status",
                ordinal: 1,
                requiredTools: ["review_diff", "review_complete"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list" } },
                    { name: "review_diff", arguments: { command: "show", path: "ahead-status.txt" } },
                    { name: "review_diff", arguments: { command: "show", path: "docs/plans/ahead-status.md" } },
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Ahead status kept its canonical progress." },
                    },
                ],
            },
        ],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "ahead-status",
                status: "validated_ci",
                rememberedValidationPhase: "mechanical",
                files: [{ path: "ahead-status.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan ahead-status" },
            { type: "enter" },
            { type: "enter" },
            { type: "waitForPlanStatus", planName: "ahead-status", statuses: ["verified"], timeoutMs: 90000 },
        ],
        assertions: [],
    },
    "validation-tree-ahead-status",
    ["ahead-status"],
    ["lifecycle:ahead-status-keeps-canonical-progress"],
);

// Raw corrupt Front Matter must fail closed before its parsed default can route
// the Plan into a normal draft flow.
export const validationTreeUnsupportedStatusScenario = withValidationBranches(
    {
        name: "validation-tree-unsupported-status-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 60000,
        initialProjectFiles: [{
            path: "docs/plans/unsupported-status.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Unsupported status\naffectedPaths: []\nstatus: sideways\nplanId: unsupported-status-plan\n---\n# Unsupported status\n\nDraft content.\n",
        }],
        actions: [
            { type: "type", text: "/load-plan unsupported-status" },
            { type: "enter" },
            { type: "enter" },
            { type: "sleep", ms: 1000 },
            { type: "waitForIdle", timeoutMs: 12000 },
        ],
        assertions: [],
    },
    "validation-tree-unsupported-status",
    ["unsupported-status"],
    ["lifecycle:unsupported-status-fails-closed"],
);

// A stale Plan-local worktree id must not override the registry's live attempt.
// The registry locates the execution Plan; validation then continues normally.
export const validationTreeMismatchedWorktreeIdentityScenario = withValidationBranches(
    {
        name: "validation-tree-mismatched-worktree-identity-base",
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        timeoutMs: 240000,
        committedProjectFiles: [
            { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
        ],
        initialProjectFiles: [{
            path: "docs/plans/mismatched-worktree-identity.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Mismatched worktree identity\naffectedPaths: []\nstatus: ready_for_work\nplanId: mismatched-worktree-identity-plan\n---\n# Mismatched worktree identity\n\nDraft content.\n",
        }],
        script: [
            {
                id: "reviewer-approves-registry-owned-worktree",
                agent: "reviewer",
                phase: "semantic_review",
                planName: "mismatched-worktree-identity",
                ordinal: 1,
                requiredTools: ["review_diff", "review_complete"],
                toolCalls: [
                    { name: "review_diff", arguments: { command: "list" } },
                    { name: "review_diff", arguments: { command: "show", path: "mismatched-worktree-identity.txt" } },
                    {
                        name: "review_diff",
                        arguments: { command: "show", path: "docs/plans/mismatched-worktree-identity.md" },
                    },
                    {
                        name: "review_complete",
                        arguments: { approved: true, feedback: "Registry-owned execution attempt approved." },
                    },
                ],
            },
        ],
        scriptedInteractions: [{ type: "select", promptIncludes: "Plan recovery (implemented)", value: "validate" }],
        actions: [
            {
                type: "seedActiveWorktree",
                planName: "mismatched-worktree-identity",
                status: "implemented",
                attrs: { worktreeId: "wrong-worktree-id" },
                files: [{ path: "mismatched-worktree-identity.txt", text: "done\n" }],
            },
            { type: "type", text: "/load-plan mismatched-worktree-identity" },
            { type: "enter" },
            { type: "enter" },
            {
                type: "waitForPlanStatus",
                planName: "mismatched-worktree-identity",
                statuses: ["verified"],
                timeoutMs: 180000,
            },
            { type: "captureProjectState", planNames: ["mismatched-worktree-identity"] },
        ],
        assertions: [],
    },
    "validation-tree-mismatched-worktree-identity",
    ["mismatched-worktree-identity"],
    ["lifecycle:registry-authority-ignores-stale-worktree-metadata"],
);

export const validationWorkflowLifecycleScenarios = [
    validationTreeMissingPlanScenario,
    validationTreeMalformedFrontMatterScenario,
    validationTreeMissingExecutionContextScenario,
    validationTreeMismatchedWorktreeIdentityScenario,
    validationTreeAheadStatusScenario,
    validationTreeUnsupportedStatusScenario,
    validationTreeResumeImplementedScenario,
    validationTreeResumeValidatedCiScenario,
    validationTreeResumeValidatedReviewerScenario,
];
