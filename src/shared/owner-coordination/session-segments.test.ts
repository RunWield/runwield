import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertThrows } from "../../testing/assertions.ts";
import { DatabaseSync } from "../sqlite.ts";
import { getRunWieldSessionDir } from "../session/root-session.js";
import { captureTranscriptEvidence } from "../session/session-transcript-projection.js";
import { openOwnerCoordinationDatabase } from "./database.js";
import { registerProject } from "./projects.js";
import {
    OWNER_COORDINATION_SCHEMA_V1_SQL,
    OWNER_COORDINATION_SCHEMA_V2_SQL,
    OWNER_COORDINATION_SCHEMA_V3_SQL,
    OWNER_COORDINATION_SCHEMA_V4_SQL,
    OWNER_COORDINATION_SCHEMA_V5_SQL,
} from "./schema.ts";
import {
    appendSessionTranscriptSegment,
    diagnoseSessionSegmentLineage,
    ensureSessionCatalogRecord,
    getCurrentSessionSegment,
    listProjectSessions,
    listSessionTranscriptSegments,
    sealSessionTranscriptSegment,
} from "./sessions.js";

function idFactory(prefix = "id") {
    let next = 0;
    return () => `${prefix}-${++next}`;
}

interface TranscriptOptions {
    timestamp?: string;
    filenamePiSessionId?: string;
    headerVersion?: number;
    headerCwd?: string;
    body?: string;
}

async function writeTranscript(cwd: string, piSessionId: string, options: TranscriptOptions = {}) {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const timestamp = options.timestamp || "2026-01-01T00:00:00.000Z";
    const sessionPath = join(
        sessionDir,
        `${timestamp.replace(/[:.]/g, "-")}_${options.filenamePiSessionId || piSessionId}.jsonl`,
    );
    const header = {
        type: "session",
        version: options.headerVersion ?? 3,
        id: piSessionId,
        timestamp,
        cwd: options.headerCwd || cwd,
    };
    await fsWriteFile(sessionPath, `${JSON.stringify(header)}\n${options.body || ""}`);
    return sessionPath;
}

function createVersion5Database(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    try {
        db.exec("PRAGMA foreign_keys = ON");
        db.exec(OWNER_COORDINATION_SCHEMA_V1_SQL);
        db.exec(OWNER_COORDINATION_SCHEMA_V2_SQL);
        db.exec(OWNER_COORDINATION_SCHEMA_V3_SQL);
        db.exec(OWNER_COORDINATION_SCHEMA_V4_SQL);
        db.exec(OWNER_COORDINATION_SCHEMA_V5_SQL);
        const insert = db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
        for (const version of [1, 2, 3, 4, 5]) insert.run(version, `v${version}`);
    } finally {
        db.close();
    }
}

test("version-five locator rows migrate to ordinal-zero transcript segments without touching transcript files", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-migration-"));
    try {
        const dbPath = join(dir, `owner.sqlite3`);
        createVersion5Database(dbPath);
        const legacy = new DatabaseSync(dbPath);
        const root = join(dir, `repo`);
        await fsMkdir(root);
        const transcriptPath = await writeTranscript(root, "pi-legacy", { body: "legacy body\n" });
        const before = await fsStat(transcriptPath);
        try {
            legacy.exec("PRAGMA foreign_keys = ON");
            legacy
                .prepare(
                    "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, 'enabled', 't0', 't0')",
                )
                .run(root, root);
            legacy
                .prepare(
                    "INSERT INTO project_roots(id, project_id, entered_root, canonical_root, root_state, created_at) VALUES ('root-1', 'project-1', ?, ?, 'current', 't0')",
                )
                .run(root, await fsRealpath(root));
            legacy
                .prepare(
                    "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
                )
                .run();
            legacy
                .prepare(
                    "INSERT INTO session_transcript_locators(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES ('locator-1', 'session-1', 'project-1', 'pi-legacy', ?, ?, 3, '2026-01-01T00:00:00.000Z', 't1', 't1')",
                )
                .run(transcriptPath, root);
        } finally {
            legacy.close();
        }

        const database = openOwnerCoordinationDatabase({ dbPath });
        try {
            const after = await fsStat(transcriptPath);
            const segments = listSessionTranscriptSegments(database, "session-1");
            assertEquals(segments.length, 1);
            assertEquals(segments[0].ordinal, 0);
            assertEquals(segments[0].piSessionId, "pi-legacy");
            assertEquals(segments[0].transcriptPath, transcriptPath);
            assertEquals(segments[0].sealedAt, null);
            assertEquals(getCurrentSessionSegment(database, "session-1")?.segmentId, segments[0].segmentId);
            assertEquals(before.mtime?.getTime(), after.mtime?.getTime());
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("segments append after sealing and preserve ordering while allowing duplicate Pi ids", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-append-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t0" });
            const firstPath = await writeTranscript(root, "pi-same");
            const session = await ensureSessionCatalogRecord(database, {
                projectId: project.projectId,
                piSessionId: "pi-same",
                transcriptPath: firstPath,
                transcriptCwd: root,
                idFactory: idFactory("session"),
                now: () => "t1",
            });
            const first = getCurrentSessionSegment(database, session.runwieldSessionId);
            assert(first);
            await sealSessionTranscriptSegment(database, {
                runwieldSessionId: session.runwieldSessionId,
                segmentId: first.segmentId,
                evidence: await captureTranscriptEvidence({
                    transcriptPath: first.transcriptPath,
                    transcriptCwd: root,
                }),
                now: () => "t2",
            });
            const secondPath = await writeTranscript(root, "pi-same", { timestamp: "2026-01-01T00:00:01.000Z" });
            const second = await appendSessionTranscriptSegment(database, {
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                piSessionId: "pi-same",
                transcriptPath: secondPath,
                transcriptCwd: root,
                kind: "execution",
                lineageParentSegmentId: first.segmentId,
                idFactory: idFactory("segment"),
                now: () => "t3",
            });
            const segments = listSessionTranscriptSegments(database, session.runwieldSessionId);
            assertEquals(
                segments.map((segment) => segment.ordinal),
                [0, 1],
            );
            assertEquals(
                segments.map((segment) => segment.piSessionId),
                ["pi-same", "pi-same"],
            );
            assertEquals(getCurrentSessionSegment(database, session.runwieldSessionId)?.segmentId, second.segmentId);
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("append rejects transcript paths outside the Project root and missing files", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-guard-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            const outside = join(dir, `outside`);
            await fsMkdir(root);
            await fsMkdir(outside);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t0" });
            const firstPath = await writeTranscript(root, "pi-1");
            const session = await ensureSessionCatalogRecord(database, {
                projectId: project.projectId,
                piSessionId: "pi-1",
                transcriptPath: firstPath,
                transcriptCwd: root,
                idFactory: idFactory("session"),
            });
            const first = getCurrentSessionSegment(database, session.runwieldSessionId);
            assert(first);
            await sealSessionTranscriptSegment(database, {
                runwieldSessionId: session.runwieldSessionId,
                segmentId: first.segmentId,
                evidence: await captureTranscriptEvidence({
                    transcriptPath: first.transcriptPath,
                    transcriptCwd: root,
                }),
            });
            const outsidePath = await writeTranscript(outside, "pi-2");
            await assertRejects(
                () =>
                    appendSessionTranscriptSegment(database, {
                        runwieldSessionId: session.runwieldSessionId,
                        projectId: project.projectId,
                        piSessionId: "pi-2",
                        transcriptPath: outsidePath,
                        transcriptCwd: outside,
                        kind: "execution",
                    }),
                Error,
                "Project root evidence",
            );
            await assertRejects(
                () =>
                    appendSessionTranscriptSegment(database, {
                        runwieldSessionId: session.runwieldSessionId,
                        projectId: project.projectId,
                        piSessionId: "missing",
                        transcriptPath: `${getRunWieldSessionDir(root)}/2026-01-01T00-00-02-000Z_missing.jsonl`,
                        transcriptCwd: root,
                        kind: "execution",
                    }),
                Error,
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("sealed segments are immutable at the database boundary", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-immutable-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            database.transaction(() => {
                database.handle
                    .prepare(
                        "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, 'enabled', 't0', 't0')",
                    )
                    .run(dir, dir);
                database.handle
                    .prepare(
                        "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
                    )
                    .run();
                database.handle
                    .prepare(
                        "INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, ordinal, kind, sealed_at, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES ('segment-1', 'session-1', 'project-1', 'pi-1', '/tmp/segment-1.jsonl', ?, 0, 'planning', 'sealed', 3, 'ts', 't1', 't1')",
                    )
                    .run(dir);
            });
            assertThrows(
                () =>
                    database.handle
                        .prepare("UPDATE session_transcript_segments SET kind = 'execution' WHERE id = 'segment-1'")
                        .run(),
                Error,
                "immutable",
            );
            assertThrows(
                () => database.handle.prepare("DELETE FROM session_transcript_segments WHERE id = 'segment-1'").run(),
                Error,
                "immutable",
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("catalog reconstruction regroups valid lineage-bearing transcript segments", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-reconstruct-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t0" });
            const firstPath = await writeTranscript(root, "pi-a", {
                timestamp: "2026-01-01T00:00:00.000Z",
                body: `${JSON.stringify({
                    type: "custom",
                    customType: "runwield.segment_lineage",
                    data: { segmentId: "segment-a", runwieldSessionId: "session-lineage" },
                })}\n`,
            });
            const secondPath = await writeTranscript(root, "pi-b", {
                timestamp: "2026-01-01T00:00:01.000Z",
                body: `${JSON.stringify({
                    type: "custom",
                    customType: "runwield.segment_lineage",
                    data: {
                        segmentId: "segment-b",
                        runwieldSessionId: "session-lineage",
                        parentSegmentId: "segment-a",
                        parentPiSessionId: "pi-a",
                    },
                })}\n`,
            });
            const result = await listProjectSessions(database, project.projectId, {
                fullRescan: true,
                idFactory: idFactory("locator"),
                now: () => "t1",
            });
            assertEquals(result.diagnostics, []);
            assertEquals(result.sessions.length, 1);
            assertEquals(result.sessions[0].runwieldSessionId, "session-lineage");
            const segments = listSessionTranscriptSegments(database, "session-lineage");
            assertEquals(
                segments.map((segment) => segment.segmentId),
                ["segment-a", "segment-b"],
            );
            assertEquals(
                segments.map((segment) => segment.transcriptPath),
                [firstPath, secondPath],
            );
            assertEquals(segments[0].sealedAt, "t1");
            assertEquals(getCurrentSessionSegment(database, "session-lineage")?.segmentId, "segment-b");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("catalog reconstruction marks ambiguous lineage-bearing transcript segments for recovery", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-recovery-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            const root = join(dir, `repo`);
            await fsMkdir(root);
            const project = registerProject(database, { root, idFactory: idFactory(), now: () => "t0" });
            await writeTranscript(root, "pi-a", {
                timestamp: "2026-01-01T00:00:00.000Z",
                body: `${JSON.stringify({
                    type: "custom",
                    customType: "runwield.segment_lineage",
                    data: { segmentId: "segment-a", runwieldSessionId: "session-lineage" },
                })}\n`,
            });
            await writeTranscript(root, "pi-b", {
                timestamp: "2026-01-01T00:00:01.000Z",
                body: `${JSON.stringify({
                    type: "custom",
                    customType: "runwield.segment_lineage",
                    data: {
                        segmentId: "segment-b",
                        runwieldSessionId: "session-lineage",
                        parentSegmentId: "segment-a",
                    },
                })}\n`,
            });
            await writeTranscript(root, "pi-c", {
                timestamp: "2026-01-01T00:00:02.000Z",
                body: `${JSON.stringify({
                    type: "custom",
                    customType: "runwield.segment_lineage",
                    data: {
                        segmentId: "segment-c",
                        runwieldSessionId: "session-lineage",
                        parentSegmentId: "segment-a",
                    },
                })}\n`,
            });
            const result = await listProjectSessions(database, project.projectId, { fullRescan: true });
            assertEquals(result.sessions.length, 0);
            assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
                "lineage_recovery_required",
                "lineage_recovery_required",
                "lineage_recovery_required",
            ]);
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("lineage diagnostics distinguish missing ambiguous cyclic and orphaned reconstruction states", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-lineage-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: join(dir, `owner.sqlite3`) });
        try {
            database.transaction(() => {
                database.handle
                    .prepare(
                        "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', ?, ?, 'enabled', 't0', 't0')",
                    )
                    .run(dir, dir);
                database.handle
                    .prepare(
                        "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
                    )
                    .run();
                const insert = database.handle.prepare(
                    "INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, ordinal, kind, sealed_at, header_version, header_timestamp, first_cataloged_at, last_cataloged_at, lineage_parent_segment_id) VALUES (?, 'session-1', 'project-1', ?, ?, ?, ?, 'execution', 'sealed', 3, 'ts', 't1', 't1', ?)",
                );
                insert.run("a", "pi-a", join(dir, `a.jsonl`), dir, 0, "c");
                insert.run("b", "pi-b", join(dir, `b.jsonl`), dir, 1, "a");
                insert.run("c", "pi-c", join(dir, `c.jsonl`), dir, 2, "a");
                insert.run("d", "pi-d", join(dir, `d.jsonl`), dir, 3, null);
                insert.run("e", "pi-e", join(dir, `e.jsonl`), dir, 4, "missing");
            });
            const codes = diagnoseSessionSegmentLineage(database, "session-1")
                .map((diagnostic) => diagnostic.code)
                .sort();
            assertEquals(codes.includes("ambiguous_lineage"), true);
            assertEquals(codes.includes("cyclic_lineage"), true);
            assertEquals(codes.includes("missing_lineage"), true);
            assertEquals(codes.includes("orphaned_lineage"), true);
            assertThrows(
                () =>
                    database.handle
                        .prepare(
                            "INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, ordinal, kind, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES ('bad', 'session-1', 'project-1', 'pi-bad', '/tmp/bad.jsonl', ?, 5, 'unknown', 3, 'ts', 't1', 't1')",
                        )
                        .run(dir),
                Error,
                "CHECK",
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
