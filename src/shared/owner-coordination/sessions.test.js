import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getRunWieldSessionDir } from "../session/root-session.js";
import { openOwnerCoordinationDatabase } from "./database.js";
import { registerProject, relinkProject } from "./projects.js";
import {
    catalogProjectSessions,
    ensureSessionCatalogRecord,
    findSessionByLocator,
    listProjectSessions,
} from "./sessions.js";

/**
 * @param {string} [prefix]
 * @returns {() => string}
 */
function idFactory(prefix = "id") {
    let next = 0;
    return () => `${prefix}-${++next}`;
}

/**
 * @param {string} cwd
 * @param {string} piSessionId
 * @param {{ headerCwd?: string, headerVersion?: number, headerTimestamp?: string, body?: string }} [options]
 */
async function writeTranscript(cwd, piSessionId, options = {}) {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`);
    const header = {
        type: "session",
        version: options.headerVersion ?? 3,
        id: piSessionId,
        timestamp: options.headerTimestamp || "2026-01-01T00:00:00.000Z",
        cwd: options.headerCwd || cwd,
    };
    await fsWriteFile(sessionPath, `${JSON.stringify(header)}\n${options.body || ""}`);
    return sessionPath;
}

/** @param {string} dir */
async function removeTempDir(dir) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await fsRm(dir, { recursive: true });
            return;
        } catch (error) {
            if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return;
            if (attempt === 4) throw error;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
}

test("Session listing lazily catalogs legacy transcripts without storing message bodies", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-catalog-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            const transcriptPath = await writeTranscript(root, "pi-1", {
                body: JSON.stringify({
                    type: "message",
                    message: { content: [{ type: "text", text: "secret body" }] },
                }),
            });
            const before = await fsStat(transcriptPath);
            const result = await listProjectSessions(database, project.projectId, {
                idFactory: idFactory(),
                now: () => "t2",
            });
            const after = await fsStat(transcriptPath);

            assertEquals(result.diagnostics, []);
            assertEquals(result.sessions.length, 1);
            assertEquals(result.sessions[0].projectId, project.projectId);
            assertEquals(result.sessions[0].piSessionId, "pi-1");
            assertEquals(result.sessions[0].transcriptPath, transcriptPath);
            assertEquals(before.mtime?.getTime(), after.mtime?.getTime());

            const rows = database.handle.prepare("SELECT display_name FROM runwield_sessions").all();
            assertEquals(rows, [{ display_name: null }]);
            const raw = JSON.stringify(database.handle.prepare("SELECT * FROM session_transcript_locators").all());
            assert(!raw.includes("secret body"));
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session catalog scans registered symlink alias session directories", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-alias-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            const link = join(dir, `repo-link`);
            await fsMkdir(root);
            await fsSymlink(root, link);
            const ids = idFactory();
            const project = registerProject(database, { root, idFactory: ids, now: () => "t1" });
            registerProject(database, { root: link, idFactory: ids, now: () => "t2" });
            const transcriptPath = await writeTranscript(link, "alias-pi");

            const result = await listProjectSessions(database, project.projectId, {
                idFactory: ids,
                now: () => "t3",
            });

            assertEquals(result.diagnostics, []);
            assertEquals(result.sessions.length, 1);
            assertEquals(result.sessions[0].piSessionId, "alias-pi");
            assertEquals(result.sessions[0].transcriptPath, transcriptPath);
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session listing is incremental and full rescan remains explicit", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-incremental-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            await writeTranscript(root, "valid");
            const sessionDir = getRunWieldSessionDir(root);
            const brokenPath = join(sessionDir, `2026-01-01T00-00-00-000Z_broken.jsonl`);
            await fsWriteFile(brokenPath, "not-json\n");

            const first = await listProjectSessions(database, project.projectId, {
                idFactory: idFactory(),
                now: () => "t2",
            });
            const second = await listProjectSessions(database, project.projectId, {
                idFactory: idFactory(),
                now: () => "t3",
            });
            const fullRescan = await catalogProjectSessions(database, project.projectId, {
                fullRescan: true,
                idFactory: idFactory(),
                now: () => "t4",
            });

            assertEquals(first.sessions.map((session) => session.piSessionId), ["valid"]);
            assertEquals(first.diagnostics.map((diagnostic) => diagnostic.code), ["invalid_locator"]);
            assertEquals(second.sessions.map((session) => session.piSessionId), ["valid"]);
            assertEquals(second.diagnostics.map((diagnostic) => diagnostic.code), ["invalid_locator"]);
            assertEquals(fullRescan.diagnostics.map((diagnostic) => diagnostic.code), ["invalid_locator"]);

            await fsWriteFile(
                brokenPath,
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "broken",
                    timestamp: "2026-01-01T00:00:00.000Z",
                    cwd: root,
                }) + "\n",
            );
            const third = await listProjectSessions(database, project.projectId, {
                idFactory: idFactory("third"),
                now: () => "t5",
            });
            assertEquals(third.sessions.map((session) => session.piSessionId).sort(), ["broken", "valid"]);

            await writeTranscript(root, "new-after-scan");
            const fourth = await listProjectSessions(database, project.projectId, {
                idFactory: idFactory("fourth"),
                now: () => "t6",
            });
            assertEquals(fourth.sessions.map((session) => session.piSessionId).sort(), [
                "broken",
                "new-after-scan",
                "valid",
            ]);
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session cataloging reuses stable IDs across repeated scans and database connections", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-reuse-"));
        process.env["HOME"] = dir;
        const dbPath = join(dir, `owner.sqlite3`);
        const firstDb = openOwnerCoordinationDatabase({ dbPath });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(firstDb, { root, idFactory: idFactory(), now: () => "t1" });
            await writeTranscript(root, "pi-1");
            const first = await listProjectSessions(firstDb, project.projectId, {
                idFactory: idFactory(),
                now: () => "t2",
            });
            const secondDb = openOwnerCoordinationDatabase({ dbPath });
            try {
                const second = await listProjectSessions(secondDb, project.projectId, {
                    idFactory: idFactory(),
                    now: () => "t3",
                });
                assertEquals(second.sessions[0].runwieldSessionId, first.sessions[0].runwieldSessionId);
            } finally {
                secondDb.close();
            }
        } finally {
            firstDb.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session cataloging reports malformed and wrong-cwd transcripts while cataloging valid files", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-diagnostics-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            const other = join(dir, `other`);
            await fsMkdir(root);
            await fsMkdir(other);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            await writeTranscript(root, "valid");
            await writeTranscript(root, "wrong", { headerCwd: other });
            const sessionDir = getRunWieldSessionDir(root);
            await fsWriteFile(join(sessionDir, `broken.jsonl`), "not-json\n");

            const result = await catalogProjectSessions(database, project.projectId, {
                idFactory: idFactory(),
                now: () => "t2",
            });
            assertEquals(result.cataloged.length, 1);
            assertEquals(result.cataloged[0].piSessionId, "valid");
            assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
                "invalid_locator",
                "wrong_cwd",
            ]);
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session locator conflicts are diagnostics and do not reassign existing stable IDs", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-conflict-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            const firstPath = await writeTranscript(root, "same-pi");
            const first = await ensureSessionCatalogRecord(database, {
                projectId: project.projectId,
                piSessionId: "same-pi",
                transcriptPath: firstPath,
                transcriptCwd: root,
                idFactory: idFactory(),
                now: () => "t2",
            });
            const secondPath = `${getRunWieldSessionDir(root)}/2026-01-02T00-00-00-000Z_same-pi.jsonl`;
            await fsWriteFile(
                secondPath,
                JSON.stringify({ type: "session", version: 3, id: "same-pi", cwd: root }) + "\n",
            );

            const result = await catalogProjectSessions(database, project.projectId, {
                idFactory: idFactory(),
                now: () => "t3",
            });
            assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ["catalog_conflict"]);
            assertEquals(
                findSessionByLocator(database, { transcriptPath: firstPath })?.runwieldSessionId,
                first.runwieldSessionId,
            );
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("shared Session catalog API rejects unguarded or contradictory locators", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-guard-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            const other = join(dir, `other`);
            await fsMkdir(root);
            await fsMkdir(other);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            const outside = join(dir, `outside.jsonl`);
            await fsWriteFile(
                outside,
                JSON.stringify({ type: "session", version: 3, id: "outside", cwd: root }) + "\n",
            );
            await assertRejects(
                () =>
                    ensureSessionCatalogRecord(database, {
                        projectId: project.projectId,
                        piSessionId: "outside",
                        transcriptPath: outside,
                        transcriptCwd: root,
                    }),
                Error,
                "outside the RunWield session directory",
            );

            const outsideTarget = join(dir, `outside-target.jsonl`);
            await fsWriteFile(
                outsideTarget,
                JSON.stringify({ type: "session", version: 3, id: "outside-target", cwd: root }) + "\n",
            );
            const symlinkPath = `${getRunWieldSessionDir(root)}/2026-01-01T00-00-00-000Z_outside-target.jsonl`;
            await fsMkdir(getRunWieldSessionDir(root), { recursive: true });
            await fsSymlink(outsideTarget, symlinkPath);
            await assertRejects(
                () =>
                    ensureSessionCatalogRecord(database, {
                        projectId: project.projectId,
                        piSessionId: "outside-target",
                        transcriptPath: symlinkPath,
                        transcriptCwd: root,
                    }),
                Error,
                "resolves outside the RunWield session directory",
            );

            const wrongCwdPath = await writeTranscript(root, "wrong-cwd", { headerCwd: other });
            await assertRejects(
                () =>
                    ensureSessionCatalogRecord(database, {
                        projectId: project.projectId,
                        piSessionId: "wrong-cwd",
                        transcriptPath: wrongCwdPath,
                        transcriptCwd: other,
                    }),
                Error,
                "does not match Project root evidence",
            );
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("two database connections racing to catalog one locator converge on one stable Session ID", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-race-"));
        process.env["HOME"] = dir;
        const dbPath = join(dir, `owner.sqlite3`);
        const firstDb = openOwnerCoordinationDatabase({ dbPath });
        const secondDb = openOwnerCoordinationDatabase({ dbPath });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(firstDb, { root, idFactory: idFactory("project"), now: () => "t1" });
            const transcriptPath = await writeTranscript(root, "race-pi");
            const locator = {
                projectId: project.projectId,
                piSessionId: "race-pi",
                transcriptPath,
                transcriptCwd: root,
            };
            const [first, second] = await Promise.all([
                new Promise((resolvePromise, reject) =>
                    setTimeout(() =>
                        ensureSessionCatalogRecord(firstDb, {
                            ...locator,
                            idFactory: idFactory("first"),
                            now: () => "t2",
                        }).then(resolvePromise, reject), 0)
                ),
                new Promise((resolvePromise, reject) =>
                    setTimeout(() =>
                        ensureSessionCatalogRecord(secondDb, {
                            ...locator,
                            idFactory: idFactory("second"),
                            now: () => "t3",
                        }).then(resolvePromise, reject), 0)
                ),
            ]);
            assertEquals(
                /** @type {any} */ (first).runwieldSessionId,
                /** @type {any} */ (second).runwieldSessionId,
            );
        } finally {
            firstDb.close();
            secondDb.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session catalog persists validated header evidence and conflicts on later contradictions", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-evidence-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t1" });
            const transcriptPath = await writeTranscript(root, "evidence-pi", { headerVersion: 3 });
            const session = await ensureSessionCatalogRecord(database, {
                projectId: project.projectId,
                piSessionId: "evidence-pi",
                transcriptPath,
                transcriptCwd: root,
                headerVersion: 99,
                headerTimestamp: "caller-value",
                idFactory: idFactory(),
                now: () => "t2",
            });
            assertEquals(session.headerVersion, 3);
            assertEquals(session.headerTimestamp, "2026-01-01T00:00:00.000Z");

            await fsWriteFile(
                transcriptPath,
                JSON.stringify({
                    type: "session",
                    version: 4,
                    id: "evidence-pi",
                    timestamp: "2026-01-01T00:00:00.000Z",
                    cwd: root,
                }) + "\n",
            );
            await assertRejects(
                () =>
                    ensureSessionCatalogRecord(database, {
                        projectId: project.projectId,
                        piSessionId: "evidence-pi",
                        transcriptPath,
                        transcriptCwd: root,
                    }),
                Error,
                "header evidence conflict",
            );
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session catalog does not let an encoded-directory collision rejected candidate hide a valid one", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-collision-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const historicalRoot = join(dir, `repo-root`);
            const currentParent = join(dir, `repo`);
            const currentRoot = join(currentParent, `root`);
            await fsMkdir(historicalRoot, { recursive: true });
            await fsMkdir(currentRoot, { recursive: true });
            const ids = idFactory();
            const project = registerProject(database, { root: historicalRoot, idFactory: ids, now: () => "t1" });
            relinkProject(database, {
                projectId: project.projectId,
                newRoot: currentRoot,
                idFactory: ids,
                now: () => "t2",
            });
            await writeTranscript(historicalRoot, "collision-pi");

            const result = await catalogProjectSessions(database, project.projectId, {
                idFactory: ids,
                now: () => "t3",
            });

            assertEquals(result.cataloged.map((session) => session.piSessionId), ["collision-pi"]);
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session catalog rejects symlink-retargeted roots even when entered root text matches", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-retarget-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const firstTarget = join(dir, `first`);
            const secondTarget = join(dir, `second`);
            const link = join(dir, `repo-link`);
            await fsMkdir(firstTarget);
            await fsMkdir(secondTarget);
            await fsSymlink(firstTarget, link);
            const project = registerProject(database, { root: link, idFactory: idFactory(), now: () => "t1" });
            await fsRm(link);
            await fsSymlink(secondTarget, link);
            await writeTranscript(link, "retarget-pi");

            const result = await catalogProjectSessions(database, project.projectId, {
                idFactory: idFactory(),
                now: () => "t2",
            });

            assertEquals(result.cataloged, []);
            assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ["wrong_cwd"]);
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session catalog accepts stored historical root evidence after old cwd disappears", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-historical-missing-"));
        process.env["HOME"] = dir;
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const historicalRoot = join(dir, `old-repo`);
            const currentRoot = join(dir, `new-repo`);
            await fsMkdir(historicalRoot, { recursive: true });
            await fsMkdir(currentRoot, { recursive: true });
            const ids = idFactory();
            const project = registerProject(database, { root: historicalRoot, idFactory: ids, now: () => "t1" });
            const transcriptPath = await writeTranscript(historicalRoot, "historical-pi");
            relinkProject(database, {
                projectId: project.projectId,
                newRoot: currentRoot,
                idFactory: ids,
                now: () => "t2",
            });
            await fsRm(historicalRoot, { recursive: true });

            const result = await catalogProjectSessions(database, project.projectId, {
                idFactory: ids,
                now: () => "t3",
            });

            assertEquals(result.diagnostics, []);
            assertEquals(result.cataloged.length, 1);
            assertEquals(result.cataloged[0].piSessionId, "historical-pi");
            assertEquals(result.cataloged[0].transcriptPath, transcriptPath);
        } finally {
            database.close();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});

test("Session catalog reconstruction after database deletion requires re-registration and creates conservative mappings", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const dir = await fsMkdtemp(join(tmpdir(), "runwield-session-reconstruct-"));
        process.env["HOME"] = dir;
        const dbPath = join(dir, `owner.sqlite3`);
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            await writeTranscript(root, "pi-1");
            const firstDb = openOwnerCoordinationDatabase({ dbPath });
            let firstId = "";
            try {
                const project = registerProject(firstDb, { root, idFactory: idFactory("first"), now: () => "t1" });
                const first = await listProjectSessions(firstDb, project.projectId, {
                    idFactory: idFactory("first-session"),
                    now: () => "t2",
                });
                firstId = first.sessions[0].runwieldSessionId;
            } finally {
                firstDb.close();
            }
            await fsRm(dbPath);
            const secondDb = openOwnerCoordinationDatabase({ dbPath });
            try {
                const project = registerProject(secondDb, { root, idFactory: idFactory("second"), now: () => "t3" });
                const second = await listProjectSessions(secondDb, project.projectId, {
                    idFactory: idFactory("second-session"),
                    now: () => "t4",
                });
                assertEquals(second.sessions.length, 1);
                assert(second.sessions[0].runwieldSessionId);
                assertEquals(second.sessions[0].runwieldSessionId === firstId, false);
            } finally {
                secondDb.close();
            }
        } finally {
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await removeTempDir(dir);
        }
    });
});
