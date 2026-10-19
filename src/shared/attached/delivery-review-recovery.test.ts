import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { EVIDENCE, spawnAttachedCli } from "./attached-test-fixture.ts";
import { toDelivery } from "./delivery-test-fixture.ts";
import { crash } from "./delivery-recovery-test-fixture.ts";

for (const outcome of ["approved", "feedback"]) {
    for (const timing of ["before", "after"] as const) {
        test(`a fresh process preserves code-review ${outcome} ${timing} its decision claim`, async () => {
            const fixture = await attachedValidationFixture();
            try {
                const started = await toDelivery(fixture);
                assert(started.workflow.nextAction.kind === "code_review");
                const input = {
                    workflowId: started.workflow.workflowId,
                    expectedRevision: started.workflow.revision,
                    operationId: "interrupted-browser-decision",
                    evidence: EVIDENCE,
                    payload: {
                        actionId: started.workflow.nextAction.actionId,
                        answer: { outcome, ...(outcome === "feedback" ? { message: "Export value 3." } : {}) },
                    },
                };
                await crash(fixture, "validation_decision", input, "code_review_decision", timing);
                const status = await spawnAttachedCli("status", fixture.root, { workflowId: fixture.workflowId });
                assert(status.result.ok);
                const continued =
                    timing === "before"
                        ? await spawnAttachedCli("validation_decision", fixture.root, input)
                        : await spawnAttachedCli("start_validation", fixture.root, {
                              workflowId: fixture.workflowId,
                              expectedRevision: status.result.workflow.revision,
                              operationId: "resume-saved-decision",
                              evidence: EVIDENCE,
                              payload: {},
                          });
                assert(continued.result.ok, JSON.stringify(continued.result));
                const action = continued.result.workflow.nextAction;
                if (outcome === "approved") assert(action.kind === "recorder", JSON.stringify(action));
                else {
                    assert(action.kind === "validation" && action.request.kind === "repair", JSON.stringify(action));
                    assert(action.request.prompt.includes("Export value 3."));
                }
                assertEquals((await fixture.evidence()).filter((entry) => entry.kind === "human").length, 1);
            } finally {
                await fixture.close();
            }
        });
    }
}
