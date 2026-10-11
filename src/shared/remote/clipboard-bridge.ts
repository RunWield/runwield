import type { ClipboardImage, ClipboardReader } from "../../ui/tui/clipboard.ts";

export interface RemoteClipboardConnection {
    port: number;
    credential: string;
}

// Match the 20 MiB image limit used by other image input surfaces, including JSON overhead.
export const MAX_CLIPBOARD_BODY_BYTES = Math.ceil(20 * 1024 * 1024 / 3) * 4 + 64;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Clipboard input is bytes only. Local paths and attachment identities never cross this boundary. */
export function validateClipboardImage(value: JsonValue | ClipboardImage): ClipboardImage | null {
    if (value === null) return null;
    if (
        typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "base64,mimeType" ||
        value.mimeType !== "image/png" || typeof value.base64 !== "string" ||
        value.base64.length === 0 || value.base64.length > MAX_CLIPBOARD_BODY_BYTES - 64 ||
        value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)
    ) throw new Error("Invalid laptop clipboard image");
    return { base64: value.base64, mimeType: "image/png" };
}

export interface RemoteClipboardReader extends ClipboardReader {
    close(): void;
}

/** Compose only the authenticated network boundary; closing never enables a local clipboard fallback. */
export function createRemoteClipboardReader(connection: RemoteClipboardConnection): RemoteClipboardReader {
    if (
        !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(connection.credential)
    ) throw new Error("Invalid remote clipboard connection");
    const { port, credential } = connection;
    const abort = new AbortController();
    async function readClipboardImage(): Promise<ClipboardImage | null> {
        if (abort.signal.aborted) throw new Error("Remote clipboard connection is closed");
        const response = await fetch(`http://127.0.0.1:${port}/clipboard/image`, {
            headers: { Authorization: `Bearer ${credential}` },
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4_000)]),
            redirect: "error",
        });
        if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
            await response.body?.cancel();
            throw new Error(`Laptop clipboard read failed (${response.status})`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing laptop clipboard reply");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > MAX_CLIPBOARD_BODY_BYTES) throw new Error("Laptop clipboard reply too large");
                chunks.push(value);
            }
            if (abort.signal.aborted) throw new Error("Remote clipboard connection is closed");
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            return validateClipboardImage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    return {
        readClipboardImage,
        hasClipboardImage: async () => await readClipboardImage() !== null,
        close: () => abort.abort(),
    };
}
