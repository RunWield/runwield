import type { APIContext } from "astro";
import type { RemoteWorkspaceAdapter } from "./remote-adapter.js";
import process from "node:process";
import { DEFAULT_REMOTE_MAX_REQUEST_BYTES, registerRemoteApiRoutes } from "../routes/remote-api.js";
import { openRemoteWorkspaceAdapter } from "./remote-adapter.js";
import { isRemoteDevelopmentModeEnabled } from "./remote-mode.ts";
import { isAstroDevelopmentMode } from "./astro-dev-mode.ts";

const REMOTE_DEV_APP_KEY = Symbol.for("runwield.workspace.remote-dev-app");
const REMOTE_DEV_DB_PATH_KEY = Symbol.for("runwield.workspace.remote-dev-db-path");
const REMOTE_DEV_CONFIG_KEY = Symbol.for("runwield.workspace.remote-dev-config");

type RemoteRouteParams = Record<string, string>;
interface RemoteDevRouterOptions {
    maxRequestBytes?: number;
}
interface RemoteDevRouteState extends RemoteDevRouterOptions {
    collaboration: RemoteWorkspaceAdapter;
}
interface RemoteDevRouteContext {
    req: Request;
    request: Request;
    url: URL;
    params: RemoteRouteParams | null;
    state: RemoteDevRouteState;
}
type RemoteDevRouteHandler = (context: RemoteDevRouteContext) => Response | Promise<Response>;
type RemoteDevRequestHandler = (request: Request) => Promise<Response>;
interface RemoteDevRoute {
    method: string;
    pattern: string;
    handler: RemoteDevRouteHandler;
}
interface RemoteDevApp {
    handler: RemoteDevRequestHandler;
    adapter: RemoteWorkspaceAdapter;
}
interface RemoteDevCache {
    [REMOTE_DEV_APP_KEY]?: RemoteDevApp;
    [REMOTE_DEV_DB_PATH_KEY]?: string;
    [REMOTE_DEV_CONFIG_KEY]?: string;
}
type RemoteDevRuntime = typeof globalThis & RemoteDevCache;

export async function handleRemoteSpaceApi(context: APIContext) {
    if (
        !isRemoteDevelopmentModeEnabled({
            isDevelopment: isAstroDevelopmentMode(),
            workspaceMode: process.env["RUNWIELD_WORKSPACE_MODE"],
        })
    ) {
        return Response.json({ error: "Not found" }, { status: 404 });
    }
    const app = getRemoteDevApp();
    return await app(context.request);
}

function getRemoteDevApp() {
    const runtime: RemoteDevRuntime = globalThis;
    const dbPath =
        process.env["RUNWIELD_REMOTE_DB_PATH"] || process.env["RUNWIELD_WORKSPACE_REMOTE_DB_PATH"] || undefined;
    const maxRequestBytes = parseMaxRequestBytes(process.env["RUNWIELD_REMOTE_MAX_REQUEST_BYTES"]);
    const retentionDays = parseRetentionDays(process.env["RUNWIELD_REMOTE_RETENTION_DAYS"]);
    const configKey = JSON.stringify({ dbPath, maxRequestBytes, retentionDays });
    if (
        !runtime[REMOTE_DEV_APP_KEY] ||
        runtime[REMOTE_DEV_DB_PATH_KEY] !== dbPath ||
        runtime[REMOTE_DEV_CONFIG_KEY] !== configKey
    ) {
        runtime[REMOTE_DEV_APP_KEY]?.adapter?.close?.();
        const adapter = openRemoteWorkspaceAdapter({ dbPath, retention: { days: retentionDays } });
        adapter.reconcileRetentionPolicy();
        adapter.cleanupExpiredSharedSpaces();
        const router = createRemoteDevRouter(adapter, { maxRequestBytes });
        runtime[REMOTE_DEV_APP_KEY] = { handler: router.handler(), adapter };
        runtime[REMOTE_DEV_DB_PATH_KEY] = dbPath;
        runtime[REMOTE_DEV_CONFIG_KEY] = configKey;
    }
    return runtime[REMOTE_DEV_APP_KEY].handler;
}

function createRemoteDevRouter(adapter: RemoteWorkspaceAdapter, options: RemoteDevRouterOptions = {}) {
    const routes: RemoteDevRoute[] = [];
    const add = (method: string, pattern: string, handler: RemoteDevRouteHandler) =>
        routes.push({ method, pattern, handler });
    const app = {
        get: (pattern: string, handler: RemoteDevRouteHandler) => add("GET", pattern, handler),
        post: (pattern: string, handler: RemoteDevRouteHandler) => add("POST", pattern, handler),
        handler: () => async (request: Request) => {
            const url = new URL(request.url);
            const route = routes.find(
                (candidate) => candidate.method === request.method && matchRoute(candidate.pattern, url.pathname),
            );
            if (!route) return Response.json({ error: "Not found" }, { status: 404 });
            return await route.handler({
                req: request,
                request,
                url,
                params: matchRoute(route.pattern, url.pathname),
                state: { collaboration: adapter, maxRequestBytes: options.maxRequestBytes },
            });
        },
    };
    registerRemoteApiRoutes(app);
    return app;
}

function matchRoute(pattern: string, pathname: string) {
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) return null;
    const params: RemoteRouteParams = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const patternPart = patternParts[index];
        const pathPart = pathParts[index];
        if (patternPart.startsWith(":")) params[patternPart.slice(1)] = decodeURIComponent(pathPart);
        else if (patternPart !== pathPart) return null;
    }
    return params;
}

function parseMaxRequestBytes(value: string | undefined) {
    if (value === undefined || value.trim() === "") return DEFAULT_REMOTE_MAX_REQUEST_BYTES;
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 100 * 1024 * 1024) {
        throw new Error("RUNWIELD_REMOTE_MAX_REQUEST_BYTES must be an integer from 1024 to 104857600.");
    }
    return bytes;
}

function parseRetentionDays(value: string | undefined) {
    if (value === undefined || value.trim() === "" || value.trim() === "0") return undefined;
    const days = Number(value);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
        throw new Error("RUNWIELD_REMOTE_RETENTION_DAYS must be a positive integer number of days, or 0/unset.");
    }
    return days;
}
