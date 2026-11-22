import { Type } from "typebox";
import { WORK_KINDS } from "../routing.ts";
import { stringLiteralUnion } from "./literal-union.ts";
import { PLAN_COLLABORATION_MODES, PLAN_EXECUTION_AGENTS } from "./plan-written.ts";

const [autonomous, pair] = PLAN_COLLABORATION_MODES;

const TICKET_REFERENCE_SCHEMA = Type.Object({
    url: Type.String({ description: "User-identified external Ticket URL." }),
});

const CHILD_DESCRIPTOR_SCHEMA = Type.Object({
    title: Type.String({ description: "Child planned change title." }),
    order: Type.Number({ description: "1-based integer execution order from the agreed slice sequence." }),
    summary: Type.String({ description: "Brief child planned change summary." }),
    dependencies: Type.Array(Type.String(), { description: "Child plan dependencies, if any." }),
    affectedPaths: Type.Array(Type.String(), { description: "Expected affected paths." }),
    tickets: Type.Optional(
        Type.Array(TICKET_REFERENCE_SCHEMA, {
            description:
                "Direct child Ticket References only when the user identified those URLs as Tickets. Omit to preserve existing child references; [] clears direct child references.",
        }),
    ),
    executionAgent: stringLiteralUnion(PLAN_EXECUTION_AGENTS, {
        description: "Canonical owner; Frontend Engineer is browser-rendered UI only.",
    }),
    collaborationRecommendation: stringLiteralUnion([pair, autonomous], {
        description:
            "Suggested execution style. Use pair when live user judgment between increments is worth the interruptions; otherwise autonomous.",
    }),
    devServerCommand: Type.Optional(
        Type.String({
            description: "Dev or preview command to run for browser verification, if known.",
        }),
    ),
    devServerUrl: Type.Optional(
        Type.String({
            description: "Local URL to open for browser verification, if known.",
        }),
    ),
    devServerHmr: Type.Optional(
        Type.Boolean({
            description: "Whether the dev server is expected to support hot module reload.",
        }),
    ),
    targetBranch: Type.Optional(
        Type.Union([
            Type.String({
                description: "Target branch this child planned change should execute from and merge back into.",
            }),
            Type.Null({ description: "Do not inherit the parent Epic target branch for this child planned change." }),
        ]),
    ),
    workKind: Type.Optional(
        stringLiteralUnion(WORK_KINDS, {
            description:
                "Child Work Kind. Set for new child planned changes based on the work's nature, including DOCUMENTATION for documentation creation or substantial documentation updates; omit only to preserve an existing child draft's Work Kind.",
        }),
    ),
    content: Type.String({
        description:
            "Child planned change plan markdown body without YAML front matter. A seed shaped like a Plan: the whole body in canonical planner sections, carrying the boundary and its intent. Planner elaborates executable detail before execution, so do not invent implementation steps or verification you would be guessing at.",
    }),
});

export const slicerFinalizeDecompositionDefinition = {
    name: "slicer_finalize_decomposition",
    exposure: "model-only",
    label: "Finalize Epic Decomposition",
    description:
        "Materialize child planned change draft plans and finalize the current Epic decomposition after explicit user confirmation.",
    parameters: Type.Object({
        children: Type.Optional(
            Type.Array(CHILD_DESCRIPTOR_SCHEMA, {
                description: "Child planned change plan descriptors to create or update before finalizing.",
            }),
        ),
        confirmation: Type.String({
            description: "A short statement that the user explicitly confirmed finalizing decomposition.",
        }),
    }),
} as const;
