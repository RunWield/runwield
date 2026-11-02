/**
 * Helpers for the remote Shared Space browser review payload.
 *
 * Remote APIs store this payload only after content-key encryption. The helper
 * shape intentionally mirrors Plannotator's annotation metadata so the browser
 * can render/restore annotations while `wld plans pull` still receives the
 * stable remote review fields it already understands.
 */

export interface RemoteSelectionMeta {
    parentTagName: string;
    parentIndex: number;
    textOffset: number;
}

export interface RemoteCommentAnchor {
    blockId: string;
    startOffset: number;
    endOffset: number;
    prefix?: string;
    suffix?: string;
    startMeta?: RemoteSelectionMeta;
    endMeta?: RemoteSelectionMeta;
}

export interface RemoteCommentPayload {
    schemaVersion: 1;
    type: "comment" | "global_comment";
    displayName: string;
    body: string;
    originalText: string;
    anchor: RemoteCommentAnchor | null;
    createdAt: string;
}

export interface RemoteCommentRecord {
    id: string;
    resolved: boolean;
    createdAt: string;
    unreadable?: boolean;
    anchorMissing?: boolean;
    type: "comment" | "global_comment";
    displayName: string;
    body: string;
    originalText: string;
    anchor: RemoteCommentAnchor | null;
}

export interface RemoteCommentSelection extends RemoteCommentAnchor {
    originalText: string;
}

/** Unvalidated annotation fields from the JavaScript Plannotator integration. */
export interface RemoteCommentAnnotationInput {
    [key: string]: unknown;
    type?: unknown;
    originalText?: unknown;
    text?: unknown;
    blockId?: unknown;
    startOffset?: unknown;
    endOffset?: unknown;
    startMeta?: unknown;
    endMeta?: unknown;
    createdA?: unknown;
}

export interface BuildRemoteCommentInput {
    displayName: string;
    body?: string;
    selection?: RemoteCommentSelection | null;
    annotation?: RemoteCommentAnnotationInput | null;
}

/** Raw decrypted fields are validated by the existing normalization functions. */
interface RawRemoteCommentPayload {
    schemaVersion?: unknown;
    type?: unknown;
    body?: unknown;
    displayName?: unknown;
    originalText?: unknown;
    anchor?: unknown;
    createdAt?: unknown;
}

interface RawRemoteCommentAnchor {
    startOffset?: unknown;
    endOffset?: unknown;
    blockId?: unknown;
    prefix?: unknown;
    suffix?: unknown;
    startMeta?: unknown;
    endMeta?: unknown;
}

interface RawRemoteSelectionMeta {
    parentTagName?: unknown;
    parentIndex?: unknown;
    textOffset?: unknown;
}

export function normalizeRemoteCommentPayload(value: unknown): RemoteCommentPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Comment payload must be an object.");
    }
    const record = value as RawRemoteCommentPayload;
    if (record.schemaVersion !== 1) throw new Error("Unsupported comment payload version.");
    if (record.type !== "comment" && record.type !== "global_comment") {
        throw new Error("Comment payload type must be comment or global_comment.");
    }
    const body = nonEmpty(record.body, "body");
    return {
        schemaVersion: 1,
        type: record.type,
        displayName: nonEmpty(record.displayName, "displayName"),
        body,
        originalText: typeof record.originalText === "string" ? record.originalText : "",
        anchor: record.type === "comment" ? normalizeAnchor(record.anchor) : null,
        createdAt: nonEmpty(record.createdAt, "createdAt"),
    };
}

export function buildRemoteCommentPayload(input: BuildRemoteCommentInput): RemoteCommentPayload {
    const annotation = input.annotation ?? null;
    if (annotation) {
        const type = annotation.type === "GLOBAL_COMMENT" ? "global_comment" : "comment";
        const originalText = typeof annotation.originalText === "string" ? annotation.originalText : "";
        return normalizeRemoteCommentPayload({
            schemaVersion: 1,
            type,
            displayName: input.displayName,
            body: typeof input.body === "string" ? input.body : String(annotation.text || ""),
            originalText,
            anchor:
                type === "comment"
                    ? {
                          blockId: annotation.blockId,
                          startOffset: annotation.startOffset,
                          endOffset: annotation.endOffset,
                          startMeta: annotation.startMeta,
                          endMeta: annotation.endMeta,
                      }
                    : null,
            createdAt: new Date(
                typeof annotation.createdA === "number" ? annotation.createdA : Date.now(),
            ).toISOString(),
        });
    }

    const selection = input.selection ?? null;
    return normalizeRemoteCommentPayload({
        schemaVersion: 1,
        type: selection ? "comment" : "global_comment",
        displayName: input.displayName,
        body: input.body,
        originalText: selection?.originalText ?? "",
        anchor: selection
            ? {
                  blockId: selection.blockId,
                  startOffset: selection.startOffset,
                  endOffset: selection.endOffset,
                  prefix: selection.prefix,
                  suffix: selection.suffix,
                  startMeta: selection.startMeta,
                  endMeta: selection.endMeta,
              }
            : null,
        createdAt: new Date().toISOString(),
    });
}

export function remoteCommentToPlannotatorAnnotation(comment: RemoteCommentRecord) {
    const createdA = Date.parse(comment.createdAt || "");
    const anchor = comment.anchor || null;
    const legacyInlineAnchor = comment.type === "comment" && anchor && (!anchor.startMeta || !anchor.endMeta);
    return {
        id: comment.id,
        blockId: legacyInlineAnchor ? `__missing_legacy_anchor_${comment.id}` : anchor?.blockId || "",
        startOffset: legacyInlineAnchor ? 0 : anchor?.startOffset || 0,
        endOffset: legacyInlineAnchor
            ? Math.max(1, comment.originalText.length)
            : anchor?.endOffset || Math.max(0, comment.originalText.length),
        type: comment.type === "global_comment" ? "GLOBAL_COMMENT" : "COMMENT",
        text: comment.unreadable ? "Unreadable encrypted comment." : comment.body,
        originalText: comment.originalText || "",
        createdA: Number.isFinite(createdA) ? createdA : Date.now(),
        author: comment.displayName || (comment.unreadable ? "Unreadable comment" : "Reviewer"),
        startMeta: legacyInlineAnchor ? undefined : anchor?.startMeta,
        endMeta: legacyInlineAnchor ? undefined : anchor?.endMeta,
    };
}

function normalizeAnchor(value: unknown): RemoteCommentAnchor {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Comment anchor is required.");
    const record = value as RawRemoteCommentAnchor;
    const startOffset = positiveOffset(record.startOffset, "startOffset");
    const endOffset = positiveOffset(record.endOffset, "endOffset");
    if (endOffset <= startOffset) throw new Error("Comment anchor endOffset must be after startOffset.");
    return {
        blockId: nonEmpty(record.blockId, "blockId"),
        startOffset,
        endOffset,
        prefix: typeof record.prefix === "string" ? record.prefix : undefined,
        suffix: typeof record.suffix === "string" ? record.suffix : undefined,
        startMeta: normalizeSelectionMeta(record.startMeta),
        endMeta: normalizeSelectionMeta(record.endMeta),
    };
}

function normalizeSelectionMeta(value: unknown): RemoteSelectionMeta | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Selection metadata must be an object.");
    const record = value as RawRemoteSelectionMeta;
    return {
        parentTagName: nonEmpty(record.parentTagName, "parentTagName"),
        parentIndex: positiveOffset(record.parentIndex, "parentIndex"),
        textOffset: positiveOffset(record.textOffset, "textOffset"),
    };
}

function nonEmpty(value: unknown, name: string) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string.`);
    return value.trim();
}

function positiveOffset(value: unknown, name: string) {
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return value as number;
}
