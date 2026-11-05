import { writeFile, readFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { prepareIndexRuntime, toDelivery } from "./delivery-test-fixture.ts";
import { listWorkRecords } from "../work-records/store.js";
import { git } from "../git-test-fixture.ts";
import { loadPlan } from "../../plan-store.js";

test("Attached FEATURE records Claude sections and proves publication before delivered closure", async () => {
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

test("two invalid Recorder submissions are rejected and recording failure does not block delivery", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        const first = await fixture.call(
            "work_record_completed",
            started.workflow,
            {
                actionId: started.workflow.nextAction.actionId,
                title: "",
                summary: "",
            },
            "invalid-first",
        );
        assert(!first.ok && first.workflow?.nextAction.kind === "recorder", JSON.stringify(first));
        assertStringIncludes(first.rejection.message, "non-empty title");
        assert(first.workflow.nextAction.actionId !== started.workflow.nextAction.actionId);
        const replay = await fixture.call(
            "work_record_completed",
            started.workflow,
            {
                actionId: started.workflow.nextAction.actionId,
                title: "",
                summary: "",
            },
            "invalid-first",
        );
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

test("a missing supersession record is rejected before accepting Recorder sections", async () => {
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

test("consented non-Git completion records through Claude before Core establishes Verified", async () => {
    await prepareIndexRuntime();
    const fixture = await attachedValidationFixture({ nonGit: true, attrs: { humanReviewMode: "none" } });
    try {
        await writeFile(join(fixture.cwd, "marker"), "pass");
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

for (const invalid of [false, true]) {
    test(`delivery to another branch retains the ${invalid ? "failed" : "generated"} recording outcome`, async () => {
        const fixture = await attachedValidationFixture({
            attrs: { humanReviewMode: "none", deliveryBranch: "landing" },
        });
        try {
            await git(fixture.root, ["branch", "landing"]);
            const primaryPlan = await readFile(join(fixture.root, "docs/plans/p.md"), "utf8");
            let started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "recorder");
            const sections = {
                title: "Value outcome",
                summary: "Implemented.",
                supersessionProposals: invalid
                    ? [{ recordId: "de174442-62e4-4c14-980c-783531bdb457", reason: "Replaces old value" }]
                    : [],
            };
            if (invalid) {
                const first = await fixture.call("work_record_completed", started.workflow, {
                    actionId: started.workflow.nextAction.actionId,
                    ...sections,
                });
                assert(!first.ok && first.workflow?.nextAction.kind === "recorder");
                started = { ...started, workflow: first.workflow };
            }
            assert(started.workflow.nextAction.kind === "recorder");
            const completed = await fixture.call("work_record_completed", started.workflow, {
                actionId: started.workflow.nextAction.actionId,
                ...sections,
            });
            assertEquals(completed.ok, !invalid, JSON.stringify(completed));
            assert(completed.workflow?.nextAction.kind === "delivered", JSON.stringify(completed));
            assertEquals(completed.workflow.nextAction.workRecord?.status, invalid ? "failed" : "generated");
            assertEquals(await readFile(join(fixture.root, "docs/plans/p.md"), "utf8"), primaryPlan);
            const replayedCore = await fixture.turn();
            assert(replayedCore.kind === "verified", JSON.stringify(replayedCore));
            assertEquals(replayedCore.workRecord, completed.workflow.nextAction.workRecord);
            const restored = await fixture.status();
            assert(restored.nextAction.kind === "delivered");
            assertEquals(restored.nextAction.workRecord, completed.workflow.nextAction.workRecord);
        } finally {
            await fixture.close();
        }
    });
}
