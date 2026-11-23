import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { env, execPath, platform } from "node:process";
import { chmodSync as fsChmodSync, readdirSync as fsReaddirSync } from "node:fs";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    realpath as fsRealpath,
    rename as fsRename,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "./database.ts";
import { openOwnerCoordinationStore } from "./index.ts";
import { DirectoryConfirmationRequired, parseProjectId, projects, type ProjectLaunchContext } from "@runwield/projects";
import { bindProjectRegistry } from "@runwield/projects/owner-coordination";
import { manifestPath } from "@runwield/session-files";
import { classifyRootSessionLocator } from "../session/root-session.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getOwnerCoordinationDatabasePath, OWNER_COORDINATION_SCHEMA_V1_SQL } from "@runwield/resources/owner-database";
import { DatabaseSync } from "@runwield/resources/sqlite";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";

const gitFixture = defineCommittedGitFixture();

test("Project registration converges symlink aliases and re-adding after removal retains the admitted Project ID", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-reg-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        const root = join(dir, `repo`);
        const link = join(dir, `repo-link`);
        await fsMkdir(root);
        await fsSymlink(root, link);
        const direct = registry.register({ root, now: () => "t1" });
        const viaLink = registry.register({ root: link, now: () => "t2" });
        assertEquals(viaLink.projectId, direct.projectId);
        assertEquals(viaLink.status, "active");
        assertEquals(
            registry
                .listRootEvidence(direct.projectId)
                .map((rootEvidence) => rootEvidence.enteredRoot)
                .sort(),
            [link, root].sort(),
        );

        registry.remove(direct.projectId);
        assertEquals(registry.get(direct.projectId), null);
        assertEquals(registry.list(), []);
        assertEquals(registry.listRootEvidence(direct.projectId), []);
        assertThrows(() => registry.requireActiveRoot(direct.projectId), Error, "not found");

        const restored = registry.register({ root, now: () => "t4" });
        assertEquals(restored.projectId, direct.projectId);
        assertEquals(restored.status, "active");
        assertEquals(registry.requireActiveRoot(restored.projectId), await fsRealpath(root));
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test(
    "Windows Project aliases retain native canonical identity and health",
    { skip: platform !== "win32" },
    async () => {
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-alias-"));
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, "owner.sqlite3") });
        const registry = bindProjectRegistry(database);
        try {
            const root = join(dir, "Mixed Case Project");
            await fsMkdir(root);
            const canonicalRoot = await fsRealpath(root);
            const enteredRoot = root.toLowerCase();
            assertNotEquals(enteredRoot, canonicalRoot);
            const project = registry.register({ root: enteredRoot });
            assertEquals(project.currentRoot, canonicalRoot);
            assertEquals(registry.getHealth(project.projectId).status, "available");
            assertEquals(registry.getHealth(project.projectId).observedRealRoot, canonicalRoot);
            assertEquals(registry.register({ root: canonicalRoot }).projectId, project.projectId);
            assertEquals(registry.list().length, 1);
            assertEquals(
                registry.listRootEvidence(project.projectId).map((item) => item.canonicalRoot),
                [canonicalRoot, canonicalRoot],
            );
        } finally {
            database.close();
            await fsRm(dir, { recursive: true });
        }
    },
);

test("relinking a Project keeps its new directory available", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-relink-health-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, "owner.sqlite3") });
    const registry = bindProjectRegistry(database);
    try {
        const originalRoot = join(dir, "Original Project");
        const newRoot = join(dir, "Relinked Project");
        await fsMkdir(originalRoot);
        const project = registry.register({ root: originalRoot });
        await fsRename(originalRoot, newRoot);
        await fsMkdir(originalRoot);
        assertEquals(registry.getHealth(project.projectId).status, "identity_mismatch");
        assertThrows(() => registry.requireActiveRoot(project.projectId), Error, "identity_mismatch");
        assertThrows(() => registry.register({ root: originalRoot }), Error, "identity");
        assertThrows(() => registry.relink({ projectId: project.projectId, newRoot: originalRoot }), Error, "identity");
        assertEquals(await fsReaddir(originalRoot), []);
        registry.relink({ projectId: project.projectId, newRoot });
        assertEquals(registry.requireActiveRoot(project.projectId), await fsRealpath(newRoot));
        assertEquals(registry.getHealth(project.projectId).status, "available");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Inactive Projects stay inactive on duplicate registration", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-inactive-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        const root = join(dir, `repo`);
        await fsMkdir(root);
        const project = registry.register({ root, now: () => "t1" });
        registry.setStatus(project.projectId, "inactive", { now: () => "t2" });
        const duplicate = registry.register({ root, now: () => "t3" });
        assertEquals(duplicate.projectId, project.projectId);
        assertEquals(duplicate.status, "inactive");
        assertEquals(duplicate.inactiveAt, "t2");
        const health = registry.getHealth(project.projectId);
        assertEquals(health.status, "available");
        assertEquals(health.projectStatus, "inactive");
        assertThrows(() => registry.requireActiveRoot(project.projectId), Error, "inactive");
        assertThrows(
            () => Reflect.apply(registry.setStatus, registry, [project.projectId, "removed"]),
            Error,
            "Invalid Project status",
        );
        assertEquals(registry.get(project.projectId), duplicate);
        const active = registry.setStatus(project.projectId, "active", { now: () => "t4" });
        assertEquals(active.status, "active");
        assertEquals(active.inactiveAt, null);
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Project health is filesystem-based and non-Git directories are available", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-health-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        const root = join(dir, `plain-directory`);
        await fsMkdir(root);
        const project = registry.register({ root, now: () => "t1" });
        assertEquals(registry.getHealth(project.projectId).status, "available");
        await fsRm(root, { recursive: true });
        assertEquals(registry.getHealth(project.projectId).status, "missing");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test(
    "Project health reports unreadable registered roots distinctly from missing roots",
    { skip: platform === "win32" },
    async () => {
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-unreadable-"));
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        const registry = bindProjectRegistry(database);
        const root = join(dir, `repo`);
        try {
            await fsMkdir(root);
            const project = registry.register({ root, now: () => "t1" });
            try {
                fsChmodSync(root, 0o000);
                assertEquals(registry.getHealth(project.projectId).status, "unreadable");
            } finally {
                fsChmodSync(root, 0o700);
            }
        } finally {
            database.close();
            await fsRm(dir, { recursive: true });
        }
    },
);

test("Project removal clears dependent database records and rolls back on failure", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-remove-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        const project = registry.register({ root: dir });
        const id = project.projectId;
        const db = database.handle;
        db.prepare(
            "INSERT INTO runwield_sessions(id, project_id, created_at, updated_at) VALUES ('session', ?, 'now', 'now')",
        ).run(id);
        db.prepare(
            "INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, ordinal, kind, sealed_at, first_cataloged_at, last_cataloged_at) VALUES ('segment', 'session', ?, 'pi', '/transcript', ?, 0, 'planning', 'now', 'now', 'now')",
        ).run(id, dir);
        db.prepare(
            "UPDATE session_transcript_segment_state SET current_segment_id = 'segment' WHERE project_id = ?",
        ).run(id);
        db.prepare(
            "INSERT INTO session_committed_generations(runwield_session_id, project_id, generation, digest_algorithm, byte_length, digest_hex, operation_id, fence, committed_at) VALUES ('session', ?, 0, 'sha256', 0, 'digest', 'operation', 1, 'now')",
        ).run(id);
        db.prepare(
            "INSERT INTO session_transcript_locators(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, first_cataloged_at, last_cataloged_at) VALUES ('locator', 'session', ?, 'pi', '/transcript', ?, 'now', 'now')",
        ).run(id, dir);
        db.prepare(
            "INSERT INTO project_session_catalog_scans(project_id, cwd, session_dir, last_scanned_at) VALUES (?, ?, '/sessions', 'now')",
        ).run(id, dir);
        db.prepare(
            "INSERT INTO owner_session_operations(id, request_id, request_hash, runwield_session_id, project_id, kind, status, operation_id, started_at, updated_at) VALUES ('receipt', 'request', 'hash', 'session', ?, 'continuation', 'completed', 'operation', 'now', 'now')",
        ).run(id);
        assertThrows(() => db.exec("DELETE FROM session_committed_generations"), Error, "append-only");
        assertThrows(() => db.exec("DELETE FROM session_transcript_segments"), Error, "immutable");
        db.exec("CREATE TRIGGER fail_removal BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'test failure'); END");
        assertThrows(() => registry.remove(id), Error, "test failure");
        assertEquals(registry.get(id)?.status, "active");
        assertEquals(db.prepare("SELECT COUNT(*) AS count FROM session_committed_generations").get()?.count, 1);
        db.exec("DROP TRIGGER fail_removal");
        registry.remove(id);
        for (const table of [
            "projects",
            "project_roots",
            "runwield_sessions",
            "session_transcript_locators",
            "project_session_catalog_scans",
            "session_activation_state",
            "session_committed_generations",
            "owner_session_operations",
            "session_transcript_segments",
            "session_transcript_segment_state",
        ]) {
            assertEquals(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
        }
        assertEquals(db.prepare("PRAGMA foreign_key_check").all(), []);
        assertThrows(() => registry.remove(id), Error, "not found");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("migration deletes previously removed registrations and preserves other Projects", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-removal-migration-"));
    const dbPath = join(dir, `owner.sqlite3`);
    const database = openOwnerCoordinationDatabase({ dbPath });
    const registry = bindProjectRegistry(database);
    let keptId;
    try {
        await fsMkdir(join(dir, "removed"));
        await fsMkdir(join(dir, "kept"));
        const removed = registry.register({ root: join(dir, "removed") });
        keptId = registry.register({ root: join(dir, `kept`) }).projectId;
        database.handle.prepare("UPDATE projects SET lifecycle = 'removed' WHERE id = ?").run(removed.projectId);
        database.handle.exec(`
            DROP INDEX idx_projects_canonical_project_id;
            ALTER TABLE projects DROP COLUMN canonical_project_id;
            ALTER TABLE project_roots DROP COLUMN display_name;
            DELETE FROM schema_migrations WHERE version >= 10;
        `);
    } finally {
        database.close();
    }
    const migrated = openOwnerCoordinationDatabase({ dbPath });
    try {
        assertEquals(
            bindProjectRegistry(migrated)
                .list()
                .map((project) => project.projectId),
            [keptId],
        );
        assertEquals(migrated.handle.prepare("PRAGMA foreign_key_check").all(), []);
        assertEquals((await fsStat(join(dir, `kept`))).isDirectory(), true);
        const backups = Array.from(fsReaddirSync(dir, { withFileTypes: true })).filter((entry) =>
            entry.name.includes("backup-v9"),
        );
        assertEquals(backups.length, 1);
    } finally {
        migrated.close();
        await fsRm(dir, { recursive: true });
    }
});

test("legacy registrations converge on their admitted Project ID and preserve dependent data", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-identity-migration-"));
    const dbPath = join(dir, "owner.sqlite3");
    const root = join(dir, "primary");
    const alias = join(dir, "alias");
    await fsMkdir(root);
    await fsSymlink(root, alias, "junction");
    try {
        const admitted = await projects.checkout.admit(root);
        if (admitted.kind !== "existing") throw new Error(`Unexpected checkout identity: ${admitted.kind}`);
        const canonicalId = admitted.identity.projectId;
        const oldId = crypto.randomUUID();
        const oldAliasId = parseProjectId(crypto.randomUUID())!;
        const canonicalRoot = await fsRealpath(root);
        const database = openOwnerCoordinationDatabase({ dbPath });
        try {
            const db = database.handle;
            db.exec(`
                DROP INDEX idx_projects_canonical_project_id;
                ALTER TABLE projects DROP COLUMN canonical_project_id;
                ALTER TABLE project_roots DROP COLUMN display_name;
                DELETE FROM schema_migrations WHERE version >= 11;
            `);
            const addProject = db.prepare(
                `INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at, disabled_at)
                 VALUES (?, ?, ?, ?, 'disabled', ?, 't2', 't2')`,
            );
            addProject.run(oldId, "Migration fixture", root, canonicalRoot, "t0");
            addProject.run(oldAliasId, "Alias fixture", alias, canonicalRoot, "t1");
            const addRoot = db.prepare(
                `INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, created_at)
                 VALUES (?, ?, ?, ?, 'current', 't0')`,
            );
            addRoot.run("primary", oldId, root, canonicalRoot);
            addRoot.run("alias", oldAliasId, alias, canonicalRoot);
            db.prepare(
                "INSERT INTO runwield_sessions(id, project_id, created_at, updated_at) VALUES ('session', ?, 't1', 't1')",
            ).run(oldAliasId);
            db.prepare(
                `INSERT INTO owner_session_operations(id, request_id, request_hash, runwield_session_id, project_id,
                                                      kind, status, operation_id, started_at, updated_at)
                 VALUES ('receipt', 'request', 'hash', 'session', ?, 'continuation', 'completed', 'operation', 't1', 't2')`,
            ).run(oldAliasId);
        } finally {
            database.close();
        }
        const owner = openOwnerCoordinationStore({ dbPath });
        const observer = new DatabaseSync(dbPath, { readOnly: true });
        const bindings = () =>
            observer
                .prepare("SELECT canonical_project_id FROM projects ORDER BY id")
                .all()
                .map((row) => row.canonical_project_id);
        try {
            assertEquals(bindings(), [null, null]);
            const { projects: registry } = owner;
            assertEquals(
                registry.list().map((item) => [item.projectId, item.displayName, item.status, item.inactiveAt]),
                [[canonicalId, "Migration fixture", "inactive", "t2"]],
            );
            assertEquals(registry.get(oldId), null);
            assertEquals(registry.get(oldAliasId), null);
            assertThrows(() => registry.setStatus(oldAliasId, "active"), Error, "not found");
            assertEquals(registry.get(canonicalId)?.currentRoot, canonicalRoot);
            assertEquals(registry.getHealth(canonicalId).status, "available");
            assertThrows(() => registry.requireActiveRoot(canonicalId), Error, "inactive");
            assertEquals(
                registry
                    .listRootEvidence(canonicalId)
                    .map(({ enteredRoot, displayName }) => [enteredRoot, displayName])
                    .sort(),
                [
                    [root, "Migration fixture"],
                    [alias, "Alias fixture"],
                ].sort(),
            );
            assertEquals(owner.getOperationReceipt("operation")?.projectId, canonicalId);
            assertEquals(
                owner.findOperationReceiptByRequest({
                    projectId: canonicalId,
                    requestHash: "hash",
                    requestId: "request",
                })?.operationId,
                "operation",
            );
            assertEquals(
                owner.findOperationReceiptByRequest({
                    projectId: oldAliasId,
                    requestHash: "hash",
                    requestId: "request",
                }),
                null,
            );
            assertEquals(bindings(), [null, null]);
            assertEquals(registry.register({ root: alias }).projectId, canonicalId);
            assertEquals(bindings(), [canonicalId, canonicalId]);
            assertEquals(registry.setStatus(canonicalId, "active").status, "active");
            registry.remove(canonicalId);
            assertEquals(registry.list(), []);
            assertEquals(owner.getOperationReceipt("operation"), null);
        } finally {
            observer.close();
            owner.close();
        }
        assertEquals((await fsStat(root)).isDirectory(), true);
        const reopened = openOwnerCoordinationDatabase({ dbPath });
        try {
            assertEquals(reopened.handle.prepare("PRAGMA foreign_key_check").all(), []);
            assertEquals(reopened.handle.prepare("SELECT COUNT(*) AS count FROM runwield_sessions").get()?.count, 0);
        } finally {
            reopened.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("relink migrates a moved legacy registration using committed checkout history", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-moved-legacy-registration-"));
    const root = join(dir, "prior-checkout");
    const destination = join(dir, "moved-checkout");
    const foreignRoot = join(dir, "unrelated-checkout");
    const dbPath = join(dir, "owner.sqlite3");
    await Promise.all([fsMkdir(root), fsMkdir(foreignRoot)]);
    const database = openOwnerCoordinationDatabase({ dbPath });
    try {
        const canonicalRoot = await fsRealpath(root);
        const admitted = await projects.checkout.admit(root);
        const foreign = await projects.checkout.admit(foreignRoot);
        if (admitted.kind !== "existing" || foreign.kind !== "existing") throw new Error("Expected admitted Projects");
        const legacyId = parseProjectId(crypto.randomUUID())!;
        database.handle
            .prepare(
                `INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at)
             VALUES (?, 'Retained name', ?, ?, 'enabled', 't1', 't1')`,
            )
            .run(legacyId, root, canonicalRoot);
        database.handle
            .prepare(
                `INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, created_at)
             VALUES ('original', ?, ?, ?, 'current', 't1')`,
            )
            .run(legacyId, root, canonicalRoot);
        await fsRename(root, destination);

        const registry = bindProjectRegistry(database);
        assertEquals(registry.getHealth(legacyId).status, "missing");
        assertThrows(
            () => registry.relink({ projectId: legacyId, newRoot: foreignRoot }),
            Error,
            "belongs to another Project",
        );
        const relinked = registry.relink({ projectId: legacyId, newRoot: destination });
        assertEquals(relinked.projectId, admitted.identity.projectId);
        assertEquals(relinked.displayName, "Retained name");
        assertEquals(registry.get(legacyId), null);
        assertEquals(registry.getHealth(relinked.projectId).status, "available");
        assertEquals(
            registry.listRootEvidence(relinked.projectId).map(({ rootState }) => rootState),
            ["current", "historical"],
        );
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("first Core entry retains the legacy Project UUID before Workspace upgrades its database", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-core-first-identity-migration-"));
    const home = join(dir, "home");
    const root = join(dir, "checkout");
    await fsMkdir(join(home, ".wld"), { recursive: true });
    await fsMkdir(root);
    const dbPath = getOwnerCoordinationDatabasePath({ home });
    const oldId = crypto.randomUUID();
    const canonicalRoot = await fsRealpath(root);
    try {
        const database = new DatabaseSync(dbPath);
        try {
            database.exec(OWNER_COORDINATION_SCHEMA_V1_SQL);
            database.exec("INSERT INTO schema_migrations(version, applied_at) VALUES (1, 't1')");
            database
                .prepare(
                    `INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at, disabled_at)
                 VALUES (?, 'Previous registration', ?, ?, 'disabled', 't1', 't2', 't2')`,
                )
                .run(oldId, root, canonicalRoot);
            database
                .prepare(
                    `INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, created_at)
                 VALUES ('root', ?, ?, ?, 'current', 't1')`,
                )
                .run(oldId, root, canonicalRoot);
            await projects.launch.withContext(
                {
                    executionAccountHome: home,
                    personalOwner: { kind: "execution-account", identity: home },
                },
                async () => {
                    assertEquals(projects.checkout.inspect(root).kind, "fresh");
                    assertEquals(await fsReaddir(root), []);
                    const admitted = await projects.checkout.admit(root);
                    assertEquals(admitted.kind === "existing" ? admitted.identity.projectId : admitted.kind, oldId);
                },
            );
            assertEquals(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 1);
        } finally {
            database.close();
        }
        const owner = openOwnerCoordinationStore({ dbPath });
        try {
            assertEquals(owner.projects.get(oldId)?.status, "inactive");
            assertEquals(owner.projects.get(oldId)?.displayName, "Previous registration");
            assertEquals(owner.projects.getHealth(oldId).status, "available");
        } finally {
            owner.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("Project relink preserves root history and rejects another Project root", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-relink-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    const oldRoot = await gitFixture.checkout();
    try {
        const newRoot = join(dir, `new`);
        const otherRoot = join(dir, `other`);
        await fsMkdir(otherRoot);
        const project = registry.register({ root: oldRoot, displayName: "Primary checkout", now: () => "t1" });
        const other = registry.register({ root: otherRoot, now: () => "t2" });
        await git(oldRoot, ["worktree", "add", "-b", "feature", newRoot]);
        const sameProject = registry.register({ root: newRoot, displayName: "Feature checkout" });
        assertEquals(sameProject.projectId, project.projectId);
        assertEquals(sameProject.displayName, "Primary checkout");
        assertEquals(
            registry.listRootEvidence(project.projectId).map((root) => root.displayName),
            ["Primary checkout", "Feature checkout"],
        );
        const relinked = registry.relink({
            projectId: project.projectId,
            newRoot,
            now: () => "t3",
        });
        assertEquals(relinked.projectId, project.projectId);
        assertEquals(relinked.currentRoot, await fsRealpath(newRoot));
        const roots = registry.listRootEvidence(project.projectId);
        assertEquals(
            roots.map((root) => [root.rootState, root.displayName]),
            [
                ["current", "Feature checkout"],
                ["historical", "Primary checkout"],
            ],
        );
        const duplicateHistorical = registry.register({ root: oldRoot, now: () => "t4" });
        assertEquals(duplicateHistorical.currentRoot, await fsRealpath(newRoot));
        assertEquals(
            registry
                .listRootEvidence(project.projectId)
                .filter((root) => root.rootState === "current")
                .map((root) => root.canonicalRoot),
            [await fsRealpath(newRoot)],
        );
        assertThrows(
            () => registry.relink({ projectId: project.projectId, newRoot: otherRoot }),
            Error,
            "another Project",
        );
        assertEquals(registry.requireActiveRoot(other.projectId), await fsRealpath(otherRoot));
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
        await fsRm(oldRoot, { recursive: true });
    }
});

test("Project registration and relink report symlink path reuse conflicts", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-retarget-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        const firstRoot = join(dir, `first`);
        const secondRoot = join(dir, `second`);
        const link = join(dir, `project-link`);
        await fsMkdir(firstRoot);
        await fsMkdir(secondRoot);
        await fsSymlink(firstRoot, link);
        const project = registry.register({ root: link, now: () => "t1" });
        await fsRm(link);
        await fsSymlink(secondRoot, link);

        assertThrows(() => registry.register({ root: link, now: () => "t2" }), Error, "path reuse or symlink retarget");
        assertThrows(
            () => registry.relink({ projectId: project.projectId, newRoot: link }),
            Error,
            "path reuse or symlink retarget",
        );
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test(
    "independent processes contend for one Project registration and preserve only its two root aliases",
    { timeout: 20_000 },
    async () => {
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-race-"));
        const dbPath = join(dir, "owner.sqlite3");
        const database = openOwnerCoordinationDatabase({ dbPath });
        const root = join(dir, "repo");
        const alias = join(dir, "alias");
        const script = String.raw`
        import { stdin, stdout } from "node:process";
        import { openOwnerCoordinationDatabase } from ${JSON.stringify(import.meta.resolve("@runwield/resources/owner-database"))};
        import { bindProjectRegistry } from ${JSON.stringify(import.meta.resolve("@runwield/projects/owner-coordination"))};
        const [dbPath, root] = process.argv.slice(1);
        const database = openOwnerCoordinationDatabase({ dbPath });
        try {
            const registry = bindProjectRegistry(database);
            stdout.write("ready\n");
            for await (const _ of stdin) {}
            database.handle.exec("PRAGMA busy_timeout = 0");
            try {
                database.transaction(() => {});
                throw new Error("Expected contention from the held writer lock");
            } catch (error) {
                if (!(error instanceof Error) || !error.message.includes("database is locked")) throw error;
            }
            stdout.write("contended\n");
            database.handle.exec("PRAGMA busy_timeout = 5000");
            const { projectId } = registry.register({ root });
            stdout.write(projectId + "\n");
        } finally {
            database.close();
        }
    `;
        await fsMkdir(root);
        await fsSymlink(root, alias);
        const workers: ReturnType<typeof startWorker>[] = [];
        function startWorker(enteredRoot: string) {
            const child = spawn(execPath, ["-e", script, dbPath, enteredRoot], { stdio: ["pipe", "pipe", "inherit"] });
            const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
            return { child, lines, exited: once(child, "exit") };
        }
        try {
            for (const enteredRoot of [root, alias]) {
                const worker = startWorker(enteredRoot);
                workers.push(worker);
                assertEquals((await worker.lines.next()).value, "ready");
            }
            database.handle.exec("BEGIN IMMEDIATE");
            try {
                for (const { child } of workers) child.stdin.end();
                for (const { lines } of workers) assertEquals((await lines.next()).value, "contended");
            } finally {
                database.handle.exec("ROLLBACK");
            }
            const [first, second] = await Promise.all(workers.map(async ({ lines }) => (await lines.next()).value));
            assertEquals(first, second);
            assertEquals(await Promise.all(workers.map(({ exited }) => exited)), [
                [0, null],
                [0, null],
            ]);
            const registry = bindProjectRegistry(database);
            const owned = registry.list();
            assertEquals(
                owned.map((project) => project.projectId),
                [first],
            );
            const evidence = registry.listRootEvidence(owned[0].projectId);
            const canonicalRoot = await fsRealpath(root);
            assertEquals(
                evidence
                    .map(({ enteredRoot, canonicalRoot, rootState }) => [enteredRoot, canonicalRoot, rootState])
                    .sort(),
                [
                    [alias, canonicalRoot, "current"],
                    [root, canonicalRoot, "current"],
                ].sort(),
            );
        } finally {
            for (const { child } of workers) if (child.exitCode === null) child.kill();
            await Promise.allSettled(workers.map(({ exited }) => exited));
            database.close();
            await fsRm(dir, { recursive: true });
        }
    },
);

test("owner coordination registration binding rejects a structural database substitute", () => {
    const substitute = {
        path: ":memory:",
        handle: {},
        transaction: () => {
            throw new Error("Substitute transaction was called");
        },
    };
    assertThrows(
        () => Reflect.apply(bindProjectRegistry, undefined, [substitute]),
        Error,
        "require a RunWield owner coordination database",
    );
});

test("Project registration rejects relative roots before filesystem resolution", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-relative-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        assertThrows(() => registry.register({ root: "relative/project" }), Error, "absolute path");
        assertThrows(
            () => registry.relink({ projectId: parseProjectId(crypto.randomUUID())!, newRoot: "relative/project" }),
            Error,
            "absolute path",
        );
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Project registration rejects files", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-file-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    const registry = bindProjectRegistry(database);
    try {
        const file = join(dir, `not-directory`);
        await fsWriteFile(file, "x");
        assertThrows(() => registry.register({ root: file }), Error, "must be a directory");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("home registration and relink require root-bound consent before writes", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "project-consent-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, "owner.sqlite3") });
    const home = join(dir, "home");
    const ordinaryRoot = join(dir, "ordinary");
    await fsMkdir(home);
    await fsMkdir(ordinaryRoot);
    try {
        await projects.launch.withContext(
            {
                executionAccountHome: home,
                personalOwner: { kind: "execution-account", identity: home },
            },
            async () => {
                const registry = bindProjectRegistry(database);
                const required = assertThrows(() => registry.register({ root: home }), DirectoryConfirmationRequired);
                assertEquals(registry.list(), []);
                const ordinary = registry.register({ root: ordinaryRoot });
                const evidence = registry.listRootEvidence(ordinary.projectId);
                assertThrows(
                    () => registry.relink({ projectId: ordinary.projectId, newRoot: home }),
                    DirectoryConfirmationRequired,
                );
                assertEquals(registry.listRootEvidence(ordinary.projectId), evidence);
                const alias = join(dir, "alias");
                await fsSymlink(home, alias);
                assertThrows(
                    () => registry.register({ root: alias, directoryConfirmation: required.confirmation }),
                    DirectoryConfirmationRequired,
                );
                await fsRename(join(ordinaryRoot, ".wld-project.json"), join(home, ".wld-project.json"));
                const relinked = registry.relink({
                    projectId: ordinary.projectId,
                    newRoot: home,
                    directoryConfirmation: required.confirmation,
                });
                assertEquals(relinked.currentRoot, await fsRealpath(home));
                assertThrows(() => registry.register({ root: home }), DirectoryConfirmationRequired);
                assertEquals(
                    registry.register({ root: home, directoryConfirmation: required.confirmation }).projectId,
                    ordinary.projectId,
                );
                const aliasConsent = assertThrows(
                    () => registry.register({ root: alias }),
                    DirectoryConfirmationRequired,
                );
                await fsRm(alias);
                await fsSymlink("/", alias);
                assertThrows(
                    () => registry.register({ root: alias, directoryConfirmation: aliasConsent.confirmation }),
                    DirectoryConfirmationRequired,
                );
            },
        );
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("the public registry shares the owner database and preserves a Plan-less registration across relink", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-public-registry-"));
    const originalRoot = join(dir, "first");
    const newRoot = join(dir, "second");
    await fsMkdir(originalRoot);
    const owner = openOwnerCoordinationStore();
    const registry = projects.registrations.open();
    try {
        const pairing = owner.createPairingRequest();
        const registration = owner.projects.register({ root: originalRoot });
        const admitted = projects.checkout.inspect(originalRoot);
        assertEquals(
            admitted.kind === "existing" ? admitted.identity.projectId : admitted.kind,
            registration.projectId,
        );
        assertEquals(registry.get(registration.projectId), registration);
        assertEquals(registry.list(), [registration]);
        assertEquals(await fsReaddir(originalRoot), [".wld-project.json"]);

        await fsRename(originalRoot, newRoot);
        const relinked = registry.relink({ projectId: registration.projectId, newRoot });
        assertEquals(relinked.projectId, registration.projectId);
        const newIdentity = projects.checkout.inspect(newRoot);
        assertEquals(
            newIdentity.kind === "existing" ? newIdentity.identity.projectId : newIdentity.kind,
            registration.projectId,
        );
        assertEquals(owner.projects.list(), [relinked]);
        assertEquals(owner.projects.get(registration.projectId), relinked);
        assertEquals(owner.getPairingRequestByProof(pairing.proof)?.state, "pending");
        assertEquals(await fsReaddir(newRoot), [".wld-project.json"]);
    } finally {
        registry.close();
        owner.close();
        await fsRm(dir, { recursive: true });
    }
});

test("a scoped registry and Workspace open the same account database and isolate its existing and new registrations", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-account-registry-"));
    const account = join(dir, "account");
    const alias = join(dir, "account-alias");
    const otherAccount = join(dir, "other-account");
    const processRoot = join(dir, "process-root");
    const existingRoot = join(dir, "scoped-existing-root");
    const newRoot = join(dir, "scoped-new-root");
    for (const path of [account, otherAccount, processRoot, existingRoot, newRoot]) await fsMkdir(path);
    await fsSymlink(account, alias, "junction");
    const physical = await fsRealpath(account);
    const directory = await fsStat(physical);
    const context: ProjectLaunchContext = {
        executionAccountHome: physical,
        configuredExecutionAccountHome: alias,
        accountHomeDirectory: { device: directory.dev, inode: directory.ino },
        personalOwner: { kind: "managed-remote", identity: "trusted-scoped-owner" },
    };
    const dbPath = getOwnerCoordinationDatabasePath({ home: physical });
    const olderDb = openOwnerCoordinationDatabase({ dbPath });
    const outsideRegistry = projects.registrations.open();
    try {
        const olderRegistration = bindProjectRegistry(olderDb).register({ root: existingRoot });
        const outsideRegistration = outsideRegistry.register({ root: processRoot });
        const scopedRegistry = await projects.launch.withContext(context, () =>
            Promise.resolve(projects.registrations.open()),
        );
        let scopedId: string;
        try {
            assertEquals(scopedRegistry.list(), [olderRegistration]);
            assertEquals(scopedRegistry.get(outsideRegistration.projectId), null);
            assertThrows(() => scopedRegistry.register({ root: physical }), DirectoryConfirmationRequired);

            const registered = scopedRegistry.register({ root: newRoot });
            scopedId = registered.projectId;
            assertEquals(await fsReaddir(newRoot), [".wld-project.json"]);

            await projects.launch.withContext(context, async () => {
                const workspace = openOwnerCoordinationStore();
                try {
                    assertEquals(workspace.path, dbPath);
                    assertEquals(workspace.projects.get(registered.projectId), registered);
                    assertEquals(workspace.projects.get(olderRegistration.projectId), olderRegistration);

                    await fsRm(alias);
                    await fsSymlink(otherAccount, alias, "junction");
                    assertThrows(() => scopedRegistry.list(), Error, "execution account home changed");
                    assertThrows(() => projects.registrations.open(), Error, "execution account home changed");
                    assertThrows(() => openOwnerCoordinationStore(), Error, "execution account home changed");
                } finally {
                    workspace.close();
                }
            });
        } finally {
            scopedRegistry.close();
        }

        assertEquals(outsideRegistry.get(outsideRegistration.projectId), outsideRegistration);
        assertEquals(outsideRegistry.get(olderRegistration.projectId), null);
        assertEquals(outsideRegistry.get(scopedId), null);
        assertEquals(bindProjectRegistry(olderDb).list().length, 2);
        assertEquals(await fsReaddir(otherAccount), []);
    } finally {
        olderDb.close();
        outsideRegistry.close();
        await fsRm(dir, { recursive: true });
    }
});

test("a registry opened under the default process HOME refuses writes after its HOME alias detaches", async () => {
    await withProcessGlobalTestLock(async () => {
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-detached-home-"));
        const first = join(dir, "first");
        const second = join(dir, "second");
        const alias = join(dir, "alias");
        const root = join(dir, "project");
        const originalHome = env.HOME;
        for (const path of [first, second, root]) await fsMkdir(path);
        await fsSymlink(first, alias, "junction");
        env.HOME = alias;
        try {
            const registry = projects.registrations.open();
            try {
                assertEquals(registry.list(), []);
                await fsRm(alias);
                await fsSymlink(second, alias, "junction");
                assertThrows(() => registry.register({ root }), Error, "execution account home changed");
                assertEquals(await fsReaddir(second), []);
                assertEquals(await fsReaddir(root), []);
            } finally {
                registry.close();
            }
        } finally {
            if (originalHome === undefined) delete env.HOME;
            else env.HOME = originalHome;
            await fsRm(dir, { recursive: true });
        }
    });
});

test("a retargeted HOME ancestor blocks registry writes and leaves Session files in the original account", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-account-retarget-"));
    const accountsDir = join(dir, ".wld", "sessions-backup");
    const firstParent = join(accountsDir, "first");
    const secondParent = join(accountsDir, "second");
    const alias = join(accountsDir, "parent-alias");
    const scopedHome = join(alias, "home");
    const root = join(dir, "project");
    await fsMkdir(join(firstParent, "home"), { recursive: true });
    await fsMkdir(join(secondParent, "home"), { recursive: true });
    await fsMkdir(root);
    await fsSymlink(firstParent, alias, "junction");
    try {
        const workspace = await projects.launch.withContext(
            {
                executionAccountHome: scopedHome,
                personalOwner: { kind: "execution-account", identity: scopedHome },
            },
            () => Promise.resolve(openOwnerCoordinationStore()),
        );
        const registry = workspace.projects;
        try {
            const registered = registry.register({ root });
            assertEquals(registry.list(), [registered]);
            const sessionProject = workspace.ensureRuntimeProject({ root });
            const piSessionId = "legacy-home-alias";
            const sessionDir = join(
                scopedHome,
                ".wld",
                "sessions",
                projects.directory.sessionKey(await fsRealpath(root)),
            );
            const transcriptPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`);
            await fsMkdir(sessionDir, { recursive: true });
            await fsWriteFile(transcriptPath, `${JSON.stringify({ type: "session", id: piSessionId, cwd: root })}\n`);
            const session = await workspace.ensureSessionCatalogRecord({
                projectId: sessionProject.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: root,
            });
            assertEquals(session.transcriptPath, transcriptPath);
            const physicalTranscript = await fsRealpath(transcriptPath);
            await fsRm(manifestPath(dirname(physicalTranscript), session.runwieldSessionId));
            for (const path of [physicalTranscript, transcriptPath]) {
                const found = workspace.findSessionByLocator({ transcriptPath: path });
                assertEquals(found?.runwieldSessionId, session.runwieldSessionId);
                assertEquals(found?.transcriptPath, transcriptPath);
                const classified = await classifyRootSessionLocator({
                    cwd: root,
                    sessionPath: path,
                    ownerCoordinationStore: workspace,
                });
                assertEquals(classified.kind, "managed", classified.reason);
                assertEquals(classified.session?.transcriptPath, transcriptPath);
            }
            const proof = workspace.acquireSessionActivation({
                projectId: sessionProject.projectId,
                runwieldSessionId: session.runwieldSessionId,
                ownerInstanceId: "legacy-home-alias",
                ownerProcessKind: "test",
                phase: "turning",
                expectedGeneration: null,
            });
            const before = workspace.readActiveSessionTranscript(proof);
            const next = `${before}${JSON.stringify({ type: "model_change", id: "model" })}\n`;
            const expectedDigest = createHash("sha256").update(before).digest("hex");
            const { digestHex } = workspace.writeActiveSessionTranscript(proof, next, expectedDigest);
            assertEquals(workspace.readActiveSessionTranscript(proof), next);
            await fsRm(alias);
            await fsSymlink(secondParent, alias, "junction");
            assertThrows(() => registry.get(registered.projectId), Error, "execution account home changed");
            assertThrows(() => registry.register({ root }), Error, "execution account home changed");
            assertThrows(
                () => workspace.writeActiveSessionTranscript(proof, next, digestHex),
                Error,
                "different execution account home",
            );
            assertEquals(workspace.ensureRuntimeProject({ root }).projectId, sessionProject.projectId);
            assertEquals(
                workspace.listSessionProjects().map((project) => project.projectId),
                [sessionProject.projectId],
            );
            assertEquals(await fsReaddir(join(secondParent, "home")), []);
        } finally {
            workspace.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("scoped account directory inspection and registration agree through an ancestor alias", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-account-ancestor-"));
    const parent = join(dir, "parent");
    const parentAlias = join(dir, "parent-alias");
    const home = join(parent, "home");
    await fsMkdir(home, { recursive: true });
    await fsSymlink(parent, parentAlias, "junction");
    const scopedHome = join(parentAlias, "home");
    try {
        const physical = await fsRealpath(home);
        assertEquals(projects.directory.inspect(physical).classified, false);
        const scoped = await projects.launch.withContext(
            {
                executionAccountHome: scopedHome,
                personalOwner: { kind: "execution-account", identity: scopedHome },
            },
            () => {
                const inspection = projects.directory.inspect(physical);
                assertEquals(inspection.classified, true);
                const confirmation = assertThrows(
                    () => projects.directory.requireConfirmation(inspection),
                    DirectoryConfirmationRequired,
                );
                return Promise.resolve({
                    registry: projects.registrations.open(),
                    confirmation: confirmation.confirmation,
                });
            },
        );
        try {
            assertThrows(() => scoped.registry.register({ root: physical }), DirectoryConfirmationRequired);
            const registration = scoped.registry.register({
                root: physical,
                directoryConfirmation: scoped.confirmation,
            });
            assertEquals(registration.currentRoot, physical);
        } finally {
            scoped.registry.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("raw database keeps the unset HOME fallback while Workspace and Session stores require a valid account", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-no-home-"));
    const script = `
        import assert from "node:assert/strict";
        import { openOwnerCoordinationDatabase } from ${JSON.stringify(import.meta.resolve("@runwield/resources/owner-database"))};
        import { openFileSessionStore } from ${JSON.stringify(new URL("../session/file-session-store.ts", import.meta.url).href)};
        import { projects } from ${JSON.stringify(import.meta.resolve("@runwield/projects"))};
        import { openOwnerCoordinationStore } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
        const required = /Explicit Project owner and execution account home are required/;
        openOwnerCoordinationDatabase().close();
        assert.throws(() => openOwnerCoordinationStore(), required);
        assert.throws(() => openFileSessionStore(), required);
        assert.throws(() => openFileSessionStore({ baseDir: "explicit" }), required);
        assert.throws(() => projects.registrations.open(), required);
        await assert.rejects(projects.launch.withContext({
            executionAccountHome: "",
            personalOwner: { kind: "managed-remote", identity: "malformed" },
        }, () => Promise.resolve(openOwnerCoordinationStore())), required);
    `;
    try {
        const child = spawn(execPath, ["-e", script], {
            cwd: dir,
            env: { ...env, HOME: "", USERPROFILE: "", HOMEDRIVE: "", HOMEPATH: "", LOCALAPPDATA: "" },
            stdio: "inherit",
        });
        assertEquals(await once(child, "exit"), [0, null]);
        assertEquals((await fsStat(join(dir, "~", ".wld", "owner-coordination.sqlite3"))).isFile(), true);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
