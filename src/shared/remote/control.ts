import { type HomeProjectOwner } from "@runwield/projects";
import {
    resolveManagedProjectStore,
    resolveManagedProjectIdentity,
    type ManagedProjectStoreLaunch,
} from "./project-store-launch.ts";
import { LaptopProjectStoreService } from "./project-store-service.ts";
import type { ProjectStoreBinding } from "@runwield/plans/project-store-wire";
import { handleBrowserOpen } from "./browser-bridge.ts";
import { serveHttp } from "../http-server.ts";
/* Connection-scoped local control and authenticated laptop model bridge. */

import { readPersonalMcpConfig } from "../mcp/config.ts";
import { LaptopMcpBridge } from "./mcp-bridge.ts";
import { USE_PROJECT_MEMORY } from "../memory-collection.ts";
import { LaptopMemoryService } from "./memory-service.ts";
import { createRunWieldModelRuntime } from "@runwield/pi-ai/models";
import { handleModelRequest, LocalModelBridge } from "@runwield/pi-ai/remote-models";
import type { SettingsUpdate } from "./settings-bridge.ts";
import { readSystemClipboardImage } from "../../ui/tui/clipboard.ts";
import { validateClipboardImage } from "./clipboard-bridge.ts";
import { MAX_SESSION_BYTES, type RemoteSessionRequest, validateSessionRequest } from "./session-protocol.ts";
import {
    getRemoteSessionOwner,
    releaseRemoteSessionOperation,
    type RemoteSessionOwner,
} from "../session/file-session-store.ts";
import { LaptopSessionControl, type LaptopSessionTarget } from "./laptop-session-control.ts";
import { type RemoteSessionControlRequest, validateSessionControlRequest } from "./session-protocol.ts";

import { applyLaptopGlobalSettingsUpdate, readLaptopGlobalSettingsSnapshot } from "../settings.ts";

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
        !request ||
        typeof request.id !== "string" ||
        !/^[a-f0-9]{32}$/.test(request.id) ||
        !request.update ||
        !record(request.update as JsonValue)
    )
        throw new Error("Invalid settings request");
    const update = request.update;
    if (update.kind === "set") {
        if (
            Object.keys(update).sort().join(",") !== "key,kind,value" ||
            !/^[a-zA-Z][a-zA-Z0-9]*$/.test(update.key) ||
            !validJson(update.value)
        ) {
            throw new Error("Invalid settings update");
        }
    } else if (update.kind === "model") {
        if (
            Object.keys(update).sort().join(",") !== "kind,model,provider" ||
            typeof update.model !== "string" ||
            typeof update.provider !== "string"
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
    /** Authenticated peer cleanup, not a laptop stop request. */
    remoteCleanupConfirmed: boolean;
    closed: boolean;
}

export interface RemoteControlService {
    readonly port: number;
    /** Send only in the first private SSH tty input line, after echo is disabled. */
    readonly credential: string;
    status(): RemoteControlStatus;
    /** Trusted laptop registration only. HTTP clients cannot supply writer proofs. */
    registerProjectStore(cwd: string | HomeProjectOwner): ProjectStoreBinding;
    unregisterProjectStore(): void;
    registerSessionOperation(operation: string): void;
    unregisterSessionOperation(operation: string): void;
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
export function startRemoteControlService(
    identity: RemoteControlIdentity,
    target?: LaptopSessionTarget,
    memoryCollection?: string,
    reviewOrigin = "",
    projectStoreLaunch?: ManagedProjectStoreLaunch,
): RemoteControlService {
    if (!validIdentity(identity)) throw new Error("Invalid remote control identity");
    const credential = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    let projectStore: LaptopProjectStoreService | undefined;
    let projectMutationsAdmitted = !projectStoreLaunch;
    const projectAdmissionAbort = new AbortController();
    let projectAdmission: Promise<ProjectStoreBinding> | undefined;
    let memory =
        memoryCollection && memoryCollection !== USE_PROJECT_MEMORY
            ? new LaptopMemoryService(memoryCollection)
            : undefined;
    let pendingMemory: Promise<void> | undefined;
    const mcp = new LaptopMcpBridge();
    let connected = false;
    let ready = false;
    let shutdown = false;
    let remoteCleanupConfirmed = false;
    let closed = false;
    let closing: Promise<void> | undefined;
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
    const sessionOwners = new Map<string, RemoteSessionOwner>();
    const sessions = target ? new LaptopSessionControl(target) : null;
    const stopSessions = () => {
        try {
            sessions?.close();
        } catch {
            /* Continue cleanup and release the listener. */
        }
        for (const operation of sessionOwners.keys()) {
            try {
                releaseRemoteSessionOperation(operation);
            } catch {
                /* Other operations must still be released. */
            }
            sessionOwners.delete(operation);
        }
    };
    const sessionControlHandler = async (request: Request): Promise<Response> => {
        if (!sessions || request.method !== "POST") return new Response(null, { status: 404 });
        let input: RemoteSessionControlRequest;
        try {
            const reader = request.body?.getReader();
            if (!reader) throw new Error("Missing Session control request");
            const bytes: number[] = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (bytes.length + value.length > 4096) {
                    await reader.cancel();
                    throw new Error("Large Session control request");
                }
                for (const byte of value) bytes.push(byte);
            }
            input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)));
            validateSessionControlRequest(input);
        } catch {
            return new Response(null, { status: 400 });
        }
        if (shutdown || closed || !ready) return new Response(null, { status: 403 });
        try {
            if (projectStoreLaunch && input.kind !== "markUncertain") {
                const identity = await resolveManagedProjectIdentity(
                    projectStoreLaunch,
                    projectAdmissionAbort.signal,
                    input.kind === "create",
                );
                if (shutdown || closed || !ready) return new Response(null, { status: 403 });
                if (input.kind === "create" && !identity) throw new Error("Remote Project identity is unavailable");
                sessions.bindProjectIdentity(identity);
            }
            const result = await sessions.handle(input);
            if (shutdown || closed || !ready) {
                stopSessions();
                return new Response(null, { status: 403 });
            }
            return Response.json(result);
        } catch {
            return new Response(null, { status: 409 });
        }
    };
    const sessionHandler = async (request: Request): Promise<Response> => {
        if (request.method !== "POST") return new Response(null, { status: 404 });
        let input: RemoteSessionRequest;
        try {
            const reader = request.body?.getReader();
            if (!reader) throw new Error("Missing Session request");
            const parts: Uint8Array[] = [];
            let size = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                // JSON escaping may expand the immutable JSONL string.
                if (size > MAX_SESSION_BYTES * 6 + 4096) {
                    await reader.cancel();
                    throw new Error("Session request too large");
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
            validateSessionRequest(input);
        } catch {
            return new Response(null, { status: 400 });
        }
        // Body reads are asynchronous: authority must be checked again after the last byte.
        if (shutdown || closed || !ready) return new Response(null, { status: 403 });
        try {
            const owner = sessionOwners.get(input.operation);
            if (owner) return Response.json(owner.handle(input));
            if (!sessions) throw new Error("Stale Session operation");
            return Response.json(await sessions.handleSave(input));
        } catch {
            return new Response(null, { status: 409 });
        }
    };
    let modelBridge: Promise<LocalModelBridge> | undefined;
    const getModelBridge = () => {
        if (!modelBridge) {
            const loading = createRunWieldModelRuntime()
                .then((runtime) => new LocalModelBridge(runtime))
                .catch((error) => {
                    if (modelBridge === loading) modelBridge = undefined;
                    throw error;
                });
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
            stopSessions();
            memory?.close();
            void mcp.close();
        }
    };
    const abort = new AbortController();
    const server = serveHttp(
        {
            hostname: "127.0.0.1",
            port: 0,
            signal: abort.signal,
            onListen() {},
            onError: () => new Response(null, { status: 503 }),
        },
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
                remoteCleanupConfirmed = true;
                shutdown = true;
                ready = false;
                stopModels();
                stopSessions();
                memory?.close();
                void mcp.close();
                return Response.json({ shutdown: true });
            }
            if (path === "/mcp/config") {
                if (shutdown || !ready) return new Response(null, { status: 403 });
                if (request.method !== "GET") return new Response(null, { status: 405 });
                try {
                    const config = await readPersonalMcpConfig();
                    if (shutdown || closed || !ready) return new Response(null, { status: 403 });
                    return Response.json({
                        servers: config.servers.map((server) => ({
                            name: server.name,
                            source: "global",
                            location: "laptop",
                            command: "",
                            args: [],
                            env: {},
                        })),
                        warnings: config.warnings.map((warning) => ({
                            source: warning.source,
                            stage: warning.stage,
                            message: "Personal MCP configuration could not be loaded.",
                        })),
                    });
                } catch {
                    return new Response(null, { status: 503 });
                }
            }
            if (path.startsWith("/mcp/transport/")) {
                return await mcp.handle(request, () => ready && !shutdown && !closed);
            }
            if (path === "/memory") {
                if (shutdown || closed || !ready) return new Response(null, { status: 403 });
                if (request.method !== "POST") return new Response(null, { status: 405 });
                if (!memory && memoryCollection === USE_PROJECT_MEMORY && projectStoreLaunch) {
                    pendingMemory ??= resolveManagedProjectIdentity(
                        projectStoreLaunch,
                        projectAdmissionAbort.signal,
                        false,
                    )
                        .then((verified) => {
                            if (verified && !shutdown && !closed && ready) {
                                memory = new LaptopMemoryService(verified.projectId, USE_PROJECT_MEMORY);
                            }
                        })
                        .finally(() => {
                            pendingMemory = undefined;
                        });
                    try {
                        await pendingMemory;
                    } catch {
                        return new Response(null, { status: shutdown || closed || !ready ? 403 : 503 });
                    }
                    if (shutdown || closed || !ready) return new Response(null, { status: 403 });
                    if (!memory) return new Response("Project admission required", { status: 409 });
                }
                return memory ? await memory.handle(request) : new Response(null, { status: 404 });
            }
            if (path === "/browser/open") {
                return await handleBrowserOpen(request, reviewOrigin, () => ready && !shutdown && !closed);
            }
            if (path === "/clipboard/image") {
                if (shutdown || !ready) return new Response(null, { status: 403 });
                if (request.method !== "GET") return new Response(null, { status: 405 });
                try {
                    const image = validateClipboardImage(await readSystemClipboardImage());
                    // Clipboard hardware access is asynchronous. Revocation discards its result.
                    if (shutdown || closed || !ready) return new Response(null, { status: 403 });
                    return Response.json(image);
                } catch {
                    return new Response(null, { status: 503 });
                }
            }
            if (path === "/project-store/inspect") {
                if (request.method !== "POST") return new Response(null, { status: 405 });
                if (!ready || shutdown || closed || !projectStoreLaunch) return new Response(null, { status: 403 });
                if ((await request.text()) !== "") return new Response(null, { status: 400 });
                if (projectStore) return Response.json(projectStore.binding);
                try {
                    const admission = await resolveManagedProjectStore(
                        projectStoreLaunch,
                        projectAdmissionAbort.signal,
                        false,
                    );
                    if (!ready || shutdown || closed) return new Response(null, { status: 403 });
                    if (!admission) return Response.json(null);
                    projectStore = new LaptopProjectStoreService(
                        admission.owner,
                        admission.execution,
                        projectStoreLaunch,
                        projectAdmissionAbort.signal,
                    );
                    return Response.json(projectStore.binding);
                } catch {
                    return new Response(null, { status: 409 });
                }
            }
            if (path === "/project-store/admit") {
                if (request.method !== "POST") return new Response(null, { status: 405 });
                if (!ready || shutdown || closed || !projectStoreLaunch) return new Response(null, { status: 403 });
                // The request selects no identity or path. Only the trusted launcher can admit its target.
                if ((await request.text()) !== "") return new Response(null, { status: 400 });
                if (!projectAdmission) {
                    projectAdmission = resolveManagedProjectStore(
                        projectStoreLaunch,
                        projectAdmissionAbort.signal,
                        true,
                    )
                        .then((admission) => {
                            if (!admission) throw new Error("Managed Project admission is unavailable.");
                            const { owner, execution } = admission;
                            if (!ready || shutdown || closed)
                                throw new Error("Managed connection closed during admission.");
                            projectStore = new LaptopProjectStoreService(
                                owner,
                                execution,
                                projectStoreLaunch,
                                projectAdmissionAbort.signal,
                            );
                            projectMutationsAdmitted = true;
                            return projectStore.binding;
                        })
                        .catch((error) => {
                            projectAdmission = undefined;
                            throw error;
                        });
                }
                try {
                    return Response.json(await projectAdmission);
                } catch {
                    return new Response(null, { status: 409 });
                }
            }
            if (path === "/project-store") {
                const selected = projectStore;
                if (!selected) return new Response(null, { status: 404 });
                return await selected.handle(
                    request,
                    () => ready && !shutdown && !closed && projectStore === selected,
                    projectMutationsAdmitted,
                );
            }
            if (path === "/session/control") {
                if (shutdown || !ready) return new Response(null, { status: 403 });
                return await sessionControlHandler(request);
            }
            if (path === "/session/request") {
                if (shutdown || !ready) return new Response(null, { status: 403 });
                return await sessionHandler(request);
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
        status: () => ({ connected, ready, shutdown, remoteCleanupConfirmed, closed }),
        registerProjectStore(cwd) {
            if (shutdown || closed || projectStore) throw new Error("Project store registration is unavailable.");
            projectStore = new LaptopProjectStoreService(cwd);
            return projectStore.binding;
        },
        unregisterProjectStore() {
            projectStore = undefined;
        },
        registerSessionOperation(operation) {
            const owner = getRemoteSessionOwner(operation);
            if (shutdown || closed || sessionOwners.has(operation)) {
                throw new Error("Remote Session owner cannot be registered");
            }
            sessionOwners.set(owner.operation, owner);
        },
        unregisterSessionOperation(operation) {
            try {
                releaseRemoteSessionOperation(operation);
            } finally {
                sessionOwners.delete(operation);
            }
        },
        requestShutdown() {
            projectAdmissionAbort.abort();
            shutdown = true;
            ready = false;
            stopModels();
            stopSessions();
            memory?.close();
            void mcp.close();
        },
        close() {
            if (closing) return closing;
            closed = true;
            shutdown = true;
            ready = false;
            if (timer !== undefined) clearInterval(timer);
            stopModels();
            stopSessions();
            memory?.close();
            closing = (async () => {
                await mcp.close();
                abort.abort();
                await server.finished;
            })();
            return closing;
        },
    };
}
