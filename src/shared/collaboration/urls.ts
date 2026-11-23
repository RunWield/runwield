/** @module shared/collaboration/urls */

import { assertCapabilityScope, type CapabilityScope, redactSecrets } from "./capabilities.ts";
import { assertNonEmptyString } from "./protocol.ts";
import { normalizeServerUrl } from "@runwield/plans/format";

export { normalizePlanServerUrl, normalizeServerUrl } from "@runwield/plans/format";

export interface CollaborationUrlInput {
    serverUrl: string;
    spaceId: string;
    contentKey: string;
    bearerCapability: string;
    role: CapabilityScope;
}

export interface CollaborationUrlParts extends CollaborationUrlInput {
    apiBaseUrl: string;
}

export function buildCollaborationUrl(parts: CollaborationUrlInput): string {
    const serverUrl = normalizeServerUrl(parts.serverUrl);
    const spaceId = encodeURIComponent(assertNonEmptyString(parts.spaceId, "spaceId"));
    const url = new URL(`${serverUrl}/p/${spaceId}`);
    const fragment = new URLSearchParams();
    fragment.set("key", assertNonEmptyString(parts.contentKey, "contentKey"));
    fragment.set("cap", assertNonEmptyString(parts.bearerCapability, "bearerCapability"));
    fragment.set("role", assertCapabilityScope(parts.role));
    url.hash = fragment.toString();
    return url.toString();
}

export function parseCollaborationUrl(value: string): CollaborationUrlParts {
    const url = new URL(value);
    const match = /^(.*)\/p\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw new Error("Collaboration URL path must be /p/<space-id>");
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const contentKey = fragment.get("key");
    const bearerCapability = fragment.get("cap");
    const role = fragment.get("role");
    if (!contentKey || !bearerCapability || !role) {
        throw new Error("Collaboration URL fragment must include key, cap, and role");
    }
    url.hash = "";
    url.pathname = match[1] || "";
    url.search = "";
    const serverUrl = normalizeServerUrl(url.toString());
    return {
        serverUrl,
        apiBaseUrl: serverUrl,
        spaceId: decodeURIComponent(match[2]),
        contentKey,
        bearerCapability,
        role: assertCapabilityScope(role),
    };
}

export function redactCollaborationUrl(value: string): string {
    return redactSecrets(value).replace(/#.*$/, "#[redacted]");
}

export function buildApiUrl(serverUrl: string, path: string): string {
    const normalizedPath = normalizeApiPath(path);
    const base = `${normalizeServerUrl(serverUrl)}/`;
    const url = new URL(normalizedPath, base);
    url.hash = "";
    return url.toString();
}

function normalizeApiPath(path: string): string {
    const trimmed = assertNonEmptyString(path, "path");
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//") || trimmed.includes("\\")) {
        throw new Error("API path must be relative to the Plan Server URL");
    }
    const normalizedPath = trimmed.replace(/^\/+/, "");
    if (normalizedPath.split("/").some((segment) => segment === "." || segment === "..")) {
        throw new Error("API path must stay within the Plan Server URL");
    }
    return normalizedPath;
}
