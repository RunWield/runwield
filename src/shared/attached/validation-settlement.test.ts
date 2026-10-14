import { test } from "node:test";
import { writeFile as fsWriteFile, stat as fsStat, rm as fsRm } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { EVIDENCE } from "./attached-test-fixture.ts";
import { runAttachedOperation } from "./coordinator.ts";
import {
    loadAttachedWorkflowRecord,
    locateAttachedWorkflows,
    writeAttachedWorkflowRecord,
    type AttachedWorkflowRecord,
} from "./record-store.ts";
import { parseDiffFiles } from "../workflow/review-diff.ts";
import { getLockHostname } from "../process-liveness.ts";
import { type AttachedJsonObject, type AttachedWorkflowView } from "./operations.ts";
import process from "node:process";

for (const outcome of ["correction", "repair", "reviewed"] as const) {
    test(`a durable reviewer claim recovers after Core advanced to ${outcome} and replays the original receipt`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            await fsWriteFile(join(fixture.cwd, "marker"), "pass");
            const started = await fixture.call("start_validation", await fixture.status());
            assert(started.ok && started.workflow.nextAction.kind === "validation");
            const action = started.workflow.nextAction;
            assert(action.request.kind === "reviewer");
            let workflow: AttachedWorkflowView = started.workflow;
            if (outcome !== "correction") {
                for (const file of parseDiffFiles(action.request.fullDiff)) {
                    const read = await fixture.call("review_diff", workflow, {
                        actionId: action.actionId,
                        command: "show",
                        scope: "full",
                        path: file.path,
                        maxBytes: 65536,
                    });
                    assert(read.ok);
                    workflow = read.workflow;
                }
            }
            const location = locateAttachedWorkflows(fixture.root);
            const before = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(before.status === "found" && before.record.validation);
            const payload: AttachedJsonObject =
                outcome === "repair"
                    ? {
                          actionId: action.actionId,
                          approved: false,
                          findings: [{ title: "Value", resolved: false, requirement: "Value", evidence: "Missing" }],
                      }
                    : { actionId: action.actionId, approved: true };
            const completing = fixture.call("review_complete", workflow, payload, "original-review");
            let durableClaim: AttachedWorkflowRecord | undefined;
            for (let attempt = 0; attempt < 500; attempt++) {
                const claim = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                if (
                    claim.status === "found" &&
                    claim.record.validation?.holder?.token &&
                    claim.record.validation.operationId === "original-review"
                ) {
                    durableClaim = claim.record;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 2));
            }
            const completed = await completing;
            assert(durableClaim, "The real durable claim must be observed before Core settles.");
            assert(completed.ok, JSON.stringify(completed));
            if (outcome === "reviewed") assertEquals(completed.workflow.state, "reviewed");
            else {
                assert(completed.workflow.nextAction.kind === "validation");
                assertEquals(completed.workflow.nextAction.request.kind, outcome === "repair" ? "repair" : "reviewer");
            }
            const after = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(after.status === "found");
            const originalReceipt = after.record.acceptedOperations["original-review"];
            const acceptedOperations = { ...after.record.acceptedOperations };
            delete acceptedOperations["original-review"];
            // Restore the actual durable claim state left when the final Attached write is lost.
            assertEquals(
                (
                    await writeAttachedWorkflowRecord(
                        location,
                        {
                            ...durableClaim,
                            revision: after.record.revision + 1,
                            acceptedOperations,
                        },
                        after.record.revision,
                    )
                ).status,
                "written",
            );
            const recovered = await fixture.call("start_validation", await fixture.status());
            assert(recovered.ok, JSON.stringify(recovered));
            assertEquals(recovered.workflow.nextAction, completed.workflow.nextAction);
            const replay = await fixture.call("review_complete", workflow, payload, "original-review");
            assert(replay.ok);
            assertEquals(replay.operation, "review_complete");
            assertEquals(replay.workflow.nextAction, completed.workflow.nextAction);
            assertEquals(await fixture.ciCount(), 1);
            const saved = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(saved.status === "found");
            assertEquals(saved.record.acceptedOperations["original-review"].evidence, originalReceipt.evidence);
        } finally {
            await fixture.close();
        }
    });
}

for (const operation of ["review_complete", "task_completed"] as const) {
    test(`two lost final writes preserve the original ${operation} receipt after its resume is consumed`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            if (operation === "review_complete") await fsWriteFile(join(fixture.cwd, "marker"), "pass");
            const started = await fixture.call("start_validation", await fixture.status());
            assert(started.ok && started.workflow.nextAction.kind === "validation");
            const action = started.workflow.nextAction;
            assertEquals(action.request.kind, operation === "review_complete" ? "reviewer" : "repair");
            if (operation === "task_completed") await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
            const payload: AttachedJsonObject =
                operation === "review_complete"
                    ? { actionId: action.actionId, approved: true }
                    : { actionId: action.actionId, message: "- Fixed CI by adding the required marker." };
            const location = locateAttachedWorkflows(fixture.root);
            let originalReceipt: AttachedWorkflowRecord["acceptedOperations"][string] | undefined;
            let expectedAction = started.workflow.nextAction;
            let lastToken = "";
            const recover = async (operationId: string) => {
                const workflow = await fixture.status();
                return await runAttachedOperation(
                    "start_validation",
                    fixture.root,
                    JSON.stringify({
                        workflowId: fixture.workflowId,
                        expectedRevision: workflow.revision,
                        operationId,
                        evidence: { ...EVIDENCE, hostVersion: "recovery-host-version" },
                        payload: {},
                    }),
                );
            };
            for (let loss = 0; loss < 2; loss++) {
                const pending: ReturnType<typeof runAttachedOperation> =
                    loss === 0
                        ? fixture.call(operation, started.workflow, payload, "original-outcome")
                        : recover("first-recovery");
                let durableClaim: AttachedWorkflowRecord | undefined;
                for (let attempt = 0; attempt < 500; attempt++) {
                    const claim = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                    if (
                        claim.status === "found" &&
                        claim.record.validation?.holder?.token &&
                        claim.record.validation.holder.token !== lastToken
                    ) {
                        durableClaim = claim.record;
                        lastToken = claim.record.validation.holder.token;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 2));
                }
                const completed = await pending;
                assert(durableClaim, "Observe the actual claim before losing each final write.");
                assert(completed.ok, JSON.stringify(completed));
                assert(completed.workflow.nextAction.kind === "validation");
                expectedAction = completed.workflow.nextAction;
                if (loss === 1) assertEquals(durableClaim.validation?.resume, undefined);
                const after = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                assert(after.status === "found");
                if (loss === 0) originalReceipt = after.record.acceptedOperations["original-outcome"];
                // Core has advanced, but only the claim survives each lost final write.
                assertEquals(
                    (
                        await writeAttachedWorkflowRecord(
                            location,
                            {
                                ...durableClaim,
                                revision: after.record.revision + 1,
                            },
                            after.record.revision,
                        )
                    ).status,
                    "written",
                );
            }
            const recovered = await recover("second-recovery");
            assert(recovered.ok, JSON.stringify(recovered));
            assertEquals(recovered.workflow.nextAction, expectedAction);
            const replay = await fixture.call(operation, started.workflow, payload, "original-outcome");
            assert(replay.ok, JSON.stringify(replay));
            assertEquals(replay.operation, operation);
            assertEquals(replay.workflow.nextAction, expectedAction);
            const saved = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(saved.status === "found" && originalReceipt);
            assertEquals(saved.record.acceptedOperations["original-outcome"].evidence, originalReceipt.evidence);
            assertEquals(await fixture.ciCount(), operation === "review_complete" ? 1 : 2);
        } finally {
            await fixture.close();
        }
    });
}

for (const releaseBeforeSettlement of [true, false]) {
    test(`a settled validation call recovers its live holder with a ${releaseBeforeSettlement ? "released" : "contended"} settlement lock`, async () => {
        const fixture = await attachedValidationFixture({ command: "sleep 1; sh verify.sh" });
        let lockPath = "";
        try {
            await fsWriteFile(join(fixture.cwd, "marker"), "pass");
            const location = locateAttachedWorkflows(fixture.root);
            const pending = fixture.call("start_validation", await fixture.status());
            let token = "";
            for (let attempt = 0; attempt < 500; attempt++) {
                const loaded = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                if (loaded.status === "found" && loaded.record.validation?.holder?.token) {
                    token = loaded.record.validation.holder.token;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(token);
            lockPath = join(location.workflowsDir, `${fixture.workflowId}.lock`);
            for (let attempt = 0; ; attempt++) {
                try {
                    await fsWriteFile(
                        lockPath,
                        JSON.stringify({
                            pid: process.pid,
                            hostname: getLockHostname(),
                            token: "contention",
                            createdAt: Date.now(),
                        }),
                        { flag: "wx" },
                    );
                    break;
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || attempt >= 500)
                        throw error;
                    await new Promise((resolve) => setTimeout(resolve, 2));
                }
            }
            // Keep a real lock until settlement proves that the final CAS timed out.
            for (let attempt = 0; attempt < 2000; attempt++) {
                try {
                    await fsStat(join(location.workflowsDir, `validation-${token}.settled`));
                    break;
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (releaseBeforeSettlement) {
                await fsRm(lockPath);
                lockPath = "";
            }
            const failed = await pending;
            if (lockPath) {
                await fsRm(lockPath);
                lockPath = "";
            }
            assert(!failed.ok, JSON.stringify(failed));
            const recovered = await fixture.call("start_validation", await fixture.status());
            assert(recovered.ok && recovered.workflow.nextAction.kind === "validation", JSON.stringify(recovered));
            assertEquals(await fixture.ciCount(), 1);
        } finally {
            if (lockPath) await fsRm(lockPath).catch(() => {});
            await fixture.close();
        }
    });
}
