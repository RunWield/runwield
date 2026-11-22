import { Type, type Static } from "typebox";

const PARAMETERS = Type.Object(
    {
        action: Type.Optional(
            Type.Union([Type.Literal("report"), Type.Literal("resolve")], {
                description: "Report a new checkpoint or resolve the current checkpoint from the user's direction.",
            }),
        ),
        summary: Type.Optional(
            Type.String({
                minLength: 1,
                description:
                    "Concise Markdown description of the observable increment now available for review. Use short paragraphs or bullets; separate changes and verification with bold section titles and blank lines. Put supporting evidence, diagnostics, and next steps in their dedicated fields.",
            }),
        ),
        route: Type.Optional(Type.String({ minLength: 1, description: "Route or URL currently shown." })),
        state: Type.Optional(Type.String({ minLength: 1, description: "Application state or scenario inspected." })),
        viewport: Type.Optional(Type.String({ minLength: 1, description: "Viewport or device inspected." })),
        evidence: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
                description: "Content-safe notes or screenshot paths describing visible evidence.",
            }),
        ),
        diagnostics: Type.Optional(
            Type.String({
                minLength: 1,
                description: "Console, network, accessibility, or runtime health summary.",
            }),
        ),
        nextIncrement: Type.Optional(
            Type.String({ minLength: 1, description: "The next coherent increment proposed." }),
        ),
        final: Type.Optional(
            Type.Boolean({ description: "Whether this is the final checkpoint before task completion." }),
        ),
        checkpointId: Type.Optional(
            Type.String({
                minLength: 1,
                description: "Current checkpoint ID shown in the restored Pair context.",
            }),
        ),
        decision: Type.Optional(
            Type.Union(
                [
                    Type.Literal("continue"),
                    Type.Literal("revise"),
                    Type.Literal("switch_to_autonomous"),
                    Type.Literal("stop"),
                ],
                { description: "Typed interpretation of the user's direction." },
            ),
        ),
        revisionDirection: Type.Optional(
            Type.String({
                minLength: 1,
                description: "The user's full revision direction. Required for revise.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const pairCheckpointDefinition = {
    name: "pair_checkpoint",
    exposure: "model-only",
    label: "Pair Checkpoint",
    description:
        "Report a Pair Execution increment and end the turn for ordinary conversation. On a later real user turn, resolve the current checkpoint from the user's natural-language direction. Questions need no resolution call.",
    parameters: PARAMETERS,
} as const;

export type PairCheckpointParameters = Static<typeof pairCheckpointDefinition.parameters>;
