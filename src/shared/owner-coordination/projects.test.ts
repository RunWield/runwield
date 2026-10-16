import { platform } from "node:process";
import { chmodSync as fsChmodSync, readdirSync as fsReaddirSync } from "node:fs";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "./database.js";
import {
    getProjectById,
    getProjectHealth,
    listProjectRootEvidence,
    listProjects,
    registerProject,
    relinkProject,
    removeProject,
    requireEnabledProjectRoot,
    setProjectEnabled,
} from "./projects.js";

type RegisteredProject = ReturnType<typeof registerProject>;

function idFactory(): () => string {
    let next = 0;
    return () => `id-${++next}`;
}

test("Project registration converges symlink duplicates and re-adding after removal creates a new registration", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-reg-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    try {
        const root = join(dir, `repo`);
        const link = join(dir, `repo-link`);
        await fsMkdir(root);
        await fsSymlink(root, link);
        const ids = idFactory();
        const direct = registerProject(database, { root, idFactory: ids, now: () => "t1" });
        const viaLink = registerProject(database, { root: link, idFactory: ids, now: () => "t2" });
        assertEquals(viaLink.projectId, direct.projectId);
        assertEquals(viaLink.lifecycle, "enabled");
        assertEquals(
            listProjectRootEvidence(database, direct.projectId)
                .map((rootEvidence) => rootEvidence.enteredRoot)
                .sort(),
            [link, root].sort(),
        );

        removeProject(database, direct.projectId);
        assertEquals(getProjectById(database, direct.projectId), null);
        assertEquals(listProjects(database), []);
        assertEquals(listProjectRootEvidence(database, direct.projectId), []);
        assertThrows(() => requireEnabledProjectRoot(database, direct.projectId), Error, "not found");

        const restored = registerProject(database, { root, idFactory: ids, now: () => "t4" });
        assertNotEquals(restored.projectId, direct.projectId);
        assertEquals(restored.lifecycle, "enabled");
        assertEquals(requireEnabledProjectRoot(database, restored.projectId), await fsRealpath(root));
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
        try {
            const root = join(dir, "Mixed Case Project");
            await fsMkdir(root);
            const canonicalRoot = await fsRealpath(root);
            const enteredRoot = root.toLowerCase();
            assertNotEquals(enteredRoot, canonicalRoot);
            const project = registerProject(database, { root: enteredRoot });
            assertEquals(project.currentRoot, canonicalRoot);
            assertEquals(getProjectHealth(database, project.projectId).status, "available");
            assertEquals(getProjectHealth(database, project.projectId).observedRealRoot, canonicalRoot);
            assertEquals(registerProject(database, { root: canonicalRoot }).projectId, project.projectId);
            assertEquals(listProjects(database).length, 1);
            assertEquals(
                listProjectRootEvidence(database, project.projectId).map((item) => item.canonicalRoot),
                [canonicalRoot, canonicalRoot],
            );
        } finally {
            database.close();
            await fsRm(dir, { recursive: true });
        }
    },
);

test("disabled Projects stay disabled on duplicate registration", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-disabled-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    try {
        const root = join(dir, `repo`);
        await fsMkdir(root);
        const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
        setProjectEnabled(database, project.projectId, false, { now: () => "t2" });
        const duplicate = registerProject(database, { root, idFactory: idFactory(), now: () => "t3" });
        assertEquals(duplicate.projectId, project.projectId);
        assertEquals(duplicate.lifecycle, "disabled");
        assertEquals(getProjectHealth(database, project.projectId).status, "available");
        assertThrows(() => requireEnabledProjectRoot(database, project.projectId), Error, "not enabled");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Project health is filesystem-based and non-Git directories are available", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-health-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    try {
        const root = join(dir, `plain-directory`);
        await fsMkdir(root);
        const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
        assertEquals(getProjectHealth(database, project.projectId).status, "available");
        await fsRm(root, { recursive: true });
        assertEquals(getProjectHealth(database, project.projectId).status, "missing");
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
        const root = join(dir, `repo`);
        try {
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            try {
                fsChmodSync(root, 0o000);
                assertEquals(getProjectHealth(database, project.projectId).status, "unreadable");
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
    try {
        const project = registerProject(database, { root: dir });
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
        assertThrows(() => removeProject(database, id), Error, "test failure");
        assertEquals(getProjectById(database, id)?.lifecycle, "enabled");
        assertEquals(db.prepare("SELECT COUNT(*) AS count FROM session_committed_generations").get()?.count, 1);
        db.exec("DROP TRIGGER fail_removal");
        removeProject(database, id);
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
        assertThrows(() => removeProject(database, id), Error, "not found");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("migration deletes previously removed registrations and preserves other Projects", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-removal-migration-"));
    const dbPath = join(dir, `owner.sqlite3`);
    const database = openOwnerCoordinationDatabase({ dbPath });
    let keptId;
    try {
        await fsMkdir(join(dir, `kept`));
        const removed = registerProject(database, { root: dir });
        keptId = registerProject(database, { root: join(dir, `kept`) }).projectId;
        database.handle.prepare("UPDATE projects SET lifecycle = 'removed' WHERE id = ?").run(removed.projectId);
        database.handle.exec("DELETE FROM schema_migrations WHERE version = 10");
    } finally {
        database.close();
    }
    const migrated = openOwnerCoordinationDatabase({ dbPath });
    try {
        assertEquals(
            listProjects(migrated).map((project) => project.projectId),
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

test("Project relink preserves root history and rejects another Project root", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-relink-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    try {
        const oldRoot = join(dir, `old`);
        const newRoot = join(dir, `new`);
        const otherRoot = join(dir, `other`);
        await fsMkdir(oldRoot);
        await fsMkdir(newRoot);
        await fsMkdir(otherRoot);
        const ids = idFactory();
        const project = registerProject(database, { root: oldRoot, idFactory: ids, now: () => "t1" });
        const other = registerProject(database, { root: otherRoot, idFactory: ids, now: () => "t2" });
        const relinked = relinkProject(database, {
            projectId: project.projectId,
            newRoot,
            idFactory: ids,
            now: () => "t3",
        });
        assertEquals(relinked.projectId, project.projectId);
        assertEquals(relinked.currentRoot, await fsRealpath(newRoot));
        const roots = listProjectRootEvidence(database, project.projectId);
        assertEquals(
            roots.map((root) => root.rootState),
            ["current", "historical"],
        );
        const duplicateHistorical = registerProject(database, { root: oldRoot, idFactory: ids, now: () => "t4" });
        assertEquals(duplicateHistorical.currentRoot, await fsRealpath(newRoot));
        assertEquals(
            listProjectRootEvidence(database, project.projectId)
                .filter((root) => root.rootState === "current")
                .map((root) => root.canonicalRoot),
            [await fsRealpath(newRoot)],
        );
        assertThrows(
            () => relinkProject(database, { projectId: project.projectId, newRoot: otherRoot }),
            Error,
            "another Project",
        );
        assertEquals(requireEnabledProjectRoot(database, other.projectId), await fsRealpath(otherRoot));
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Project registration and relink report symlink path reuse conflicts", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-retarget-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    try {
        const firstRoot = join(dir, `first`);
        const secondRoot = join(dir, `second`);
        const link = join(dir, `project-link`);
        await fsMkdir(firstRoot);
        await fsMkdir(secondRoot);
        await fsSymlink(firstRoot, link);
        const project = registerProject(database, { root: link, idFactory: idFactory(), now: () => "t1" });
        await fsRm(link);
        await fsSymlink(secondRoot, link);

        assertThrows(
            () => registerProject(database, { root: link, idFactory: idFactory(), now: () => "t2" }),
            Error,
            "path reuse or symlink retarget",
        );
        assertThrows(
            () => relinkProject(database, { projectId: project.projectId, newRoot: link, idFactory: idFactory() }),
            Error,
            "path reuse or symlink retarget",
        );
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("two database connections racing to register one Project converge on one stable ID", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-race-"));
    const dbPath = join(dir, `owner.sqlite3`);
    const firstDb = openOwnerCoordinationDatabase({ dbPath });
    const secondDb = openOwnerCoordinationDatabase({ dbPath });
    try {
        const root = join(dir, `repo`);
        await fsMkdir(root);
        const [first, second] = await Promise.all([
            new Promise<RegisteredProject>((resolvePromise) =>
                setTimeout(
                    () => resolvePromise(registerProject(firstDb, { root, idFactory: idFactory(), now: () => "t1" })),
                    0,
                ),
            ),
            new Promise<RegisteredProject>((resolvePromise) =>
                setTimeout(
                    () => resolvePromise(registerProject(secondDb, { root, idFactory: idFactory(), now: () => "t2" })),
                    0,
                ),
            ),
        ]);
        assertEquals(first.projectId, second.projectId);
    } finally {
        firstDb.close();
        secondDb.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Project registration rejects relative roots before filesystem resolution", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-relative-"));
    const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
    try {
        assertThrows(() => registerProject(database, { root: "relative/project" }), Error, "absolute path");
        assertThrows(
            () => relinkProject(database, { projectId: "missing", newRoot: "relative/project" }),
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
    try {
        const file = join(dir, `not-directory`);
        await fsWriteFile(file, "x");
        assertThrows(() => registerProject(database, { root: file }), Error, "must be a directory");
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});

test("home registration and relink require root-bound consent before writes", async () => {
    const { getHomeDir } = await import("../../constants.js");
    const { DirectoryConfirmationRequired } = await import("../project-directory.ts");
    const dir = await fsMkdtemp(join(tmpdir(), "project-consent-"));
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const root = getHomeDir();
        const required = assertThrows(() => registerProject(database, { root }), DirectoryConfirmationRequired);
        assertEquals(listProjects(database), []);
        const ordinary = registerProject(database, { root: dir });
        const evidence = listProjectRootEvidence(database, ordinary.projectId);
        assertThrows(
            () => relinkProject(database, { projectId: ordinary.projectId, newRoot: root }),
            DirectoryConfirmationRequired,
        );
        assertEquals(listProjectRootEvidence(database, ordinary.projectId), evidence);
        const alias = `${dir}/alias`;
        await fsSymlink(root, alias);
        assertThrows(
            () => registerProject(database, { root: alias, directoryConfirmation: required.confirmation }),
            DirectoryConfirmationRequired,
        );
        const relinked = relinkProject(database, {
            projectId: ordinary.projectId,
            newRoot: root,
            directoryConfirmation: required.confirmation,
        });
        assertEquals(relinked.currentRoot, await fsRealpath(root));
        assertThrows(() => registerProject(database, { root }), DirectoryConfirmationRequired);
        assertEquals(
            registerProject(database, { root, directoryConfirmation: required.confirmation }).projectId,
            ordinary.projectId,
        );
        const aliasConsent = assertThrows(
            () => registerProject(database, { root: alias }),
            DirectoryConfirmationRequired,
        );
        await fsRm(alias);
        await fsSymlink("/", alias);
        assertThrows(
            () => registerProject(database, { root: alias, directoryConfirmation: aliasConsent.confirmation }),
            DirectoryConfirmationRequired,
        );
    } finally {
        database.close();
        await fsRm(dir, { recursive: true });
    }
});
