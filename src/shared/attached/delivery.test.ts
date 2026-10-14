import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { git } from "../git-test-fixture.ts";
import { loadPlan } from "../../plan-store.js";

Deno.test("Attached FEATURE records Claude sections and proves publication before delivered closure", async () => {
    const fixture = await attachedValidationFixture({ attrs: { workKind: "FEATURE", humanReviewMode: "none" } });
    try {
        const result = await toDelivery(fixture);
        assert(
            result.workflow.nextAction.kind === "recorder",
            JSON.stringify({ result, plan: await loadPlan(fixture.root, "p") }),
        );
        assertStringIncludes(result.instructions?.text || "", "Attached Recorder");
        const action = result.workflow.nextAction;
        const completed = await fixture.call("work_record_completed", result.workflow, {
            actionId: action.actionId,
            title: "Value implemented",
            summary: "The implementation exports the new value.",
        });
        assert(completed.ok, JSON.stringify(completed));
        assertEquals(completed.workflow.closure?.reason, "delivered");
        const plan = await loadPlan(fixture.root, "p");
        assertEquals(plan?.attrs.status, "verified");
        const records = await listWorkRecords(fixture.root);
        assertEquals(records.length, 1);
        assertEquals(records[0].attrs.status, "approved");
        assert(plan?.attrs.publicationReceipt?.publishedCommit);
        assertEquals(
            await git(fixture.root, [
                "merge-base",
                "--is-ancestor",
                plan.attrs.publicationReceipt.publishedCommit,
                "main",
            ]),
            "",
        );
        assertEquals((await fixture.status()).nextAction.kind, "delivered");
    } finally {
        await fixture.close();
    }
});

Deno.test("Attached code review rejects an approval after the worktree changes", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const result = await toDelivery(fixture);
        assert(result.workflow.nextAction.kind === "code_review", JSON.stringify(result));
        const action = result.workflow.nextAction;
        await Deno.writeTextFile(join(fixture.cwd, "implementation.ts"), "export const value = 9;\n");
        const rejected = await fixture.call("validation_decision", result.workflow, {
            actionId: action.actionId,
            answer: { outcome: "approved" },
        });
        assert(!rejected.ok, JSON.stringify(rejected));
        assertEquals((await loadPlan(fixture.root, "p"))?.attrs.publicationReceipt ?? null, null);
        const refreshed = await fixture.call("start_validation", await fixture.status());
        assert(refreshed.ok && refreshed.workflow.nextAction.kind === "code_review", JSON.stringify(refreshed));
        assert(refreshed.workflow.nextAction.actionId !== action.actionId);
        assertStringIncludes(String(refreshed.workflow.nextAction.request.interaction._meta?.diffText), "value = 9");
    } finally {
        await fixture.close();
    }
});

Deno.test("two invalid Recorder submissions are rejected and recording failure does not block delivery", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        const first = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "",
            summary: "",
        }, "invalid-first");
        assert(!first.ok && first.workflow?.nextAction.kind === "recorder", JSON.stringify(first));
        assertStringIncludes(first.rejection.message, "non-empty title");
        assert(first.workflow.nextAction.actionId !== started.workflow.nextAction.actionId);
        const replay = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "",
            summary: "",
        }, "invalid-first");
        assertEquals(replay, first);
        const second = await fixture.call("work_record_completed", first.workflow, {
            actionId: first.workflow.nextAction.actionId,
            title: "",
            summary: "",
        });
        assert(!second.ok && second.workflow?.nextAction.kind === "delivered", JSON.stringify(second));
        const plan = await loadPlan(fixture.root, "p");
        assertEquals(plan?.attrs.workRecord?.status, "failed");
        assertEquals(plan?.attrs.status, "verified");
        assertEquals((await listWorkRecords(fixture.root)).length, 0);
    } finally {
        await fixture.close();
    }
});

Deno.test("a missing supersession record is rejected before accepting Recorder sections", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        const first = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "Value",
            summary: "Implemented.",
            supersessionProposals: [{ recordId: "de174442-62e4-4c14-980c-783531bdb457", reason: "Replaces old value" }],
        });
        assert(!first.ok && first.workflow?.nextAction.kind === "recorder", JSON.stringify(first));
        assertStringIncludes(first.rejection.message, "not found");
        const retry = await fixture.call("work_record_completed", first.workflow, {
            actionId: first.workflow.nextAction.actionId,
            title: "Value",
            summary: "Implemented.",
        });
        assert(retry.ok && retry.workflow.nextAction.kind === "delivered", JSON.stringify(retry));
    } finally {
        await fixture.close();
    }
});

Deno.test("human feedback runs in a Claude repair action and re-verifies before a new code review", async () => {
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
        await Deno.writeTextFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
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

Deno.test("canceled code review supports Retry and Stop without losing the pending approval", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const canceled = await fixture.call("validation_decision", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            answer: { outcome: "canceled" },
        });
        assert(
            canceled.ok && canceled.workflow.nextAction.kind === "validation" &&
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

Deno.test("consented non-Git completion records through Claude before Core establishes Verified", async () => {
    await prepareIndexRuntime();
    const fixture = await attachedValidationFixture({ nonGit: true, attrs: { humanReviewMode: "none" } });
    try {
        await Deno.writeTextFile(join(fixture.cwd, "marker"), "pass");
        const started = await fixture.call("start_validation", await fixture.status());
        assert(started.ok && started.workflow.nextAction.kind === "recorder", JSON.stringify(started));
        assertEquals((await fixture.plan()).attrs.status, "reviewed");
        const result = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "In-place result",
            summary: "Changed the current files with consent.",
        });
        assert(result.ok && result.workflow.nextAction.kind === "delivered", JSON.stringify(result));
        assertEquals(result.workflow.nextAction.completionMode, "in_place");
        assertStringIncludes(result.workflow.nextAction.guidance, "no Git publication is claimed");
        assertEquals((await listWorkRecords(fixture.root))[0].attrs.status, "approved");
    } finally {
        await fixture.close();
    }
});
