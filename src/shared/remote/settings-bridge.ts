import { readFileSync } from "node:fs";
import { parse as parseJsonc } from "../jsonc.ts";
import { join } from "node:path";
import { personalGlobalRoot } from "./personal-resources.ts";

export interface RemoteSettingsConnection {
    port: number;
    credential: string;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SettingsUpdate =
    | { kind: "set"; key: string; value: JsonValue }
    | { kind: "model"; model: string; provider: string }
    | { kind: "compaction"; key: "enabled" | "reserveTokens" | "keepRecentTokens"; value: boolean | number };

interface UpdateReceipt {
    id: string;
    snapshot: string;
}

let remoteConnection: RemoteSettingsConnection | undefined;
let receiptSnapshot: { mountedBefore: string | undefined; snapshot: string } | undefined;

/** A receipt is authoritative until the mounted view changes. A fresh connection never inherits one. */
export function remoteSettingsSnapshot(mounted: string | undefined): string | undefined {
    if (receiptSnapshot && mounted === receiptSnapshot.mountedBefore) return receiptSnapshot.snapshot;
    receiptSnapshot = undefined;
    return mounted;
}

function mountedSettings(): string | undefined {
    try {
        return JSON.stringify(parseJsonc(readFileSync(join(personalGlobalRoot(), "settings.json"), "utf8")));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

function acceptReceipt(receipt: UpdateReceipt, id: string, mountedBefore: string | undefined): void {
    const parsed = parseJsonc(receipt.snapshot);
    if (receipt.id !== id || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid laptop settings receipt");
    }
    receiptSnapshot = { mountedBefore, snapshot: receipt.snapshot };
}

/** Activated only after the authenticated control handshake and verified mount. */
export function configureRemoteSettingsConnection(connection: RemoteSettingsConnection): void {
    if (
        remoteConnection || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(connection.credential)
    ) throw new Error("Invalid remote settings connection");
    remoteConnection = { ...connection };
    receiptSnapshot = undefined;
}

async function send(connection: RemoteSettingsConnection, path: string, body?: string): Promise<Response> {
    return await fetch(`http://127.0.0.1:${connection.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            Authorization: `Bearer ${connection.credential}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        signal: AbortSignal.timeout(4_000),
    });
}

/** The receipt survives a lost acknowledgement; never issue a new id for a retry. */
export async function updateRemoteGlobalSetting(update: SettingsUpdate): Promise<void> {
    const connection = remoteConnection;
    if (!connection) throw new Error("Remote global settings writes require the laptop settings service");
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const body = JSON.stringify({ id, update });
    const mountedBefore = mountedSettings();
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await send(connection, "/settings/update", body);
            if (!response.ok) throw new Error(`Laptop settings update failed (${response.status})`);
            const receipt: UpdateReceipt = await response.json();
            acceptReceipt(receipt, id, mountedBefore);
            return;
        } catch (error) {
            if (attempt === 0) continue;
            try {
                const response = await send(connection, `/settings/receipt/${id}`);
                if (response.ok) {
                    const receipt: UpdateReceipt = await response.json();
                    acceptReceipt(receipt, id, mountedBefore);
                    return;
                }
            } catch { /* Keep the original failure; a later caller can read the mounted snapshot. */ }
            throw error;
        }
    }
}
