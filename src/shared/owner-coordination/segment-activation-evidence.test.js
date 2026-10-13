import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "./database.js";
import {
    acquireSessionActivation,
    changeSessionActivationPhase,
    inspectSessionActivation,
    publishGenerationAndRelease,
} from "./session-activations.js";

/** @param {import('./database.js').OwnerCoordinationDatabase} database */
function insertCatalogedSessionWithSegment(database) {
    database.transaction(() => {
        database.handle.prepare(
            "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', '/tmp/project', '/tmp/project', 'enabled', 't0', 't0')",
        ).run();
        database.handle.prepare(
            "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
        ).run();
        database.handle.prepare(
            "INSERT INTO session_transcript_segments(id, runwield_session_id, project_id, pi_session_id, transcript_path, transcript_cwd, ordinal, kind, header_version, header_timestamp, first_cataloged_at, last_cataloged_at) VALUES ('segment-1', 'session-1', 'project-1', 'pi-1', '/tmp/project/.wld/sessions/2026-01-01T00-00-00-000Z_pi-1.jsonl', '/tmp/project', 0, 'planning', 3, '2026-01-01T00:00:00.000Z', 't1', 't1')",
        ).run();
    });
}

test("acquireSessionActivation rejects a wrong current-segment expectation", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-acquire-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSessionWithSegment(database);
            assertThrows(
                () =>
                    acquireSessionActivation(database, {
                        runwieldSessionId: "session-1",
                        projectId: "project-1",
                        ownerInstanceId: "owner-1",
                        ownerProcessKind: "test",
                        operationId: "op-1",
                        expectedGeneration: null,
                        expectedCurrentSegmentId: "wrong",
                        phase: "bootstrap",
                    }),
                Error,
                "current segment expectation",
            );
            const inspected = inspectSessionActivation(database, "session-1");
            assertEquals(inspected.activation?.state, "uninitialized");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("acquireSessionActivation rejects an explicit null current-segment expectation", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-null-acquire-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSessionWithSegment(database);
            assertThrows(
                () =>
                    acquireSessionActivation(database, {
                        runwieldSessionId: "session-1",
                        projectId: "project-1",
                        ownerInstanceId: "owner-1",
                        ownerProcessKind: "test",
                        operationId: "op-1",
                        expectedGeneration: null,
                        expectedCurrentSegmentId: null,
                        phase: "bootstrap",
                    }),
                Error,
                "current segment expectation",
            );
            const inspected = inspectSessionActivation(database, "session-1");
            assertEquals(inspected.activation?.state, "uninitialized");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("publishGenerationAndRelease rejects a wrong-current-segment proof", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-proof-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSessionWithSegment(database);
            const proof = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "op-1",
                expectedGeneration: null,
                phase: "bootstrap",
                now: () => "2026-01-01T00:00:00.000Z",
            });
            assertEquals(proof.expectedCurrentSegmentId, "segment-1");
            const checkpointProof = changeSessionActivationPhase(database, proof, "checkpointing", {
                now: () => "2026-01-01T00:00:00.500Z",
            });
            assertThrows(
                () =>
                    publishGenerationAndRelease(database, { ...checkpointProof, expectedCurrentSegmentId: "wrong" }, {
                        generation: 0,
                        byteLength: 42,
                        terminalEntryId: "entry-1",
                        digestHex: "a".repeat(64),
                        currentSegmentId: "wrong",
                    }, { now: () => "2026-01-01T00:00:01.000Z" }),
                Error,
                "proof",
            );
            publishGenerationAndRelease(database, checkpointProof, {
                generation: 0,
                byteLength: 42,
                terminalEntryId: "entry-1",
                digestHex: "b".repeat(64),
                currentSegmentId: "segment-1",
            }, { now: () => "2026-01-01T00:00:02.000Z" });
            const inspected = inspectSessionActivation(database, "session-1");
            assertEquals(inspected.activation?.state, "idle");
            assertEquals(inspected.generation?.currentSegmentId, "segment-1");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("segment evidence does not introduce segment-level activation locks", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-segment-lock-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSessionWithSegment(database);
            acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "op-1",
                expectedGeneration: null,
                phase: "bootstrap",
            });
            assertThrows(
                () =>
                    acquireSessionActivation(database, {
                        runwieldSessionId: "session-1",
                        projectId: "project-1",
                        ownerInstanceId: "owner-2",
                        ownerProcessKind: "test",
                        operationId: "op-2",
                        expectedGeneration: null,
                        expectedCurrentSegmentId: "segment-1",
                        phase: "bootstrap",
                    }),
                Error,
                "not available",
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
