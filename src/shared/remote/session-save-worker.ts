import type { RemoteSessionResponse, SessionWorkerRequest } from "./session-protocol.ts";

let active: SessionWorkerRequest | undefined;
const encoder = new TextEncoder();

/** Errors must wake a blocked caller, not depend on its onerror callback. */
function fail(message: string): void {
    if (!active) return;
    Atomics.store(new Int32Array(active.fault), 0, 1);
    finish(2, encoder.encode(message));
}

function finish(status: number, bytes: Uint8Array): void {
    if (!active) return;
    const state = new Int32Array(active.result, 0, 2);
    if (Atomics.load(state, 0) !== 0) return; // Timed out or closed: never reuse this request slot.
    const output = new Uint8Array(active.result, 8);
    if (bytes.length > output.length) {
        fail("Session response exceeded the bridge limit");
        return;
    }
    output.set(bytes);
    Atomics.store(state, 1, bytes.length);
    if (Atomics.compareExchange(state, 0, 0, status) === 0) Atomics.notify(state, 0);
}

self.addEventListener("error", (event) => {
    fail("Session save Worker error");
    event.preventDefault();
});
self.addEventListener("unhandledrejection", (event) => {
    fail("Session save Worker rejected");
    event.preventDefault();
});

export async function saveSessionRequest(request: SessionWorkerRequest): Promise<void> {
    active = request;
    try {
        const response = await fetch(`${request.connection.baseUrl}/session/request`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${request.connection.credential}`,
                "Content-Type": "application/json",
            },
            body: request.payload,
            signal: AbortSignal.timeout(request.connection.timeoutMs ?? 5_000),
        });
        if (!response.ok) throw new Error(`Laptop Session save refused (${response.status})`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing Session acknowledgement");
        const parts: Uint8Array[] = [];
        let length = 0;
        const capacity = request.result.byteLength - 8;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > capacity) {
                await reader.cancel();
                throw new Error("Session acknowledgement too large");
            }
            parts.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
        }
        const receipt: RemoteSessionResponse = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const input = JSON.parse(request.payload);
        if (receipt.operation !== input.operation || receipt.sequence !== input.sequence) {
            throw new Error("Session acknowledgement identity mismatch");
        }
        finish(1, bytes);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}

self.onmessage = ({ data }: MessageEvent<SessionWorkerRequest>) => {
    void saveSessionRequest(data);
};
