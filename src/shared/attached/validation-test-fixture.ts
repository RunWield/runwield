import { ok as assert } from "node:assert/strict";
import { hostFixture, type HostFixtureOptions } from "../workflow/testing/validation-host-fixture.ts";
import { activate, runAttachedOperation } from "./coordinator.ts";
import { EVIDENCE } from "./attached-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, writeAttachedWorkflowRecord } from "./record-store.ts";
import {
    type AttachedJsonObject,
    type AttachedOperationName,
    type AttachedOperationResult,
    type AttachedWorkflowView,
} from "./operations.ts";

/** Real implemented Plan and worktree; only the carrier's pre-validation record is seeded. */
export async function attachedValidationFixture(options: HostFixtureOptions = {}) {
    const fixture = await hostFixture(options);
    const activated = await activate({
        projectRoot: fixture.root,
        operationId: "activate-validation",
        evidence: EVIDENCE,
        payload: { requestText: "Implement the value", hostRequestId: "host-validation" },
    });
    assert(activated.ok);
    const location = locateAttachedWorkflows(fixture.root);
    const loaded = await loadAttachedWorkflowRecord(location, activated.workflow.workflowId);
    assert(loaded.status === "found");
    const seeded = {
        ...loaded.record,
        revision: loaded.record.revision + 1,
        state: "implemented" as const,
        pendingAction: null,
        plan: { planId: "plan-host", planName: "p" },
    };
    assert((await writeAttachedWorkflowRecord(location, seeded, loaded.record.revision)).status === "written");
    return {
        ...fixture,
        workflowId: seeded.workflowId,
        async status(): Promise<AttachedWorkflowView> {
            const result = await runAttachedOperation(
                "status",
                fixture.root,
                JSON.stringify({ workflowId: seeded.workflowId }),
            );
            assert(result.ok);
            return result.workflow;
        },
        async call(
            operation: AttachedOperationName,
            workflow: AttachedWorkflowView,
            payload: AttachedJsonObject = {},
            operationId: string = crypto.randomUUID(),
        ): Promise<AttachedOperationResult> {
            return await runAttachedOperation(
                operation,
                fixture.root,
                JSON.stringify({
                    workflowId: seeded.workflowId,
                    expectedRevision: workflow.revision,
                    operationId,
                    evidence: EVIDENCE,
                    payload,
                }),
            );
        },
    };
}
