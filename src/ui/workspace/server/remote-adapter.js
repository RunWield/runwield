/** @module ui/workspace/server/remote-adapter */

import {
    hashCapability,
    MAINTAINER_SCOPE,
    REVIEWER_SCOPE,
    timingSafeEqual,
} from "../../../shared/collaboration/capabilities.ts";
import { openRemoteDatabase } from "./remote-db.ts";

const EXPIRED_SPACE_CLEANUP_BATCH_SIZE = 100;

export const SYSTEM_REMOTE_WORKSPACE_CLOCK = Object.freeze({
    now: () => new Date(),
});

export class RemoteWorkspaceError extends Error {
    /** @param {string} code @param {string} message @param {number} status */
    constructor(code, message, status) {
        super(message);
        this.name = "RemoteWorkspaceError";
        this.code = code;
        this.status = status;
    }
}

/**
 * @typedef {Object} RemoteRetentionPolicy
 * @property {number} [days]
 */

/**
 * @typedef {Object} RemoteWorkspaceAdapter
 * @property {import("./remote-db.ts").RemoteDatabase} database
 * @property {(input: { planId: string, payloadCiphertext: string, capabilities: { scope: "reviewer" | "maintainer", capabilityHash: string }[] }) => any} createSharedSpace
 * @property {(spaceId: string, capability: string, requiredScope: "reviewer" | "maintainer") => Promise<void>} verifyCapability
 * @property {(spaceId: string) => any} getSharedSpace
 * @property {(spaceId: string) => any[]} listRevisions
 * @property {(spaceId: string, revision: number) => any} getRevision
 * @property {(spaceId: string, payloadCiphertext: string, expectedRevision?: number) => any} appendRevision
 * @property {(spaceId: string, revision: number) => any[]} listComments
 * @property {(spaceId: string, revision: number, ciphertext: string) => any} appendComment
 * @property {(spaceId: string, commentId: string, action: "resolve" | "reopen") => any} setCommentState
 * @property {(spaceId: string) => any} closeSharedSpace
 * @property {(spaceId: string) => void} deleteSharedSpace
 * @property {() => { ok: true, mode: "remote" }} ready
 * @property {() => number} cleanupExpiredSharedSpaces
 * @property {() => void} reconcileRetentionPolicy
 * @property {() => void} close
 */

/**
 * @param {{ database: import("./remote-db.ts").RemoteDatabase, retention?: RemoteRetentionPolicy, clock: { now: () => Date } }} options
 * @returns {RemoteWorkspaceAdapter}
 */
export function createRemoteWorkspaceAdapter(options) {
    const { database, clock } = options;
    const db = database.handle;
    const retentionDays = options.retention?.days;
    let closed = false;

    /** @param {string} timestamp */
    const expiryFor = (timestamp) => retentionDays ? addDaysIso(new Date(timestamp), retentionDays) : null;
    const currentIso = () => clock.now().toISOString();

    return {
        database,
        close() {
            if (closed) return;
            closed = true;
            database.close();
        },
        reconcileRetentionPolicy() {
            database.transaction(() => {
                if (!retentionDays) {
                    db.prepare("UPDATE shared_spaces SET expires_at = NULL WHERE expires_at IS NOT NULL").run();
                    return;
                }
                const expiry = expiryFor(currentIso());
                db.prepare("UPDATE shared_spaces SET expires_at = ? WHERE expires_at IS NULL").run(expiry);
            });
        },
        ready() {
            db.prepare("SELECT 1").get();
            return { ok: true, mode: "remote" };
        },
        cleanupExpiredSharedSpaces() {
            if (!retentionDays) return 0;
            let deleted = 0;
            while (true) {
                const cutoff = currentIso();
                const changes = database.transaction(() => {
                    const result = db.prepare(
                        `DELETE FROM shared_spaces
                         WHERE id IN (
                             SELECT id FROM shared_spaces
                             WHERE expires_at IS NOT NULL AND expires_at <= ?
                             ORDER BY expires_at, id
                             LIMIT ?
                         )`,
                    ).run(cutoff, EXPIRED_SPACE_CLEANUP_BATCH_SIZE);
                    return Number(result.changes ?? 0);
                });
                deleted += changes;
                if (changes < EXPIRED_SPACE_CLEANUP_BATCH_SIZE) return deleted;
            }
        },
        createSharedSpace(input) {
            const spaceId = crypto.randomUUID();
            const nowIso = currentIso();
            const expiresAt = expiryFor(nowIso);
            return database.transaction(() => {
                db.prepare(
                    "INSERT INTO shared_spaces(id, plan_id, status, latest_revision, created_at, updated_at, expires_at) VALUES (?, ?, 'open', 1, ?, ?, ?)",
                ).run(spaceId, input.planId, nowIso, nowIso, expiresAt);
                db.prepare(
                    "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, 1, ?, ?)",
                ).run(spaceId, input.payloadCiphertext, nowIso);
                const insertCapability = db.prepare(
                    "INSERT INTO space_capabilities(space_id, scope, capability_hash, created_at) VALUES (?, ?, ?, ?)",
                );
                for (const capability of input.capabilities) {
                    insertCapability.run(spaceId, capability.scope, capability.capabilityHash, nowIso);
                }
                /** @type {any} */
                const space = {
                    spaceId,
                    planId: input.planId,
                    status: "open",
                    latestRevision: 1,
                    createdAt: nowIso,
                    updatedAt: nowIso,
                };
                if (expiresAt) space.expiresAt = expiresAt;
                return withRevisions(space, [{ spaceId, revision: 1, createdAt: nowIso }]);
            });
        },
        async verifyCapability(spaceId, capability, requiredScope) {
            await verifyCapability(db, spaceId, capability, requiredScope);
        },
        getSharedSpace(spaceId) {
            const space = getSpaceRow(db, spaceId);
            return { ...mapSpace(space), revisions: listRevisionMetadata(db, spaceId) };
        },
        listRevisions(spaceId) {
            getSpaceRow(db, spaceId);
            return listRevisionMetadata(db, spaceId);
        },
        getRevision(spaceId, revision) {
            getSpaceRow(db, spaceId);
            const row = db.prepare(
                "SELECT space_id, revision, payload_ciphertext, created_at FROM space_revisions WHERE space_id = ? AND revision = ?",
            ).get(spaceId, revision);
            if (!row) throw notFound("Revision not found.");
            return mapRevision(row, true);
        },
        appendRevision(spaceId, payloadCiphertext, expectedRevision) {
            return database.transaction(() => {
                const space = getSpaceRow(db, spaceId);
                assertOpen(space);
                const nextRevision = Number(space.latest_revision) + 1;
                if (expectedRevision !== undefined && expectedRevision !== nextRevision) {
                    throw conflict("Revision conflict.");
                }
                const nowIso = currentIso();
                db.prepare(
                    "INSERT INTO space_revisions(space_id, revision, payload_ciphertext, created_at) VALUES (?, ?, ?, ?)",
                ).run(spaceId, nextRevision, payloadCiphertext, nowIso);
                touchSpace(db, spaceId, nowIso, expiryFor(nowIso), "latest_revision = ?", [nextRevision]);
                return { spaceId, revision: nextRevision, payloadCiphertext, createdAt: nowIso };
            });
        },
        listComments(spaceId, revision) {
            getRevisionRow(db, spaceId, revision);
            return db.prepare(
                "SELECT id, space_id, revision, ciphertext, resolved, created_at, updated_at FROM space_comments WHERE space_id = ? AND revision = ? ORDER BY created_at, id",
            ).all(spaceId, revision).map(mapComment);
        },
        appendComment(spaceId, revision, ciphertext) {
            return database.transaction(() => {
                const space = getSpaceRow(db, spaceId);
                assertOpen(space);
                getRevisionRow(db, spaceId, revision);
                const id = crypto.randomUUID();
                const nowIso = currentIso();
                db.prepare(
                    "INSERT INTO space_comments(id, space_id, revision, ciphertext, resolved, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
                ).run(id, spaceId, revision, ciphertext, nowIso, nowIso);
                touchSpace(db, spaceId, nowIso, expiryFor(nowIso));
                return { id, spaceId, revision, ciphertext, resolved: false, createdAt: nowIso, updatedAt: nowIso };
            });
        },
        setCommentState(spaceId, commentId, action) {
            return database.transaction(() => {
                const space = getSpaceRow(db, spaceId);
                assertOpen(space);
                const row = db.prepare(
                    "SELECT id, space_id, revision, ciphertext, resolved, created_at, updated_at FROM space_comments WHERE space_id = ? AND id = ?",
                ).get(spaceId, commentId);
                if (!row) throw notFound("Comment not found.");
                const resolved = action === "resolve" ? 1 : 0;
                const nowIso = currentIso();
                db.prepare("UPDATE space_comments SET resolved = ?, updated_at = ? WHERE space_id = ? AND id = ?").run(
                    resolved,
                    nowIso,
                    spaceId,
                    commentId,
                );
                touchSpace(db, spaceId, nowIso, expiryFor(nowIso));
                return mapComment({ ...row, resolved, updated_at: nowIso });
            });
        },
        closeSharedSpace(spaceId) {
            return database.transaction(() => {
                const space = getSpaceRow(db, spaceId);
                const nowIso = currentIso();
                const expiresAt = expiryFor(nowIso);
                if (space.status === "closed") {
                    touchSpace(db, spaceId, nowIso, expiresAt);
                    return mapSpace({ ...space, updated_at: nowIso, expires_at: expiresAt });
                }
                db.prepare(
                    "UPDATE shared_spaces SET status = 'closed', updated_at = ?, closed_at = ?, expires_at = ? WHERE id = ?",
                ).run(nowIso, nowIso, expiresAt, spaceId);
                return mapSpace({
                    ...space,
                    status: "closed",
                    updated_at: nowIso,
                    closed_at: nowIso,
                    expires_at: expiresAt,
                });
            });
        },
        deleteSharedSpace(spaceId) {
            const result = db.prepare("DELETE FROM shared_spaces WHERE id = ?").run(spaceId);
            if (Number(result.changes) === 0) throw notFound("Shared Space not found or deleted.");
        },
    };
}

/**
 * Production composition for the remote Workspace adapter.
 *
 * @param {{ dbPath?: string, retention?: RemoteRetentionPolicy }} [options]
 * @returns {RemoteWorkspaceAdapter}
 */
export function openRemoteWorkspaceAdapter(options = {}) {
    return createRemoteWorkspaceAdapter({
        database: openRemoteDatabase({ dbPath: options.dbPath }),
        retention: options.retention,
        clock: SYSTEM_REMOTE_WORKSPACE_CLOCK,
    });
}

/** @param {import("../../../shared/sqlite.ts").DatabaseSync} db @param {string} spaceId @param {string} capability @param {"reviewer" | "maintainer"} requiredScope */
async function verifyCapability(db, spaceId, capability, requiredScope) {
    getSpaceRow(db, spaceId);
    const presentedHash = await hashCapability(capability);
    const rows = db.prepare("SELECT scope, capability_hash FROM space_capabilities WHERE space_id = ?").all(spaceId);
    for (const row of rows) {
        const scope = String(row.scope);
        const allowed = requiredScope === REVIEWER_SCOPE || scope === MAINTAINER_SCOPE;
        if (allowed && timingSafeEqual(String(row.capability_hash), presentedHash)) return;
    }
    if (rows.some((row) => timingSafeEqual(String(row.capability_hash), presentedHash))) {
        throw new RemoteWorkspaceError("forbidden", "Capability is not authorized for this operation.", 403);
    }
    throw new RemoteWorkspaceError("forbidden", "Capability is not authorized for this operation.", 403);
}

/** @param {import("../../../shared/sqlite.ts").DatabaseSync} db @param {string} spaceId */
function getSpaceRow(db, spaceId) {
    const row = db.prepare(
        "SELECT id, plan_id, status, latest_revision, created_at, updated_at, closed_at, expires_at FROM shared_spaces WHERE id = ?",
    ).get(spaceId);
    if (!row) throw notFound("Shared Space not found or deleted.");
    return row;
}

/** @param {import("../../../shared/sqlite.ts").DatabaseSync} db @param {string} spaceId @param {number} revision */
function getRevisionRow(db, spaceId, revision) {
    const row = db.prepare(
        "SELECT space_id, revision, payload_ciphertext, created_at FROM space_revisions WHERE space_id = ? AND revision = ?",
    ).get(spaceId, revision);
    if (!row) throw notFound("Revision not found.");
    return row;
}

/** @param {import("../../../shared/sqlite.ts").DatabaseSync} db @param {string} spaceId */
function listRevisionMetadata(db, spaceId) {
    return db.prepare(
        "SELECT space_id, revision, created_at FROM space_revisions WHERE space_id = ? ORDER BY revision",
    ).all(spaceId).map((row) => mapRevision(row, false));
}

/**
 * @param {import("../../../shared/sqlite.ts").DatabaseSync} db
 * @param {string} spaceId
 * @param {string} updatedAt
 * @param {string | null} expiresAt
 * @param {string} [extraSet]
 * @param {any[]} [extraValues]
 */
function touchSpace(db, spaceId, updatedAt, expiresAt, extraSet = "", extraValues = []) {
    const prefix = extraSet ? `${extraSet}, ` : "";
    db.prepare(`UPDATE shared_spaces SET ${prefix}updated_at = ?, expires_at = ? WHERE id = ?`).run(
        ...extraValues,
        updatedAt,
        expiresAt,
        spaceId,
    );
}

/** @param {any} space @param {any[]} revisions */
function withRevisions(space, revisions) {
    return { ...space, revisions };
}

/** @param {any} row */
function mapSpace(row) {
    /** @type {any} */
    const space = {
        spaceId: String(row.id),
        planId: String(row.plan_id),
        status: String(row.status),
        latestRevision: Number(row.latest_revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
    if (row.closed_at) space.closedAt = String(row.closed_at);
    if (row.expires_at) space.expiresAt = String(row.expires_at);
    return space;
}

/** @param {any} row @param {boolean} includePayload */
function mapRevision(row, includePayload) {
    /** @type {any} */
    const revision = {
        spaceId: String(row.space_id),
        revision: Number(row.revision),
        createdAt: String(row.created_at),
    };
    if (includePayload) revision.payloadCiphertext = String(row.payload_ciphertext);
    return revision;
}

/** @param {any} row */
function mapComment(row) {
    return {
        id: String(row.id),
        spaceId: String(row.space_id),
        revision: Number(row.revision),
        ciphertext: String(row.ciphertext),
        resolved: Number(row.resolved) === 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}

/** @param {any} space */
function assertOpen(space) {
    if (space.status === "closed") throw conflict("Shared Space is closed.");
}

/** @param {Date} start @param {number} days */
function addDaysIso(start, days) {
    return new Date(start.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** @param {string} message */
function notFound(message) {
    return new RemoteWorkspaceError("not_found", message, 404);
}

/** @param {string} message */
function conflict(message) {
    return new RemoteWorkspaceError("conflict", message, 409);
}
