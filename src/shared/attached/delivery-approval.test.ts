import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { approveSemantic, toDelivery } from "./delivery-test-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { loadPlan } from "../../plan-store.js";

test("Attached code review rejects an approval after the worktree changes", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const result = await toDelivery(fixture);
        assert(result.workflow.nextAction.kind === "code_review", JSON.stringify(result));
        const action = result.workflow.nextAction;
        await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 9;\n");
        const rejected = await fixture.call("validation_decision", result.workflow, {
            actionId: action.actionId,
            answer: { outcome: "approved" },
        });
        assert(!rejected.ok, JSON.stringify(rejected));
        assertEquals((await loadPlan(fixture.root, "p"))?.attrs.publicationReceipt ?? null, null);
        const revalidating = await fixture.call("start_validation", await fixture.status());
        assert(revalidating.ok && revalidating.workflow.nextAction.kind === "validation", JSON.stringify(revalidating));
        assertEquals(revalidating.workflow.nextAction.request.kind, "reviewer");
        assertEquals(await fixture.ciCount(), 2);
        const refreshed = await approveSemantic(fixture, revalidating.workflow);
        assert(refreshed.workflow.nextAction.kind === "code_review", JSON.stringify(refreshed));
        assert(refreshed.workflow.nextAction.actionId !== action.actionId);
        assertStringIncludes(String(refreshed.workflow.nextAction.request.interaction._meta?.diffText), "value = 9");
    } finally {
        await fixture.close();
    }
});

test("human feedback runs in a Claude repair action and re-verifies before a new code review", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const feedback = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "feedback", message: "Export value 3." },
        });
        assert(feedback.ok && feedback.workflow.nextAction.kind === "validation", JSON.stringify(feedback));
        const repair = feedback.workflow.nextAction;
        assert(repair.request.kind === "repair");
        assertStringIncludes(repair.request.prompt, "Export value 3.");
        assertEquals((await fixture.plan()).attrs.validationCheckpoint?.repairKind, "human_feedback");
        await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
        const completion = await fixture.call("task_completed", feedback.workflow, {
            actionId: repair.actionId,
            message: "- Exported value 3 as requested.",
        });
        assert(completion.ok, JSON.stringify(completion));
        const reviewed = completion;
        assertEquals(reviewed.workflow.nextAction.kind, "code_review");
        assertEquals(await fixture.ciCount(), 2);
        assert(
            reviewed.workflow.nextAction.kind === "code_review" &&
                reviewed.workflow.nextAction.actionId !== started.workflow.nextAction.actionId,
        );
    } finally {
        await fixture.close();
    }
});

test("canceled code review supports Retry and Stop without losing the pending approval", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const canceled = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(
            canceled.ok &&
                canceled.workflow.nextAction.kind === "validation" &&
                canceled.workflow.nextAction.request.kind === "decision",
        );
        const retry = await fixture.call("validation_decision", canceled.workflow, {
            actionId: canceled.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "retry" },
        });
        assert(retry.ok && retry.workflow.nextAction.kind === "code_review", JSON.stringify(retry));
        const canceledAgain = await fixture.call("validation_decision", retry.workflow, {
            actionId: retry.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(
            canceledAgain.ok && canceledAgain.workflow.nextAction.kind === "validation",
            JSON.stringify(canceledAgain),
        );
        const stop = await fixture.call("validation_decision", canceledAgain.workflow, {
            actionId: canceledAgain.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "stop" },
        });
        assert(stop.ok && stop.workflow.nextAction.kind === "validation_recovery", JSON.stringify(stop));
        const resumed = await fixture.call("start_validation", stop.workflow);
        assert(resumed.ok && resumed.workflow.nextAction.kind === "code_review", JSON.stringify(resumed));
    } finally {
        await fixture.close();
    }
});

for (const committed of [false, true]) {
    test(`${committed ? "committed" : "uncommitted"} implementation edits during Recorder wait require fresh CI, semantic review and human approval`, async () => {
        const fixture = await attachedValidationFixture();
        try {
            const started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "code_review");
            const approved = await fixture.call("validation_decision", started.workflow, {
                actionId: started.workflow.nextAction.actionId,
                answer: { outcome: "approved" },
            });
            assert(approved.ok && approved.workflow.nextAction.kind === "recorder");
            await writeFile(join(fixture.cwd, "implementation.ts"), "export const value = 4;\n");
            if (committed) {
                await git(fixture.cwd, ["add", "implementation.ts"]);
                await git(fixture.cwd, ["commit", "-m", "Edit during Recorder wait"]);
            }
            const resumed = await fixture.call("work_record_completed", approved.workflow, {
                actionId: approved.workflow.nextAction.actionId,
                title: "Value outcome",
                summary: "The implementation exports the new value.",
            });
            assert(resumed.ok && resumed.workflow.nextAction.kind === "validation", JSON.stringify(resumed));
            assertEquals(resumed.workflow.nextAction.request.kind, "reviewer");
            assertEquals(await fixture.ciCount(), 2);
            assertEquals((await loadPlan(fixture.root, "p"))?.attrs.publicationReceipt ?? null, null);
            const reviewed = await approveSemantic(fixture, resumed.workflow);
            assertEquals(reviewed.workflow.nextAction.kind, "code_review");
        } finally {
            await fixture.close();
        }
    });
}
