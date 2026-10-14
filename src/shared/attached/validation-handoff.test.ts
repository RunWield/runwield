import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { parseDiffFiles } from "../workflow/review-diff.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { type AttachedWorkflowView } from "./operations.ts";

test("Attached validation hands CI repair to a fresh worker and accepts task_completed through Core", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const result = await fixture.call("start_validation", await fixture.status());
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        const action = result.workflow.nextAction;
        assertEquals(action.request.kind, "repair");
        assertStringIncludes(result.instructions?.text || "", "Do not call completion or lifecycle tools");
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        const input = { actionId: action.actionId, message: "- Fixed CI by adding the required marker." };
        const next = await fixture.call("task_completed", result.workflow, input, "repair-completed");
        assert(next.ok && next.workflow.nextAction.kind === "validation", JSON.stringify(next));
        assertEquals(next.workflow.nextAction.request.kind, "reviewer");
        assertEquals(await fixture.ciCount(), 2);
        const replay = await fixture.call("task_completed", result.workflow, input, "repair-completed");
        assertEquals(replay, next);
        assertEquals(await fixture.ciCount(), 2);
    } finally {
        await fixture.close();
    }
});

test("direct review_diff receipts gate review; listing is not inspection and stale actions fail", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        let result = await fixture.call("start_validation", await fixture.status());
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        const original = result.workflow.nextAction.actionId;
        result = await fixture.call("review_diff", result.workflow, { actionId: original, command: "list" });
        assert(result.ok && result.diff);
        result = await fixture.call("review_complete", result.workflow, {
            actionId: original,
            ...{ approved: true },
        });
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        assert(result.workflow.nextAction.request.kind === "reviewer");
        assertEquals(result.workflow.nextAction.request.identity.correctionCount, 1);
        const stale = await fixture.call("review_diff", result.workflow, { actionId: original, command: "list" });
        assert(!stale.ok);
        assertEquals(stale.rejection.code, "action_superseded");
        let workflow: AttachedWorkflowView = result.workflow;
        for (let round = 0; round < 5 && workflow.nextAction.kind === "validation"; round++) {
            const action = workflow.nextAction;
            assert(action.request.kind === "reviewer");
            for (const file of parseDiffFiles(
                action.request.requiredScope === "full" ? action.request.fullDiff : action.request.repairDiff,
            )) {
                const read = await fixture.call("review_diff", workflow, {
                    actionId: action.actionId,
                    command: "show",
                    scope: action.request.requiredScope,
                    path: file.path,
                    maxBytes: 65536,
                });
                assert(read.ok && read.diff?.coverage);
                workflow = read.workflow;
            }
            const review = await fixture.call("review_complete", workflow, {
                actionId: action.actionId,
                ...{ approved: true },
            });
            assert(review.ok);
            workflow = review.workflow;
        }
        assertEquals(workflow.state, "reviewed");
        assertEquals((await fixture.plan()).attrs.status, "reviewed");
    } finally {
        await fixture.close();
    }
});

test("changed review candidates reject old host outcomes and start_validation recovers", async () => {
    const fixture = await attachedValidationFixture();
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "pass");
        const result = await fixture.call("start_validation", await fixture.status());
        assert(result.ok && result.workflow.nextAction.kind === "validation");
        const old = result.workflow.nextAction.actionId;
        await fsWriteFile(join(fixture.cwd, "implementation.ts"), "export const value = 2;\n");
        const rejected = await fixture.call("review_complete", result.workflow, {
            actionId: old,
            ...{ approved: true },
        });
        assert(!rejected.ok, JSON.stringify(rejected));
        assertEquals(rejected.workflow?.revision, result.workflow.revision);
        const staleRead = await fixture.call("review_diff", result.workflow, { actionId: old, command: "list" });
        assert(!staleRead.ok);
        assertEquals(staleRead.workflow?.revision, result.workflow.revision);
        const recovered = await fixture.call("start_validation", await fixture.status());
        assert(recovered.ok && recovered.workflow.nextAction.kind === "validation");
        assert(recovered.workflow.nextAction.actionId !== old);
    } finally {
        await fixture.close();
    }
});
