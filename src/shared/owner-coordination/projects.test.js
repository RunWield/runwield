import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
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

/** @returns {() => string} */
function idFactory() {
    let next = 0;
    return () => `id-${++next}`;
}

Deno.test("Project registration converges symlink duplicates and re-adding after removal creates a new registration", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-reg-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const root = `${dir}/repo`;
        const link = `${dir}/repo-link`;
        await Deno.mkdir(root);
        await Deno.symlink(root, link);
        const ids = idFactory();
        const direct = registerProject(database, { root, idFactory: ids, now: () => "t1" });
        const viaLink = registerProject(database, { root: link, idFactory: ids, now: () => "t2" });
        assertEquals(viaLink.projectId, direct.projectId);
        assertEquals(viaLink.lifecycle, "enabled");
        assertEquals(
            listProjectRootEvidence(database, direct.projectId).map((rootEvidence) => rootEvidence.enteredRoot).sort(),
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
        assertEquals(requireEnabledProjectRoot(database, restored.projectId), await Deno.realPath(root));
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("disabled Projects stay disabled on duplicate registration", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-disabled-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const root = `${dir}/repo`;
        await Deno.mkdir(root);
        const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
        setProjectEnabled(database, project.projectId, false, { now: () => "t2" });
        const duplicate = registerProject(database, { root, idFactory: idFactory(), now: () => "t3" });
        assertEquals(duplicate.projectId, project.projectId);
        assertEquals(duplicate.lifecycle, "disabled");
        assertEquals(getProjectHealth(database, project.projectId).status, "available");
        assertThrows(
            () => requireEnabledProjectRoot(database, project.projectId),
            Error,
            "not enabled",
        );
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project health is filesystem-based and non-Git directories are available", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-health-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const root = `${dir}/plain-directory`;
        await Deno.mkdir(root);
        const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
        assertEquals(getProjectHealth(database, project.projectId).status, "available");
        await Deno.remove(root, { recursive: true });
        assertEquals(getProjectHealth(database, project.projectId).status, "missing");
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project health reports unreadable registered roots distinctly from missing roots", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-unreadable-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    const root = `${dir}/repo`;
    try {
        await Deno.mkdir(root);
        const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
        try {
            Deno.chmodSync(root, 0o000);
            assertEquals(getProjectHealth(database, project.projectId).status, "unreadable");
        } finally {
            Deno.chmodSync(root, 0o700);
        }
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project removal clears dependent database records and rolls back on failure", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-remove-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
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
        db.prepare("UPDATE session_transcript_segment_state SET current_segment_id = 'segment' WHERE project_id = ?")
            .run(id);
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
        for (
            const table of [
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
            ]
        ) {
            assertEquals(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
        }
        assertEquals(db.prepare("PRAGMA foreign_key_check").all(), []);
        assertThrows(() => removeProject(database, id), Error, "not found");
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("migration deletes previously removed registrations and preserves other Projects", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-removal-migration-" });
    const dbPath = `${dir}/owner.sqlite3`;
    const database = openOwnerCoordinationDatabase({ dbPath });
    let keptId;
    try {
        await Deno.mkdir(`${dir}/kept`);
        const removed = registerProject(database, { root: dir });
        keptId = registerProject(database, { root: `${dir}/kept` }).projectId;
        database.handle.prepare("UPDATE projects SET lifecycle = 'removed' WHERE id = ?").run(removed.projectId);
        database.handle.exec("DELETE FROM schema_migrations WHERE version = 10");
    } finally {
        database.close();
    }
    const migrated = openOwnerCoordinationDatabase({ dbPath });
    try {
        assertEquals(listProjects(migrated).map((project) => project.projectId), [keptId]);
        assertEquals(migrated.handle.prepare("PRAGMA foreign_key_check").all(), []);
        assertEquals((await Deno.stat(`${dir}/kept`)).isDirectory, true);
        const backups = Array.from(Deno.readDirSync(dir)).filter((entry) => entry.name.includes("backup-v9"));
        assertEquals(backups.length, 1);
    } finally {
        migrated.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project relink preserves root history and rejects another Project root", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-relink-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const oldRoot = `${dir}/old`;
        const newRoot = `${dir}/new`;
        const otherRoot = `${dir}/other`;
        await Deno.mkdir(oldRoot);
        await Deno.mkdir(newRoot);
        await Deno.mkdir(otherRoot);
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
        assertEquals(relinked.currentRoot, await Deno.realPath(newRoot));
        const roots = listProjectRootEvidence(database, project.projectId);
        assertEquals(roots.map((root) => root.rootState), ["current", "historical"]);
        const duplicateHistorical = registerProject(database, { root: oldRoot, idFactory: ids, now: () => "t4" });
        assertEquals(duplicateHistorical.currentRoot, await Deno.realPath(newRoot));
        assertEquals(
            listProjectRootEvidence(database, project.projectId).filter((root) => root.rootState === "current").map((
                root,
            ) => root.canonicalRoot),
            [await Deno.realPath(newRoot)],
        );
        assertThrows(
            () => relinkProject(database, { projectId: project.projectId, newRoot: otherRoot }),
            Error,
            "another Project",
        );
        assertEquals(requireEnabledProjectRoot(database, other.projectId), await Deno.realPath(otherRoot));
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project registration and relink report symlink path reuse conflicts", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-retarget-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const firstRoot = `${dir}/first`;
        const secondRoot = `${dir}/second`;
        const link = `${dir}/project-link`;
        await Deno.mkdir(firstRoot);
        await Deno.mkdir(secondRoot);
        await Deno.symlink(firstRoot, link);
        const project = registerProject(database, { root: link, idFactory: idFactory(), now: () => "t1" });
        await Deno.remove(link);
        await Deno.symlink(secondRoot, link);

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
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("two database connections racing to register one Project converge on one stable ID", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-race-" });
    const dbPath = `${dir}/owner.sqlite3`;
    const firstDb = openOwnerCoordinationDatabase({ dbPath });
    const secondDb = openOwnerCoordinationDatabase({ dbPath });
    try {
        const root = `${dir}/repo`;
        await Deno.mkdir(root);
        const [first, second] = await Promise.all([
            new Promise((resolvePromise) =>
                setTimeout(
                    () => resolvePromise(registerProject(firstDb, { root, idFactory: idFactory(), now: () => "t1" })),
                    0,
                )
            ),
            new Promise((resolvePromise) =>
                setTimeout(
                    () => resolvePromise(registerProject(secondDb, { root, idFactory: idFactory(), now: () => "t2" })),
                    0,
                )
            ),
        ]);
        assertEquals(/** @type {any} */ (first).projectId, /** @type {any} */ (second).projectId);
    } finally {
        firstDb.close();
        secondDb.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project registration rejects relative roots before filesystem resolution", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-relative-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        assertThrows(
            () => registerProject(database, { root: "relative/project" }),
            Error,
            "absolute path",
        );
        assertThrows(
            () => relinkProject(database, { projectId: "missing", newRoot: "relative/project" }),
            Error,
            "absolute path",
        );
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Project registration rejects files", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-file-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const file = `${dir}/not-directory`;
        await Deno.writeTextFile(file, "x");
        assertThrows(
            () => registerProject(database, { root: file }),
            Error,
            "must be a directory",
        );
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("home registration and relink require root-bound consent before writes", async () => {
    const { getHomeDir } = await import("../../constants.js");
    const { DirectoryConfirmationRequired } = await import("../project-directory.ts");
    const dir = await Deno.makeTempDir();
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
        await Deno.symlink(root, alias);
        assertThrows(
            () => registerProject(database, { root: alias, directoryConfirmation: required.confirmation }),
            DirectoryConfirmationRequired,
        );
        const relinked = relinkProject(database, {
            projectId: ordinary.projectId,
            newRoot: root,
            directoryConfirmation: required.confirmation,
        });
        assertEquals(relinked.currentRoot, Deno.realPathSync(root));
        assertThrows(() => registerProject(database, { root }), DirectoryConfirmationRequired);
        assertEquals(
            registerProject(database, { root, directoryConfirmation: required.confirmation }).projectId,
            ordinary.projectId,
        );
        const aliasConsent = assertThrows(
            () => registerProject(database, { root: alias }),
            DirectoryConfirmationRequired,
        );
        await Deno.remove(alias);
        await Deno.symlink("/", alias);
        assertThrows(
            () => registerProject(database, { root: alias, directoryConfirmation: aliasConsent.confirmation }),
            DirectoryConfirmationRequired,
        );
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});
