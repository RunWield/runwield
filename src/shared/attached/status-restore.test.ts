import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import {
    activateInput,
    pendingTriage,
    runOperation,
    spawnAttachedCli,
    submitReview,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";

test("status without a workflowId finds the latest open workflow and skips closed requests", async () => {
    await withProject(async (root) => {
        const review = await submitReview(root);
        const input = activateInput("second-activation");
        input.payload = { requestText: "Explain this project", hostRequestId: "another-request" };
        const second = pendingTriage(await runOperation("activate", root, input));
        const latest = await spawnAttachedCli("status", root, {});
        assert(latest.result.ok);
        assertEquals(latest.result.workflow.workflowId, second.workflowId);
        const closed = await runOperation(
            "triage_report",
            root,
            triageReportInput({
                ...second,
                operationId: "second-triage",
                outcome: { routingIntent: "INQUIRY", complexity: "LOW", summary: "Explain" },
            }),
        );
        assert(closed.ok);
        assertEquals(closed.workflow.state, "closed");
        const previous = await runOperation("status", root, {});
        assert(previous.ok);
        assertEquals(previous.workflow.workflowId, review.workflowId);
    });
});

test("status without a workflowId never restores another project's request", async () => {
    await withProject(async (first) => {
        await submitReview(first);
        await withProject(async (other) => {
            const result = await runOperation("status", other, {});
            assert(!result.ok);
            assertEquals(result.rejection.code, "workflow_not_found");
        });
    });
});
