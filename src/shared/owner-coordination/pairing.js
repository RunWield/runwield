/**
 * @module shared/owner-coordination/pairing
 * Short-lived owner Workspace pairing request lifecycle.
 */

import { createPairedDevice } from "./devices.ts";
import { hashSecret, normalizePairingCode, randomBase64Url, randomHumanCode, timingSafeSecretEqual } from "./crypto.ts";

export const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000;
export const PAIRING_TERMINAL_PRUNE_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PAIRING_REQUESTS = 20;

/** @param {unknown} value */
function requireDatabase(value) {
    if (!value || typeof value !== "object" || !("handle" in value)) throw new Error("Owner database is required");
    return /** @type {import('./database.js').OwnerCoordinationDatabase} */ (value);
}

/** @param {() => string} [now] */
function isoNow(now) {
    return now ? now() : new Date().toISOString();
}

/** @param {() => string} [idFactory] */
function newId(idFactory) {
    return idFactory ? idFactory() : crypto.randomUUID();
}

/** @param {string} iso */
function timeMs(iso) {
    return Date.parse(iso);
}

/** @param {string} iso @param {number} ms */
function addMs(iso, ms) {
    return new Date(timeMs(iso) + ms).toISOString();
}

/** @param {any} row */
function requestFromRow(row) {
    return {
        requestId: row.id,
        deviceLabel: row.device_label,
        state: row.state,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        approvedAt: row.approved_at,
        claimedAt: row.claimed_at,
        claimedDeviceId: row.claimed_device_id,
        approvalAttempts: Number(row.approval_attempts || 0),
    };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stripTerminalControlCharacters(value) {
    const text = String(value || "");
    let sanitized = "";
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code === 27) {
            index += 1;
            if (text[index] === "[") {
                while (index + 1 < text.length) {
                    index += 1;
                    const sequenceCode = text.charCodeAt(index);
                    if (sequenceCode >= 64 && sequenceCode <= 126) break;
                }
            }
            continue;
        }
        if (code < 32 || code === 127 || (code >= 128 && code <= 159)) continue;
        sanitized += text[index];
    }
    return sanitized;
}

/** @param {string} label */
function normalizeLabel(label) {
    const normalized = stripTerminalControlCharacters(label).replace(/\s+/g, " ").trim();
    return normalized.slice(0, 80) || "Browser device";
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} now
 */
export function expirePairingRequests(database, now = new Date().toISOString()) {
    const db = requireDatabase(database).handle;
    db.prepare(
        "UPDATE pairing_requests SET state = 'expired' WHERE state IN ('pending', 'approved') AND expires_at <= ?",
    )
        .run(now);
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} now
 */
export function prunePairingRequests(database, now = new Date().toISOString()) {
    const cutoff = new Date(timeMs(now) - PAIRING_TERMINAL_PRUNE_MS).toISOString();
    requireDatabase(database).handle.prepare(
        "DELETE FROM pairing_requests WHERE state IN ('claimed', 'expired') AND created_at < ?",
    ).run(cutoff);
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {{ deviceLabel?: string, now?: () => string, idFactory?: () => string, codeFactory?: () => string, proofFactory?: () => string, ttlMs?: number, maxPending?: number }} [options]
 */
export function createPairingRequest(database, options = {}) {
    const ownerDb = requireDatabase(database);
    return ownerDb.transaction(() => {
        const now = isoNow(options.now);
        expirePairingRequests(ownerDb, now);
        prunePairingRequests(ownerDb, now);
        const pending = ownerDb.handle.prepare(
            "SELECT COUNT(*) AS count FROM pairing_requests WHERE state IN ('pending', 'approved') AND expires_at > ?",
        ).get(now);
        if (Number(pending?.count || 0) >= (options.maxPending || MAX_PENDING_PAIRING_REQUESTS)) {
            throw new Error("Too many pending Workspace pairing requests. Approve or wait for one to expire.");
        }

        for (let attempt = 0; attempt < 10; attempt += 1) {
            const code = normalizePairingCode(options.codeFactory ? options.codeFactory() : randomHumanCode());
            const codeHash = hashSecret(code);
            const collision = ownerDb.handle.prepare(
                "SELECT id FROM pairing_requests WHERE code_hash = ? AND ((state IN ('pending', 'approved') AND expires_at > ?) OR state = 'claimed')",
            ).get(codeHash, now);
            if (collision) continue;
            const proof = options.proofFactory ? options.proofFactory() : randomBase64Url(32);
            const requestId = newId(options.idFactory);
            const expiresAt = addMs(now, options.ttlMs || PAIRING_REQUEST_TTL_MS);
            ownerDb.handle.prepare(
                "INSERT INTO pairing_requests(id, code_hash, proof_hash, device_label, state, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
            ).run(
                requestId,
                codeHash,
                hashSecret(proof),
                normalizeLabel(options.deviceLabel || "Browser device"),
                now,
                expiresAt,
            );
            return { requestId, code, proof, expiresAt, state: "pending" };
        }
        throw new Error("Could not generate an unused Workspace pairing code.");
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} proof
 * @param {{ now?: () => string }} [options]
 */
export function getPairingRequestByProof(database, proof, options = {}) {
    const ownerDb = requireDatabase(database);
    const now = isoNow(options.now);
    expirePairingRequests(ownerDb, now);
    const proofHash = hashSecret(proof || "");
    const rows = ownerDb.handle.prepare(
        "SELECT * FROM pairing_requests WHERE state IN ('pending', 'approved', 'claimed')",
    ).all();
    const row = rows.find((candidate) => timingSafeSecretEqual(String(candidate.proof_hash), proofHash));
    return row ? requestFromRow(row) : null;
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} code
 * @param {{ now?: () => string }} [options]
 */
export function approvePairingRequest(database, code, options = {}) {
    const ownerDb = requireDatabase(database);
    return ownerDb.transaction(() => {
        const now = isoNow(options.now);
        expirePairingRequests(ownerDb, now);
        const normalizedCode = normalizePairingCode(code);
        const codeHash = hashSecret(normalizedCode);
        const rows = ownerDb.handle.prepare(
            "SELECT * FROM pairing_requests WHERE code_hash = ? AND state IN ('pending', 'approved', 'claimed') ORDER BY created_at DESC",
        ).all(codeHash);
        if (rows.length === 0) throw new Error("Workspace pairing code was not found or has expired.");
        if (rows.length > 1) {
            throw new Error("Workspace pairing code is ambiguous; ask the browser to request a new code.");
        }
        const row = rows[0];
        ownerDb.handle.prepare("UPDATE pairing_requests SET approval_attempts = approval_attempts + 1 WHERE id = ?")
            .run(row.id);
        if (row.state === "approved") return requestFromRow(row);
        if (row.state === "claimed") throw new Error("Workspace pairing code has already been claimed.");
        if (String(row.expires_at) <= now) throw new Error("Workspace pairing code has expired.");
        const result = ownerDb.handle.prepare(
            "UPDATE pairing_requests SET state = 'approved', approved_at = ? WHERE id = ? AND state = 'pending' AND expires_at > ?",
        ).run(now, row.id, now);
        if (result.changes !== 1) throw new Error("Workspace pairing code changed before approval; try again.");
        return requestFromRow(ownerDb.handle.prepare("SELECT * FROM pairing_requests WHERE id = ?").get(row.id));
    });
}

/**
 * @param {import('./database.js').OwnerCoordinationDatabase} database
 * @param {string} proof
 * @param {{ now?: () => string, idFactory?: () => string, credentialFactory?: () => string, csrfFactory?: () => string }} [options]
 */
export function claimPairingRequest(database, proof, options = {}) {
    const ownerDb = requireDatabase(database);
    return ownerDb.transaction(() => {
        const now = isoNow(options.now);
        expirePairingRequests(ownerDb, now);
        const proofHash = hashSecret(proof || "");
        const rows = ownerDb.handle.prepare("SELECT * FROM pairing_requests WHERE state IN ('approved', 'claimed')")
            .all();
        const row = rows.find((candidate) => timingSafeSecretEqual(String(candidate.proof_hash), proofHash));
        if (!row) throw new Error("Workspace pairing request is not approved or has expired.");
        if (row.state === "claimed") throw new Error("Workspace pairing request has already been claimed.");
        if (String(row.expires_at) <= now) throw new Error("Workspace pairing request has expired.");
        const device = createPairedDevice(ownerDb, {
            label: String(row.device_label || "Browser device"),
            idFactory: options.idFactory,
            now: options.now,
            credentialFactory: options.credentialFactory,
            csrfFactory: options.csrfFactory,
        });
        const result = ownerDb.handle.prepare(
            "UPDATE pairing_requests SET state = 'claimed', claimed_at = ?, claimed_device_id = ? WHERE id = ? AND state = 'approved' AND expires_at > ?",
        ).run(now, device.deviceId, row.id, now);
        if (result.changes !== 1) throw new Error("Workspace pairing request changed before claim; try again.");
        return {
            ...device,
            request: requestFromRow(ownerDb.handle.prepare("SELECT * FROM pairing_requests WHERE id = ?").get(row.id)),
        };
    });
}
