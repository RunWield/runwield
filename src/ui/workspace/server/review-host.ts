/** One lazy listener for token-scoped reviews and document readers in this process. */
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
        listener ??= serveHttp({ hostname: "127.0.0.1", port: 0, automaticCompression: true, onListen() {} }, dispatch);
        const origin = `http://127.0.0.1:${listener.addr.port}`;
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
