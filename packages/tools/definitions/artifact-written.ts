import { Type } from "typebox";

const TOOL_PARAMS = Type.Object(
    {
        path: Type.String({
            minLength: 1,
            description: "Project-relative path to the completed Markdown artifact.",
        }),
        kind: Type.Union(
            [
                Type.Literal("plan"),
                Type.Literal("prd"),
                Type.Literal("adr"),
                Type.Literal("work-record"),
                Type.Literal("epic-artifact"),
                Type.Literal("report"),
            ],
            { description: "The artifact's durable role in this Session." },
        ),
        title: Type.Optional(
            Type.String({
                minLength: 1,
                description: "Human-readable title. Omit to use the first Markdown heading or filename.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const artifactWrittenDefinition = {
    name: "artifact_written",
    exposure: "model-only",
    label: "Artifact Written",
    description:
        "Register a completed, meaningful Markdown artifact with the current RunWield Session. " +
        "Use this after writing a PRD, ADR, report, Work Record, or other explicit deliverable; do not register files merely mentioned or edited during implementation.",
    parameters: TOOL_PARAMS,
} as const;
