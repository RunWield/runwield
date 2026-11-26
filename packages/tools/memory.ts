import type { MemoryParams } from "./definitions/mnemoteca.ts";

/** The project collection or the shared global collection. */
export type MemoryScope = NonNullable<MemoryParams["scope"]>;

/** A query to run against both memory scopes. */
export interface RecallMemoryRequest {
    action: "recall";
    query: string;
}

/** Memory content with its resolved storage scope and core status. */
export interface StoreMemoryRequest {
    action: "store";
    content: string;
    scope: MemoryScope;
    core: boolean;
}

/** A document ID and the scope in which the caller requests deletion. */
export interface DeleteMemoryRequest {
    action: "delete";
    id: number;
    scope: MemoryScope;
}

/** A prepared action or the reason its input is invalid. */
export type PreparedMemory =
    | { ok: true; request: RecallMemoryRequest | StoreMemoryRequest | DeleteMemoryRequest }
    | { ok: false; error: string };

/** Whether a scope contains the document, or why the scope check failed. */
export type MemoryScopePresence = { status: "success"; present: boolean } | { status: "failure"; message: string };

export function prepareMemory(params: MemoryParams): PreparedMemory {
    switch (params.action) {
        case "recall":
            if (!params.query) return { ok: false, error: "query is required for recall." };
            return { ok: true, request: { action: "recall", query: params.query } };
        case "store":
            if (!params.content) return { ok: false, error: "content is required for store." };
            return {
                ok: true,
                request: {
                    action: "store",
                    content: params.content,
                    scope: params.scope === "global" ? "global" : "project",
                    core: Boolean(params.core),
                },
            };
        case "delete":
            if (typeof params.id !== "number") return { ok: false, error: "id is required for delete." };
            if (params.scope !== "project" && params.scope !== "global") {
                return { ok: false, error: "scope is required for delete." };
            }
            return { ok: true, request: { action: "delete", id: params.id, scope: params.scope } };
        default:
            return { ok: false, error: "action must be recall, store, or delete." };
    }
}

export function checkMemoryDeleteScope(
    request: DeleteMemoryRequest,
    project: MemoryScopePresence,
    global: MemoryScopePresence,
): string | null {
    if (project.status === "failure") return `project scope check failed: ${project.message}`;
    if (global.status === "failure") return `global scope check failed: ${global.message}`;
    if (project.present && global.present) {
        return `id ${request.id} is ambiguous across project and global memory. Refusing delete.`;
    }
    const targetPresent = request.scope === "project" ? project.present : global.present;
    return targetPresent ? null : `id ${request.id} was not found in ${request.scope} memory.`;
}
