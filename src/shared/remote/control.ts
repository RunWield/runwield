import { serveHttp } from "../http-server.ts";
/* Connection-scoped local control and authenticated laptop model bridge. */

import { createRunWieldModelRuntime } from "../models/model-registry.ts";
import { handleModelRequest, LocalModelBridge } from "./model-bridge.ts";
import type { SettingsUpdate } from "./settings-bridge.ts";

import { applyLaptopGlobalSettingsUpdate, readLaptopGlobalSettingsSnapshot } from "../settings.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface UpdateRequest {
    id: string;
    update: SettingsUpdate;
}
interface UpdateReceipt {
    id: string;
    snapshot: string;
}

const MAX_BODY = 64 * 1024;

function record(value: JsonValue): value is { [key: string]: JsonValue } {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validJson(value: JsonValue): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(validJson);
    return record(value) && Object.values(value).every(validJson);
}

function validate(request: UpdateRequest): void {
    if (
        !request || typeof request.id !== "string" || !/^[a-f0-9]{32}$/.test(request.id) ||
        !request.update || !record(request.update as JsonValue)
    ) throw new Error("Invalid settings request");
    const update = request.update;
    if (update.kind === "set") {
        if (
            Object.keys(update).sort().join(",") !== "key,kind,value" ||
            !/^[a-zA-Z][a-zA-Z0-9]*$/.test(update.key) || !validJson(update.value)
        ) {
            throw new Error("Invalid settings update");
        }
    } else if (update.kind === "model") {
        if (
            Object.keys(update).sort().join(",") !== "kind,model,provider" ||
            typeof update.model !== "string" || typeof update.provider !== "string"
        ) {
            throw new Error("Invalid model update");
        }
    } else if (update.kind === "compaction") {
        if (
            Object.keys(update).sort().join(",") !== "key,kind,value" ||
            !["enabled", "reserveTokens", "keepRecentTokens"].includes(update.key) ||
            (update.key === "enabled"
                ? typeof update.value !== "boolean"
                : !Number.isSafeInteger(update.value) || Number(update.value) < 1)
        ) {
            throw new Error("Invalid compaction update");
        }
    } else throw new Error("Invalid settings update");
}

export interface RemoteControlStatus {
    connected: boolean;
    ready: boolean;
    shutdown: boolean;
    closed: boolean;
}

export interface RemoteControlService {
    readonly port: number;
    /** Send only in the first private SSH tty input line, after echo is disabled. */
    readonly credential: string;
    status(): RemoteControlStatus;
    requestShutdown(): void;
    close(): Promise<void>;
}

export interface RemoteControlIdentity {
    buildId: string;
    protocol: number;
}

const PERIOD_MS = 5_000;
const encoder = new TextEncoder();

function validIdentity(identity: RemoteControlIdentity): boolean {
    return /^[a-f0-9]{64}$/.test(identity.buildId) && Number.isInteger(identity.protocol) && identity.protocol >= 0;
}

function equalSecret(left: string, right: string): boolean {
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    let difference = a.length ^ b.length;
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
    }
    return difference === 0;
}

/** Start a fresh, loopback-only listener. The launcher must close it in its finally block. */
export function startRemoteControlService(identity: RemoteControlIdentity): RemoteControlService {
    if (!validIdentity(identity)) throw new Error("Invalid remote control identity");
    const credential = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, "0"),
    )
        .join("");
    let connected = false;
    let ready = false;
    let shutdown = false;
    let closed = false;
    let seenSinceCheck = false;
    let misses = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    /** Each service owns its replay history; do not reuse acknowledgements across connections. */
    const receipts = new Map<string, { payload: string; receipt: UpdateReceipt }>();
    const settingsHandler = async (request: Request, path: string): Promise<Response> => {
        if (request.method === "GET" && path === "/settings/snapshot") {
            return Response.json({ snapshot: readLaptopGlobalSettingsSnapshot() });
        }
        if (request.method === "GET" && path.startsWith("/settings/receipt/")) {
            const receipt = receipts.get(path.slice("/settings/receipt/".length))?.receipt;
            return receipt ? Response.json(receipt) : new Response(null, { status: 404 });
        }
        if (request.method !== "POST" || path !== "/settings/update") return new Response(null, { status: 404 });
        let input: UpdateRequest;
        try {
            const reader = request.body?.getReader();
            if (!reader) throw new Error("Missing settings request");
            const parts: Uint8Array[] = [];
            let size = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > MAX_BODY) {
                    await reader.cancel();
                    throw new Error("Settings request too large");
                }
                parts.push(value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) {
                bytes.set(part, offset);
                offset += part.length;
            }
            input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            validate(input);
        } catch {
            return new Response(null, { status: 400 });
        }
        if (shutdown || closed || !ready) return new Response(null, { status: 403 });
        const payload = JSON.stringify(input.update);
        const old = receipts.get(input.id);
        if (old) return old.payload === payload ? Response.json(old.receipt) : new Response(null, { status: 409 });
        try {
            const snapshot = applyLaptopGlobalSettingsUpdate(input.update);
            const receipt = { id: input.id, snapshot };
            receipts.set(input.id, { payload, receipt });
            return Response.json(receipt);
        } catch {
            return new Response(null, { status: 503 });
        }
    };
    let modelBridge: Promise<LocalModelBridge> | undefined;
    const getModelBridge = () => {
        if (!modelBridge) {
            const loading = createRunWieldModelRuntime().then((runtime) => new LocalModelBridge(runtime)).catch(
                (error) => {
                    if (modelBridge === loading) modelBridge = undefined;
                    throw error;
                },
            );
            modelBridge = loading;
        }
        return modelBridge;
    };
    const stopModels = () => {
        void modelBridge?.then((bridge) => bridge.close()).catch(() => {});
    };
    const checkHealth = () => {
        if (shutdown) return;
        misses = seenSinceCheck ? 0 : misses + 1;
        seenSinceCheck = false;
        if (misses >= 3) {
            shutdown = true;
            ready = false;
            stopModels();
        }
    };
    const abort = new AbortController();
    const server = serveHttp(
        { hostname: "127.0.0.1", port: 0, signal: abort.signal, onListen() {} },
        async (request) => {
            if (closed || !equalSecret(request.headers.get("Authorization") ?? "", `Bearer ${credential}`)) {
                return new Response(null, { status: 401 });
            }
            const path = new URL(request.url).pathname;
            if (request.method === "POST" && path === "/handshake") {
                let received: RemoteControlIdentity;
                try {
                    const reader = request.body?.getReader();
                    if (!reader) throw new Error("Missing identity");
                    const parts: Uint8Array[] = [];
                    let size = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        size += value.length;
                        if (size > 4096) {
                            await reader.cancel();
                            throw new Error("Large identity");
                        }
                        parts.push(value);
                    }
                    const bytes = new Uint8Array(size);
                    let offset = 0;
                    for (const part of parts) {
                        bytes.set(part, offset);
                        offset += part.length;
                    }
                    received = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
                } catch {
                    return new Response(null, { status: 400 });
                }
                if (!received || received.buildId !== identity.buildId || received.protocol !== identity.protocol) {
                    return new Response(null, { status: 409 });
                }
                if (shutdown) return Response.json({ shutdown: true });
                connected = true;
                seenSinceCheck = false;
                misses = 0;
                if (timer !== undefined) clearInterval(timer);
                timer = setInterval(checkHealth, PERIOD_MS);
                return Response.json({ shutdown: false });
            }
            if (!connected) return new Response(null, { status: 403 });
            if (request.method === "POST" && path === "/readiness") {
                if (!shutdown) ready = true;
                return Response.json({ shutdown });
            }
            if (request.method === "POST" && path === "/health") {
                if (!shutdown) seenSinceCheck = true;
                return Response.json({ shutdown });
            }
            if (request.method === "POST" && path === "/shutdown") {
                shutdown = true;
                ready = false;
                stopModels();
                return Response.json({ shutdown: true });
            }
            if (path.startsWith("/settings/")) {
                if (shutdown || !ready) return new Response(null, { status: 403 });
                try {
                    return await settingsHandler(request, path);
                } catch {
                    return new Response(null, { status: 503 });
                }
            }
            if (path.startsWith("/models/")) {
                if (shutdown || !ready) return new Response(null, { status: 403 });
                try {
                    const bridge = await getModelBridge();
                    if (shutdown || closed) return new Response(null, { status: 403 });
                    return await handleModelRequest(bridge, request, path);
                } catch {
                    return new Response(null, { status: 503 });
                }
            }
            return new Response(null, { status: 404 });
        },
    );
    const address = server.addr;
    if (address.transport !== "tcp" || address.hostname !== "127.0.0.1") {
        server.shutdown();
        throw new Error("Remote control is not bound to loopback");
    }
    return {
        port: address.port,
        credential,
        status: () => ({ connected, ready, shutdown, closed }),
        requestShutdown() {
            shutdown = true;
            ready = false;
            stopModels();
        },
        async close() {
            if (closed) return;
            closed = true;
            shutdown = true;
            ready = false;
            if (timer !== undefined) clearInterval(timer);
            stopModels();
            abort.abort();
            await server.finished;
        },
    };
}
