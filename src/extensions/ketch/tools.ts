import { toolRegistry } from "@runwield/tools";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HelperBinaryExec } from "../helper-binary-exec.ts";

export interface KetchToolHost {
    cwd: string;
    exec: HelperBinaryExec;
}

export const MAX_WEB_FETCH_CHARS = 50_000;

const DEFAULT_WEB_SEARCH_BACKEND = "keenable";
const DEFAULT_WEB_CODE_SEARCH_BACKEND = "grepapp";
const DEFAULT_WEB_DOCS_SEARCH_BACKEND = "context7";
const WEB_SEARCH_ALTERNATES = ["ddg", "brave", "exa", "searxng"];
const WEB_CODE_SEARCH_ALTERNATES = ["sourcegraph", "github"];
const WEB_DOCS_SEARCH_ALTERNATES: string[] = [];

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

function text(value: string): string {
    return value.trim() || "No results found.";
}

function cleanKetchMessage(result: { stdout: string; stderr: string }): string {
    return (result.stderr.trim() || result.stdout.trim()).split("\nUsage:")[0].trim();
}

function numberArg(value: number | undefined): string | null {
    if (!Number.isFinite(value) || value === undefined) return null;
    return String(Math.trunc(value));
}

function readRecord(value: JsonValue): JsonRecord | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readString(record: JsonRecord, key: string): string {
    const value = record[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
}

function parseJson(textToParse: string): JsonValue | null {
    try {
        return JSON.parse(textToParse) as JsonValue;
    } catch {
        return null;
    }
}

function asArrayJson(value: JsonValue | null): JsonValue[] | null {
    if (Array.isArray(value)) return value;
    const record = value ? readRecord(value) : null;
    const results = record?.results;
    return Array.isArray(results) ? results : null;
}

function truncateText(value: string, maxChars: number, toolName: string): { text: string; truncated: boolean } {
    if (value.length <= maxChars) return { text: value, truncated: false };
    const marker = `\n\n[${toolName} output truncated at ${maxChars} characters. Use maxChars or a narrower request for remaining content.]`;
    return { text: value.slice(0, maxChars) + marker, truncated: true };
}

function formatFailure(exitCode: number, message: string, alternates: string[]): string {
    const alternatesText =
        alternates.length > 0 ? ` Alternate backends accepted by backend: ${alternates.join(", ")}.` : "";
    return `Error (exit ${exitCode}): ${message || "ketch returned no error text."}${alternatesText}`;
}

function formatWebSearch(
    raw: string,
    scrape: boolean,
    maxChars: number | undefined,
): { text: string; truncated: boolean } {
    const parsed = asArrayJson(parseJson(raw));
    if (!parsed) return { text: text(raw), truncated: false };
    const lines = parsed
        .map((item) => {
            const record = readRecord(item);
            if (!record) return "";
            if (scrape) {
                const title = readString(record, "title");
                const url = readString(record, "url");
                const content = readString(record, "content") || readString(record, "markdown");
                return [`## ${title || url || "Result"}`, url, "", content].filter((line) => line !== "").join("\n");
            }
            const title = readString(record, "title");
            const url = readString(record, "url");
            return [title, url].filter((part) => part !== "").join(" - ");
        })
        .filter((line) => line.trim().length > 0);
    const formatted = text(lines.join("\n"));
    if (!scrape) return { text: formatted, truncated: false };
    return truncateText(formatted, maxChars ?? MAX_WEB_FETCH_CHARS, "web_search");
}

function formatWebFetch(raw: string, maxChars: number | undefined): { text: string; truncated: boolean } {
    const parsed = parseJson(raw);
    const record = parsed ? readRecord(parsed) : null;
    const markdown = record ? readString(record, "markdown") : "";
    return truncateText(text(markdown || raw), maxChars ?? MAX_WEB_FETCH_CHARS, "web_fetch");
}

function formatWebCodeSearch(raw: string): string {
    const parsed = asArrayJson(parseJson(raw));
    if (!parsed) return text(raw);
    const lines = parsed
        .map((item) => {
            const record = readRecord(item);
            if (!record) return "";
            const repo = readString(record, "repo");
            const path = readString(record, "path");
            const line = readString(record, "line");
            const snippet = readString(record, "snippet");
            const url = readString(record, "url");
            const location = [repo, path, line ? `line ${line}` : ""].filter((part) => part !== "").join(" ");
            return [location, snippet, url].filter((part) => part !== "").join("\n");
        })
        .filter((line) => line.trim().length > 0);
    return text(lines.join("\n\n"));
}

function formatWebDocsSearch(raw: string): string {
    const parsed = asArrayJson(parseJson(raw));
    if (!parsed) return text(raw);
    const lines = parsed
        .map((item) => {
            const record = readRecord(item);
            if (!record) return "";
            const library = readString(record, "library");
            const title = readString(record, "title");
            const snippet = readString(record, "snippet");
            return [library, title, snippet].filter((part) => part !== "").join("\n");
        })
        .filter((line) => line.trim().length > 0);
    return text(lines.join("\n\n"));
}

export function createKetchTools(host: KetchToolHost): ToolDefinition[] {
    async function runKetch(args: string[], signal?: AbortSignal) {
        try {
            return await host.exec("ketch", args, { cwd: host.cwd, signal });
        } catch (error) {
            return {
                code: 1,
                stdout: "",
                stderr: `Error running ketch: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    return [
        defineTool({
            ...toolRegistry.get("web_search").definition,
            async execute(_id, params, signal) {
                const args = ["search", "-b", params.backend || DEFAULT_WEB_SEARCH_BACKEND, "--json"];
                const limit = numberArg(params.limit);
                if (limit) args.push("--limit", limit);
                if (params.scrape) {
                    args.push("--scrape");
                    const maxChars = numberArg(params.maxChars);
                    if (maxChars) args.push("--max-chars", maxChars);
                }
                args.push(params.query);
                const result = await runKetch(args, signal);
                if (result.code !== 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: formatFailure(result.code, cleanKetchMessage(result), WEB_SEARCH_ALTERNATES),
                            },
                        ],
                        details: params,
                    };
                }
                const formatted = formatWebSearch(
                    result.stdout || result.stderr || "",
                    Boolean(params.scrape),
                    params.maxChars,
                );
                return {
                    content: [{ type: "text" as const, text: formatted.text }],
                    details: { ...params, truncated: formatted.truncated },
                };
            },
        }),
        defineTool({
            ...toolRegistry.get("web_fetch").definition,
            async execute(_id, params, signal) {
                const result = await runKetch(["scrape", params.url, "--json"], signal);
                if (result.code !== 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: formatFailure(result.code, cleanKetchMessage(result), []),
                            },
                        ],
                        details: params,
                    };
                }
                const formatted = formatWebFetch(result.stdout || result.stderr || "", params.maxChars);
                return {
                    content: [{ type: "text" as const, text: formatted.text }],
                    details: { ...params, truncated: formatted.truncated },
                };
            },
        }),
        defineTool({
            ...toolRegistry.get("web_code_search").definition,
            async execute(_id, params, signal) {
                const args = ["code", "-b", params.backend || DEFAULT_WEB_CODE_SEARCH_BACKEND, "--json"];
                const limit = numberArg(params.limit);
                if (limit) args.push("--limit", limit);
                if (params.lang) args.push("--lang", params.lang);
                if (params.regex) args.push("--regex");
                args.push(params.query);
                const result = await runKetch(args, signal);
                if (result.code !== 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: formatFailure(result.code, cleanKetchMessage(result), WEB_CODE_SEARCH_ALTERNATES),
                            },
                        ],
                        details: params,
                    };
                }
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: formatWebCodeSearch(result.stdout || result.stderr || ""),
                        },
                    ],
                    details: params,
                };
            },
        }),
        defineTool({
            ...toolRegistry.get("web_docs_search").definition,
            async execute(_id, params, signal) {
                const args = ["docs", "-b", DEFAULT_WEB_DOCS_SEARCH_BACKEND, "--json"];
                const limit = numberArg(params.limit);
                if (limit) args.push("--limit", limit);
                if (params.library) args.push("--library", params.library);
                const tokens = numberArg(params.tokens);
                if (tokens) args.push("--tokens", tokens);
                args.push(params.query);
                const result = await runKetch(args, signal);
                if (result.code === 5 && cleanKetchMessage(result).includes("ketch config set context7_api_key")) {
                    return { content: [{ type: "text" as const, text: cleanKetchMessage(result) }], details: params };
                }
                if (result.code !== 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: formatFailure(result.code, cleanKetchMessage(result), WEB_DOCS_SEARCH_ALTERNATES),
                            },
                        ],
                        details: params,
                    };
                }
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: formatWebDocsSearch(result.stdout || result.stderr || ""),
                        },
                    ],
                    details: params,
                };
            },
        }),
    ];
}
