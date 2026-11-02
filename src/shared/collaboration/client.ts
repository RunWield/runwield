/** @module shared/collaboration/client */

import { redactSecrets } from "./capabilities.ts";
import {
    normalizeAppendCommentPayload,
    normalizeAppendRevisionPayload,
    normalizeCreateSharedSpacePayload,
} from "./protocol.js";
import { buildApiUrl, normalizeServerUrl } from "./urls.ts";

import type {
    AppendCommentPayload,
    AppendRevisionPayload,
    CommentStateChangePayload,
    CreateSharedSpacePayload,
    SharedSpaceLifecyclePayload,
} from "./protocol.js";

export type { AppendCommentPayload, AppendRevisionPayload, CreateSharedSpacePayload } from "./protocol.js";

export interface CollaborationClientOptions {
    serverUrl: string;
    bearerCapability?: string;
    fetch: typeof globalThis.fetch;
}

/** JSON transport and error payloads remain opaque until validated by their consumers. */
export interface CollaborationApiErrorOptions {
    status?: number;
    payload?: unknown;
    secrets?: string[];
}

export interface CollaborationRequestHeaders {
    [name: string]: string;
}

export interface CollaborationRequestOptions {
    method?: string;
    body?: unknown;
    headers?: CollaborationRequestHeaders;
    auth?: boolean;
}

export type CollaborationCommentStatePayload = Pick<CommentStateChangePayload, "action">;
export type CollaborationLifecyclePayload = Pick<SharedSpaceLifecyclePayload, "action">;

interface RawApiErrorPayload {
    message?: unknown;
}

interface RedactedJsonFields {
    [key: string]: unknown;
}

export const SYSTEM_COLLABORATION_FETCH = globalThis.fetch.bind(globalThis);

export class CollaborationApiError extends Error {
    declare status: number | undefined;
    declare payload: unknown;

    constructor(message: string, options: CollaborationApiErrorOptions = {}) {
        super(redactSecrets(message, options.secrets));
        this.name = "CollaborationApiError";
        this.status = options.status;
        this.payload = redactPayload(options.payload, options.secrets);
    }
}

export class CollaborationClient {
    declare serverUrl: string;
    declare bearerCapability: string | undefined;
    declare fetch: typeof globalThis.fetch;

    constructor(options: CollaborationClientOptions) {
        this.serverUrl = normalizeServerUrl(options.serverUrl);
        this.bearerCapability = options.bearerCapability;
        this.fetch = options.fetch;
    }

    async requestJson(path: string, options: CollaborationRequestOptions = {}): Promise<unknown> {
        const url = buildApiUrl(this.serverUrl, path);
        const headers: CollaborationRequestHeaders = {
            Accept: "application/json",
            ...(options.headers ?? {}),
        };
        if (options.auth !== false) {
            if (!this.bearerCapability) {
                throw new CollaborationApiError("Bearer capability is required for this Plan Server request.");
            }
            headers.Authorization = `Bearer ${this.bearerCapability}`;
        }
        const init: RequestInit = { method: options.method ?? "GET", headers };
        if (options.body !== undefined) {
            headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(options.body);
        }

        const secrets = this.bearerCapability ? [this.bearerCapability] : [];
        let response;
        try {
            response = await this.fetch(url, init);
        } catch (error) {
            throw new CollaborationApiError(`Network failure calling ${url}: ${redactSecrets(error, secrets)}`, {
                secrets,
            });
        }

        const text = await response.text();
        const payload = parseJsonOrUndefined(text);
        if (!response.ok) {
            const message = getErrorMessage(payload) ?? (text || response.statusText || "Request failed");
            throw new CollaborationApiError(`Plan Server error ${response.status}: ${message}`, {
                status: response.status,
                payload,
                secrets,
            });
        }
        return payload;
    }

    async createSharedSpace(payload: CreateSharedSpacePayload) {
        return await this.requestJson("/api/spaces", {
            method: "POST",
            auth: false,
            body: normalizeCreateSharedSpacePayload(payload),
        });
    }

    async getSharedSpace(spaceId: string) {
        return await this.requestJson(`/api/spaces/${encodeURIComponent(spaceId)}`);
    }

    async getRevision(spaceId: string, revision: number) {
        return await this.requestJson(`/api/spaces/${encodeURIComponent(spaceId)}/revisions/${revision}`);
    }

    async appendRevision(spaceId: string, payload: AppendRevisionPayload) {
        return await this.requestJson(`/api/spaces/${encodeURIComponent(spaceId)}/revisions`, {
            method: "POST",
            body: normalizeAppendRevisionPayload(payload),
        });
    }

    async listComments(spaceId: string, revision: number) {
        return await this.requestJson(`/api/spaces/${encodeURIComponent(spaceId)}/revisions/${revision}/comments`);
    }

    async appendComment(spaceId: string, revision: number, payload: AppendCommentPayload) {
        return await this.requestJson(`/api/spaces/${encodeURIComponent(spaceId)}/revisions/${revision}/comments`, {
            method: "POST",
            body: normalizeAppendCommentPayload(payload),
        });
    }

    async setCommentState(spaceId: string, commentId: string, payload: CollaborationCommentStatePayload) {
        return await this.requestJson(
            `/api/spaces/${encodeURIComponent(spaceId)}/comments/${encodeURIComponent(commentId)}/state`,
            {
                method: "POST",
                body: payload,
            },
        );
    }

    async updateSharedSpaceLifecycle(spaceId: string, payload: CollaborationLifecyclePayload) {
        return await this.requestJson(`/api/spaces/${encodeURIComponent(spaceId)}/lifecycle`, {
            method: "POST",
            body: payload,
        });
    }

    async deleteSharedSpace(spaceId: string) {
        return await this.updateSharedSpaceLifecycle(spaceId, { action: "delete" });
    }
}

export function createCollaborationClient(options: CollaborationClientOptions) {
    return new CollaborationClient(options);
}

function parseJsonOrUndefined(text: string): unknown {
    if (text.trim() === "") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function getErrorMessage(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const record = payload as RawApiErrorPayload;
    return typeof record.message === "string" ? record.message : undefined;
}

function redactPayload(payload: unknown, secrets: string[] | undefined): unknown {
    if (typeof payload === "string") return redactSecrets(payload, secrets);
    if (!payload || typeof payload !== "object") return payload;
    if (Array.isArray(payload)) return payload.map((item) => redactPayload(item, secrets));
    const redacted: RedactedJsonFields = {};
    for (const [key, value] of Object.entries(payload)) redacted[key] = redactPayload(value, secrets);
    return redacted;
}
