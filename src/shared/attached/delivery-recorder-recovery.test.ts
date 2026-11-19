import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { crash, recoverDelivery } from "./delivery-recovery-test-fixture.ts";
import { readAttachedAction } from "./coordinator.ts";
import {
    loadAttachedWorkflowRecord,
    locateAttachedWorkflows,
    writeAttachedWorkflowRecord,
    type AttachedWorkflowRecord,
} from "./record-store.ts";

for (const point of ["code_review_wait", "recorder_wait", "recorder_sections", "record_saved"]) {
    for (const timing of point === "record_saved" ? ["after"] : ["before", "after"]) {
        test(`fresh Attached process recovers ${timing} ${point} without repeating accepted work`, async () => {
            await recoverDelivery(point, timing);
        });
    }
}

for (const timing of ["before", "after"]) {
    test(`an invalid Recorder submission gets exactly one retry after a crash ${timing} its receipt`, async () => {
        await prepareIndexRuntime();
        const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
        try {
            const started = await toDelivery(fixture);
            const workflow = started.workflow;
            assert(workflow.nextAction.kind === "recorder");
            await crash(
                fixture,
                "work_record_completed",
                {
                    workflowId: workflow.workflowId,
                    expectedRevision: workflow.revision,
                    operationId: "lost-invalid-outcome",
                    evidence: EVIDENCE,
                    payload: { actionId: workflow.nextAction.actionId, title: "", summary: "" },
                },
                "recorder_rejected",
                timing,
            );
            const status = await spawnAttachedCli("status", fixture.root, { workflowId: workflow.workflowId });
            assert(status.result.ok);
            const recovered = await spawnAttachedCli("start_validation", fixture.root, {
                workflowId: workflow.workflowId,
                expectedRevision: status.result.workflow.revision,
                operationId: "recover-invalid",
                evidence: EVIDENCE,
                payload: {},
            });
            assert(
                !recovered.result.ok && recovered.result.rejection.code === "invalid_outcome",
                JSON.stringify(recovered.result),
            );
            const current = await fixture.status();
            assert(current.nextAction.kind === "recorder", JSON.stringify(current));
            assertEquals((await fixture.plan()).attrs.validationCheckpoint?.hostRecorder?.invalidSubmissions, 1);
            const error = current.nextAction.request.validationError;
            assert(error);
            const instructions = await readAttachedAction({
                evidence: EVIDENCE,
                projectRoot: fixture.root,
                workflowId: workflow.workflowId,
                actionId: current.nextAction.actionId,
                content: "instructions",
            });
            assert(instructions.ok && "instructions" in instructions && instructions.instructions);
            assert(instructions.instructions.text.includes(error));
            const completed = await fixture.call("work_record_completed", current, {
                actionId: current.nextAction.actionId,
                title: "Value outcome",
                summary: "The value is implemented.",
            });
            assert(completed.ok && completed.workflow.nextAction.kind === "delivered", JSON.stringify(completed));
            assertEquals((await listWorkRecords(fixture.root)).length, 1);
        } finally {
            await fixture.close();
        }
    });
}

for (const interruptedCall of ["submission", "recovery"]) {
    test(`publication recovery preserves a second Recorder rejection after losing the ${interruptedCall} receipt`, async () => {
        const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
        try {
            const started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "recorder");
            const first = await fixture.call("work_record_completed", started.workflow, {
                actionId: started.workflow.nextAction.actionId,
                title: "",
                summary: "",
            });
            assert(!first.ok && first.rejection.code === "invalid_outcome" && first.workflow);
            const workflow = first.workflow;
            assert(workflow.nextAction.kind === "recorder");
            const payload = { actionId: workflow.nextAction.actionId, title: "", summary: "" };
            const location = locateAttachedWorkflows(fixture.root);
            if (interruptedCall === "recovery") {
                await crash(
                    fixture,
                    "work_record_completed",
                    {
                        workflowId: workflow.workflowId,
                        expectedRevision: workflow.revision,
                        operationId: "second-invalid",
                        evidence: EVIDENCE,
                        payload,
                    },
                    "recorder_failure",
                    "after",
                );
                assert((await fixture.plan()).attrs.validationCheckpoint?.hostRecorder?.failure);
            }
            const before = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(before.status === "found");
            const completing =
                interruptedCall === "submission"
                    ? fixture.call("work_record_completed", workflow, payload, "second-invalid")
                    : fixture.call("start_validation", await fixture.status(), {}, "recover-second-invalid");
            let durableClaim: AttachedWorkflowRecord | undefined;
            for (let attempt = 0; attempt < 500; attempt++) {
                const claim = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                if (
                    claim.status === "found" &&
                    claim.record.validation?.holder?.token &&
                    claim.record.validation.holder.token !== before.record.validation?.holder?.token &&
                    claim.record.validation.operationId === "second-invalid"
                ) {
                    durableClaim = claim.record;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 2));
            }
            const completed = await completing;
            assert(durableClaim, "The real durable claim must be observed before publication settles.");
            assert(!completed.ok && completed.rejection.code === "invalid_outcome" && completed.workflow);
            assertEquals(completed.workflow.nextAction.kind, "delivered");
            const after = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(after.status === "found");
            const acceptedOperations = durableClaim.acceptedOperations;
            // Restore the actual claim left when publication succeeds but its Attached receipt is lost.
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
            const recovered = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
            assert(recovered.result.workflow);
            assertEquals(recovered.result.workflow.nextAction.kind, "delivered");
            const replay = await fixture.call("work_record_completed", workflow, payload, "second-invalid");
            assert(!replay.ok, JSON.stringify(replay));
            assertEquals(replay.rejection, completed.rejection);
            assertEquals(replay.operation, "work_record_completed");
            assertEquals(replay.workflow?.nextAction.kind, "delivered");
            assert(replay.workflow?.closure?.reason === "delivered");
            assertEquals(replay.workflow.closure.workRecord?.status, "failed");
        } finally {
            await fixture.close();
        }
    });
}
