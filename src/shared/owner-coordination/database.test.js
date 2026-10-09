import { assertEquals, assertFalse, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { getLatestOwnerCoordinationSchemaVersion, openOwnerCoordinationDatabase } from "./database.js";
import { OWNER_COORDINATION_SCHEMA_V1_SQL, OWNER_COORDINATION_SCHEMA_VERSION } from "./schema.ts";

/** @param {string} path */
async function exists(path) {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

Deno.test("owner database opens on disk with schema, WAL, foreign keys, and rollback-safe transactions", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-db-" });
    const dbPath = `${dir}/owner.sqlite3`;
    try {
        const database = openOwnerCoordinationDatabase({ dbPath });
        try {
            assertEquals(getLatestOwnerCoordinationSchemaVersion(database.handle), OWNER_COORDINATION_SCHEMA_VERSION);
            const foreignKeys =
                /** @type {{ foreign_keys: number }} */ (database.handle.prepare("PRAGMA foreign_keys").get());
            assertEquals(foreignKeys.foreign_keys, 1);
            const journalMode =
                /** @type {{ journal_mode: string }} */ (database.handle.prepare("PRAGMA journal_mode").get());
            assertEquals(String(journalMode.journal_mode).toLowerCase(), "wal");
            assertThrows(
                () =>
                    database.transaction(() => {
                        database.handle.prepare(
                            "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('rollback', 'Rollback', '/tmp/a', '/tmp/a', 'enabled', 'now', 'now')",
                        ).run();
                        throw new Error("rollback");
                    }),
                Error,
                "rollback",
            );
            const row = database.handle.prepare("SELECT id FROM projects WHERE id = 'rollback'").get();
            assertEquals(row, undefined);
        } finally {
            database.close();
        }
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner database refuses newer schema without recording local migrations", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-newer-" });
    const dbPath = `${dir}/owner.sqlite3`;
    try {
        const fixture = new DatabaseSync(dbPath);
        fixture.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
        fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(999, "future");
        fixture.close();

        assertThrows(
            () => openOwnerCoordinationDatabase({ dbPath }),
            Error,
            "newer than supported",
        );

        const check = new DatabaseSync(dbPath);
        try {
            const rows = check.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
            assertEquals(rows.map((row) => row.version), [999]);
            const projectsTable = check.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
            ).get();
            assertEquals(projectsTable, undefined);
            const journalMode = /** @type {{ journal_mode: string }} */ (check.prepare("PRAGMA journal_mode").get());
            assertFalse(["wal"].includes(String(journalMode.journal_mode).toLowerCase()));
            assertFalse(await exists(`${dbPath}-wal`));
            assertFalse(await exists(`${dbPath}-shm`));
        } finally {
            check.close();
        }
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner database reports corrupted files visibly and does not delete them", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-corrupt-" });
    const dbPath = `${dir}/owner.sqlite3`;
    try {
        await Deno.writeTextFile(dbPath, "not sqlite");
        assertThrows(
            () => openOwnerCoordinationDatabase({ dbPath }),
            Error,
        );
        assertEquals(await Deno.readTextFile(dbPath), "not sqlite");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner database enforces transcript locator Project consistency", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-fk-" });
    const dbPath = `${dir}/owner.sqlite3`;
    try {
        const database = openOwnerCoordinationDatabase({ dbPath });
        try {
            database.handle.prepare(
                "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('p1', 'P1', '/tmp/p1', '/tmp/p1', 'enabled', 'now', 'now')",
            ).run();
            database.handle.prepare(
                "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('p2', 'P2', '/tmp/p2', '/tmp/p2', 'enabled', 'now', 'now')",
            ).run();
            database.handle.prepare(
                "INSERT INTO runwield_sessions(id, project_id, created_at, updated_at) VALUES ('s1', 'p1', 'now', 'now')",
            ).run();
            assertThrows(
                () =>
                    database.handle.prepare(
                        "INSERT INTO session_transcript_locators(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, first_cataloged_at, last_cataloged_at) VALUES ('l1', 's1', 'p2', 'pi', '/tmp/p2/t.jsonl', '/tmp/p2', 'now', 'now')",
                    ).run(),
                Error,
            );
        } finally {
            database.close();
        }
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner database migration rejects existing locator Project mismatches", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-migration-mismatch-" });
    const dbPath = `${dir}/owner.sqlite3`;
    try {
        const fixture = new DatabaseSync(dbPath);
        try {
            fixture.exec(`
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    registered_root TEXT NOT NULL,
    current_root TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('enabled', 'disabled', 'removed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE runwield_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'catalog' CHECK (source IN ('catalog', 'created', 'imported')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);
CREATE TABLE session_transcript_locators (
    id TEXT PRIMARY KEY,
    runwield_session_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    pi_session_id TEXT NOT NULL,
    transcript_path TEXT NOT NULL UNIQUE,
    transcript_cwd TEXT NOT NULL,
    header_version INTEGER,
    header_timestamp TEXT,
    first_cataloged_at TEXT NOT NULL,
    last_cataloged_at TEXT NOT NULL,
    FOREIGN KEY (runwield_session_id) REFERENCES runwield_sessions(id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    UNIQUE(project_id, pi_session_id)
);
CREATE TABLE owner_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`);
            fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "v1");
            fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, "v2");
            fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, "v3");
            fixture.prepare(
                "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('p1', 'P1', '/tmp/p1', '/tmp/p1', 'enabled', 'now', 'now')",
            ).run();
            fixture.prepare(
                "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('p2', 'P2', '/tmp/p2', '/tmp/p2', 'enabled', 'now', 'now')",
            ).run();
            fixture.prepare(
                "INSERT INTO runwield_sessions(id, project_id, created_at, updated_at) VALUES ('s1', 'p1', 'now', 'now')",
            ).run();
            fixture.prepare(
                "INSERT INTO session_transcript_locators(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, first_cataloged_at, last_cataloged_at) VALUES ('l1', 's1', 'p2', 'pi', '/tmp/p2/t.jsonl', '/tmp/p2', 'now', 'now')",
            ).run();
        } finally {
            fixture.close();
        }

        assertThrows(
            () => openOwnerCoordinationDatabase({ dbPath }),
            Error,
            "mismatched Project IDs",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner database backs up extensionless explicit paths without truncating the filename", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-backup-extensionless-" });
    const dbPath = `${dir}/ownerdb`;
    try {
        const fixture = new DatabaseSync(dbPath);
        try {
            fixture.exec(OWNER_COORDINATION_SCHEMA_V1_SQL);
            fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "v1");
        } finally {
            fixture.close();
        }
        const database = openOwnerCoordinationDatabase({
            dbPath,
            now: () => "2026-01-01T00:00:00.000Z",
        });
        database.close();
        assertEquals(await exists(`${dir}/ownerdb.backup-v1-2026-01-01T00-00-00-000Z.sqlite3`), true);
        assertEquals(await exists(`${dir}/.backup-v1-2026-01-01T00-00-00-000Z.sqlite3`), false);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner database migration backs up committed WAL contents before changing the schema", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-wal-backup-" });
    const dbPath = `${dir}/owner.sqlite3`;
    const fixture = new DatabaseSync(dbPath);
    try {
        fixture.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
        fixture.exec(OWNER_COORDINATION_SCHEMA_V1_SQL);
        fixture.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "v1");
        fixture.exec("CREATE TABLE backup_probe(value TEXT NOT NULL)");
        fixture.prepare("INSERT INTO backup_probe(value) VALUES (?)").run("committed WAL contents");
        assertEquals((await Deno.stat(`${dbPath}-wal`)).size > 0, true);
        const database = openOwnerCoordinationDatabase({ dbPath, now: () => "2026-01-01T00:00:00.000Z" });
        try {
            const backup = new DatabaseSync(`${dir}/owner.backup-v1-2026-01-01T00-00-00-000Z.sqlite3`, {
                readOnly: true,
            });
            try {
                assertEquals(getLatestOwnerCoordinationSchemaVersion(backup), 1);
                assertEquals(backup.prepare("SELECT value FROM backup_probe").get()?.value, "committed WAL contents");
                assertEquals(backup.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
            } finally {
                backup.close();
            }
            assertEquals(getLatestOwnerCoordinationSchemaVersion(database.handle), OWNER_COORDINATION_SCHEMA_VERSION);
        } finally {
            database.close();
        }
    } finally {
        fixture.close();
        await Deno.remove(dir, { recursive: true });
    }
});
