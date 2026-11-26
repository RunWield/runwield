import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remotePersonalResourcesActive } from "../../shared/remote/personal-resources.ts";
import { requestRemoteMemory } from "../../shared/remote/memory-bridge.ts";
import { resolveMemoryCollection } from "../../shared/memory-collection.ts";
import {
    toolRegistry,
    type DeleteMemoryRequest,
    type MemoryParams,
    type MemoryScopePresence,
    type StoreMemoryRequest,
} from "@runwield/tools";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HelperBinaryExec } from "../helper-binary-exec.ts";

const memory = toolRegistry.get("memory");

export interface MnemotecaToolHost {
    cwd: string;
    boundCollection?: string;
    exec: HelperBinaryExec;
}

interface MemoryExportHeader {
    version: number;
    collection: string;
    doc_count: number;
}
interface MemoryExportDocument {
    original_document_id: number;
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

export const MISSING_BINARY_MSG =
    "Error: mnemoteca binary not found. Rerun the RunWield installer to install required runtime helpers: curl -fsSL https://raw.githubusercontent.com/gandazgul/runwield/main/install.sh | bash";

export function createMnemotecaTools(host: MnemotecaToolHost): ToolDefinition[] {
    const initializations = new Map<string, Promise<void>>();

    async function mnemoteca(args: string[], signal?: AbortSignal): Promise<string> {
        try {
            const result = await host.exec("mnemoteca", args, { cwd: host.cwd, signal });
            if (result.code !== 0) {
                const errMsg = result.stderr.trim() || `mnemoteca ${args[0]} failed (exit ${result.code})`;
                if (
                    result.code === 127 ||
                    errMsg.includes("not found") ||
                    errMsg.includes("ENOENT") ||
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
        const name = await resolveMemoryCollection(host);
        let initialized = initializations.get(name);
        if (!initialized) {
            initialized = mnemoteca(["init", "--name", name], signal)
                .then(() => undefined)
                .catch(() => undefined);
            initializations.set(name, initialized);
        }
        await initialized;
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

    async function scopedIdPresence(
        scope: "project" | "global",
        name: string,
        id: number,
        signal?: AbortSignal,
    ): Promise<MemoryScopePresence> {
        const directory = await mkdtemp(join(tmpdir(), "wld-memory-scope-"));
        const output = join(directory, "memories.jsonl");
        const args = scope === "global" ? ["export", "--global"] : ["export", "--name", name];
        try {
            const text = await mnemoteca([...args, "--no-embeddings", "--output", output], signal);
            if (text.trim() === MISSING_BINARY_MSG) return { status: "failure", message: MISSING_BINARY_MSG };
            const [first, ...lines] = (await readFile(output, "utf8")).trimEnd().split("\n");
            const header: MemoryExportHeader = JSON.parse(first);
            const documents: MemoryExportDocument[] = lines.map((line) => JSON.parse(line));
            if (
                header.version !== 1 ||
                header.collection !== (scope === "global" ? "global" : name) ||
                header.doc_count !== documents.length ||
                documents.some((document) => !Number.isSafeInteger(document.original_document_id))
            )
                throw new Error("Invalid scoped Memory export");
            return { status: "success", present: documents.some((document) => document.original_document_id === id) };
        } catch (error) {
            return { status: "failure", message: error instanceof Error ? error.message : String(error) };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    function errorResult(message: string, details: MemoryParams) {
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], details };
    }

    async function recall(query: string, details: MemoryParams, signal?: AbortSignal) {
        const name = await ensureProjectInitialized(signal);
        const safeQuery = `"${query.replaceAll('"', '""')}"`;
        const [project, global] = await Promise.all([
            searchProject(name, safeQuery, signal),
            searchGlobal(safeQuery, signal),
        ]);
        return {
            content: [{ type: "text" as const, text: formatMergedRecall(name, project, global) }],
            details,
        };
    }

    async function store(request: StoreMemoryRequest, details: MemoryParams, signal?: AbortSignal) {
        let args: string[];
        if (request.scope === "global") {
            await mnemoteca(["init", "--global"], signal).catch(() => "");
            args = ["add", "--global"];
        } else {
            const name = await ensureProjectInitialized(signal);
            args = ["add", "--name", name];
        }
        if (request.core) args.push("--tag", "core");
        args.push(request.content);
        const result = await mnemoteca(args, signal);
        return {
            content: [{ type: "text" as const, text: result.trim() }],
            details,
            callMessage: `Storing ${request.scope} memory:\n\n${request.content}`,
        };
    }

    async function deleteMemory(request: DeleteMemoryRequest, details: MemoryParams, signal?: AbortSignal) {
        const name = await ensureProjectInitialized(signal);
        const [project, global] = await Promise.all([
            scopedIdPresence("project", name, request.id, signal),
            scopedIdPresence("global", name, request.id, signal),
        ]);
        const error = memory.checkDeleteScope(request, project, global);
        if (error) return errorResult(error, details);

        const result = await mnemoteca(["delete", String(request.id)], signal);
        return {
            content: [{ type: "text" as const, text: result.trim() || "Memory deleted." }],
            details,
        };
    }

    return [
        defineTool({
            ...memory.definition,
            promptGuidelines: [...memory.definition.promptGuidelines],
            async execute(_id, params, signal) {
                if (remotePersonalResourcesActive()) return await requestRemoteMemory(params, signal);
                const prepared = memory.prepare(params);
                if (!prepared.ok) return errorResult(prepared.error, params);
                const { request } = prepared;
                if (request.action === "recall") return await recall(request.query, params, signal);
                if (request.action === "store") return await store(request, params, signal);
                return await deleteMemory(request, params, signal);
            },
        }),
    ];
}
