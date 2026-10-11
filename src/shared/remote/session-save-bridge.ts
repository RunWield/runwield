import {
    MAX_SESSION_BYTES,
    type RemoteSessionConnection,
    type RemoteSessionRequest,
    type RemoteSessionResponse,
    sessionDigest,
    validateSessionRequest,
} from "./session-protocol.ts";

/** Strict synchronous saves. A dedicated Worker owns network progress; each request has its own shared slot. */
export class RemoteSessionSaveBridge {
    #connection: RemoteSessionConnection;
    #sequence = 0;
    #failure: Error | null = null;
    #closed = false;
    #fault = new SharedArrayBuffer(4);
    #abort = new AbortController();
    #worker: Worker;
    #savedContents: string | null = null;

    constructor(connection: RemoteSessionConnection) {
        const url = new URL(connection.baseUrl);
        const timeoutMs = connection.timeoutMs ?? 5_000;
        if (
            url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
            url.pathname !== "/" || url.search || url.hash || url.username || url.password ||
            !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
            !connection.credential || !connection.operation
        ) throw new Error("Invalid remote Session bridge connection");
        this.#connection = { ...connection, baseUrl: url.origin, timeoutMs };
        this.#worker = new Worker(new URL("./session-save-worker.ts", import.meta.url).href, { type: "module" });
        this.#worker.onerror = (event) => {
            event.preventDefault();
            Atomics.store(new Int32Array(this.#fault), 0, 1);
        };
    }

    get signal(): AbortSignal {
        return this.#abort.signal;
    }

    assertHealthy(): void {
        if (!this.#failure && Atomics.load(new Int32Array(this.#fault), 0)) {
            this.fail(new Error("Remote Session save Worker failed; discard the manager and recover laptop evidence"));
        }
        if (this.#failure) throw this.#failure;
        if (this.#closed) throw new Error("Remote Session bridge is closed");
    }

    /** Also used by the root Proxy when a recorder swallows an error. Failure never resets. */
    fail(error: Error): never {
        this.#failure ??= error;
        this.#abort.abort(this.#failure);
        throw this.#failure;
    }

    /** Guard the actual model, tool and prompt boundaries, including cached Pi state. */
    bindAgentSession(session: import("@earendil-works/pi-coding-agent").AgentSession): void {
        this.assertHealthy();
        const stream = session.agent.streamFunction;
        session.agent.streamFunction = (model, context, options) => {
            this.assertHealthy();
            return stream(model, context, options);
        };
        const beforeTool = session.agent.beforeToolCall;
        session.agent.beforeToolCall = async (context, signal) => {
            this.assertHealthy();
            const result = await beforeTool?.(context, signal);
            this.assertHealthy();
            return result;
        };
        session.agent.subscribe(() => this.assertHealthy());
        this.signal.addEventListener("abort", () => session.agent.abort(), { once: true });
        const prompt = session.prompt.bind(session);
        session.prompt = async (text, options) => {
            this.assertHealthy();
            await prompt(text, options);
            this.assertHealthy();
        };
    }

    request(kind: RemoteSessionRequest["kind"], contents = ""): RemoteSessionResponse {
        this.assertHealthy();
        const input: RemoteSessionRequest = {
            operation: this.#connection.operation,
            sequence: this.#sequence,
            kind,
            contents,
        };
        try {
            validateSessionRequest(input);
            // Attachment reads carry at most MAX_SESSION_BYTES raw bytes, expanded to base64 plus envelope.
            const capacity = kind === "hydrate" || kind === "inspect"
                ? MAX_SESSION_BYTES * 6 + 4096
                : kind === "attachment-read"
                ? Math.ceil(MAX_SESSION_BYTES / 3) * 4 + 4096
                : kind === "attachment"
                ? new TextEncoder().encode(contents).length * 6 + 4096
                : 4096;
            const result = new SharedArrayBuffer(8 + capacity);
            const state = new Int32Array(result, 0, 2);
            const deadline = performance.now() + (this.#connection.timeoutMs ?? 5_000);
            this.#worker.postMessage({
                connection: this.#connection,
                payload: JSON.stringify(input),
                result,
                fault: this.#fault,
            });
            while (Atomics.load(state, 0) === 0) {
                const remaining = deadline - performance.now();
                if (remaining <= 0) {
                    // Even a late success cannot undo uncertainty or serve another request.
                    Atomics.compareExchange(state, 0, 0, 3);
                    throw new Error("Remote Session save deadline exceeded; outcome is uncertain");
                }
                Atomics.wait(state, 0, 0, remaining);
            }
            const length = Atomics.load(state, 1);
            const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(result, 8, length));
            if (Atomics.load(state, 0) !== 1) throw new Error(text || "Remote Session save Worker failed");
            const response: RemoteSessionResponse = JSON.parse(text);
            if (
                response.operation !== input.operation || response.sequence !== input.sequence ||
                typeof response.contents !== "string" || !response.evidence ||
                !Number.isSafeInteger(response.evidence.byteLength) || response.evidence.byteLength < 0 ||
                !/^[a-f0-9]{64}$/.test(response.evidence.digestHex)
            ) throw new Error("Invalid laptop Session acknowledgement");
            const intended = kind === "hydrate" || kind === "inspect"
                ? response.contents
                : kind === "append"
                ? (this.#savedContents ?? "") + contents
                : kind === "rewrite"
                ? contents
                : this.#savedContents;
            if (
                intended !== null && (response.evidence.byteLength !== new TextEncoder().encode(intended).length ||
                    response.evidence.digestHex !== sessionDigest(intended))
            ) {
                throw new Error("Laptop Session acknowledgement did not match intended bytes");
            }
            this.#savedContents = intended;
            this.#sequence++;
            return response;
        } catch (error) {
            return this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    close(): void {
        this.#closed = true;
        this.#worker.terminate();
    }
}
