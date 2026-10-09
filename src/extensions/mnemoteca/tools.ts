import { basename, dirname, isAbsolute, join, normalize } from "@std/path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HelperBinaryExec } from "../helper-binary-exec.ts";

export interface MnemotecaToolHost {
    cwd: string;
    exec: HelperBinaryExec;
}

interface MemoryParams {
    action: "recall" | "store" | "delete";
    query?: string;
    content?: string;
    scope?: "project" | "global";
    core?: boolean;
    id?: number;
}

interface SearchSuccess {
    status: "success";
    text: string;
}

interface SearchFailure {
    status: "failure";
    message: string;
}

type SearchResult = SearchSuccess | SearchFailure;

interface ScopePresenceSuccess {
    status: "success";
    present: boolean;
}

interface ScopePresenceFailure {
    status: "failure";
    message: string;
}

type ScopePresenceResult = ScopePresenceSuccess | ScopePresenceFailure;

export const MISSING_BINARY_MSG =
    "Error: mnemoteca binary not found. Rerun the RunWield installer to install required runtime helpers: curl -fsSL https://raw.githubusercontent.com/gandazgul/runwield/main/install.sh | bash";

export const memoryToolDef = defineTool({
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
        action: Type.Union([
            Type.Literal("recall"),
            Type.Literal("store"),
            Type.Literal("delete"),
        ], { description: "Memory action" }),
        query: Type.Optional(Type.String({ description: "Semantic search query; required for action=recall" })),
        content: Type.Optional(Type.String({ description: "Concise memory to store; required for action=store" })),
        scope: Type.Optional(Type.Union([
            Type.Literal("project"),
            Type.Literal("global"),
        ], { description: "Memory scope. Defaults to project for store. Required for delete." })),
        core: Type.Optional(
            Type.Boolean({ description: "If true, this memory is always injected into context. Use sparingly." }),
        ),
        id: Type.Optional(Type.Number({ description: "Document ID to delete; required for action=delete" })),
    }),
    execute() {
        throw new Error("Not implemented");
    },
});

export function normalizedProjectCollectionName(rawName: string): string {
    return rawName === "global" ? "default" : (rawName || "default");
}

export async function resolveProjectCollectionName(host: MnemotecaToolHost): Promise<string> {
    const cwd = host.cwd;
    const fallback = normalizedProjectCollectionName(basename(cwd));
    try {
        const result = await host.exec("git", ["rev-parse", "--git-common-dir"], { cwd });
        if (result.code !== 0) return fallback;
        const commonDir = result.stdout.trim().split(/\r?\n/).at(-1) || "";
        if (!commonDir) return fallback;
        const absoluteCommonDir = normalize(isAbsolute(commonDir) ? commonDir : join(cwd, commonDir));
        if (basename(absoluteCommonDir) !== ".git") return fallback;
        return normalizedProjectCollectionName(basename(dirname(absoluteCommonDir)));
    } catch {
        return fallback;
    }
}

export function createMnemotecaTools(host: MnemotecaToolHost): ToolDefinition[] {
    let collectionName: string | null = null;
    let initPromise: Promise<void> | null = null;

    async function projectName(): Promise<string> {
        if (collectionName) return collectionName;
        collectionName = await resolveProjectCollectionName(host);
        return collectionName;
    }

    async function mnemoteca(args: string[], signal?: AbortSignal): Promise<string> {
        try {
            const result = await host.exec("mnemoteca", args, { cwd: host.cwd, signal });
            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `mnemoteca ${args[0]} failed (exit ${result.code})`;
                if (
                    result.code === 127 || errMsg.includes("not found") || errMsg.includes("ENOENT") ||
                    errMsg.includes("No such file")
                ) {
                    return MISSING_BINARY_MSG;
                }
                throw new Error(errMsg);
            }
            return result.stdout || result.stderr || "";
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("not found") || msg.includes("ENOENT") || msg.includes("No such file")) {
                return MISSING_BINARY_MSG;
            }
            throw error;
        }
    }

    async function ensureProjectInitialized(signal?: AbortSignal): Promise<string> {
        const name = await projectName();
        initPromise ??= mnemoteca(["init", "--name", name], signal).then(() => undefined).catch(() => undefined);
        await initPromise;
        return name;
    }

    async function searchProject(name: string, safeQuery: string, signal?: AbortSignal): Promise<SearchResult> {
        try {
            const text = await mnemoteca(["search", "--name", name, "--format", "plain", safeQuery], signal);
            return { status: "success", text: text.trim() };
        } catch (error) {
            return { status: "failure", message: error instanceof Error ? error.message : String(error) };
        }
    }

    async function searchGlobal(safeQuery: string, signal?: AbortSignal): Promise<SearchResult> {
        try {
            const text = await mnemoteca(["search", "--global", "--format", "plain", safeQuery], signal);
            return { status: "success", text: text.trim() };
        } catch (error) {
            return { status: "failure", message: error instanceof Error ? error.message : String(error) };
        }
    }

    function formatMergedRecall(name: string, project: SearchResult, global: SearchResult): string {
        if (
            (project.status === "success" && project.text === MISSING_BINARY_MSG) ||
            (global.status === "success" && global.text === MISSING_BINARY_MSG)
        ) {
            return MISSING_BINARY_MSG;
        }

        const projectText = project.status === "success" ? project.text : "";
        const globalText = global.status === "success" ? global.text : "";
        if (project.status === "success" && global.status === "success" && !projectText && !globalText) {
            return "No memories found.";
        }

        const sections: string[] = [];
        if (project.status === "success") {
            sections.push(
                `Project memories (${name}) — these take precedence over global memories:\n${projectText || "None."}`,
            );
        } else {
            sections.push(`Project memory search failed: ${project.message}`);
        }
        if (global.status === "success") {
            sections.push(`Global memories (cross-project defaults):\n${globalText || "None."}`);
        } else {
            sections.push(`Global memory search failed: ${global.message}`);
        }
        return sections.join("\n\n");
    }

    function memoryIdPattern(id: number): RegExp {
        return new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    }

    async function scopedIdPresence(
        scope: "project" | "global",
        name: string,
        id: number,
        signal?: AbortSignal,
    ): Promise<ScopePresenceResult> {
        const args = scope === "global"
            ? ["list", "--global", "--format", "plain", "--limit", "100000"]
            : ["list", "--name", name, "--format", "plain", "--limit", "100000"];
        try {
            const text = await mnemoteca(args, signal);
            if (text.trim() === MISSING_BINARY_MSG) return { status: "failure", message: MISSING_BINARY_MSG };
            return { status: "success", present: memoryIdPattern(id).test(text) };
        } catch (error) {
            return { status: "failure", message: error instanceof Error ? error.message : String(error) };
        }
    }

    function errorResult(message: string, details: MemoryParams) {
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], details };
    }

    async function recall(typed: MemoryParams, signal?: AbortSignal) {
        if (!typed.query) return errorResult("query is required for recall.", typed);
        const name = await ensureProjectInitialized(signal);
        const safeQuery = `"${typed.query.replaceAll('"', '""')}"`;
        const [project, global] = await Promise.all([
            searchProject(name, safeQuery, signal),
            searchGlobal(safeQuery, signal),
        ]);
        return {
            content: [{ type: "text" as const, text: formatMergedRecall(name, project, global) }],
            details: typed,
        };
    }

    async function store(typed: MemoryParams, signal?: AbortSignal) {
        if (!typed.content) return errorResult("content is required for store.", typed);

        if (typed.scope === "global") {
            await mnemoteca(["init", "--global"], signal).catch(() => "");
            const args = ["add", "--global"];
            if (typed.core) args.push("--tag", "core");
            args.push(typed.content);
            const result = await mnemoteca(args, signal);
            return {
                content: [{ type: "text" as const, text: result.trim() }],
                details: typed,
                callMessage: `Storing global memory:\n\n${typed.content}`,
            };
        }

        const name = await ensureProjectInitialized(signal);
        const args = ["add", "--name", name];
        if (typed.core) args.push("--tag", "core");
        args.push(typed.content);
        const result = await mnemoteca(args, signal);
        return {
            content: [{ type: "text" as const, text: result.trim() }],
            details: typed,
            callMessage: `Storing project memory:\n\n${typed.content}`,
        };
    }

    async function deleteMemory(typed: MemoryParams, signal?: AbortSignal) {
        if (typeof typed.id !== "number") return errorResult("id is required for delete.", typed);
        if (typed.scope !== "project" && typed.scope !== "global") {
            return errorResult("scope is required for delete.", typed);
        }

        const name = await ensureProjectInitialized(signal);
        const [project, global] = await Promise.all([
            scopedIdPresence("project", name, typed.id, signal),
            scopedIdPresence("global", name, typed.id, signal),
        ]);
        if (project.status === "failure") return errorResult(`project scope check failed: ${project.message}`, typed);
        if (global.status === "failure") return errorResult(`global scope check failed: ${global.message}`, typed);
        if (project.present && global.present) {
            return errorResult(`id ${typed.id} is ambiguous across project and global memory. Refusing delete.`, typed);
        }
        const targetPresent = typed.scope === "project" ? project.present : global.present;
        if (!targetPresent) return errorResult(`id ${typed.id} was not found in ${typed.scope} memory.`, typed);

        const result = await mnemoteca(["delete", String(typed.id)], signal);
        return {
            content: [{ type: "text" as const, text: result.trim() || "Memory deleted." }],
            details: typed,
        };
    }

    return [
        {
            ...memoryToolDef,
            async execute(_id, params, signal) {
                const typed = params as MemoryParams;
                if (typed.action === "recall") return await recall(typed, signal);
                if (typed.action === "store") return await store(typed, signal);
                if (typed.action === "delete") return await deleteMemory(typed, signal);
                return errorResult("action must be recall, store, or delete.", typed);
            },
        },
    ];
}
