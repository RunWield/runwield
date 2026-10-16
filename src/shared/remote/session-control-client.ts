import {
    type RemoteSessionAdmissionRequest,
    type RemoteSessionControlRequest,
    type RemoteSessionControlResponse,
    type RemoteSessionSummary,
    validateSessionControlRequest,
} from "./session-protocol.ts";

export interface RemoteSessionControlConnection {
    port: number;
    credential: string;
}

/** Operation lifecycle only. Pi entry saves use the synchronous bridge from the returned operation. */
export class RemoteSessionControl {
    readonly #baseUrl: string;
    constructor(readonly connection: RemoteSessionControlConnection) {
        if (
            !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
            !/^[a-f0-9]{64}$/.test(connection.credential)
        ) {
            throw new Error("Invalid remote Session control connection");
        }
        this.#baseUrl = `http://127.0.0.1:${connection.port}`;
    }

    async #request(input: RemoteSessionControlRequest): Promise<RemoteSessionControlResponse> {
        validateSessionControlRequest(input);
        const response = await fetch(`${this.#baseUrl}/session/control`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.connection.credential}`, "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Laptop Session control refused ${input.kind} (${response.status})`);
        return await response.json();
    }

    async #admit(input: RemoteSessionAdmissionRequest): Promise<string> {
        try {
            const result = await this.#request(input);
            if (typeof result.operation !== "string" || !/^[a-f0-9-]{36}$/.test(result.operation)) {
                throw new Error("Missing laptop Session operation");
            }
            return result.operation;
        } catch (error) {
            // The laptop can own a writer even if its reply never reached us.
            // Cancel this admission only; never replay create/begin or user work.
            await this.#request({ kind: "markUncertain", admissionId: input.admissionId }).catch(() => {});
            throw error;
        }
    }
    async create(sessionId: string, name = ""): Promise<string> {
        return await this.#admit({ kind: "create", sessionId, name, admissionId: crypto.randomUUID() });
    }
    async begin(sessionId: string): Promise<string> {
        return await this.#admit({ kind: "begin", sessionId, admissionId: crypto.randomUUID() });
    }
    async checkpoint(operation: string): Promise<void> {
        await this.#request({ kind: "checkpoint", operation });
    }
    async markUncertain(operation: string): Promise<void> {
        await this.#request({ kind: "markUncertain", operation });
    }
    async list(sessionId?: string): Promise<RemoteSessionSummary[]> {
        const result = await this.#request({ kind: "list", ...(sessionId ? { sessionId } : {}) });
        if (!Array.isArray(result.sessions)) throw new Error("Invalid laptop Session list");
        return result.sessions;
    }
    sessionConnection(operation: string) {
        return {
            baseUrl: this.#baseUrl,
            credential: this.connection.credential,
            operation,
        };
    }
}
