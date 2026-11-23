/*
 * @module resources/owner-database
 * SQLite opener and migration runner for owner-only coordination state.
 */

import { chmodSync, copyFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "../sqlite.ts";
import { dirname, extname } from "node:path";
import { ensureOwnerDatabaseDirectory, getOwnerCoordinationDatabasePath } from "./paths.ts";
import {
    OWNER_COORDINATION_SCHEMA_V10_SQL,
    OWNER_COORDINATION_SCHEMA_V11_SQL,
    OWNER_COORDINATION_SCHEMA_V12_SQL,
    OWNER_COORDINATION_SCHEMA_V1_SQL,
    OWNER_COORDINATION_SCHEMA_V2_SQL,
    OWNER_COORDINATION_SCHEMA_V3_SQL,
    OWNER_COORDINATION_SCHEMA_V4_SQL,
    OWNER_COORDINATION_SCHEMA_V5_SQL,
    OWNER_COORDINATION_SCHEMA_V6_SQL,
    OWNER_COORDINATION_SCHEMA_V7_SQL,
    OWNER_COORDINATION_SCHEMA_V8_SQL,
    OWNER_COORDINATION_SCHEMA_V9_SQL,
    OWNER_COORDINATION_SCHEMA_VERSION,
} from "./schema.ts";

import type { SQLOutputValue } from "node:sqlite";

export { getOwnerCoordinationDatabasePath, OWNER_COORDINATION_DB_FILENAME } from "./paths.ts";
export { OWNER_COORDINATION_SCHEMA_V1_SQL, OWNER_COORDINATION_SCHEMA_VERSION } from "./schema.ts";

const connectionKey = Symbol("owner coordination connection");

class OwnerCoordinationDatabase {
    readonly #handle: DatabaseSync;
    readonly #path: string;

    private constructor(key: typeof connectionKey, handle: DatabaseSync, path: string) {
        if (key !== connectionKey) throw new Error("Owner coordination connections must be opened by RunWield.");
        this.#handle = handle;
        this.#path = path;
        Object.freeze(this);
    }

    get handle(): DatabaseSync {
        return this.#handle;
    }

    get path(): string {
        return this.#path;
    }

    static isConnection(database: OwnerCoordinationDatabase): boolean {
        return Boolean(database && typeof database === "object" && #handle in database);
    }

    static open(options: OpenOwnerDatabaseOptions): OwnerCoordinationDatabase {
        const path = options.dbPath || getOwnerCoordinationDatabasePath();
        ensureOwnerDatabaseDirectory(path);
        const db = new DatabaseSync(path);
        try {
            db.exec("PRAGMA foreign_keys = ON");
            db.exec("PRAGMA busy_timeout = 5000");
            db.exec("PRAGMA synchronous = FULL");
            runOwnerCoordinationMigrations(db, { dbPath: path, now: options.now });
            if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
            db.exec("PRAGMA synchronous = FULL");
            return new OwnerCoordinationDatabase(connectionKey, db, path);
        } catch (error) {
            db.close();
            throw error;
        }
    }

    close(): void {
        this.#handle.close();
    }

    transaction<Result>(callback: () => Result): Result {
        this.#handle.exec("BEGIN IMMEDIATE");
        try {
            const result = callback();
            this.#handle.exec("COMMIT");
            return result;
        } catch (error) {
            try {
                this.#handle.exec("ROLLBACK");
            } catch {
                /* SQLite may already have rolled back after an I/O failure. */
            }
            throw error;
        }
    }
}

export type { OwnerCoordinationDatabase };

export function isOwnerCoordinationDatabase(database: OwnerCoordinationDatabase): boolean {
    return OwnerCoordinationDatabase.isConnection(database);
}

export interface OpenOwnerDatabaseOptions {
    dbPath?: string;
    now?: () => string;
}

// node:sqlite does not infer the named column returned by PRAGMA quick_check.
interface OwnerDatabaseQuickCheckRow extends Record<string, SQLOutputValue> {
    quick_check: string;
}

export function openOwnerCoordinationDatabase(options: OpenOwnerDatabaseOptions = {}): OwnerCoordinationDatabase {
    return OwnerCoordinationDatabase.open(options);
}

export function runOwnerCoordinationMigrations(db: DatabaseSync, options: OpenOwnerDatabaseOptions = {}) {
    const latestVersion = getLatestSchemaVersionIfPresent(db);
    if (latestVersion > OWNER_COORDINATION_SCHEMA_VERSION) {
        throw new Error(
            `Owner coordination database schema ${latestVersion} is newer than supported schema ${OWNER_COORDINATION_SCHEMA_VERSION}.`,
        );
    }
    if (latestVersion > 0 && latestVersion < OWNER_COORDINATION_SCHEMA_VERSION && options.dbPath) {
        backupOwnerDatabase(db, options.dbPath, latestVersion, options.now);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
        const versionAtLock = getLatestSchemaVersionIfPresent(db);
        if (versionAtLock > OWNER_COORDINATION_SCHEMA_VERSION) {
            throw new Error(
                `Owner coordination database schema ${versionAtLock} is newer than supported schema ${OWNER_COORDINATION_SCHEMA_VERSION}.`,
            );
        }
        if (versionAtLock < 1) {
            db.exec(OWNER_COORDINATION_SCHEMA_V1_SQL);
            recordMigration(db, 1, options.now);
        }
        if (versionAtLock < 2) {
            db.exec(OWNER_COORDINATION_SCHEMA_V2_SQL);
            recordMigration(db, 2, options.now);
        }
        if (versionAtLock < 3) {
            db.exec(OWNER_COORDINATION_SCHEMA_V3_SQL);
            ensureDatabaseEpoch(db, options.now);
            recordMigration(db, 3, options.now);
        } else if (versionAtLock >= 3) {
            ensureDatabaseEpoch(db, options.now);
        }
        if (versionAtLock < 4) {
            assertSessionLocatorProjectConsistency(db);
            db.exec(OWNER_COORDINATION_SCHEMA_V4_SQL);
            recordMigration(db, 4, options.now);
        }
        if (versionAtLock < 5) {
            db.exec(OWNER_COORDINATION_SCHEMA_V5_SQL);
            recordMigration(db, 5, options.now);
        }
        if (versionAtLock < 6) {
            db.exec(OWNER_COORDINATION_SCHEMA_V6_SQL);
            recordMigration(db, 6, options.now);
        }
        if (versionAtLock < 7) {
            db.exec(OWNER_COORDINATION_SCHEMA_V7_SQL);
            recordMigration(db, 7, options.now);
        }
        if (versionAtLock < 8) {
            db.exec(OWNER_COORDINATION_SCHEMA_V8_SQL);
            recordMigration(db, 8, options.now);
        }
        if (versionAtLock < 9) {
            db.exec(OWNER_COORDINATION_SCHEMA_V9_SQL);
            recordMigration(db, 9, options.now);
        }
        if (versionAtLock < 10) {
            db.exec(OWNER_COORDINATION_SCHEMA_V10_SQL);
            purgeRemovedWorkspaceRegistrationsV10(db);
            recordMigration(db, 10, options.now);
        }
        if (versionAtLock < 11) {
            db.exec(OWNER_COORDINATION_SCHEMA_V11_SQL);
            recordMigration(db, 11, options.now);
        }
        if (versionAtLock < 12) {
            db.exec(OWNER_COORDINATION_SCHEMA_V12_SQL);
            recordMigration(db, 12, options.now);
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // SQLite can auto-clear a failed migration transaction; preserve the original migration error.
        }
        throw error;
    }
}

/** Frozen migration cleanup for registrations that were already removed at schema 9. */
function purgeRemovedWorkspaceRegistrationsV10(db: DatabaseSync): void {
    for (const project of db.prepare("SELECT id FROM projects WHERE lifecycle = 'removed'").all()) {
        const projectId = String(project.id);
        for (const table of [
            "owner_session_operations",
            "session_transcript_segment_state",
            "session_activation_state",
            "session_committed_generations",
            "session_transcript_segments",
            "session_transcript_locators",
            "runwield_sessions",
            "project_session_catalog_scans",
            "project_roots",
        ]) {
            db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
        }
        db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    }
}

export function getLatestOwnerCoordinationSchemaVersion(db: DatabaseSync): number {
    return getLatestSchemaVersionIfPresent(db);
}

export function getOwnerCoordinationDatabaseEpoch(db: DatabaseSync): string | null {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_metadata'").get();
    if (!table) return null;
    const row = db.prepare("SELECT value FROM owner_metadata WHERE key = 'database_epoch'").get();
    return typeof row?.value === "string" ? row.value : null;
}

function getLatestSchemaVersionIfPresent(db: DatabaseSync): number {
    const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (!table) return 0;
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    return Number(row?.version ?? 0);
}

function recordMigration(db: DatabaseSync, version: number, now?: OpenOwnerDatabaseOptions["now"]) {
    const row = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version);
    if (row) return;
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        now ? now() : new Date().toISOString(),
    );
}

function ensureDatabaseEpoch(db: DatabaseSync, now?: OpenOwnerDatabaseOptions["now"]) {
    const existing = getOwnerCoordinationDatabaseEpoch(db);
    if (existing) return;
    db.prepare("INSERT INTO owner_metadata(key, value, updated_at) VALUES ('database_epoch', ?, ?)").run(
        crypto.randomUUID(),
        now ? now() : new Date().toISOString(),
    );
}

function assertSessionLocatorProjectConsistency(db: DatabaseSync) {
    const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_transcript_locators'")
        .get();
    if (!table) return;
    const row = db
        .prepare(
            `SELECT COUNT(*) AS mismatches
           FROM session_transcript_locators locators
           JOIN runwield_sessions sessions
             ON sessions.id = locators.runwield_session_id
          WHERE sessions.project_id <> locators.project_id`,
        )
        .get();
    if (Number(row?.mismatches || 0) > 0) {
        throw new Error("Owner coordination migration found Session transcript locators with mismatched Project IDs");
    }
}

function fileExists(path: string) {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function backupPathFor(dbPath: string, sourceVersion: number, now?: OpenOwnerDatabaseOptions["now"]) {
    const stamp = (now ? now() : new Date().toISOString()).replace(/[:.]/g, "-");
    const suffix = extname(dbPath);
    if (!suffix) return `${dbPath}.backup-v${sourceVersion}-${stamp}.sqlite3`;
    const base = dbPath.slice(0, dbPath.length - suffix.length);
    return `${base}.backup-v${sourceVersion}-${stamp}${suffix}`;
}

function backupOwnerDatabase(
    db: DatabaseSync,
    dbPath: string,
    sourceVersion: number,
    now?: OpenOwnerDatabaseOptions["now"],
) {
    if (!dbPath || dbPath === ":memory:" || !fileExists(dbPath)) return;
    // Use SQLite's opened location. Deno resolves macOS /var and /tmp aliases
    // when opening a database, but VACUUM INTO does not pass through that resolver.
    const openedPath = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.file;
    if (typeof openedPath !== "string" || !openedPath) throw new Error("Cannot locate the owner database for backup.");
    const backupPath = backupPathFor(openedPath, sourceVersion, now);
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    // node:sqlite cannot open a VACUUM INTO destination in this runtime. Checkpoint
    // WAL content before copying so the backup includes all committed data.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(dbPath, backupPath);
    try {
        chmodSync(backupPath, 0o600);
    } catch {
        // Some filesystems do not support chmod; creation location is still owner-only best effort.
    }
    const backup = new DatabaseSync(backupPath);
    try {
        backup.exec("PRAGMA journal_mode = DELETE");
        const quickCheck = backup.prepare("PRAGMA quick_check").get() as OwnerDatabaseQuickCheckRow;
        if (quickCheck.quick_check !== "ok") {
            throw new Error(`Owner coordination backup failed quick_check: ${backupPath}`);
        }
        const observedVersion = getLatestSchemaVersionIfPresent(backup);
        if (observedVersion !== sourceVersion) {
            throw new Error(
                `Owner coordination backup schema ${observedVersion} did not match source schema ${sourceVersion}: ${backupPath}`,
            );
        }
    } finally {
        backup.close();
        // This node:sqlite build creates empty sidecars while opening the new
        // backup read-only. They are inspection artifacts, not backup data.
        for (const suffix of ["-wal", "-shm"]) {
            try {
                unlinkSync(`${backupPath}${suffix}`);
            } catch {
                // The SQLite build did not create this sidecar.
            }
        }
    }
}
