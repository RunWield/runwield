import type { JsonValue } from "@runwield/parsing/jsonc";
import { normalizeServerUrl } from "../format/collaboration.ts";
import { redactSecrets } from "./capabilities.ts";
import {
    normalizeAppendCommentPayload,
    normalizeAppendRevisionPayload,
    normalizeCreateSharedSpacePayload,
    SHARED_SPACE_IDEMPOTENCY_HEADER,
    SHARED_SPACE_GONE_CODE,
} from "./protocol.ts";
import { buildApiUrl } from "./urls.ts";

import type {
    AppendCommentPayload,
    AppendRevisionPayload,
    CommentStateChangePayload,
    CreateSharedSpacePayload,
    SharedSpaceLifecyclePayload,
} from "./protocol.ts";

export interface CollaborationClientOptions {
    serverUrl: string;
    bearerCapability?: string;
    accountToken?: string;
    fetch: typeof globalThis.fetch;
}

export interface CollaborationApiErrorOptions {
    status?: number;
    payload?: JsonValue;
    secrets?: string[];
}

export interface CollaborationRequestHeaders {
    [name: string]: string;
}

export interface CollaborationRequestOptions<Body> {
    method?: string;
    body?: Body;
    headers?: CollaborationRequestHeaders;
    redirect?: RequestRedirect;
}

export type CollaborationCommentStatePayload = Pick<CommentStateChangePayload, "action">;
export type CollaborationLifecyclePayload = Pick<SharedSpaceLifecyclePayload, "action">;

export const SYSTEM_COLLABORATION_FETCH = globalThis.fetch.bind(globalThis);

export class CollaborationApiError extends Error {
    declare status: number | undefined;
    declare payload: JsonValue | undefined;

    constructor(message: string, options: CollaborationApiErrorOptions = {}) {
        super(redactSecrets(message, options.secrets));
        this.name = "CollaborationApiError";
        this.status = options.status;
        this.payload = options.payload === undefined ? undefined : redactPayload(options.payload, options.secrets);
    }
}

/** The selected server needs the replay route before it can publish this attempt. */
export class PlanServerUpgradeRequiredError extends Error {
    constructor() {
        super("The original Plan Server needs replay support to publish this share. Upgrade it and retry.");
    }
}

/** The server confirmed the Shared Space for this request was permanently removed. */
export class SharedSpaceGoneError extends Error {
    constructor() {
        super(
            "The Shared Space from the previous share attempt was removed. Share the Plan again to create a new Shared Space.",
        );
    }
}

export class CollaborationClient {
    declare serverUrl: string;
    declare bearerCapability: string | undefined;
    declare fetch: typeof globalThis.fetch;
    private readonly accountToken: string | undefined;

    constructor(options: CollaborationClientOptions) {
        this.serverUrl = normalizeServerUrl(options.serverUrl);
        this.bearerCapability = options.bearerCapability;
        this.fetch = options.fetch;
        this.accountToken = options.accountToken;
    }

    async requestJson<Body>(
        path: string,
        options: CollaborationRequestOptions<Body> = {},
    ): Promise<JsonValue | undefined> {
        if (!this.bearerCapability) {
            throw new CollaborationApiError("Bearer capability is required for this Plan Server request.");
        }
        return await this.sendJson(path, options, this.bearerCapability);
    }

    private async sendJson<Body>(
        path: string,
        options: CollaborationRequestOptions<Body>,
        bearerCredential: string | undefined,
    ): Promise<JsonValue | undefined> {
        const url = buildApiUrl(this.serverUrl, path);
        const headers: CollaborationRequestHeaders = {
            Accept: "application/json",
            ...(options.headers ?? {}),
        };
        if (bearerCredential) {
            headers.Authorization = `Bearer ${bearerCredential}`;
        }
        const init: RequestInit = { method: options.method ?? "GET", headers, redirect: options.redirect };
        if (options.body !== undefined) {
            headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(options.body);
        }

        const secrets = [this.bearerCapability, this.accountToken].filter((credential) => credential !== undefined);
        let response;
        let text;
        try {
            response = await this.fetch(url, init);
            text = await response.text();
        } catch (error) {
            throw new CollaborationApiError(`Network failure calling ${url}: ${redactSecrets(error, secrets)}`, {
                secrets,
            });
        }

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

    /** Publish or recover the same Shared Space with the original encrypted request and request ID. */
    async replaySharedSpace(payload: CreateSharedSpacePayload, requestId: string) {
        try {
            return await this.sendJson(
                "/api/spaces/replay",
                {
                    method: "POST",
                    redirect: "error",
                    body: normalizeCreateSharedSpacePayload(payload),
                    headers: { [SHARED_SPACE_IDEMPOTENCY_HEADER]: requestId },
                },
                this.accountToken,
            );
        } catch (error) {
            if (error instanceof CollaborationApiError) {
                if (error.status === 404) throw new PlanServerUpgradeRequiredError();
                const payload = error.payload;
                if (
                    error.status === 410 &&
                    payload &&
                    typeof payload === "object" &&
                    !Array.isArray(payload) &&
                    payload.error === SHARED_SPACE_GONE_CODE
                )
                    throw new SharedSpaceGoneError();
            }
            throw error;
        }
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

function parseJsonOrUndefined(text: string): JsonValue | undefined {
    if (text.trim() === "") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function getErrorMessage(payload: JsonValue | undefined): string | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return typeof payload.message === "string" ? payload.message : undefined;
}

function redactPayload(payload: JsonValue, secrets: string[] | undefined): JsonValue {
    if (typeof payload === "string") return redactSecrets(payload, secrets);
    if (!payload || typeof payload !== "object") return payload;
    if (Array.isArray(payload)) return payload.map((item) => redactPayload(item, secrets));
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, redactPayload(value, secrets)]));
}
