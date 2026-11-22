import { Type, type Static } from "typebox";

export const memoryDefinition = {
    name: "memory",
    label: "Memory",
    description:
        "Recall project and global memories, store a project or global memory, or delete a scoped memory by document ID.",
    promptSnippet: "Recall, store, or delete memories with an explicit action",
    promptGuidelines: [
        "Use action=recall to search project and global memory together. Project memories take precedence over conflicting global memories.",
        "Core memories are strong guidance; other memories are useful, non-authoritative context. Neither overrides the user, current project docs, the applicable Plan, or code as evidence of implemented behavior.",
        "Use action=store only for current durable decisions, preferences, constraints, rationale, and reusable lessons. Do not store routine release dates, commit hashes, completed PR inventories, one-off test counts, or task-completion receipts.",
        "Keep history only when it explains a still-relevant decision. State current guidance directly; do not repeat an obsolete claim beside a correction or present proposed work as delivered.",
        "Store defaults to project scope. Set scope=global only for cross-project preferences and patterns.",
        "Correct or remove outdated, incorrect, superseded, duplicate, or routine bookkeeping memories. Add and verify any durable replacement before action=delete. Include scope so the tool can refuse ambiguous IDs.",
        "Set core=true only for critical, always-relevant context. Keep core memories lean.",
    ],
    parameters: Type.Object({
        action: Type.Union([Type.Literal("recall"), Type.Literal("store"), Type.Literal("delete")], {
            description: "Memory action",
        }),
        query: Type.Optional(Type.String({ description: "Semantic search query; required for action=recall" })),
        content: Type.Optional(Type.String({ description: "Concise memory to store; required for action=store" })),
        scope: Type.Optional(
            Type.Union([Type.Literal("project"), Type.Literal("global")], {
                description: "Memory scope. Defaults to project for store. Required for delete.",
            }),
        ),
        core: Type.Optional(
            Type.Boolean({ description: "If true, this memory is always injected into context. Use sparingly." }),
        ),
        id: Type.Optional(Type.Number({ description: "Document ID to delete; required for action=delete" })),
    }),
} as const;

export type MemoryParams = Static<typeof memoryDefinition.parameters>;
