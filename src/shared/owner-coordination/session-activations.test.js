import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "./database.js";
import { acknowledgeActivationProtocol, getActivationProtocolStatus } from "./activation-protocol.ts";
import {
    acquireSessionActivation,
    changeSessionActivationPhase,
    createOrGetOperationReceipt,
    heartbeatSessionActivation,
    inspectSessionActivation,
    markSessionReconcileRequired,
    markSessionReconcileRequiredWithProof,
    markSessionUncertain,
    publishGenerationAndRelease,
    recoverExpiredSessionControl,
    updateOperationReceipt,
} from "./session-activations.js";

/** @param {import('./database.js').OwnerCoordinationDatabase} database */
function insertCatalogedSession(database) {
    database.transaction(() => {
        database.handle.prepare(
            "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', '/tmp/project', '/tmp/project', 'enabled', 't0', 't0')",
        ).run();
        database.handle.prepare(
            "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
        ).run();
    });
}

test("activation protocol marker binds to the database epoch", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-activation-protocol-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            assertEquals(getActivationProtocolStatus(database).enabled, false);
            const enabled = acknowledgeActivationProtocol(database, { now: () => "2026-01-01T00:00:00.000Z" });
            assertEquals(enabled.enabled, true);
            assertEquals(getActivationProtocolStatus(database).state, "enabled");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("activation state backfills and publishes generation zero through a fenced proof", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-activation-state-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
            assertEquals(inspectSessionActivation(database, "session-1").activation?.state, "uninitialized");
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
            const checkpointProof = changeSessionActivationPhase(database, proof, "checkpointing", {
                now: () => "2026-01-01T00:00:00.500Z",
            });
            publishGenerationAndRelease(database, checkpointProof, {
                generation: 0,
                byteLength: 42,
                terminalEntryId: "entry-1",
                digestHex: "a".repeat(64),
            }, { now: () => "2026-01-01T00:00:01.000Z" });
            const inspected = inspectSessionActivation(database, "session-1");
            assertEquals(inspected.activation?.state, "idle");
            assertEquals(inspected.generation?.generation, 0);
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("stale or expired activation proofs cannot publish or revive a session", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-activation-stale-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
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
            assertThrows(
                () => heartbeatSessionActivation(database, proof, { now: () => "2026-01-01T00:01:00.000Z" }),
                Error,
                "expired",
            );
            assertEquals(inspectSessionActivation(database, "session-1").activation?.state, "uncertain");
            assertThrows(() =>
                acquireSessionActivation(database, {
                    runwieldSessionId: "session-1",
                    projectId: "project-1",
                    ownerInstanceId: "owner-2",
                    ownerProcessKind: "test",
                    expectedGeneration: null,
                    phase: "bootstrap",
                })
            );
            markSessionReconcileRequired(database, { runwieldSessionId: "session-1", projectId: "project-1" });
            assertEquals(inspectSessionActivation(database, "session-1").activation?.state, "reconcile_required");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("activation state enforces phase graph, exact proof, and no-change release boundaries", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-activation-graph-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
            const proof = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "op-1",
                expectedGeneration: null,
                phase: "preparing",
                now: () => "2026-01-01T00:00:00.000Z",
            });
            assertThrows(
                () =>
                    changeSessionActivationPhase(database, proof, "turning", {
                        now: () => "2026-01-01T00:00:00.250Z",
                    }),
                Error,
                "Illegal activation phase transition",
            );
            const hydrated = changeSessionActivationPhase(database, proof, "hydrated", {
                now: () => "2026-01-01T00:00:01.000Z",
            });
            assertThrows(
                () => changeSessionActivationPhase(database, { ...hydrated, expectedGeneration: 0 }, "turning"),
                Error,
                "proof",
            );
            assertThrows(
                () =>
                    publishGenerationAndRelease(database, hydrated, {
                        generation: 0,
                        byteLength: 0,
                        terminalEntryId: null,
                        digestHex: "b".repeat(64),
                    }, { now: () => "2026-01-01T00:00:02.000Z" }),
                Error,
                "checkpointing",
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("proof-fenced unhealthy transitions reject a superseded activation", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-activation-fenced-unhealthy-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
            const first = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "op-1",
                expectedGeneration: null,
                phase: "bootstrap",
                now: () => "2026-01-01T00:00:00.000Z",
            });
            const checkpoint = changeSessionActivationPhase(database, first, "checkpointing", {
                now: () => "2026-01-01T00:00:01.000Z",
            });
            publishGenerationAndRelease(database, checkpoint, {
                generation: 0,
                byteLength: 1,
                terminalEntryId: null,
                digestHex: "c".repeat(64),
            }, { now: () => "2026-01-01T00:00:02.000Z" });
            const second = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-2",
                ownerProcessKind: "test",
                operationId: "op-2",
                expectedGeneration: 0,
                phase: "preparing",
                now: () => "2026-01-01T00:00:03.000Z",
            });

            assertThrows(
                () => markSessionReconcileRequiredWithProof(database, first, { reason: "stale" }),
                Error,
                "proof",
            );
            assertThrows(
                () => markSessionUncertain(database, first, { reason: "stale" }),
                Error,
                "proof",
            );
            assertEquals(inspectSessionActivation(database, "session-1").activation?.operationId, second.operationId);
            assertEquals(inspectSessionActivation(database, "session-1").activation?.state, "active");

            markSessionReconcileRequiredWithProof(database, second, {
                reason: "current",
                now: () => "2026-01-01T00:00:04.000Z",
            });
            assertEquals(inspectSessionActivation(database, "session-1").activation?.state, "reconcile_required");
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("plan_action operation receipts preserve bounded results", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-plan-action-receipt-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
            const receipt = createOrGetOperationReceipt(database, {
                deviceId: "device-1",
                requestId: "request-1",
                requestHash: "hash-1",
                runwieldSessionId: "session-1",
                projectId: "project-1",
                expectedGeneration: 0,
                kind: "plan_action",
                operationId: "operation-1",
            });
            if (!receipt) throw new Error("receipt was not created");
            const completed = updateOperationReceipt(database, receipt.operationId, {
                status: "completed",
                resultGeneration: 0,
                resultHttpStatus: 409,
                resultBody: {
                    result: {
                        kind: "refresh_required",
                        message: "refresh",
                        evidence: {
                            planId: "plan-1",
                            planName: "p",
                            revision: "r2",
                            status: "draft",
                            worktree: { kind: "none" },
                        },
                    },
                },
            });
            if (!completed) throw new Error("receipt was not completed");
            assertEquals(completed.resultHttpStatus, 409);
            assertEquals(completed.resultBody.result.kind, "refresh_required");
            assertThrows(() =>
                createOrGetOperationReceipt(database, {
                    deviceId: "device-1",
                    requestId: "request-1",
                    requestHash: "different",
                    runwieldSessionId: "session-1",
                    projectId: "project-1",
                    expectedGeneration: 0,
                    kind: "plan_action",
                })
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("recoverExpiredSessionControl adopts exact or transcript-ahead evidence only after expiry", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-recover-expired-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database);
            const initialProof = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "op-1",
                expectedGeneration: null,
                phase: "bootstrap",
                now: () => "2026-01-01T00:00:00.000Z",
            });
            const checkpointProof = changeSessionActivationPhase(database, initialProof, "checkpointing", {
                now: () => "2026-01-01T00:00:01.000Z",
            });
            publishGenerationAndRelease(database, checkpointProof, {
                generation: 0,
                byteLength: 1,
                terminalEntryId: "entry-0",
                digestHex: "a".repeat(64),
            }, { now: () => "2026-01-01T00:00:02.000Z" });
            const staleProof = acquireSessionActivation(database, {
                runwieldSessionId: "session-1",
                projectId: "project-1",
                ownerInstanceId: "owner-2",
                ownerProcessKind: "test",
                operationId: "op-2",
                expectedGeneration: 0,
                phase: "preparing",
                now: () => "2026-01-01T00:01:00.000Z",
            });
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
                    byteLength: 2,
                    terminalEntryId: "entry-1",
                    digestHex: "b".repeat(64),
                },
                now: () => "2026-01-01T00:02:00.000Z",
            });
            const inspected = inspectSessionActivation(database, "session-1");
            assertEquals(inspected.activation?.state, "idle");
            assertEquals(inspected.generation?.generation, 1);
            assertThrows(() =>
                publishGenerationAndRelease(database, { ...staleProof, phase: "checkpointing" }, {
                    generation: 1,
                    byteLength: 2,
                    terminalEntryId: "entry-1",
                    digestHex: "c".repeat(64),
                }), Error);
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
