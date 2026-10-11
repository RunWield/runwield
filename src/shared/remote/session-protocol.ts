import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

export function sessionDigest(contents: string | Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}
/** File-free, operation-scoped messages on the existing authenticated control channel. */
import type { TranscriptEvidence } from "../session/file-session-store-types.ts";

export const MAX_SESSION_BYTES = 16 * 1024 * 1024;
export interface RemoteSessionRequest {
    operation: string;
    sequence: number;
    kind: "hydrate" | "inspect" | "append" | "rewrite" | "attachment" | "attachment-read" | "checkpoint" | "uncertain";
    /** Exact JSONL bytes, attachment JSON, or an attachment ref; never a path or a writer proof. */
    contents: string;
}
export interface RemoteSessionResponse {
    operation: string;
    sequence: number;
    contents: string;
    evidence: TranscriptEvidence;
}
export interface RemoteSessionConnection {
    baseUrl: string;
    credential: string;
    operation: string;
    timeoutMs?: number;
}
export interface SessionWorkerRequest {
    connection: RemoteSessionConnection;
    payload: string;
    result: SharedArrayBuffer;
    fault: SharedArrayBuffer;
}

export function validateSessionRequest(input: RemoteSessionRequest): void {
    if (
        !input || Object.keys(input).sort().join(",") !== "contents,kind,operation,sequence" ||
        typeof input.operation !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(input.operation) ||
        !Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
        !["hydrate", "inspect", "append", "rewrite", "attachment", "attachment-read", "checkpoint", "uncertain"]
            .includes(input.kind) ||
        typeof input.contents !== "string" || new TextEncoder().encode(input.contents).length > MAX_SESSION_BYTES ||
        (!["append", "rewrite", "attachment", "attachment-read"].includes(input.kind) && input.contents !== "")
    ) throw new Error("Invalid remote Session request");
}

/** Validate current Pi JSONL before admitting an in-memory remote manager. No file paths cross the wire. */
export function parseRemoteSessionTranscript(contents: string): FileEntry[] {
    if (!contents.endsWith("\n")) throw new Error("Session transcript must end with a newline");
    const entries: FileEntry[] = contents.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    const header = entries[0];
    if (
        !header || header.type !== "session" || header.version !== 3 ||
        typeof header.id !== "string" || !header.id || typeof header.cwd !== "string" ||
        !header.cwd || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))
    ) throw new Error("Session header requires laptop migration or is invalid");
    const ids = new Set<string>();
    for (const entry of entries.slice(1)) {
        if (
            !entry || entry.type === "session" ||
            ![
                "message",
                "thinking_level_change",
                "model_change",
                "usage",
                "compaction",
                "branch_summary",
                "custom",
                "custom_message",
                "context_edit",
                "label",
                "session_info",
            ].includes(entry.type) ||
            typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || typeof entry.timestamp !== "string" ||
            !Number.isFinite(Date.parse(entry.timestamp)) ||
            (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
        ) throw new Error("Invalid Session entry identity or parent");
        switch (entry.type) {
            case "message":
                if (!entry.message || typeof entry.message.role !== "string") {
                    throw new Error("Invalid Session message");
                }
                break;
            case "custom":
            case "custom_message":
                if (typeof entry.customType !== "string" || !entry.customType) {
                    throw new Error("Invalid Session custom entry");
                }
                break;
            case "model_change":
                if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") {
                    throw new Error("Invalid model entry");
                }
                break;
            case "thinking_level_change":
                if (typeof entry.thinkingLevel !== "string") throw new Error("Invalid thinking entry");
                break;
            case "compaction":
                if (
                    typeof entry.summary !== "string" || typeof entry.firstKeptEntryId !== "string" ||
                    !Number.isFinite(entry.tokensBefore)
                ) throw new Error("Invalid compaction entry");
                break;
            case "branch_summary":
                if (typeof entry.summary !== "string" || typeof entry.fromId !== "string") {
                    throw new Error("Invalid branch entry");
                }
                break;
            case "context_edit":
            case "label":
                if (!ids.has(entry.targetId)) throw new Error("Invalid Session entry target");
                break;
        }
        ids.add(entry.id);
    }
    return entries;
}

export interface RecoverableSessionTranscript {
    contents: string;
    terminalEntryId: string | null;
}

/** Keep complete entries; an interrupted final JSONL write cannot authorize work or trigger effect replay. */
export function inspectRecoverableSessionTranscript(bytes: Uint8Array): RecoverableSessionTranscript {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let contents: string;
    let entries: FileEntry[];
    try {
        contents = decoder.decode(bytes);
        if (!contents.endsWith("\n")) contents += "\n";
        entries = parseRemoteSessionTranscript(contents);
    } catch (error) {
        // A malformed complete line is not an interrupted tail and must not be discarded.
        if (bytes.at(-1) === 10) throw error;
        contents = decoder.decode(bytes.subarray(0, bytes.lastIndexOf(10) + 1));
        entries = parseRemoteSessionTranscript(contents);
    }
    const last = entries.at(-1);
    return { contents, terminalEntryId: last?.type === "session" ? null : last?.id ?? null };
}
