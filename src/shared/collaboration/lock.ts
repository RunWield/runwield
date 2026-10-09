/** @module shared/collaboration/lock */

import { redactSecrets } from "./capabilities.ts";
import { normalizePlanServerUrl } from "./urls.ts";

export const COLLABORATION_STATE_REMOTE_CANONICAL = "remote_canonical";

export const COLLABORATION_FRONT_MATTER_KEYS = Object.freeze({
    collaborationState: "collaborationState",
    collaborationServerUrl: "collaborationServerUrl",
    collaborationSpaceId: "collaborationSpaceId",
    collaborationRevision: "collaborationRevision",
    collaborationBodyHash: "collaborationBodyHash",
    collaborationSyncedAt: "collaborationSyncedAt",
});

export const COLLABORATION_LOCK_BYPASS = Object.freeze({
    share: Symbol("runwield.collaborationLockBypass.share"),
    pull: Symbol("runwield.collaborationLockBypass.pull"),
    push: Symbol("runwield.collaborationLockBypass.push"),
    unshare: Symbol("runwield.collaborationLockBypass.unshare"),
});

const VALID_BYPASSES = new Set(Object.values(COLLABORATION_LOCK_BYPASS));

export const SHARED_PLAN_LOCK_REPAIR =
    "Run `wld plans pull`, `wld plans push`, or `wld plans unshare` before editing this shared Plan locally.";

export interface CollaborationFrontMatter {
    collaborationState?: string;
    collaborationServerUrl?: string;
    collaborationSpaceId?: string;
    collaborationRevision?: number;
    collaborationBodyHash?: string;
    collaborationSyncedAt?: string;
}

export interface CollaborationWriteOptions {
    collaborationLockBypass?: symbol;
}

export interface SharedPlanLockErrorOptions {
    reason?: string;
    repair?: string;
}

export class SharedPlanLockError extends Error {
    declare blockedReason: string;
    declare repair: string;
    declare collaboration: CollaborationFrontMatter;
    constructor(attrs: CollaborationFrontMatter = {}, options: SharedPlanLockErrorOptions = {}) {
        super(buildSharedPlanLockMessage(attrs, options.reason));
        this.name = "SharedPlanLockError";
        this.blockedReason = this.message;
        this.repair = options.repair || SHARED_PLAN_LOCK_REPAIR;
        this.collaboration = redactCollaborationMetadata(attrs);
    }
}

function redactCollaborationMetadata(attrs: CollaborationFrontMatter): CollaborationFrontMatter {
    return {
        collaborationState: attrs.collaborationState,
        collaborationServerUrl: typeof attrs.collaborationServerUrl === "string"
            ? redactSecrets(attrs.collaborationServerUrl).replace(/#.*$/, "#[redacted]")
            : attrs.collaborationServerUrl,
        collaborationSpaceId: attrs.collaborationSpaceId,
        collaborationRevision: attrs.collaborationRevision,
        collaborationBodyHash: attrs.collaborationBodyHash,
        collaborationSyncedAt: attrs.collaborationSyncedAt,
    };
}

export function normalizeCollaborationRevision<T>(value: T): number | undefined {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return Number(value.trim());
    return undefined;
}

function normalizeOptionalString<T>(value: T): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeCollaborationFrontMatter(attrs: CollaborationFrontMatter = {}): CollaborationFrontMatter {
    const normalized: CollaborationFrontMatter = {};
    if (attrs.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL) {
        normalized.collaborationState = COLLABORATION_STATE_REMOTE_CANONICAL;
    } else if (typeof attrs.collaborationState === "string" && attrs.collaborationState.trim()) {
        normalized.collaborationState = attrs.collaborationState.trim();
    }

    if (attrs.collaborationServerUrl !== undefined) {
        try {
            normalized.collaborationServerUrl = normalizePlanServerUrl(attrs.collaborationServerUrl);
        } catch {
            // Invalid URLs are intentionally omitted instead of preserved so Plan
            // front matter never stores fragments, query strings, share URLs, or
            // other secret-bearing URL material.
        }
    }
    normalized.collaborationSpaceId = normalizeOptionalString(attrs.collaborationSpaceId);
    normalized.collaborationRevision = normalizeCollaborationRevision(attrs.collaborationRevision);
    normalized.collaborationBodyHash = normalizeOptionalString(attrs.collaborationBodyHash);
    normalized.collaborationSyncedAt = normalizeOptionalString(attrs.collaborationSyncedAt);
    return normalized;
}

export function isSharedPlanLocked(attrs: CollaborationFrontMatter = {}): boolean {
    return attrs.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL;
}

export function isCollaborationLockBypass<T>(bypass: T): boolean {
    return VALID_BYPASSES.has(bypass as symbol);
}

function collaborationMetadataProblems(attrs: CollaborationFrontMatter): string[] {
    const problems = [];
    if (!normalizeOptionalString(attrs.collaborationServerUrl)) problems.push("missing collaborationServerUrl");
    if (!normalizeOptionalString(attrs.collaborationSpaceId)) problems.push("missing collaborationSpaceId");
    return problems;
}

export function buildSharedPlanLockMessage(attrs: CollaborationFrontMatter = {}, reason?: string): string {
    const server = typeof attrs.collaborationServerUrl === "string"
        ? redactSecrets(attrs.collaborationServerUrl).replace(/#.*$/, "#[redacted]")
        : "unknown server";
    const space = typeof attrs.collaborationSpaceId === "string"
        ? redactSecrets(attrs.collaborationSpaceId)
        : "unknown space";
    const details = reason ? ` ${redactSecrets(reason)}` : "";
    return `This shared Plan is remote-canonical (${server}, space ${space}) and cannot be changed by normal RunWield writes.${details} ${SHARED_PLAN_LOCK_REPAIR}`;
}

export function assertSharedPlanWriteAllowed(
    attrs: CollaborationFrontMatter = {},
    options: CollaborationWriteOptions = {},
): void {
    if (!isSharedPlanLocked(attrs)) return;
    if (isCollaborationLockBypass(options.collaborationLockBypass)) return;
    const problems = collaborationMetadataProblems(attrs);
    const reason = problems.length ? `Repair collaboration metadata first: ${problems.join(", ")}.` : undefined;
    throw new SharedPlanLockError(attrs, { reason });
}
