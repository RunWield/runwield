import { seedPlan } from "../../shared/testing/plan-state-fixture.ts";
import { withLocalPlanWorkflow } from "../../plan-store/index.ts";
import { recordPlanEvent } from "../../shared/workflow/plan-lifecycle.js";
import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan } from "../../plan-store/index.ts";

import { loadPlanActionEvidence, type PlanActionRequest } from "../../shared/workflow/plan-actions.ts";
import { makeManagedSessionFixture, type ManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { runOwnerPlanAction, type OwnerPlanActionServiceRequest } from "./server/owner-plan-actions.ts";

async function withActionFixture(body: (fixture: ManagedSessionFixture) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const home = await realpath(await mkdtemp(join(tmpdir(), "runwield-owner-plan-action-")));
        const previousHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const fixture = await makeManagedSessionFixture({ home });
            try {
                await seedPlan(fixture.projectRoot, "demo", "# Demo\n", {
                    planId: "plan-demo",
                    status: "draft",
                    classification: "FEATURE",
                });
                await body(fixture);
            } finally {
                await fixture.cleanup();
            }
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            await rm(home, { recursive: true, force: true });
        }
    });
}

async function makeAction(root: string): Promise<PlanActionRequest> {
    const evidence = await loadPlanActionEvidence(root, "plan-demo");
    if (evidence.kind !== "success") throw new Error(evidence.message);
    return {
        planId: "plan-demo",
        expectedRevision: evidence.evidence.revision,
        expectedStatus: evidence.evidence.status,
        expectedWorktree: evidence.evidence.worktree,
        action: "put_on_hold",
    };
}

function makeRequest(fixture: ManagedSessionFixture, action: PlanActionRequest): OwnerPlanActionServiceRequest {
    return {
        projectId: fixture.project.projectId,
        runwieldSessionId: fixture.session.runwieldSessionId,
        deviceId: "device-1",
        requestId: "req-1",
        requestHash: "hash-1",
        expectedGeneration: 0,
        action,
    };
}

test("returns the stored result for an exact duplicate request", async () => {
    await withActionFixture(async (fixture) => {
        const request = makeRequest(fixture, await makeAction(fixture.projectRoot));
        const first = await runOwnerPlanAction(fixture.store, request);
        const beforeReplay = await loadPlan(fixture.projectRoot, "demo");
        const duplicate = await runOwnerPlanAction(fixture.store, request);
        assertEquals(first.status, 200);
        assertEquals(duplicate, first);
        const current = await loadPlan(fixture.projectRoot, "demo");
        assertEquals(current?.attrs.status, "on_hold");
        assertEquals(current?.revision, beforeReplay?.revision);
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state,
            "idle",
        );
    });
});

test("returns recovery guidance for an accepted duplicate without replaying", async () => {
    await withActionFixture(async (fixture) => {
        const request = makeRequest(fixture, await makeAction(fixture.projectRoot));
        fixture.store.createOrGetOperationReceipt({ ...request, kind: "plan_action" });
        const duplicate = await runOwnerPlanAction(fixture.store, request);
        assertEquals(duplicate.status, 409);
        assertEquals(duplicate.body.result.kind, "recovery_required");
        assertEquals((await loadPlan(fixture.projectRoot, "demo"))?.attrs.status, "draft");
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state,
            "idle",
        );
    });
});

test("revalidates canonical evidence for a new request id", async () => {
    await withActionFixture(async (fixture) => {
        const action = await makeAction(fixture.projectRoot);
        const before = await loadPlan(fixture.projectRoot, "demo");
        if (!before?.revision) throw new Error("fixture Plan missing revision");
        await seedPlan(fixture.projectRoot, "demo", "# Changed Demo\n", before.attrs, {
            expectedRevision: before.revision,
        });
        const result = await runOwnerPlanAction(fixture.store, makeRequest(fixture, action));
        assertEquals(result.status, 409);
        assertEquals(result.body.result.kind, "refresh_required");
        assertEquals((await loadPlan(fixture.projectRoot, "demo"))?.attrs.status, "draft");
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state,
            "idle",
        );
    });
});

test("Workspace Plan action rejects changed status and worktree evidence with a real owner store", async () => {
    await withActionFixture(async (fixture) => {
        const action = await makeAction(fixture.projectRoot);
        const before = await loadPlan(fixture.projectRoot, "demo");
        if (!before?.revision) throw new Error("fixture Plan missing revision");
        await withLocalPlanWorkflow(fixture.projectRoot, "demo", async () => {
            await recordPlanEvent({
                cwd: fixture.projectRoot,
                planName: "demo",
                event: "review_approved",
                currentStatus: "draft",
            });
            await recordPlanEvent({
                cwd: fixture.projectRoot,
                planName: "demo",
                event: "readiness_passed",
                currentStatus: "approved",
            });
        });
        const result = await runOwnerPlanAction(fixture.store, makeRequest(fixture, action));
        assertEquals(result.status, 409);
        assertEquals(result.body.result.kind, "refresh_required");
        assertEquals((await loadPlan(fixture.projectRoot, "demo"))?.attrs.status, "ready_for_work");
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation,
            0,
        );
    });
});

test("conflicts when a request id is reused with different input", async () => {
    await withActionFixture(async (fixture) => {
        const request = makeRequest(fixture, await makeAction(fixture.projectRoot));
        assertEquals((await runOwnerPlanAction(fixture.store, request)).status, 200);
        const conflict = await runOwnerPlanAction(fixture.store, { ...request, requestHash: "changed" });
        assertEquals(conflict.status, 409);
        assertEquals(conflict.body.result.kind, "invalid_action");
    });
});
