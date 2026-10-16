/**
 * @module cmd/workspace/serve
 * Persistent owner Workspace launcher.
 */

import process, { platform } from "node:process";
import { parseArgs } from "../../shared/cli-args.ts";
import { CLI_BIN } from "../../constants.js";
import { getOwnerCoordinationDatabasePath, openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { isLoopbackHost, parsePort } from "../plans/ui.ts";
import { SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";

export const WORKSPACE_DEFAULT_HOST = "127.0.0.1";
export const WORKSPACE_DEFAULT_PORT = 8787;

export interface WorkspaceServeOptions {
    host: string;
    port: number;
    publicOrigin: string;
    trustTlsTerminator: boolean;
    noOpen: boolean;
    help: boolean;
}

export function normalizePublicOrigin(value: string): string {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("--public-origin must be an origin only, with no path, query, or fragment.");
    }
    return url.origin;
}

export function parseWorkspaceServeArgs(argv: string[]): WorkspaceServeOptions {
    const parsed = parseArgs(argv, {
        boolean: ["help", "no-open", "trust-tls-terminator"],
        string: ["bind", "host", "port", "public-origin"],
        alias: { h: "help" },
    });
    const explicitHost = parsed.bind || parsed.host;
    const host = String(explicitHost || WORKSPACE_DEFAULT_HOST);
    const port = parsed.port === undefined ? WORKSPACE_DEFAULT_PORT : parsePort(String(parsed.port));
    const trustTlsTerminator = Boolean(parsed["trust-tls-terminator"]);
    const defaultOrigin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    const publicOrigin = normalizePublicOrigin(String(parsed["public-origin"] || defaultOrigin));
    if (!isLoopbackHost(host)) {
        if (!trustTlsTerminator) {
            throw new Error(
                "Non-loopback owner Workspace bind requires --trust-tls-terminator and --public-origin https://...",
            );
        }
        if (!publicOrigin.startsWith("https://")) {
            throw new Error("Non-loopback owner Workspace public origin must use https://.");
        }
    }
    return {
        host,
        port,
        publicOrigin,
        trustTlsTerminator,
        noOpen: Boolean(parsed["no-open"]),
        help: Boolean(parsed.help),
    };
}

export function printWorkspaceServeHelp(): void {
    console.log(
        `Usage: ${CLI_BIN} workspace serve [--bind <host>|--host <host>] [--port <port>] [--public-origin <origin>] [--trust-tls-terminator] [--no-open]`,
    );
    console.log("Starts the persistent owner Workspace using the owner coordination database.");
    console.log("Defaults: --bind 127.0.0.1 --port 8787.");
    console.log(
        "Phone access: keep RunWield private, expose it through Tailscale/WireGuard or another trusted HTTPS terminator.",
    );
    console.log(
        `Example: ${CLI_BIN} workspace serve --bind 127.0.0.1 --port 8787 --public-origin https://<tailnet-host> --no-open`,
    );
    console.log("Direct non-loopback serving requires --trust-tls-terminator and an https:// public origin.");
}

function installShutdownHandlers(controller: AbortController): () => void {
    const handler = () => controller.abort();
    const signals: NodeJS.Signals[] = platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
    for (const signal of signals) process.on(signal, handler);
    return () => {
        for (const signal of signals) process.off(signal, handler);
    };
}

export async function runWorkspaceServeCommand(argv: string[]): Promise<void> {
    let parsed: WorkspaceServeOptions;
    try {
        parsed = parseWorkspaceServeArgs(argv);
    } catch (error) {
        console.error(`[RunWield] ${error instanceof Error ? error.message : String(error)}`);
        console.error(`Run '${CLI_BIN} workspace serve --help' for usage.`);
        return;
    }
    if (parsed.help) {
        printWorkspaceServeHelp();
        return;
    }

    const controller = new AbortController();
    const removeShutdownHandlers = installShutdownHandlers(controller);
    const store = openOwnerCoordinationStore();
    try {
        const { startWorkspaceServer } = await import("../../ui/workspace/server.js");
        const server = startWorkspaceServer({
            mode: "owner",
            host: parsed.host,
            port: parsed.port,
            publicOrigin: parsed.publicOrigin,
            trustTlsTerminator: parsed.trustTlsTerminator,
            store,
            signal: controller.signal,
        });
        const shutdownOnAbort = () => {
            void server.shutdown().catch(() => {});
        };
        controller.signal.addEventListener("abort", shutdownOnAbort, { once: true });
        try {
            const url = parsed.publicOrigin;
            console.log(`[RunWield] Owner Workspace: ${url}`);
            console.log(`[RunWield] Owner database: ${store.path || getOwnerCoordinationDatabasePath()}`);
            if (!parsed.noOpen) await SYSTEM_BROWSER_PORT.open(url);
            await server.finished;
        } finally {
            controller.signal.removeEventListener("abort", shutdownOnAbort);
        }
    } finally {
        removeShutdownHandlers();
        store.close();
    }
}
