import { Type } from "typebox";
import { WORK_KINDS } from "../routing.ts";
import { TRIAGE_COMPLEXITIES } from "../triage-report.ts";
import { stringLiteralUnion } from "./literal-union.ts";

export const PLAN_EXECUTION_AGENTS = ["engineer", "frontend-engineer"] as const;
export const PLAN_COLLABORATION_MODES = ["autonomous", "pair"] as const;

const TOOL_PARAMS = Type.Object({
    definition: Type.Optional(
        Type.Object({
            summary: Type.Optional(Type.String()),
            affectedPaths: Type.Optional(Type.Array(Type.String())),
            workKind: Type.Optional(Type.Enum([...WORK_KINDS])),
            complexity: Type.Optional(stringLiteralUnion(TRIAGE_COMPLEXITIES)),
            tickets: Type.Optional(Type.Array(Type.Object({ url: Type.String() }))),
            supersedes: Type.Optional(Type.Array(Type.String())),
            frontend: Type.Optional(Type.Boolean()),
            devServerCommand: Type.Optional(Type.String()),
            devServerUrl: Type.Optional(Type.String()),
            devServerHmr: Type.Optional(Type.Boolean()),
        }),
    ),
    planType: Type.Optional(Type.Union([Type.Literal("epic"), Type.Literal("sequence")])),
    targetBranch: Type.Optional(Type.String()),
    order: Type.Optional(Type.Number({ minimum: 0 })),
    contextMarkdown: Type.Optional(
        Type.String({ description: "Create or revise canonical Plan prose without YAML front matter." }),
    ),
    validationMarkdown: Type.Optional(
        Type.String({ description: "Verification instructions as Markdown without front matter." }),
    ),
    expectedRevision: Type.Optional(
        Type.String({ description: "Current Plan revision, required when replacing existing prose." }),
    ),
    parentPlan: Type.Optional(Type.String()),
    dependencies: Type.Optional(Type.Array(Type.String())),

    verificationCommand: Type.Optional(
        Type.Object({
            command: Type.String({
                description: "Exact full-project verification command, not a focused diagnostic or quoted example.",
            }),
            intent: Type.Union([Type.Literal("discovered"), Type.Literal("user_selected")], {
                description:
                    "discovered fills missing configuration only. user_selected is for the user's explicit full-project command, including deliberate replacement of a saved command.",
            }),
        }),
    ),
    planName: Type.String({
        description: "Plan filename without extension (kebab-case preferred), e.g. implement-memory-system",
    }),
    plans: Type.Optional(
        Type.Array(
            Type.Object({
                planName: Type.String({
                    description: "Child Plan name or ID, in declared execution order. Write every child first.",
                }),
                executionAgent: Type.Optional(stringLiteralUnion(PLAN_EXECUTION_AGENTS)),
                collaborationRecommendation: Type.Optional(stringLiteralUnion(PLAN_COLLABORATION_MODES)),
            }),
            {
                minItems: 1,
                description:
                    "Complete child set for a PROJECT type: sequence. Omit when resuming to load its saved children.",
            },
        ),
    ),
    executionAgent: Type.Optional(
        stringLiteralUnion(PLAN_EXECUTION_AGENTS, {
            description:
                "Canonical execution owner. Use frontend-engineer only when the planned change's primary outcome is materially visual or interactive browser UI; otherwise engineer, including TUI work and incidental frontend-file edits. Omit to default to engineer. PROJECT Epics are non-executable and must omit this.",
        }),
    ),
    collaborationRecommendation: Type.Optional(
        stringLiteralUnion(PLAN_COLLABORATION_MODES, {
            description:
                "Suggested execution style. Use pair when live user judgment between increments is worth the interruptions, otherwise omit or use autonomous. PROJECT Epics are non-executable and must omit this.",
        }),
    ),
});

export const planWrittenDefinition = {
    name: "plan_written",
    exposure: "model-only",
    label: "Plan Written",
    description:
        "Create a canonical Plan with contextMarkdown and validationMarkdown, or submit an existing Plan for user review. " +
        "Triggers review and (on approval) a save-vs-execute/decompose prompt. Execution or Slicer dispatch runs " +
        "after your turn ends — the workflow dispatcher picks it up from this tool's outcome. " +
        "Call this once after writing the plan; the user reviews it in a browser UI. " +
        "If the user submits feedback instead of approving, the tool result contains that feedback so you can " +
        "reply in chat or revise in this same session. Revise and call plan_written when the answer changes scope, behavior, a decision, or verification; when in doubt, revise. RunWield keeps an unchanged Plan review open. For a PROJECT with type: sequence, submit its complete child list in plans; " +
        "all documents open together and approval executes the children in order. A later submission may name only the container.",
    parameters: TOOL_PARAMS,
} as const;
