export const COLLABORATION_STATE_REMOTE_CANONICAL = "remote_canonical";

export const COLLABORATION_FRONT_MATTER_KEYS = Object.freeze({
    collaborationState: "collaborationState",
    collaborationServerUrl: "collaborationServerUrl",
    collaborationSpaceId: "collaborationSpaceId",
    collaborationRevision: "collaborationRevision",
    collaborationBodyHash: "collaborationBodyHash",
    collaborationSyncedAt: "collaborationSyncedAt",
});

export interface CollaborationFrontMatter {
    collaborationState?: string;
    collaborationServerUrl?: string;
    collaborationSpaceId?: string;
    collaborationRevision?: number;
    collaborationBodyHash?: string;
    collaborationSyncedAt?: string;
}

export function normalizeServerUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Plan Server URL must be http or https");
    if (url.search) throw new Error("Plan Server URL must not include query parameters");
    if (url.hash) throw new Error("Plan Server URL must not include a fragment");
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
}

export function normalizePlanServerUrl<Value>(value: Value): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error("Plan Server URL must be a non-empty string.");
    }
    const normalized = normalizeServerUrl(value.trim());
    const url = new URL(normalized);
    if (/(?:^|\/)p\/[^/]+\/?$/.test(url.pathname)) {
        throw new Error("Plan Server URL must not be a full collaboration share URL.");
    }
    return normalized;
}

function normalizeCollaborationRevision<T>(value: T): number | undefined {
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
