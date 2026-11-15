import type { SessionBinding, SessionQueuedDraft } from "../workspace/client/session-client.ts";
import type {
    WorkspaceProjectContext,
    WorkspaceHistoryRequest,
    WorkspaceSnapshotRequest,
    WorkspaceConfigureRequest,
    WorkspaceSessionListRequest,
    WorkspaceSessionRequest,
    WorkspaceConfigurationSelection,
} from "../../acp/workspace-contract.ts";
import {
    validateSessionInput,
    SESSION_IMAGE_BASE64_LIMIT,
    type SessionImageTransfer,
} from "../../shared/session/session-input-contract.ts";

export const SAVED_CHANNEL = "desktop:saved:";
export const SAVED_OPERATIONS = [
    "readProject",
    "listSessions",
    "history",
    "snapshot",
    "sessionOptions",
    "configure",
    "archive",
    "unarchive",
    "stageConfiguration",
    "sendImages",
    "command",
    "queue",
    "removeQueued",
] as const;
export type SavedOperation = (typeof SAVED_OPERATIONS)[number];
export interface SavedDesktopRequest extends SessionBinding {
    projectId?: string;
    request?: WorkspaceSessionListRequest &
        Partial<WorkspaceHistoryRequest & WorkspaceSnapshotRequest & WorkspaceConfigureRequest>;
    context?: WorkspaceProjectContext;
    selection?: WorkspaceConfigurationSelection;
    text?: string;
    images?: SessionImageTransfer[];
    requestId?: string;
    expectedGeneration?: number;
    draft?: SessionQueuedDraft;
    confirmed?: boolean;
}
function keys(
    value:
        | SessionBinding
        | WorkspaceProjectContext
        | WorkspaceSessionRequest
        | WorkspaceConfigurationSelection
        | SessionQueuedDraft,
    allowed: string[],
): void {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        throw new Error("Unexpected saved Session request field.");
}
function text(value: string | undefined, limit = 512): void {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
        throw new Error("Invalid saved Session field.");
}
function selection(value: WorkspaceConfigurationSelection): void {
    keys(value, ["agentName", "model", "provider", "thinkingLevel"]);
    for (const field of Object.values(value)) text(field, 512);
}
/** Reject untrusted shapes and contexts before the semantic client can issue a runtime request. */
export function validateSavedRequest(
    operation: SavedOperation,
    payload: SavedDesktopRequest,
    binding: SessionBinding,
    contexts: ReadonlyMap<string, WorkspaceProjectContext>,
): void {
    const fields: Record<SavedOperation, string[]> = {
        readProject: ["projectId"],
        listSessions: ["request"],
        history: ["request"],
        snapshot: ["request"],
        sessionOptions: ["context"],
        configure: ["request"],
        archive: ["request", "confirmed"],
        unarchive: ["request"],
        stageConfiguration: ["selection"],
        command: ["text"],
        sendImages: ["text", "images", "requestId", "expectedGeneration"],
        queue: ["draft"],
        removeQueued: ["requestId"],
    };
    keys(payload, ["connectionId", "project", "sessionId", ...fields[operation]]);
    if (payload.connectionId !== binding.connectionId) throw new Error("Invalid Session connection.");
    if (
        ["stageConfiguration", "sendImages", "queue", "removeQueued", "command"].includes(operation) &&
        (payload.project !== binding.project || payload.sessionId !== binding.sessionId)
    )
        throw new Error("This request does not belong to the active Project and Session.");
    if (operation === "readProject") {
        text(payload.projectId, 128);
        return;
    }
    if (operation === "command") {
        text(payload.text, 65536);
        if (!payload.text!.trim().startsWith("/") || /[\r\n]/.test(payload.text!)) throw new Error("Invalid command.");
        return;
    }
    if (operation === "stageConfiguration") {
        selection(payload.selection!);
        return;
    }
    if (operation === "sendImages" || operation === "queue") {
        const input = operation === "queue" ? payload.draft! : payload;
        if (operation === "queue") keys(input, ["requestId", "text", "images"]);
        if (
            typeof input.text !== "string" ||
            !Array.isArray(input.images) ||
            input.images.length > 100 ||
            input.images.some((image) => !image || typeof image !== "object" || Array.isArray(image))
        )
            throw new Error("Invalid image message.");
        let total = 0;
        for (const image of input.images) {
            if (typeof image.base64 !== "string" || (total += image.base64.length) > SESSION_IMAGE_BASE64_LIMIT)
                throw new Error("Images exceed 10 MiB of base64.");
        }
        validateSessionInput(input.text, input.images);
        if (operation === "queue" || input.requestId !== undefined) text(input.requestId, 128);
        if (
            payload.expectedGeneration !== undefined &&
            (!Number.isSafeInteger(payload.expectedGeneration) || payload.expectedGeneration < 0)
        )
            throw new Error("Invalid generation.");
        return;
    }
    if (operation === "removeQueued") {
        text(payload.requestId, 128);
        return;
    }
    const context = operation === "sessionOptions" ? payload.context! : payload.request?.context!;
    keys(context, ["connectionId", "projectId", "canonicalRoot"]);
    const issued = contexts.get(context.projectId);
    if (!issued || context.connectionId !== binding.connectionId || context.canonicalRoot !== issued.canonicalRoot)
        throw new Error("Invalid admitted Project context.");
    if (operation === "sessionOptions") return;
    const request = payload.request!;
    const extras =
        operation === "listSessions"
            ? ["archiveState", "cursor", "limit"]
            : operation === "history"
              ? ["cursor", "limit"]
              : operation === "snapshot"
                ? ["cursor", "wireSessionId"]
                : operation === "configure"
                  ? ["requestId", "expectedGeneration", "agentName", "model", "provider", "thinkingLevel"]
                  : [];
    keys(request, ["context", ...(operation === "listSessions" ? [] : ["sessionId"]), ...extras]);
    if (operation !== "listSessions") text(request.sessionId);
    if (request.cursor !== undefined) text(request.cursor, 8192);
    if (
        request.limit !== undefined &&
        (!Number.isSafeInteger(request.limit) ||
            request.limit < 1 ||
            request.limit > (operation === "history" ? 200 : 100))
    )
        throw new Error("Invalid page limit.");
    if (request.archiveState !== undefined && !["active", "archived", "all"].includes(request.archiveState))
        throw new Error("Invalid archive filter.");
    if (request.wireSessionId !== undefined) text(request.wireSessionId);
    if (payload.confirmed !== undefined && typeof payload.confirmed !== "boolean")
        throw new Error("Invalid confirmation.");
    if (operation === "configure") {
        text(request.requestId, 128);
        if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration! < 0)
            throw new Error("Invalid generation.");
        for (const field of [request.agentName, request.model, request.provider, request.thinkingLevel])
            if (field !== undefined) text(field);
    }
}
