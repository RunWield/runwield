import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "../owner-coordination/database.js";
import {
    acquireSessionActivation,
    changeSessionActivationPhase,
    heartbeatSessionActivation,
    inspectSessionActivation,
    publishGenerationAndRelease,
    recoverExpiredSessionControl,
} from "../owner-coordination/session-activations.js";

function insertCatalogedSession(database: ReturnType<typeof openOwnerCoordinationDatabase>) {
    database.transaction(() => {
        database.handle.prepare(
            "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', '/tmp/project', '/tmp/project', 'enabled', 't0', 't0')",
        ).run();
        database.handle.prepare(
            "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
        ).run();
    });
}

function publishGenerationZero(database: ReturnType<typeof openOwnerCoordinationDatabase>) {
    const proof = acquireSessionActivation(database, {
        runwieldSessionId: "session-1",
        projectId: "project-1",
        ownerInstanceId: "owner-0",
        ownerProcessKind: "test",
        operationId: "op-0",
        expectedGeneration: null,
        phase: "bootstrap",
        now: () => "2026-01-01T00:00:00.000Z",
    });
    const checkpointProof = changeSessionActivationPhase(database, proof, "checkpointing", {
        now: () => "2026-01-01T00:00:01.000Z",
    });
    publishGenerationAndRelease(database, checkpointProof, {
        generation: 0,
        byteLength: 10,
        terminalEntryId: "entry-0",
        digestHex: "a".repeat(64),
    }, { now: () => "2026-01-01T00:00:02.000Z" });
}

test("expired control recovery trusts valid transcript evidence and fences the old owner", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-expired-control-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
            publishGenerationZero(database);
            const staleProof = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "old-owner",
                ownerProcessKind: "test",
                operationId: "old-op",
                expectedGeneration: 0,
                phase: "preparing",
                now: () => "2026-01-01T00:01:00.000Z",
            });
            assertThrows(
                () =>
                    recoverExpiredSessionControl(database, {
                        runwieldSessionId: "session-1",
                        projectId: "project-1",
                        expectedFence: staleProof.fence,
                        expectedGeneration: 0,
                        ownerInstanceId: "workspace-owner",
                        ownerProcessKind: "workspace",
                        operationId: "recover-too-early",
                        transcriptEvidence: {
                            generation: 1,
                            byteLength: 20,
                            terminalEntryId: "entry-1",
                            digestHex: "b".repeat(64),
                        },
                        now: () => "2026-01-01T00:01:05.000Z",
                    }),
                Error,
                "still renewing",
            );
            recoverExpiredSessionControl(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                expectedFence: staleProof.fence,
                expectedGeneration: 0,
                ownerInstanceId: "workspace-owner",
                ownerProcessKind: "workspace",
                operationId: "recover-op",
                transcriptEvidence: {
                    generation: 1,
                    byteLength: 20,
                    terminalEntryId: "entry-1",
                    digestHex: "b".repeat(64),
                },
                now: () => "2026-01-01T00:02:00.000Z",
            });
            const inspected = inspectSessionActivation(database, "session-1");
            assertEquals(inspected.activation?.state, "idle");
            assertEquals(inspected.generation?.generation, 1);
            assertThrows(
                () => heartbeatSessionActivation(database, staleProof, { now: () => "2026-01-01T00:02:01.000Z" }),
                Error,
                "not active",
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
