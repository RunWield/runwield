import { type JsonRpcMessage, type McpTransport, parseJsonRpcMessage, StdioTransport } from "@earendil-works/pi-mcp";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio";
import { getHomeDir } from "../../constants.js";
import { type JsonMap, readPersonalMcpConfig } from "../mcp/config.ts";
import type { RemoteSettingsConnection } from "./settings-bridge.ts";

const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_BODY = MAX_MESSAGE + 4096;
const MAX_BUFFER = MAX_MESSAGE * 2;
const encoder = new TextEncoder();
const failure = () => new Error("Laptop MCP transport closed or unavailable.");

interface RelayRequest {
    name?: string;
    sequence?: number;
    message?: JsonRpcMessage;
}

async function readRequest(request: Request): Promise<RelayRequest> {
    const reader = request.body?.getReader();
    if (!reader) throw failure();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) throw failure();
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    const input: RelayRequest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw failure();
    return input;
}

interface LaptopTransport {
    transport?: StdioTransport;
    closed: boolean;
    sequence: number;
    queuedBytes: number;
    pending: Promise<void>;
    closing?: Promise<void>;
    stream?: ReadableStreamDefaultController<Uint8Array>;
    detach?: () => void;
}

/** One registry per authenticated SSH connection. It never discovers or converts MCP tools. */
export class LaptopMcpBridge {
    private readonly entries = new Map<string, LaptopTransport>();
    private closed = false;

    private closeEntry(entry: LaptopTransport): Promise<void> {
        if (entry.closing) return entry.closing;
        entry.closed = true;
        entry.detach?.();
        try {
            entry.stream?.error(failure());
        } catch {
            // The response consumer can cancel before process shutdown completes.
        }
        entry.stream = undefined;
        entry.closing = Promise.resolve().then(() => entry.transport?.close());
        return entry.closing;
    }

    async handle(request: Request, admitted: () => boolean): Promise<Response> {
        const match =
            /^\/mcp\/transport\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(open|send|close)$/.exec(
                new URL(request.url).pathname,
            );
        if (!match || request.method !== "POST") return new Response(null, { status: 404 });
        const [, id, action] = match;
        if (this.closed || !admitted()) return new Response(null, { status: 403 });
        let input: RelayRequest;
        try {
            input = await readRequest(request);
        } catch {
            return new Response(null, { status: 400 });
        }
        if (this.closed || !admitted() || request.signal.aborted) return new Response(null, { status: 403 });
        let entry = this.entries.get(id);
        if (action === "close") {
            if (Object.keys(input).length) return new Response(null, { status: 400 });
            if (!entry) {
                // Keep tombstones for this connection, including a close that overtakes open.
                if (this.entries.size >= 4096) return new Response(null, { status: 503 });
                entry = { closed: true, sequence: 0, queuedBytes: 0, pending: Promise.resolve() };
                this.entries.set(id, entry);
            }
            await this.closeEntry(entry);
            return new Response(null, { status: 204 });
        }
        if (action === "send") {
            if (!entry || entry.closed || !entry.transport) return new Response(null, { status: 409 });
            let message: JsonRpcMessage;
            try {
                if (Object.keys(input).sort().join(",") !== "message,sequence") throw failure();
                if (!Number.isSafeInteger(input.sequence) || input.sequence !== entry.sequence) throw failure();
                message = parseJsonRpcMessage(input.message);
                if (encoder.encode(JSON.stringify(message)).length > MAX_MESSAGE) throw failure();
            } catch {
                await this.closeEntry(entry);
                return new Response(null, { status: 409 });
            }
            const size = encoder.encode(JSON.stringify(message)).length;
            if (entry.queuedBytes + size > MAX_BUFFER) {
                await this.closeEntry(entry);
                return new Response(null, { status: 503 });
            }
            entry.queuedBytes += size;
            entry.sequence++;
            const current = entry;
            const send = current.pending
                .then(async () => {
                    if (this.closed || current.closed || !admitted() || request.signal.aborted) throw failure();
                    await current.transport!.send(message);
                })
                .finally(() => {
                    current.queuedBytes -= size;
                });
            current.pending = send.catch(() => {});
            try {
                await send;
                if (this.closed || current.closed || !admitted()) throw failure();
                return new Response(null, { status: 204 });
            } catch {
                await this.closeEntry(current);
                return new Response(null, { status: 503 });
            }
        }
        if (Object.keys(input).join(",") !== "name" || typeof input.name !== "string" || !input.name) {
            return new Response(null, { status: 400 });
        }
        if (entry || this.entries.size >= 4096) return new Response(null, { status: 409 });
        const current: LaptopTransport = { closed: false, sequence: 0, queuedBytes: 0, pending: Promise.resolve() };
        this.entries.set(id, current);
        const onAbort = () => void this.closeEntry(current);
        request.signal.addEventListener("abort", onAbort, { once: true });
        current.detach = () => request.signal.removeEventListener("abort", onAbort);
        try {
            const config = await readPersonalMcpConfig();
            if (this.closed || current.closed || !admitted() || request.signal.aborted) throw failure();
            const server = config.servers.find((server) => server.name === input.name);
            if (!server) throw failure();
            const transport = new StdioTransport({
                command: server.command,
                args: server.args,
                env: { ...getDefaultEnvironment(), ...server.env },
                inheritEnv: false,
                cwd: getHomeDir(),
                stderr: "pipe",
            });
            current.transport = transport;
            const stream = new ReadableStream<Uint8Array>(
                {
                    start: (controller) => (current.stream = controller),
                    cancel: () => this.closeEntry(current),
                },
                { highWaterMark: MAX_BUFFER, size: (chunk) => chunk?.byteLength ?? 0 },
            );
            transport.onMessage((message) => {
                if (current.closed) return;
                const bytes = encoder.encode(JSON.stringify(message) + "\n");
                if (bytes.length > MAX_MESSAGE + 1 || (current.stream?.desiredSize ?? 0) < bytes.length) {
                    void this.closeEntry(current);
                    return;
                }
                current.stream?.enqueue(bytes);
            });
            transport.onError(() => void this.closeEntry(current));
            transport.onClose(() => void this.closeEntry(current));
            await transport.start();
            if (this.closed || current.closed || !admitted() || request.signal.aborted) throw failure();
            // Flush response headers before Pi sends initialize. Blank lines are relay framing, not MCP messages.
            current.stream?.enqueue(encoder.encode("\n"));
            return new Response(stream, {
                headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
            });
        } catch {
            await this.closeEntry(current);
            return new Response(null, { status: 503 });
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
    }
}

let connection: RemoteSettingsConnection | undefined;
const clients = new Set<RemoteMcpTransport>();

/** Configure after handshake; clearing also closes all remote-owned transports. */
export function configureRemoteMcpConnection(value: RemoteSettingsConnection): () => Promise<void> {
    if (connection) throw new Error("Remote MCP connection already configured");
    connection = { ...value };
    return async () => {
        connection = undefined;
        await Promise.all([...clients].map((client) => client.close()));
    };
}

/** A Pi transport, not a tool API. Every failure ends this protocol lifetime; no sends are retried. */
export class RemoteMcpTransport implements McpTransport {
    private readonly id = crypto.randomUUID();
    private readonly connection: RemoteSettingsConnection;
    private readonly abort = new AbortController();
    private readonly messages = new Set<Parameters<McpTransport["onMessage"]>[0]>();
    private readonly errors = new Set<Parameters<McpTransport["onError"]>[0]>();
    private readonly closes = new Set<Parameters<McpTransport["onClose"]>[0]>();
    private sequence = 0;
    private queuedBytes = 0;
    private pending = Promise.resolve();
    private closed = false;
    private started = false;
    private closing?: Promise<void>;

    constructor(private readonly name: string) {
        if (!connection) throw failure();
        this.connection = { ...connection };
        clients.add(this);
    }

    onMessage(listener: Parameters<McpTransport["onMessage"]>[0]): () => void {
        this.messages.add(listener);
        return () => this.messages.delete(listener);
    }
    onError(listener: Parameters<McpTransport["onError"]>[0]): () => void {
        this.errors.add(listener);
        return () => this.errors.delete(listener);
    }
    onClose(listener: Parameters<McpTransport["onClose"]>[0]): () => void {
        this.closes.add(listener);
        return () => this.closes.delete(listener);
    }

    private async request(action: string, body: string, signal: AbortSignal): Promise<Response> {
        const response = await fetch(`http://127.0.0.1:${this.connection.port}/mcp/transport/${this.id}/${action}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.connection.credential}`, "Content-Type": "application/json" },
            body,
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw failure();
        }
        return response;
    }

    async start(): Promise<void> {
        if (this.started || this.closed) throw failure();
        this.started = true;
        const timer = setTimeout(() => this.abort.abort(), 10_000);
        try {
            const response = await this.request("open", JSON.stringify({ name: this.name }), this.abort.signal);
            if (this.closed || !response.body) throw failure();
            void this.receive(response.body);
        } catch {
            await this.fail();
            throw failure();
        } finally {
            clearTimeout(timer);
        }
    }

    private async receive(body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "";
        try {
            while (!this.closed) {
                const { value, done } = await reader.read();
                if (done) throw failure();
                buffer += decoder.decode(value, { stream: true });
                let newline: number;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (!line) continue;
                    if (encoder.encode(line).length > MAX_MESSAGE) throw failure();
                    const value: JsonMap = JSON.parse(line);
                    const message = parseJsonRpcMessage(value);
                    if (this.closed) return;
                    for (const listener of this.messages) listener(message);
                }
                if (encoder.encode(buffer).length > MAX_MESSAGE) throw failure();
            }
        } catch {
            if (!this.closed) await this.fail();
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    send(message: JsonRpcMessage): Promise<void> {
        if (!this.started || this.closed) return Promise.reject(failure());
        const size = encoder.encode(JSON.stringify(message)).length;
        if (size > MAX_MESSAGE || this.queuedBytes + size > MAX_BUFFER) {
            void this.fail();
            return Promise.reject(failure());
        }
        this.queuedBytes += size;
        const sequence = this.sequence++;
        const send = this.pending.then(async () => {
            if (this.closed) throw failure();
            await this.request(
                "send",
                JSON.stringify({ sequence, message }),
                AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
            );
        });
        this.pending = send
            .finally(() => {
                this.queuedBytes -= size;
            })
            .catch(async () => {
                await this.fail();
            });
        return send.catch(() => {
            throw failure();
        });
    }

    private async fail(): Promise<void> {
        if (this.closed) return;
        for (const listener of this.errors) listener(failure());
        await this.close();
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.abort.abort();
        clients.delete(this);
        this.closing = this.request("close", "{}", AbortSignal.timeout(4_000)).then(
            () => {},
            () => {},
        );
        for (const listener of this.closes) listener();
        return this.closing;
    }
}
