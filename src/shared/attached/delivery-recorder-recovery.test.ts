import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { crash, recoverDelivery } from "./delivery-recovery-test-fixture.ts";
import { readAttachedAction } from "./coordinator.ts";

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
