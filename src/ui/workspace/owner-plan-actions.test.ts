import { assertEquals } from "../../testing/assertions.ts";
// @ts-nocheck: Astro workspace check uses browser tsconfig without Deno/JSR test globals.
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan, savePlan } from "../../plan-store.js";
import {
    loadPlanActionEvidence,
    type PlanActionRequest,
    type PlanActionResult,
} from "../../shared/workflow/plan-actions.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { runOwnerPlanAction } from "./server/owner-plan-actions.ts";

type Receipt = {
    operationId: string;
    status: string;
    requestHash: string;
    resultHttpStatus: number | null;
    resultBody: { result?: PlanActionResult } | null;
    resultGeneration: number | null;
};

function makeStore(root: string) {
    const receipts = new Map<string, Receipt>();
    let acquireCount = 0;
    return {
        get acquireCount() {
            return acquireCount;
        },
        requireEnabledProjectRoot(projectId: string) {
            if (projectId !== "project-1") throw new Error("Project not found");
            return root;
        },
        getProjectById(projectId: string) {
            return projectId === "project-1" ? { currentRoot: root } : null;
        },
        getSessionById(runwieldSessionId: string) {
            return runwieldSessionId === "session-1"
                ? { projectId: "file-project-identity", transcriptCwd: root }
                : null;
        },
        inspectSessionActivation() {
            return {
                activation: { currentSegmentId: "segment-1" },
                generation: { generation: 0, currentSegmentId: "segment-1" },
            };
        },
        createOrGetOperationReceipt(options: { requestId: string; requestHash: string }) {
            const existing = receipts.get(options.requestId);
            if (existing) {
                if (existing.requestHash !== options.requestHash) {
                    throw new Error("Operation request id was reused with different input");
                }
                return { ...existing, wasCreated: false };
            }
            const receipt: Receipt = {
                operationId: `op-${options.requestId}`,
                status: "accepted",
                requestHash: options.requestHash,
                resultHttpStatus: null,
                resultBody: null,
                resultGeneration: null,
            };
            receipts.set(options.requestId, receipt);
            return { ...receipt, wasCreated: true };
        },
        seedOperationReceipt(requestId: string, receipt: Receipt) {
            receipts.set(requestId, receipt);
        },
        updateOperationReceipt(
            operationId: string,
            updates: {
                status: string;
                resultHttpStatus?: number | null;
                resultBody?: { result?: PlanActionResult };
                resultGeneration?: number | null;
            },
        ) {
            const receipt = [...receipts.values()].find((candidate) => candidate.operationId === operationId);
            if (!receipt) throw new Error("missing receipt");
            receipt.status = updates.status;
            if (updates.resultHttpStatus !== undefined) receipt.resultHttpStatus = updates.resultHttpStatus;
            if (updates.resultBody !== undefined) receipt.resultBody = updates.resultBody;
            if (updates.resultGeneration !== undefined) receipt.resultGeneration = updates.resultGeneration;
            return receipt;
        },
        acquireSessionActivation() {
            acquireCount += 1;
            return { operationId: `activation-${acquireCount}` };
        },
        releaseUnchangedActivation() {},
        markSessionUncertain() {},
    };
}

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
    const root = await fsMkdtemp(join(tmpdir(), "runwield-owner-plan-action-"));
    await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
    const store = makeStore(root);
    const action = await makeAction(root);

    const first = await runOwnerPlanAction(store, {
        projectId: "project-1",
        runwieldSessionId: "session-1",
        deviceId: "device-1",
        requestId: "req-1",
        requestHash: "hash-1",
        expectedGeneration: 0,
        action,
    });
    const duplicate = await runOwnerPlanAction(store, {
        projectId: "project-1",
        runwieldSessionId: "session-1",
        deviceId: "device-1",
        requestId: "req-1",
        requestHash: "hash-1",
        expectedGeneration: 0,
        action,
    });

    assertEquals(first.status, 200);
    assertEquals(duplicate, first);
    assertEquals(store.acquireCount, 1);
    const current = await loadPlan(root, "demo");
    assertEquals(current?.attrs.status, "on_hold");
});

test("returns recovery guidance for an accepted duplicate without replaying", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-owner-plan-action-"));
    await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
    const store = makeStore(root);
    const action = await makeAction(root);
    store.seedOperationReceipt("req-accepted", {
        operationId: "op-accepted",
        status: "accepted",
        requestHash: "hash-accepted",
        resultHttpStatus: null,
        resultBody: null,
        resultGeneration: null,
    });

    const duplicate = await runOwnerPlanAction(store, {
        projectId: "project-1",
        runwieldSessionId: "session-1",
        deviceId: "device-1",
        requestId: "req-accepted",
        requestHash: "hash-accepted",
        expectedGeneration: 0,
        action,
    });

    assertEquals(duplicate.status, 409);
    assertEquals(duplicate.body.result.kind, "recovery_required");
    assertEquals(store.acquireCount, 0);
    const current = await loadPlan(root, "demo");
    assertEquals(current?.attrs.status, "draft");
});

test("revalidates canonical evidence for a new request id", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-owner-plan-action-"));
    await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
    const store = makeStore(root);
    const action = await makeAction(root);
    const before = await loadPlan(root, "demo");
    if (!before?.revision) throw new Error("fixture Plan missing revision");
    await savePlan(root, "demo", "# Demo changed\n", {
        planId: "plan-demo",
        status: "draft",
        classification: "FEATURE",
    }, { expectedRevision: before.revision });

    const result = await runOwnerPlanAction(store, {
        projectId: "project-1",
        runwieldSessionId: "session-1",
        deviceId: "device-1",
        requestId: "req-2",
        requestHash: "hash-2",
        expectedGeneration: 0,
        action,
    });

    assertEquals(result.status, 409);
    assertEquals(result.body.result.kind, "refresh_required");
    assertEquals(store.acquireCount, 1);
    const current = await loadPlan(root, "demo");
    assertEquals(current?.attrs.status, "draft");
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
        await savePlan(fixture.projectRoot, "demo", "# Demo\n", {
            planId: "plan-demo",
            status: "ready_for_work",
            classification: "FEATURE",
        }, { expectedRevision: before.revision });

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
    const root = await fsMkdtemp(join(tmpdir(), "runwield-owner-plan-action-"));
    await savePlan(root, "demo", "# Demo\n", { planId: "plan-demo", status: "draft", classification: "FEATURE" });
    const store = makeStore(root);
    const action = await makeAction(root);
    await runOwnerPlanAction(store, {
        projectId: "project-1",
        runwieldSessionId: "session-1",
        deviceId: "device-1",
        requestId: "req-3",
        requestHash: "hash-3",
        expectedGeneration: 0,
        action,
    });

    const conflict = await runOwnerPlanAction(store, {
        projectId: "project-1",
        runwieldSessionId: "session-1",
        deviceId: "device-1",
        requestId: "req-3",
        requestHash: "changed",
        expectedGeneration: 0,
        action,
    });

    assertEquals(conflict.status, 409);
    assertEquals(conflict.body.result.kind, "invalid_action");
});
