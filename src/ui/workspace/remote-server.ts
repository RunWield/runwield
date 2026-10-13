import { serveHttp } from "../../shared/http-server.ts";
import process from "node:process";
import { mkdir as fsMkdir } from "node:fs/promises";
/**
 * Self-hosted remote Workspace Plan Server entry point.
 *
 * This process starts only remote Shared Space mode. It has no local checkout
 * Plan Board authority and stores remote Shared Space state in SQLite.
 */

import { dirname } from "node:path";
import { DEFAULT_REMOTE_MAX_REQUEST_BYTES } from "./routes/remote-api.js";
import { createRemoteWorkspaceApp } from "./server.js";

export const DEFAULT_REMOTE_HOST = "0.0.0.0";
export const DEFAULT_REMOTE_PORT = 8080;
export const DEFAULT_REMOTE_DB_PATH = "/data/runwield-shared-spaces.sqlite";
export const REMOTE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface RemoteServerConfig {
    host: string;
    port: number;
    dbPath: string;
    maxRequestBytes: number;
    retentionDays: number | undefined;
}

export interface RemoteServerClock {
    setInterval(callback: () => void, delay: number): number;
    clearInterval(timer: number): void;
}

export type RemoteServerLogger = (...messages: string[]) => void;

export const SYSTEM_REMOTE_SERVER_CLOCK: RemoteServerClock = Object.freeze({
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
});

export function parsePort(value: string | undefined, fallback = DEFAULT_REMOTE_PORT): number {
    if (value === undefined || value.trim() === "") return fallback;
    const port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Remote Workspace port must be an integer from 1 to 65535; received ${value}.`);
    }
    return port;
}

export function parseMaxRequestBytes(
    value: string | undefined,
    fallback = DEFAULT_REMOTE_MAX_REQUEST_BYTES,
): number {
    if (value === undefined || value.trim() === "") return fallback;
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 100 * 1024 * 1024) {
        throw new Error("RUNWIELD_REMOTE_MAX_REQUEST_BYTES must be an integer from 1024 to 104857600.");
    }
    return bytes;
}

export function parseRetentionDays(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === "" || value.trim() === "0") return undefined;
    const days = Number(value);
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
        throw new Error("RUNWIELD_REMOTE_RETENTION_DAYS must be a positive integer number of days, or 0/unset.");
    }
    return days;
}

interface ServerEnvironment {
    get(name: string): string | undefined;
}

export function readRemoteServerConfig(env: ServerEnvironment): RemoteServerConfig {
    return {
        host: env.get("RUNWIELD_REMOTE_HOST") || env.get("HOST") || DEFAULT_REMOTE_HOST,
        port: parsePort(env.get("RUNWIELD_REMOTE_PORT") || env.get("PORT"), DEFAULT_REMOTE_PORT),
        dbPath: env.get("RUNWIELD_REMOTE_DB_PATH") || env.get("RUNWIELD_WORKSPACE_REMOTE_DB_PATH") ||
            DEFAULT_REMOTE_DB_PATH,
        maxRequestBytes: parseMaxRequestBytes(env.get("RUNWIELD_REMOTE_MAX_REQUEST_BYTES")),
        retentionDays: parseRetentionDays(env.get("RUNWIELD_REMOTE_RETENTION_DAYS")),
    };
}

function installShutdownHandlers(controller: AbortController): () => void {
    const handler = () => controller.abort();
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    for (const signal of signals) process.on(signal, handler);
    return () => {
        for (const signal of signals) process.off(signal, handler);
    };
}

/**
 * Run the complete remote Workspace stack until the supplied process signal
 * aborts it. The adapter and HTTP server are RunWield machinery; only the
 * process clock and log sink are supplied capabilities.
 */
export async function runRemoteWorkspaceServer(
    config: RemoteServerConfig,
    signal: AbortSignal,
    clock: RemoteServerClock,
    log: RemoteServerLogger,
): Promise<void> {
    let cleanupTimer: number | undefined;
    let adapter: ReturnType<typeof createRemoteWorkspaceApp>["adapter"] | undefined;

    try {
        await fsMkdir(dirname(config.dbPath), { recursive: true });
        const app = createRemoteWorkspaceApp({
            mode: "remote",
            dbPath: config.dbPath,
            maxRequestBytes: config.maxRequestBytes,
            retentionDays: config.retentionDays,
        });
        adapter = app.adapter;
        adapter.reconcileRetentionPolicy();
        const deleted = adapter.cleanupExpiredSharedSpaces();
        if (deleted > 0) log(`[RunWield] Removed ${deleted} expired Shared Space(s) at startup.`);
        if (config.retentionDays) {
            cleanupTimer = clock.setInterval(() => {
                try {
                    const count = adapter?.cleanupExpiredSharedSpaces() ?? 0;
                    if (count > 0) log(`[RunWield] Removed ${count} expired Shared Space(s).`);
                } catch (error) {
                    console.error(
                        `[RunWield] Expired Shared Space cleanup failed: ${
                            error instanceof Error ? error.message : error
                        }`,
                    );
                }
            }, REMOTE_CLEANUP_INTERVAL_MS);
        }
        const server = serveHttp({
            hostname: config.host,
            port: config.port,
            signal,
            automaticCompression: true,
        }, app.handler());
        const actualPort = server.addr.port;
        log(`[RunWield] Remote Workspace Plan Server listening on http://${config.host}:${actualPort}`);
        log(`[RunWield] SQLite database: ${config.dbPath}`);
        log(`[RunWield] Request body limit: ${config.maxRequestBytes} bytes`);
        log(`[RunWield] Inactivity retention: ${config.retentionDays ? `${config.retentionDays} day(s)` : "disabled"}`);
        log("[RunWield] Configure planServerUrl or pass --plan-server with the externally reachable Plan Server URL.");
        await server.finished;
    } finally {
        if (cleanupTimer !== undefined) clock.clearInterval(cleanupTimer);
        adapter?.close();
    }
}

export async function main(): Promise<void> {
    const controller = new AbortController();
    const removeShutdownHandlers = installShutdownHandlers(controller);
    try {
        await runRemoteWorkspaceServer(
            readRemoteServerConfig({ get: (name) => process.env[name] }),
            controller.signal,
            SYSTEM_REMOTE_SERVER_CLOCK,
            console.log,
        );
    } finally {
        removeShutdownHandlers();
    }
}

if (import.meta.main) await main();
