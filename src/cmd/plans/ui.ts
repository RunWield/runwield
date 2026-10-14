import process from "node:process";
/**
 * @module cmd/plans/ui
 * Secure local Workspace launcher for read-only Plan UI.
 */

import {
    getCwd,
    PLAN_UI_COMMAND_LABEL,
    PLAN_UI_DEFAULT_HOST,
    PLAN_UI_DEFAULT_PORT,
    PLAN_UI_TOKEN_QUERY,
} from "../../constants.js";
import type { BrowserPort } from "../../shared/browser-port.ts";
import { startWorkspaceServer } from "../../ui/workspace/server.js";

interface PlansUiOptions {
    host: string;
    port: number;
    noOpen: boolean;
    help: boolean;
    explicitBind: boolean;
}

interface PlansUiCommandOptions {
    browser: BrowserPort;
    signal?: AbortSignal;
}

export function isLoopbackHost(value: string): boolean {
    const host = String(value || "").trim().toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function parsePort(value: string | number): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid --port value "${value}". Expected an integer from 0 to 65535.`);
    }
    return port;
}

export function parsePlansUiArgs(argv: string[]): PlansUiOptions {
    const options: PlansUiOptions = {
        host: PLAN_UI_DEFAULT_HOST,
        port: PLAN_UI_DEFAULT_PORT,
        noOpen: false,
        help: false,
        explicitBind: false,
    };
    let bindValue: string | undefined;
    let hostValue: string | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help" || arg === "-h") {
            options.help = true;
            continue;
        }
        if (arg === "--no-open") {
            options.noOpen = true;
            continue;
        }
        if (arg === "--bind" || arg === "--host") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) throw new Error(`${arg} requires a host value.`);
            if (arg === "--bind") bindValue = value;
            else hostValue = value;
            index += 1;
            continue;
        }
        if (arg.startsWith("--bind=")) {
            bindValue = arg.slice("--bind=".length);
            continue;
        }
        if (arg.startsWith("--host=")) {
            hostValue = arg.slice("--host=".length);
            continue;
        }
        if (arg === "--port") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) throw new Error("--port requires a numeric value.");
            options.port = parsePort(value);
            index += 1;
            continue;
        }
        if (arg.startsWith("--port=")) {
            options.port = parsePort(arg.slice("--port=".length));
            continue;
        }
        throw new Error(`Unknown ${PLAN_UI_COMMAND_LABEL} option: ${arg}`);
    }

    if (bindValue && hostValue && bindValue !== hostValue) {
        throw new Error(`Conflicting --bind and --host values: "${bindValue}" and "${hostValue}".`);
    }

    const explicitHost = bindValue || hostValue;
    if (explicitHost) {
        options.host = explicitHost;
        options.explicitBind = true;
    }
    if (!options.explicitBind && !isLoopbackHost(options.host)) {
        throw new Error("Non-loopback bind requires an explicit --bind or --host value.");
    }
    return options;
}

export function generateWorkspaceToken(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface PlansUiUrlOptions {
    host: string;
    port: number;
    token: string;
    path?: string;
}

export function buildPlansUiUrl({ host, port, token, path = "/" }: PlansUiUrlOptions): string {
    const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const bracketedHost = urlHost.includes(":") && !urlHost.startsWith("[") ? `[${urlHost}]` : urlHost;
    const url = new URL(`http://${bracketedHost}:${port}${path}`);
    url.searchParams.set(PLAN_UI_TOKEN_QUERY, token);
    return url.href;
}

export function printPlansUiHelp(): void {
    console.log("Usage: wld plans ui [--bind <host>|--host <host>] [--port <port>] [--no-open] [--help]");
    console.log("Starts the local read-only Workspace board for Plans in the current checkout.");
    console.log("Defaults: --bind 127.0.0.1 --port 0 (random available port).");
}

function installShutdownHandler(controller: AbortController): () => void {
    const handler = () => controller.abort();
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
}

export async function runPlansUiCommand(argv: string[], options: PlansUiCommandOptions): Promise<void> {
    let parsed: PlansUiOptions;
    try {
        parsed = parsePlansUiArgs(argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[RunWield] ${message}`);
        console.error("Run 'wld plans ui --help' for usage.");
        return;
    }

    if (parsed.help) {
        printPlansUiHelp();
        return;
    }

    if (!isLoopbackHost(parsed.host)) {
        console.warn(
            `[RunWield] Warning: binding Workspace to ${parsed.host}. Plan markdown may contain sensitive local plaintext; only expose this server on trusted networks.`,
        );
    }

    const controller = new AbortController();
    const removeShutdownHandler = installShutdownHandler(controller);
    const abortFromExternalSignal = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", abortFromExternalSignal, { once: true });

    try {
        const token = generateWorkspaceToken();
        const server = startWorkspaceServer({
            cwd: getCwd(),
            host: parsed.host,
            port: parsed.port,
            token,
            signal: controller.signal,
        });
        try {
            const url = buildPlansUiUrl({ host: parsed.host, port: server.addr.port, token });
            console.log(`[RunWield] Workspace: ${url}`);
            if (!parsed.noOpen) await options.browser.open(url);
            await server.finished;
        } finally {
            controller.abort();
            await server.finished.catch(() => {});
        }
    } finally {
        options.signal?.removeEventListener("abort", abortFromExternalSignal);
        removeShutdownHandler();
    }
}
