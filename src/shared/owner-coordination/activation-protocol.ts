import { recoverWindowsRename } from "../native-file-replace-windows.ts";
import { renameSync as fsRenameSync } from "node:fs";
import { chmodSync as fsChmodSync } from "node:fs";
import { writeFileSync as fsWriteFileSync } from "node:fs";
import { mkdirSync as fsMkdirSync } from "node:fs";
import { readFileSync as fsReadFileSync } from "node:fs";
/*
 * @module shared/owner-coordination/activation-protocol
 * Owner-wide opt-in marker for Session activation protocol rollout.
 */

import { dirname, join } from "node:path";
import { getOwnerCoordinationDatabaseEpoch } from "./database.js";
import type { OwnerCoordinationDatabase } from "./database.js";

export const SESSION_ACTIVATION_PROTOCOL_VERSION = 1;
export const SESSION_ACTIVATION_MARKER_FILENAME = "session-activation-protocol.json";

export interface ActivationProtocolStatus {
    enabled: boolean;
    state:
        | "enabled"
        | "not_acknowledged"
        | "missing_database_epoch"
        | "missing_marker"
        | "invalid_marker"
        | "epoch_mismatch"
        | "unsupported_version";
    databaseEpoch: string | null;
    markerVersion: number | null;
    markerEpoch: string | null;
    markerPath: string;
}

interface ActivationProtocolMarker {
    invalid?: boolean;
    protocolVersion?: number | string;
    databaseEpoch?: string;
}

interface AcknowledgeActivationProtocolOptions {
    now?: () => string;
}

export function getActivationProtocolMarkerPath(dbPath: string) {
    return join(dirname(dbPath), SESSION_ACTIVATION_MARKER_FILENAME);
}

function readMarker(markerPath: string): ActivationProtocolMarker | null {
    try {
        return JSON.parse(fsReadFileSync(markerPath, "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        return { invalid: true };
    }
}

export function getActivationProtocolStatus(database: OwnerCoordinationDatabase): ActivationProtocolStatus {
    const databaseEpoch = getOwnerCoordinationDatabaseEpoch(database.handle);
    const markerPath = getActivationProtocolMarkerPath(database.path);
    if (!databaseEpoch) {
        return {
            enabled: false,
            state: "missing_database_epoch",
            databaseEpoch,
            markerVersion: null,
            markerEpoch: null,
            markerPath,
        };
    }
    const marker = readMarker(markerPath);
    if (!marker) {
        return {
            enabled: false,
            state: "missing_marker",
            databaseEpoch,
            markerVersion: null,
            markerEpoch: null,
            markerPath,
        };
    }
    if (marker.invalid || !marker || typeof marker !== "object") {
        return {
            enabled: false,
            state: "invalid_marker",
            databaseEpoch,
            markerVersion: null,
            markerEpoch: null,
            markerPath,
        };
    }
    const markerVersion = Number(marker.protocolVersion);
    const markerEpoch = typeof marker.databaseEpoch === "string" ? marker.databaseEpoch : null;
    if (markerVersion !== SESSION_ACTIVATION_PROTOCOL_VERSION) {
        return {
            enabled: false,
            state: "unsupported_version",
            databaseEpoch,
            markerVersion: Number.isFinite(markerVersion) ? markerVersion : null,
            markerEpoch,
            markerPath,
        };
    }
    if (markerEpoch !== databaseEpoch) {
        return { enabled: false, state: "epoch_mismatch", databaseEpoch, markerVersion, markerEpoch, markerPath };
    }
    return { enabled: true, state: "enabled", databaseEpoch, markerVersion, markerEpoch, markerPath };
}

export function acknowledgeActivationProtocol(
    database: OwnerCoordinationDatabase,
    options: AcknowledgeActivationProtocolOptions = {},
): ActivationProtocolStatus {
    const databaseEpoch = getOwnerCoordinationDatabaseEpoch(database.handle);
    if (!databaseEpoch) throw new Error("Owner database is missing an activation protocol epoch");
    const markerPath = getActivationProtocolMarkerPath(database.path);
    const body =
        JSON.stringify(
            {
                markerSchema: 1,
                protocolVersion: SESSION_ACTIVATION_PROTOCOL_VERSION,
                databaseEpoch,
                acknowledgedAt: options.now ? options.now() : new Date().toISOString(),
            },
            null,
            2,
        ) + "\n";
    fsMkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${markerPath}.${crypto.randomUUID()}.tmp`;
    fsWriteFileSync(temporaryPath, body, { mode: 0o600 });
    try {
        fsChmodSync(temporaryPath, 0o600);
    } catch {
        // Best effort on filesystems without chmod.
    }
    try {
        fsRenameSync(temporaryPath, markerPath);
    } catch (error) {
        if (!(error instanceof Error && recoverWindowsRename(error, temporaryPath, markerPath))) throw error;
    }
    return getActivationProtocolStatus(database);
}

export function requireActivationProtocolEnabled(database: OwnerCoordinationDatabase): ActivationProtocolStatus {
    const status = getActivationProtocolStatus(database);
    if (!status.enabled) {
        throw new Error(`Session activation protocol is not enabled: ${status.state}`);
    }
    return status;
}
