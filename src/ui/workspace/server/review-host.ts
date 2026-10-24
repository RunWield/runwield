/** One lazy listener for token-scoped reviews and document readers in this process. */
import { unlinkSync } from "node:fs";
import { PLAN_UI_TOKEN_HEADER, PLAN_UI_TOKEN_QUERY } from "../../../constants.js";
import { type HttpHandler, type HttpServer, serveHttp } from "../../../shared/http-server.ts";
import { isPublicWorkspaceAsset } from "./public-workspace-assets.ts";

export interface ReviewHostRegistration {
    readonly origin: string;
    release(): Promise<void>;
}

interface RegistrationOptions {
    onError(error: Error): Response | Promise<Response>;
}

interface ReviewApp extends RegistrationOptions {
    handler: HttpHandler;
}

const registrations = new Map<string, ReviewApp>();
let listener: HttpServer | null = null;
export interface RemoteReviewHostConfig {
    socketPath: string;
    origin: string;
}
let remoteHost: RemoteReviewHostConfig | null = null;

/** Select the process bind target before the first review starts. */
export function configureRemoteReviewHost(config: RemoteReviewHostConfig): () => void {
    if (listener || remoteHost) throw new Error("Review host is already configured or listening.");
    validateRemoteReviewHostConfig(config);
    remoteHost = { ...config };
    return () => {
        remoteHost = null;
    };
}

/** Validate bootstrap data without selecting a listener or importing the Workspace. */
export function validateRemoteReviewHostConfig(config: RemoteReviewHostConfig): void {
    if (!config || typeof config.socketPath !== "string" || typeof config.origin !== "string") {
        throw new Error("Invalid remote review host configuration.");
    }
    if (
        !/^\/tmp\/wld-remote-[a-f0-9]{32}\/review\.sock$/.test(config.socketPath) ||
        !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(config.origin) ||
        Number(new URL(config.origin).port) > 65535
    ) {
        throw new Error("Invalid remote review host configuration.");
    }
}

async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let refererToken: string | null = null;
    try {
        const referer = request.headers.get("referer");
        if (referer) refererToken = new URL(referer).searchParams.get(PLAN_UI_TOKEN_QUERY);
    } catch {
        // A malformed Referer supplies no token; other sources can still authorize.
    }
    const tokens = [
        url.searchParams.get(PLAN_UI_TOKEN_QUERY),
        request.headers.get(PLAN_UI_TOKEN_HEADER),
        request.headers.get("x-runwield-review-token"),
        refererToken,
    ];
    let app: ReviewApp | undefined;
    for (const token of tokens) {
        if (token !== null) app = registrations.get(token);
        if (app) break;
    }
    if (!app && isPublicWorkspaceAsset(url.pathname)) app = registrations.values().next().value;
    if (!app) {
        return new Response("Review token required.", { status: 401, headers: { "cache-control": "no-store" } });
    }
    try {
        return await app.handler(request);
    } catch (error) {
        return app.onError(error instanceof Error ? error : new Error(String(error)));
    }
}

export const reviewHost = {
    register(token: string, handler: HttpHandler, options: RegistrationOptions): ReviewHostRegistration {
        if (registrations.has(token)) throw new Error("Review token is already registered.");
        if (!listener) {
            if (remoteHost) {
                try {
                    unlinkSync(remoteHost.socketPath);
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                }
            }
            listener = serveHttp(
                {
                    ...(remoteHost ? { unix: remoteHost.socketPath } : { hostname: "127.0.0.1", port: 0 }),
                    automaticCompression: true,
                    onListen() {},
                },
                dispatch,
            );
        }
        const origin = remoteHost?.origin ?? `http://127.0.0.1:${listener.addr.port}`;
        registrations.set(token, { handler, ...options });
        let released: Promise<void> | null = null;
        return {
            origin,
            release() {
                if (released) return released;
                registrations.delete(token);
                if (registrations.size === 0) {
                    const draining = listener!;
                    listener = null;
                    released = draining.shutdown();
                } else {
                    released = Promise.resolve();
                }
                return released;
            },
        };
    },
};
