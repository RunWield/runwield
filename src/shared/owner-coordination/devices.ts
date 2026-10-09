/**
 * @module shared/owner-coordination/devices
 * Revocable paired browser device credentials for owner Workspace.
 */

import type { SQLOutputValue } from "node:sqlite";
import type { OwnerCoordinationDatabase } from "./database.js";
import { hashSecret, randomBase64Url, timingSafeSecretEqual } from "./crypto.ts";

export interface PairedDevice {
    deviceId: string;
    label: string;
    createdAt: string;
    lastSeenAt: string | null;
    revokedAt: string | null;
    revokedReason: string | null;
}

// node:sqlite does not infer selected columns; query assertions use the paired_devices schema.
interface PairedDeviceRow extends Record<string, SQLOutputValue> {
    id: string;
    label: string;
    credential_hash: string;
    csrf_hash: string;
    created_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
    revoked_reason: string | null;
}

interface DeviceCsrfRow extends Record<string, SQLOutputValue> {
    csrf_hash: string;
    revoked_at: string | null;
}

export interface CreatePairedDeviceOptions {
    label: string;
    idFactory?: () => string;
    now?: () => string;
    credentialFactory?: () => string;
    csrfFactory?: () => string;
}

export interface CreatedPairedDevice {
    deviceId: string;
    credential: string;
    csrf: string;
    device: PairedDevice | null;
}

export interface VerifyDeviceCredentialOptions {
    now?: () => string;
    touch?: boolean;
    touchIntervalMs?: number;
}

export interface RevokeDeviceOptions {
    now?: () => string;
    reason?: string;
}

export const OWNER_DEVICE_COOKIE = "rw_owner_device";
export const OWNER_CSRF_COOKIE = "rw_owner_csrf";
export const OWNER_DEVICE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const OWNER_DEVICE_LAST_SEEN_TOUCH_INTERVAL_MS = 60_000;

function requireDatabase(value: OwnerCoordinationDatabase) {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return value;
}

function isoNow(now?: () => string) {
    return now ? now() : new Date().toISOString();
}

function timeMs(value: string | null) {
    const time = Date.parse(String(value || ""));
    return Number.isFinite(time) ? time : 0;
}

function newId(idFactory?: () => string) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

export function normalizeDeviceLabel(label: string) {
    const normalized = String(label || "").replace(/\s+/g, " ").trim();
    return normalized.slice(0, 80) || "Browser device";
}

function deviceFromRow(row: PairedDeviceRow): PairedDevice {
    return {
        deviceId: row.id,
        label: row.label,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        revokedAt: row.revoked_at,
        revokedReason: row.revoked_reason,
    };
}

export function createPairedDevice(
    database: OwnerCoordinationDatabase,
    options: CreatePairedDeviceOptions,
): CreatedPairedDevice {
    const ownerDb = requireDatabase(database);
    const credential = options.credentialFactory ? options.credentialFactory() : randomBase64Url(32);
    const csrf = options.csrfFactory ? options.csrfFactory() : randomBase64Url(32);
    const deviceId = newId(options.idFactory);
    const now = isoNow(options.now);
    ownerDb.handle.prepare(
        "INSERT INTO paired_devices(id, label, credential_hash, csrf_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(deviceId, normalizeDeviceLabel(options.label), hashSecret(credential), hashSecret(csrf), now);
    return { deviceId, credential, csrf, device: getDeviceById(ownerDb, deviceId) };
}

export function getDeviceById(database: OwnerCoordinationDatabase, deviceId: string): PairedDevice | null {
    const row = requireDatabase(database).handle.prepare("SELECT * FROM paired_devices WHERE id = ?").get(deviceId) as
        | PairedDeviceRow
        | undefined;
    return row ? deviceFromRow(row) : null;
}

export function listDevices(database: OwnerCoordinationDatabase): PairedDevice[] {
    return (requireDatabase(database).handle.prepare("SELECT * FROM paired_devices ORDER BY created_at DESC")
        .all() as PairedDeviceRow[]).map(
            deviceFromRow,
        );
}

export function verifyDeviceCredential(
    database: OwnerCoordinationDatabase,
    credential: string,
    options: VerifyDeviceCredentialOptions = {},
): PairedDevice | null {
    const ownerDb = requireDatabase(database);
    const presentedHash = hashSecret(credential || "");
    const rows = ownerDb.handle.prepare("SELECT * FROM paired_devices WHERE revoked_at IS NULL")
        .all() as PairedDeviceRow[];
    const row = rows.find((candidate) => timingSafeSecretEqual(String(candidate.credential_hash), presentedHash));
    if (!row) return null;
    if (options.touch !== false) {
        const now = isoNow(options.now);
        const touchIntervalMs = options.touchIntervalMs ?? OWNER_DEVICE_LAST_SEEN_TOUCH_INTERVAL_MS;
        if (!row.last_seen_at || timeMs(now) - timeMs(row.last_seen_at) >= touchIntervalMs) {
            ownerDb.handle.prepare("UPDATE paired_devices SET last_seen_at = ? WHERE id = ?").run(now, row.id);
            row.last_seen_at = now;
        }
    }
    return deviceFromRow(row);
}

export function verifyDeviceCsrf(database: OwnerCoordinationDatabase, deviceId: string, csrf: string) {
    const row = requireDatabase(database).handle.prepare(
        "SELECT csrf_hash, revoked_at FROM paired_devices WHERE id = ?",
    ).get(deviceId) as DeviceCsrfRow | undefined;
    if (!row || row.revoked_at) return false;
    return timingSafeSecretEqual(String(row.csrf_hash), hashSecret(csrf || ""));
}

export function revokeDevice(database: OwnerCoordinationDatabase, deviceId: string, options: RevokeDeviceOptions = {}) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    ownerDb.handle.prepare(
        "UPDATE paired_devices SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?) WHERE id = ?",
    ).run(now, String(options.reason || "revoked"), deviceId);
    return getDeviceById(ownerDb, deviceId);
}
