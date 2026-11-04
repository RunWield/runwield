import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { openOwnerCoordinationDatabase } from "./database.ts";
import type { OwnerCoordinationDatabase } from "./database.ts";
import { createOrGetOperationReceipt, updateOperationReceipt } from "./session-activations.js";

function insertCatalogedSession(database: OwnerCoordinationDatabase, root: string) {
    database.transaction(() => {
        database.handle
            .prepare(
                "INSERT INTO projects(id, display_name, registered_root, current_root, lifecycle, created_at, updated_at) VALUES ('project-1', 'Project', ?1, ?1, 'enabled', 't0', 't0')",
            )
            .run(root);
        database.handle
            .prepare(
                "INSERT INTO runwield_sessions(id, project_id, source, created_at, updated_at) VALUES ('session-1', 'project-1', 'catalog', 't0', 't0')",
            )
            .run();
    });
}

test("plan_action operation receipts preserve bounded results", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-plan-action-receipt-"));
    try {
        const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
        try {
            insertCatalogedSession(database, dir);
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
                }),
            );
        } finally {
            database.close();
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
