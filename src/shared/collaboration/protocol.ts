/** @module shared/collaboration/protocol */

import { assertCapabilityScope, type CapabilityScope } from "./capabilities.ts";

/** Validated as a non-array record. Individual fields are checked by the normalizers. */
export interface ProtocolRecord {
    [key: string]: unknown;
}

export interface SharedSpaceMetadata {
    spaceId: string;
    planId: string;
    createdAt: string;
    updatedAt: string;
    latestRevision: number;
    status?: "open" | "closed";
    closedAt?: string;
    expiresAt?: string;
}

interface InitialRevision {
    payloadCiphertext: string;
}

export interface CreateSharedSpacePayload {
    planId: string;
    initialRevision: InitialRevision;
    capabilities: CapabilityRecord[];
}

export interface AppendRevisionPayload {
    payloadCiphertext: string;
    expectedRevision?: number;
}

export interface AppendCommentPayload {
    ciphertext: string;
}

export interface RevisionMetadata {
    spaceId: string;
    revision: number;
    createdAt: string;
    payloadCiphertext: string;
}

export interface EncryptedPlanPayload {
    planId: string;
    title: string;
    metadata: ProtocolRecord;
    body: string;
}

export interface EncryptedCommentRecord {
    id: string;
    spaceId: string;
    ciphertext: string;
    createdAt: string;
    resolved: boolean;
}

export interface DecryptedReviewCommentPayload {
    schemaVersion: number;
    type: "comment" | "global_comment";
    displayName: string;
    body: string;
    originalText?: string;
    anchor?: ProtocolRecord | null;
    createdAt?: string;
}

export interface CapabilityRecord {
    scope: CapabilityScope;
    capabilityHash: string;
}

export interface CommentStateChangePayload {
    commentId: string;
    action: "resolve" | "reopen";
}

export interface SharedSpaceLifecyclePayload {
    spaceId: string;
    action: "close" | "delete";
}

export interface ApiErrorPayload {
    error: string;
    message: string;
    status?: number;
}

export interface LocalSecretRecord {
    planId: string;
    spaceId?: string;
    contentKey: string;
    reviewerCapability?: string;
    maintainerCapability?: string;
    updatedAt: string;
}

export function assertNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
    return value.trim();
}

export function assertPositiveInteger(value: unknown, name: string): number {
    // Number.isInteger does not narrow a wire value in TypeScript.
    const integer = value as number;
    if (!Number.isInteger(integer) || integer < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return integer;
}

export function assertIsoDateTimeString(value: unknown, name: string): string {
    const text = assertNonEmptyString(value, name);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) {
        throw new Error(`${name} must be an ISO-8601 date-time string`);
    }
    return text;
}

export function normalizeSharedSpaceMetadata(value: unknown): SharedSpaceMetadata {
    const record = assertRecord(value, "Shared space metadata");
    const normalized: SharedSpaceMetadata = {
        spaceId: assertNonEmptyString(record.spaceId, "spaceId"),
        planId: assertNonEmptyString(record.planId, "planId"),
        createdAt: assertNonEmptyString(record.createdAt, "createdAt"),
        updatedAt: assertNonEmptyString(record.updatedAt, "updatedAt"),
        latestRevision: assertPositiveInteger(record.latestRevision, "latestRevision"),
    };
    if (record.status !== undefined) {
        if (record.status !== "open" && record.status !== "closed") throw new Error("status must be open or closed");
        normalized.status = record.status;
    }
    if (record.closedAt !== undefined) normalized.closedAt = assertNonEmptyString(record.closedAt, "closedAt");
    if (record.expiresAt !== undefined) normalized.expiresAt = assertIsoDateTimeString(record.expiresAt, "expiresAt");
    return normalized;
}

export function normalizeRevisionMetadata(value: unknown): RevisionMetadata {
    const record = assertRecord(value, "Revision metadata");
    return {
        spaceId: assertNonEmptyString(record.spaceId, "spaceId"),
        revision: assertPositiveInteger(record.revision, "revision"),
        createdAt: assertNonEmptyString(record.createdAt, "createdAt"),
        payloadCiphertext: assertNonEmptyString(record.payloadCiphertext, "payloadCiphertext"),
    };
}

export function normalizeCapabilityRecord(value: unknown): CapabilityRecord {
    const record = assertRecord(value, "Capability record");
    return {
        scope: assertCapabilityScope(record.scope),
        capabilityHash: assertNonEmptyString(record.capabilityHash, "capabilityHash"),
    };
}

export function normalizeCreateSharedSpacePayload(value: unknown): CreateSharedSpacePayload {
    const record = assertRecord(value, "Create Shared Space payload");
    rejectPlaintextFields(record);
    const initialRevision = assertRecord(record.initialRevision, "initialRevision");
    rejectPlaintextFields(initialRevision);
    const capabilities = Array.isArray(record.capabilities) ? record.capabilities.map(normalizeCapabilityRecord) : [];
    if (capabilities.length === 0) throw new Error("capabilities must include reviewer and maintainer hashes");
    return {
        planId: assertNonEmptyString(record.planId, "planId"),
        initialRevision: {
            payloadCiphertext: assertNonEmptyString(initialRevision.payloadCiphertext, "payloadCiphertext"),
        },
        capabilities,
    };
}

export function normalizeAppendRevisionPayload(value: unknown): AppendRevisionPayload {
    const record = assertRecord(value, "Append revision payload");
    rejectPlaintextFields(record);
    const normalized: AppendRevisionPayload = {
        payloadCiphertext: assertNonEmptyString(record.payloadCiphertext, "payloadCiphertext"),
    };
    if (record.expectedRevision !== undefined) {
        normalized.expectedRevision = assertPositiveInteger(record.expectedRevision, "expectedRevision");
    }
    return normalized;
}

export function normalizeAppendCommentPayload(value: unknown): AppendCommentPayload {
    const record = assertRecord(value, "Append comment payload");
    rejectPlaintextFields(record);
    return { ciphertext: assertNonEmptyString(record.ciphertext, "ciphertext") };
}

export function normalizeEncryptedPlanPayload(value: unknown): EncryptedPlanPayload {
    const record = assertRecord(value, "Encrypted plan payload");
    if (typeof record.body !== "string" || record.body.trim() === "") {
        throw new Error("body must be a non-empty string");
    }
    return {
        planId: assertNonEmptyString(record.planId, "planId"),
        title: assertNonEmptyString(record.title, "title"),
        metadata: { ...assertRecord(record.metadata, "metadata") },
        body: record.body,
    };
}

export function normalizeEncryptedCommentRecord(value: unknown): EncryptedCommentRecord {
    const record = assertRecord(value, "Encrypted comment record");
    if (typeof record.resolved !== "boolean") throw new Error("resolved must be a boolean");
    return {
        id: assertNonEmptyString(record.id, "id"),
        spaceId: assertNonEmptyString(record.spaceId, "spaceId"),
        ciphertext: assertNonEmptyString(record.ciphertext, "ciphertext"),
        createdAt: assertNonEmptyString(record.createdAt, "createdAt"),
        resolved: record.resolved,
    };
}

export function normalizeDecryptedReviewCommentPayload(value: unknown): DecryptedReviewCommentPayload {
    const record = assertRecord(value, "Decrypted review comment payload");
    if (record.schemaVersion !== 1) throw new Error("Review comment schemaVersion must be 1");
    if (record.type !== "comment" && record.type !== "global_comment") {
        throw new Error("Review comment type must be comment or global_comment");
    }
    const normalized: DecryptedReviewCommentPayload = {
        schemaVersion: 1,
        type: record.type,
        displayName: assertNonEmptyString(record.displayName, "displayName"),
        body: assertNonEmptyString(record.body, "body"),
    };
    if (record.originalText !== undefined) {
        if (typeof record.originalText !== "string") throw new Error("originalText must be a string");
        normalized.originalText = record.originalText;
    }
    if (record.anchor !== undefined && record.anchor !== null) {
        normalized.anchor = { ...assertRecord(record.anchor, "anchor") };
    }
    if (record.createdAt !== undefined) normalized.createdAt = assertNonEmptyString(record.createdAt, "createdAt");
    return normalized;
}

export function normalizeCommentStateChangePayload(value: unknown): CommentStateChangePayload {
    const record = assertRecord(value, "Comment state change payload");
    if (record.action !== "resolve" && record.action !== "reopen") {
        throw new Error("Comment action must be resolve or reopen");
    }
    return {
        commentId: assertNonEmptyString(record.commentId, "commentId"),
        action: record.action,
    };
}

export function normalizeSharedSpaceLifecyclePayload(value: unknown): SharedSpaceLifecyclePayload {
    const record = assertRecord(value, "Shared space lifecycle payload");
    if (record.action !== "close" && record.action !== "delete") {
        throw new Error("Shared Space lifecycle action must be close or delete");
    }
    return {
        spaceId: assertNonEmptyString(record.spaceId, "spaceId"),
        action: record.action,
    };
}

export function normalizeApiErrorPayload(value: unknown): ApiErrorPayload {
    const record = assertRecord(value, "API error payload");
    const normalized: ApiErrorPayload = {
        error: assertNonEmptyString(record.error, "error"),
        message: assertNonEmptyString(record.message, "message"),
    };
    if (record.status !== undefined) normalized.status = assertPositiveInteger(record.status, "status");
    return normalized;
}

export function normalizeLocalSecretRecord(value: unknown): LocalSecretRecord {
    const record = assertRecord(value, "Local secret record");
    const normalized: LocalSecretRecord = {
        planId: assertNonEmptyString(record.planId, "planId"),
        contentKey: assertNonEmptyString(record.contentKey, "contentKey"),
        updatedAt: assertNonEmptyString(record.updatedAt, "updatedAt"),
    };
    if (record.spaceId !== undefined) normalized.spaceId = assertNonEmptyString(record.spaceId, "spaceId");
    if (record.reviewerCapability !== undefined) {
        normalized.reviewerCapability = assertNonEmptyString(record.reviewerCapability, "reviewerCapability");
    }
    if (record.maintainerCapability !== undefined) {
        normalized.maintainerCapability = assertNonEmptyString(record.maintainerCapability, "maintainerCapability");
    }
    return normalized;
}

export function assertRecord(value: unknown, name: string): ProtocolRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value as ProtocolRecord;
}

const PLAINTEXT_FIELD_NAMES = new Set([
    "body",
    "author",
    "authorName",
    "displayName",
    "originalText",
    "context",
    "anchor",
    "anchors",
]);

function rejectPlaintextFields(record: ProtocolRecord) {
    for (const key of Object.keys(record)) {
        if (PLAINTEXT_FIELD_NAMES.has(key)) throw new Error(`${key} must be encrypted inside ciphertext payloads`);
    }
}
