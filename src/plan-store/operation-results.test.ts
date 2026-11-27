import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { operationDigest, runReceiptedOperation } from "@runwield/plans/operation-receipts";
import {
    readSequenceOperationResult,
    retainSequenceOperationResult,
    settleSequenceOperationResult,
} from "./operation-results.ts";

test("the Sequence result driver retains legacy JSON and replays the same decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sequence-result-"));
    const operationId = randomUUID();
    const digest = operationDigest(JSON.stringify({ operation: "approve-sequence" }));
    const planId = "sequence-one";
    const result = {
        approved: true,
        revision: "1".repeat(64),
        feedback: "Plan valid — résumé",
        workflowOutcome: { outcome: "approved_execute" as const, planName: "sequence" },
    };
    try {
        settleSequenceOperationResult(directory, "invalid");
        settleSequenceOperationResult(directory, operationId);
        await rejects(
            runReceiptedOperation(
                directory,
                operationId,
                digest,
                planId,
                () => {
                    retainSequenceOperationResult(result);
                    return Promise.reject(new Error("Interrupted after retaining the Sequence decision."));
                },
                true,
            ),
            /Interrupted after retaining/,
        );
        const saved = await readFile(join(directory, "sequence-review-results", operationId + ".json"), "utf8");
        equal(saved, JSON.stringify({ operationId, digest, planId, result }, null, 2) + "\n");
        throws(() => readSequenceOperationResult(directory, operationId, planId), /has not committed/);

        settleSequenceOperationResult(directory, operationId);
        const replay = await runReceiptedOperation(
            directory,
            operationId,
            digest,
            planId,
            () => Promise.reject(new Error("A settled Sequence operation must not rerun.")),
            true,
        );
        equal(replay.status, "completed");
        equal(replay.revision, result.revision);
        deepEqual(readSequenceOperationResult(directory, operationId, planId), result);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
