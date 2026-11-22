import { Type, type Static } from "typebox";

export const MAX_CODE_BATCH_OPERATIONS = 5;

const codeBatchShowOperationSchema = Type.Object(
    {
        op: Type.Literal("show"),
        target: Type.String({ description: "Symbol name or file path (e.g. file.js:10-20) to show." }),
    },
    { additionalProperties: false },
);
const codeBatchOutlineOperationSchema = Type.Object(
    {
        op: Type.Literal("outline"),
        file: Type.String({ description: "File path to outline." }),
    },
    { additionalProperties: false },
);
const codeBatchOperationSchema = Type.Union([codeBatchShowOperationSchema, codeBatchOutlineOperationSchema]);
const codeBatchParametersSchema = Type.Object(
    {
        operations: Type.Array(codeBatchOperationSchema, {
            minItems: 1,
            maxItems: MAX_CODE_BATCH_OPERATIONS,
            description:
                "One to five known code show/outline reads. Results follow request order. Search is not supported.",
        }),
    },
    { additionalProperties: false },
);

export const codeSearchDefinition = {
    name: "code_search",
    label: "Code Search",
    description: "Search for symbols or full text using cymbal.",
    promptSnippet: "Search project code and symbols efficiently",
    parameters: Type.Object({
        query: Type.String({
            description: "Symbol name or search query. DO NOT use spaces unless you want an exact phrase match.",
        }),
        textSearch: Type.Optional(
            Type.Boolean({ description: "Set to true to perform a full-text regex grep instead of symbol search." }),
        ),
    }),
} as const;
export const codeStructureDefinition = {
    name: "code_structure",
    label: "Code Structure",
    description:
        "Show the structural shape of the indexed codebase (entry points, most referenced symbols, largest packages).",
    promptSnippet: "Show the structural shape of the codebase",
    parameters: Type.Object({}),
} as const;
export const codeImplsDefinition = {
    name: "code_impls",
    label: "Code Impls",
    description:
        "Find local types that declare themselves as implementing, conforming to, or extending the given symbol name.",
    promptSnippet: "Find implementations or subclasses of a type",
    parameters: Type.Object({ symbol: Type.String({ description: "Symbol name" }) }),
} as const;
export const codeImportersDefinition = {
    name: "code_importers",
    label: "Code Importers",
    description: "Find files that import a given file or package.",
    promptSnippet: "Find files that import a file or package",
    parameters: Type.Object({ target: Type.String({ description: "File path or package name" }) }),
} as const;
export const codeShowDefinition = {
    name: "code_show",
    label: "Code Show",
    description: "Read source code of a specific symbol or file.",
    promptSnippet: "Read source code of a specific symbol or file",
    parameters: Type.Object({ target: Type.String({ description: "Symbol name or file path (e.g. file.js:10-20)" }) }),
} as const;
export const codeOutlineDefinition = {
    name: "code_outline",
    label: "Code Outline",
    description: "Show symbols defined in a file.",
    promptSnippet: "Show symbols defined in a file",
    parameters: Type.Object({ file: Type.String({ description: "File path" }) }),
} as const;
export const codeBatchDefinition = {
    name: "code_batch",
    label: "Code Batch",
    description:
        "Batch multiple known Cymbal show and outline reads in one call. Supports only show and outline; use code_search separately for discovery.",
    promptSnippet: "Batch multiple known code_show/code_outline reads; search is not supported",
    parameters: codeBatchParametersSchema,
} as const;
export const codeRefsDefinition = {
    name: "code_refs",
    label: "Code Refs",
    description: "Find references to a symbol.",
    promptSnippet: "Find references to a symbol across indexed files",
    parameters: Type.Object({ symbol: Type.String({ description: "Symbol name" }) }),
} as const;
export const codeImpactDefinition = {
    name: "code_impact",
    label: "Code Impact",
    description: "Find the impact of changing a symbol.",
    promptSnippet: "Transitive impact analysis of a symbol",
    parameters: Type.Object({ symbol: Type.String({ description: "Symbol name" }) }),
} as const;
export const codeTraceDefinition = {
    name: "code_trace",
    label: "Code Trace",
    description: "Trace relationships for a symbol.",
    promptSnippet: "Trace symbol relationships as a graph",
    parameters: Type.Object({ symbol: Type.String({ description: "Symbol name" }) }),
} as const;
export const codeInvestigateDefinition = {
    name: "code_investigate",
    label: "Code Investigate",
    description: "Investigate a symbol in depth.",
    promptSnippet: "Investigate a symbol in depth",
    parameters: Type.Object({ symbol: Type.String({ description: "Symbol name" }) }),
} as const;

export type CodeBatchOperation = Static<typeof codeBatchOperationSchema>;
export type CodeBatchParams = Static<typeof codeBatchParametersSchema>;
