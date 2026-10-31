import { getCwd } from "../../constants.js";
import { denoHelperBinaryExec } from "../../extensions/helper-binary-exec.ts";
import { createMnemotecaTools, MISSING_BINARY_MSG } from "../../extensions/mnemoteca/tools.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { MemoryReceipt, MemoryRequest, MemoryResult } from "./memory-bridge.ts";

function validate(input: MemoryRequest): void {
    if (
        !input ||
        typeof input.requestId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.requestId) ||
        !["recall", "store", "delete", "list-core"].includes(input.action) ||
        typeof input.collection !== "string" ||
        !input.args ||
        typeof input.args !== "object" ||
        Array.isArray(input.args) ||
        Object.keys(input).sort().join(",") !== "action,args,collection,requestId" ||
        Object.keys(input.args).some((key) => !["query", "content", "scope", "core", "id"].includes(key))
    ) {
        throw new Error("Invalid Memory request");
    }
    const args = input.args;
    if (
        (args.query !== undefined && typeof args.query !== "string") ||
        (args.content !== undefined && typeof args.content !== "string") ||
        (args.core !== undefined && typeof args.core !== "boolean") ||
        (args.scope !== undefined && args.scope !== "project" && args.scope !== "global") ||
        (args.id !== undefined && (!Number.isSafeInteger(args.id) || args.id < 1)) ||
        (input.action === "list-core" && Object.keys(args).length)
    )
        throw new Error("Invalid Memory arguments");
}

/** Connection-owned receipts include in-flight writes, so concurrent retries also execute once. */
export class LaptopMemoryService {
    private readonly receipts = new Map<string, { payload: string; receipt: Promise<MemoryReceipt> }>();
    private readonly abort = new AbortController();
    constructor(private readonly collection: string) {}

    close(): void {
        this.abort.abort();
    }

    async handle(request: Request): Promise<Response> {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        let input: MemoryRequest;
        try {
            const reader = request.body?.getReader();
            if (!reader) throw new Error("Missing Memory request");
            const bytes: number[] = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (bytes.length + value.length > 64 * 1024) {
                    await reader.cancel();
                    throw new Error("Large Memory request");
                }
                for (const byte of value) bytes.push(byte);
            }
            input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)));
            validate(input);
        } catch {
            return new Response(null, { status: 400 });
        }
        if (this.abort.signal.aborted) return new Response(null, { status: 403 });
        if (input.collection !== this.collection && !(input.collection === "global" && input.args.scope === "global")) {
            return new Response(null, { status: 403 });
        }
        const payload = JSON.stringify([input.action, input.collection, input.args]);
        let old = this.receipts.get(input.requestId);
        if (old && old.payload !== payload) return new Response(null, { status: 409 });
        if (!old) {
            old = { payload, receipt: this.execute(input) };
            this.receipts.set(input.requestId, old);
        }
        try {
            const receipt = await old.receipt;
            if (this.abort.signal.aborted) return new Response(null, { status: 403 });
            return Response.json(receipt);
        } catch {
            return new Response(null, { status: 503 });
        }
    }

    private async execute(input: MemoryRequest): Promise<MemoryReceipt> {
        let result: MemoryResult;
        if (input.action === "list-core") {
            const output = await denoHelperBinaryExec(
                "mnemoteca",
                ["list", "--name", this.collection, "-t", "core", "-f", "plain"],
                { cwd: getCwd(), signal: this.abort.signal },
            );
            if (output.code !== 0) throw new Error(output.stderr || "Laptop core Memory read failed");
            const text = output.stdout.trim();
            result = {
                details: { action: "list-core" },
                content: [
                    {
                        type: "text",
                        text: text.startsWith("No documents") || text.startsWith("Error:") ? "" : text,
                    },
                ],
            };
        } else {
            const [tool] = createMnemotecaTools({
                cwd: getCwd(),
                exec: denoHelperBinaryExec,
                boundCollection: this.collection,
            });
            result = (await tool.execute(
                input.requestId,
                { ...input.args, action: input.action },
                this.abort.signal,
                () => {},
                {} as ExtensionToolContext,
            )) as MemoryResult;
            if (result.content.some((item) => item.text === MISSING_BINARY_MSG)) throw new Error(MISSING_BINARY_MSG);
        }
        return { requestId: input.requestId, result };
    }
}
