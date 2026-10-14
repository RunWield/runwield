import type { MemoryParams } from "../../extensions/mnemoteca/tools.ts";
import { getCwd } from "../../constants.js";
import { resolveMemoryCollection } from "../memory-collection.ts";

export interface MemoryResult {
    content: Array<{ type: "text"; text: string }>;
    details: MemoryParams | { action: "list-core" };
    callMessage?: string;
}
export interface RemoteMemoryConnection {
    port: number;
    credential: string;
    collection: string;
}
export interface MemoryRequest {
    requestId: string;
    action: MemoryParams["action"] | "list-core";
    collection: string;
    args: Omit<MemoryParams, "action">;
}
export interface MemoryReceipt {
    requestId: string;
    result: MemoryResult;
}
let connection: RemoteMemoryConnection | undefined;

export function configureRemoteMemoryConnection(value: RemoteMemoryConnection): () => void {
    if (
        connection || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(value.credential) || !value.collection || value.collection.includes("\0")
    ) {
        throw new Error("Invalid remote Memory connection");
    }
    connection = { ...value };
    return () => {
        connection = undefined;
    };
}

export function remoteMemoryCollection(): string | undefined {
    return connection?.collection;
}

/** Repeat only the same request id; a lost reply must not duplicate a write. */
export async function requestRemoteMemory(
    operation: MemoryParams | { action: "list-core" },
    signal?: AbortSignal,
): Promise<MemoryResult> {
    const current = connection;
    if (!current) throw new Error("Remote Memory requires the laptop service");
    const { action, ...args } = operation;
    const request: MemoryRequest = {
        requestId: crypto.randomUUID(),
        action,
        collection: await resolveMemoryCollection({ cwd: getCwd(), boundCollection: current.collection }),
        args,
    };
    const body = JSON.stringify(request);
    for (let attempt = 0;; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${current.port}/memory`, {
                method: "POST",
                headers: { Authorization: `Bearer ${current.credential}`, "Content-Type": "application/json" },
                body,
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
            });
            if (!response.ok) throw new Error(`Laptop Memory request failed (${response.status})`);
            const receipt: MemoryReceipt = await response.json();
            if (
                receipt.requestId !== request.requestId || !Array.isArray(receipt.result?.content) ||
                !receipt.result.content.every((item) => item.type === "text" && typeof item.text === "string")
            ) {
                throw new Error("Invalid laptop Memory receipt");
            }
            return receipt.result;
        } catch (error) {
            if (attempt || signal?.aborted) throw error;
        }
    }
}
