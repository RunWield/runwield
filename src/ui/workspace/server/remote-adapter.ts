/** @module ui/workspace/server/remote-adapter */

import {
    hashCapability,
    MAINTAINER_SCOPE,
    REVIEWER_SCOPE,
    timingSafeEqual,
} from "../../../shared/collaboration/capabilities.ts";
import { openRemoteDatabase } from "./remote-db.ts";

import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { DatabaseSync } from "../../../shared/sqlite.ts";
import type { CapabilityScope } from "../../../shared/collaboration/capabilities.ts";
import type {
    CapabilityRecord,
    SharedSpaceMetadata,
    RevisionMetadata,
    EncryptedCommentRecord,
    CommentStateChangePayload,
} from "../../../shared/collaboration/protocol.ts";
import type { RemoteDatabase, OpenRemoteDatabaseOptions } from "./remote-db.ts";

export interface RemoteRetentionPolicy {
    days?: number;
}

export interface RemoteWorkspaceClock {
    now: () => Date;
}

export interface CreateRemoteWorkspaceAdapterOptions {
    database: RemoteDatabase;
    retention?: RemoteRetentionPolicy;
    clock: RemoteWorkspaceClock;
}

export interface OpenRemoteWorkspaceAdapterOptions extends OpenRemoteDatabaseOptions {
    retention?: RemoteRetentionPolicy;
}

export interface CreateRemoteSharedSpaceInput {
    planId: SharedSpaceMetadata["planId"];
    payloadCiphertext: RevisionMetadata["payloadCiphertext"];
    capabilities: CapabilityRecord[];
}

export type RemoteRevisionMetadata = Omit<RevisionMetadata, "payloadCiphertext">;

export interface RemoteRevision extends RemoteRevisionMetadata {
    payloadCiphertext?: RevisionMetadata["payloadCiphertext"];
}

export interface RemoteSharedSpace extends SharedSpaceMetadata {
    revisions: RemoteRevisionMetadata[];
}

export interface RemoteComment extends EncryptedCommentRecord {
    revision: number;
    updatedAt: string;
}

export interface RemoteWorkspaceReadiness {
    ok: true;
    mode: "remote";
}

export interface RemoteWorkspaceAdapter {
    database: RemoteDatabase;
    createSharedSpace(input: CreateRemoteSharedSpaceInput): RemoteSharedSpace;
    verifyCapability(spaceId: string, capability: string, requiredScope: CapabilityScope): Promise<void>;
    getSharedSpace(spaceId: string): RemoteSharedSpace;
    listRevisions(spaceId: string): RemoteRevisionMetadata[];
    getRevision(spaceId: string, revision: number): RevisionMetadata;
    appendRevision(spaceId: string, payloadCiphertext: string, expectedRevision?: number): RevisionMetadata;
    listComments(spaceId: string, revision: number): RemoteComment[];
    appendComment(spaceId: string, revision: number, ciphertext: string): RemoteComment;
    setCommentState(spaceId: string, commentId: string, action: CommentStateChangePayload["action"]): RemoteComment;
    closeSharedSpace(spaceId: string): SharedSpaceMetadata;
    deleteSharedSpace(spaceId: string): void;
    ready(): RemoteWorkspaceReadiness;
    cleanupExpiredSharedSpaces(): number;
    reconcileRetentionPolicy(): void;
    close(): void;
}

// node:sqlite does not infer selected columns; these views follow the remote schema.
interface RemoteSpaceRow extends Record<string, SQLOutputValue> {
    id: string;
    plan_id: string;
    status: NonNullable<SharedSpaceMetadata["status"]>;
    latest_revision: number;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    expires_at: string | null;
}

interface RemoteRevisionRow extends Record<string, SQLOutputValue | undefined> {
    payload_ciphertext?: string;
    space_id: string;
    revision: number;
    created_at: string;
}

interface RemoteCommentRow extends Record<string, SQLOutputValue> {
    id: string;
    space_id: string;
    revision: number;
    ciphertext: string;
    resolved: number;
    created_at: string;
    updated_at: string;
}

const EXPIRED_SPACE_CLEANUP_BATCH_SIZE = 100;

export const SYSTEM_REMOTE_WORKSPACE_CLOCK: Readonly<RemoteWorkspaceClock> = Object.freeze({
    now: () => new Date(),
});

export class RemoteWorkspaceError extends Error {
    declare code: string;
    declare status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = "RemoteWorkspaceError";
        this.code = code;
        this.status = status;
    }
}

export function createRemoteWorkspaceAdapter(options: CreateRemoteWorkspaceAdapterOptions): RemoteWorkspaceAdapter {
    const { database, clock } = options;
    const db = database.handle;
    const retentionDays = options.retention?.days;
    let closed = false;

    const expiryFor = (timestamp: string) => (retentionDays ? addDaysIso(new Date(timestamp), retentionDays) : null);
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
                    const result = db
                        .prepare(
                            `DELETE FROM shared_spaces
                         WHERE id IN (
                             SELECT id FROM shared_spaces
                             WHERE expires_at IS NOT NULL AND expires_at <= ?
                             ORDER BY expires_at, id
                             LIMIT ?
                         )`,
                        )
                        .run(cutoff, EXPIRED_SPACE_CLEANUP_BATCH_SIZE);
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

                const space: SharedSpaceMetadata = {
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
            const row = db
                .prepare(
                    "SELECT space_id, revision, payload_ciphertext, created_at FROM space_revisions WHERE space_id = ? AND revision = ?",
                )
                .get(spaceId, revision);
            if (!row) throw notFound("Revision not found.");
            return mapRevision(row as RemoteRevisionRow, true);
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
            return (
                db
                    .prepare(
                        "SELECT id, space_id, revision, ciphertext, resolved, created_at, updated_at FROM space_comments WHERE space_id = ? AND revision = ? ORDER BY created_at, id",
                    )
                    .all(spaceId, revision) as RemoteCommentRow[]
            ).map(mapComment);
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
                const row = db
                    .prepare(
                        "SELECT id, space_id, revision, ciphertext, resolved, created_at, updated_at FROM space_comments WHERE space_id = ? AND id = ?",
                    )
                    .get(spaceId, commentId) as RemoteCommentRow | undefined;
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

/** Production composition for the remote Workspace adapter. */
export function openRemoteWorkspaceAdapter(options: OpenRemoteWorkspaceAdapterOptions = {}): RemoteWorkspaceAdapter {
    return createRemoteWorkspaceAdapter({
        database: openRemoteDatabase({ dbPath: options.dbPath }),
        retention: options.retention,
        clock: SYSTEM_REMOTE_WORKSPACE_CLOCK,
    });
}

async function verifyCapability(db: DatabaseSync, spaceId: string, capability: string, requiredScope: CapabilityScope) {
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

function getSpaceRow(db: DatabaseSync, spaceId: string): RemoteSpaceRow {
    const row = db
        .prepare(
            "SELECT id, plan_id, status, latest_revision, created_at, updated_at, closed_at, expires_at FROM shared_spaces WHERE id = ?",
        )
        .get(spaceId) as RemoteSpaceRow | undefined;
    if (!row) throw notFound("Shared Space not found or deleted.");
    return row;
}

function getRevisionRow(db: DatabaseSync, spaceId: string, revision: number) {
    const row = db
        .prepare(
            "SELECT space_id, revision, payload_ciphertext, created_at FROM space_revisions WHERE space_id = ? AND revision = ?",
        )
        .get(spaceId, revision);
    if (!row) throw notFound("Revision not found.");
    return row;
}

function listRevisionMetadata(db: DatabaseSync, spaceId: string): RemoteRevisionMetadata[] {
    return db
        .prepare("SELECT space_id, revision, created_at FROM space_revisions WHERE space_id = ? ORDER BY revision")
        .all(spaceId)
        .map((row) => mapRevision(row as RemoteRevisionRow, false));
}

function touchSpace(
    db: DatabaseSync,
    spaceId: string,
    updatedAt: string,
    expiresAt: string | null,
    extraSet = "",
    extraValues: SQLInputValue[] = [],
) {
    const prefix = extraSet ? `${extraSet}, ` : "";
    db.prepare(`UPDATE shared_spaces SET ${prefix}updated_at = ?, expires_at = ? WHERE id = ?`).run(
        ...extraValues,
        updatedAt,
        expiresAt,
        spaceId,
    );
}

function withRevisions(space: SharedSpaceMetadata, revisions: RemoteRevisionMetadata[]): RemoteSharedSpace {
    return { ...space, revisions };
}

function mapSpace(row: RemoteSpaceRow): SharedSpaceMetadata {
    const space: SharedSpaceMetadata = {
        spaceId: String(row.id),
        planId: String(row.plan_id),
        status: String(row.status) as RemoteSpaceRow["status"],
        latestRevision: Number(row.latest_revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
    if (row.closed_at) space.closedAt = String(row.closed_at);
    if (row.expires_at) space.expiresAt = String(row.expires_at);
    return space;
}

function mapRevision(row: RemoteRevisionRow, includePayload: true): RevisionMetadata;
function mapRevision(row: RemoteRevisionRow, includePayload: false): RemoteRevisionMetadata;
function mapRevision(row: RemoteRevisionRow, includePayload: boolean): RemoteRevision {
    const revision: RemoteRevision = {
        spaceId: String(row.space_id),
        revision: Number(row.revision),
        createdAt: String(row.created_at),
    };
    if (includePayload) revision.payloadCiphertext = String(row.payload_ciphertext);
    return revision;
}

function mapComment(row: RemoteCommentRow): RemoteComment {
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

function assertOpen(space: RemoteSpaceRow) {
    if (space.status === "closed") throw conflict("Shared Space is closed.");
}

function addDaysIso(start: Date, days: number) {
    return new Date(start.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function notFound(message: string) {
    return new RemoteWorkspaceError("not_found", message, 404);
}

function conflict(message: string) {
    return new RemoteWorkspaceError("conflict", message, 409);
}
