import { assertEquals } from "../../testing/assertions.ts";
// @ts-nocheck: Astro workspace check uses browser tsconfig without Deno/JSR test globals.
import { test } from "node:test";
import { loadPlan, savePlan } from "../../plan-store.js";
import { loadPlanActionEvidence, type PlanActionRequest } from "../../shared/workflow/plan-actions.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { runOwnerPlanAction } from "./server/owner-plan-actions.ts";

async function makeAction(
    root: string,
    action: PlanActionRequest["action"] = "put_on_hold",
): Promise<PlanActionRequest> {
    const evidence = await loadPlanActionEvidence(root, "plan-demo");
    if (evidence.kind !== "success") throw new Error(evidence.message);
    return {
        planId: "plan-demo",
        expectedRevision: evidence.evidence.revision,
        expectedStatus: evidence.evidence.status,
        expectedWorktree: evidence.evidence.worktree,
        action,
    };
}

test("returns the stored result for an exact duplicate request", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const root = fixture.projectRoot;
        await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
        const store = fixture.store;
        const action = await makeAction(root);

        const first = await runOwnerPlanAction(store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-1",
            requestId: "req-1",
            requestHash: "hash-1",
            expectedGeneration: 0,
            action,
        });
        const duplicate = await runOwnerPlanAction(store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-1",
            requestId: "req-1",
            requestHash: "hash-1",
            expectedGeneration: 0,
            action,
        });

        assertEquals(first.status, 200);
        assertEquals(duplicate, first);
        assertEquals(store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state, "idle");
        const current = await loadPlan(root, "demo");
        assertEquals(current?.attrs.status, "on_hold");
    } finally {
        await fixture.cleanup();
    }
});

test("returns recovery guidance for an accepted duplicate without replaying", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const root = fixture.projectRoot;
        await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
        const store = fixture.store;
        const action = await makeAction(root);
        store.createOrGetOperationReceipt({
            deviceId: "device-1",
            requestId: "req-accepted",
            runwieldSessionId: fixture.session.runwieldSessionId,
            projectId: fixture.project.projectId,
            expectedGeneration: 0,
            kind: "plan_action",
            requestHash: "hash-accepted",
        });

        const duplicate = await runOwnerPlanAction(store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-1",
            requestId: "req-accepted",
            requestHash: "hash-accepted",
            expectedGeneration: 0,
            action,
        });

        assertEquals(duplicate.status, 409);
        assertEquals(duplicate.body.result.kind, "recovery_required");
        assertEquals(store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation, 0);
        const current = await loadPlan(root, "demo");
        assertEquals(current?.attrs.status, "draft");
    } finally {
        await fixture.cleanup();
    }
});

test("revalidates canonical evidence for a new request id", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const root = fixture.projectRoot;
        await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
        const store = fixture.store;
        const action = await makeAction(root);
        const before = await loadPlan(root, "demo");
        if (!before?.revision) throw new Error("fixture Plan missing revision");
        await savePlan(
            root,
            "demo",
            "# Demo changed\n",
            {
                planId: "plan-demo",
                status: "draft",
                classification: "FEATURE",
            },
            { expectedRevision: before.revision },
        );

        const result = await runOwnerPlanAction(store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-1",
            requestId: "req-2",
            requestHash: "hash-2",
            expectedGeneration: 0,
            action,
        });

        assertEquals(result.status, 409);
        assertEquals(result.body.result.kind, "refresh_required");
        assertEquals(store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state, "idle");
        const current = await loadPlan(root, "demo");
        assertEquals(current?.attrs.status, "draft");
    } finally {
        await fixture.cleanup();
    }
});

test("Workspace Plan action rejects changed status and worktree evidence with a real owner store", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        await savePlan(fixture.projectRoot, "demo", "# Demo\n", {
            planId: "plan-demo",
            status: "draft",
            classification: "FEATURE",
        });
        const action = await makeAction(fixture.projectRoot);
        const before = await loadPlan(fixture.projectRoot, "demo");
        if (!before?.revision) throw new Error("fixture Plan missing revision");
        await savePlan(
            fixture.projectRoot,
            "demo",
            "# Demo\n",
            {
                planId: "plan-demo",
                status: "ready_for_work",
                classification: "FEATURE",
            },
            { expectedRevision: before.revision },
        );

        const result = await runOwnerPlanAction(fixture.store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-real",
            requestId: "req-real-store",
            requestHash: "hash-real-store",
            expectedGeneration: 0,
            action,
        });

        assertEquals(result.status, 409);
        assertEquals(result.body.result.kind, "refresh_required");
        assertEquals((await loadPlan(fixture.projectRoot, "demo"))?.attrs.status, "ready_for_work");
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation,
            0,
        );
    } finally {
        await fixture.cleanup();
    }
});

test("conflicts when a request id is reused with different input", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const root = fixture.projectRoot;
        await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
        const store = fixture.store;
        const action = await makeAction(root);
        await runOwnerPlanAction(store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-1",
            requestId: "req-3",
            requestHash: "hash-3",
            expectedGeneration: 0,
            action,
        });

        const conflict = await runOwnerPlanAction(store, {
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            deviceId: "device-1",
            requestId: "req-3",
            requestHash: "changed",
            expectedGeneration: 0,
            action,
        });

        assertEquals(conflict.status, 409);
        assertEquals(conflict.body.result.kind, "invalid_action");
    } finally {
        await fixture.cleanup();
    }
});
