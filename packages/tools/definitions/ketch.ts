import { Type } from "typebox";

export const webSearchDefinition = {
    name: "web_search",
    label: "Web Search",
    description: "Search the web through RunWield's pinned ketch search backend.",
    promptSnippet: "Search the public web with titles and URLs, optionally fused with page content.",
    parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return." })),
        scrape: Type.Optional(Type.Boolean({ description: "Set to true to include fetched page content per result." })),
        maxChars: Type.Optional(Type.Number({ description: "Maximum fetched content characters per fused result." })),
        backend: Type.Optional(
            Type.String({
                description: "Optional ketch search backend override, such as ddg, brave, exa, or searxng.",
            }),
        ),
    }),
} as const;

export const webFetchDefinition = {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch one URL as Markdown through ketch scrape.",
    promptSnippet: "Fetch a web page as Markdown by URL.",
    parameters: Type.Object({
        url: Type.String({ description: "URL to fetch." }),
        maxChars: Type.Optional(Type.Number({ description: "Maximum returned Markdown characters." })),
    }),
} as const;

export const webCodeSearchDefinition = {
    name: "web_code_search",
    label: "Web Code Search",
    description: "Search public code repositories through RunWield's pinned ketch code backend.",
    promptSnippet: "Search public repositories on the web; use code_* tools for this checkout.",
    parameters: Type.Object({
        query: Type.String({ description: "Public code search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return." })),
        lang: Type.Optional(Type.String({ description: "Optional language filter." })),
        regex: Type.Optional(
            Type.Boolean({ description: "Set to true for regex search when the backend supports it." }),
        ),
        backend: Type.Optional(
            Type.String({ description: "Optional ketch code backend override, such as sourcegraph or github." }),
        ),
    }),
} as const;

export const webDocsSearchDefinition = {
    name: "web_docs_search",
    label: "Web Docs Search",
    description: "Search current library documentation through RunWield's pinned ketch docs backend.",
    promptSnippet: "Search current library or framework documentation.",
    parameters: Type.Object({
        query: Type.String({ description: "Documentation search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results to return." })),
        library: Type.Optional(Type.String({ description: "Optional library or package name." })),
        tokens: Type.Optional(Type.Number({ description: "Optional token budget for the docs backend." })),
    }),
} as const;
