import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savePlan } from "../../plan-store.js";
import { buildExecutionSegmentContinuation, resolvePendingSegmentHandoff } from "./execution-segment-handoff.ts";

test("rejects changed canonical Plan and worktree evidence before handoff", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-handoff-"));
    await savePlan(root, "demo", "# Demo\n\nApproved", {
        planId: "plan-demo",
        status: "ready_for_work",
        classification: "PLANNED_CHANGE",
    });
    const preparedEvidence = {
        planId: "plan-demo",
        planName: "demo",
        revision: "old-revision",
        status: "ready_for_work",
        worktree: { kind: "none" as const },
    };
    const continuation = buildExecutionSegmentContinuation({
        runwieldSessionId: "session-one",
        planId: "plan-demo",
        planName: "demo",
        approvedRevision: "old-revision",
        approvedStatus: "ready_for_work",
        approvedMarkdown: "# Demo\n\nApproved",
        preparedEvidence,
        activeWorkflow: { planName: "demo", triageMeta: {}, executionAgent: "engineer" },
        executionOwner: "plan-engineer",
        collaborationStyle: "autonomous",
        collaborationRecommendation: "autonomous",
    });

    const result = await resolvePendingSegmentHandoff({
        marker: { payload: continuation, entryIndex: 0, entries: [{ type: "custom" }] },
        projectRoot: root,
        runwieldSessionId: "session-one",
    });

    assertEquals(result.kind, "refresh_required");
});

test("treats a marker as consumed after Pi's first seeded message entry", async () => {
    const continuation = buildExecutionSegmentContinuation({
        runwieldSessionId: "session-one",
        planId: "plan-demo",
        planName: "demo",
        approvedRevision: "rev",
        approvedStatus: "ready_for_work",
        approvedMarkdown: "# Demo",
        preparedEvidence: {
            planId: "plan-demo",
            planName: "demo",
            revision: "rev",
            status: "ready_for_work",
            worktree: { kind: "none" },
        },
        activeWorkflow: { planName: "demo", triageMeta: {}, executionAgent: "engineer" },
        executionOwner: "plan-engineer",
        collaborationStyle: "autonomous",
        collaborationRecommendation: "autonomous",
    });

    const result = await resolvePendingSegmentHandoff({
        marker: {
            payload: continuation,
            entryIndex: 0,
            entries: [{ type: "custom" }, { type: "message" }],
        },
        projectRoot: "/not-read-because-consumed",
        runwieldSessionId: "session-one",
    });

    assertEquals(result.kind, "consumed");
});

test("a marker written before the Plan Engineer split still resumes", async () => {
    // Pre-split markers name `engineer`; rejecting them would strand a segment
    // that was handed off before the split landed.
    const root = await fsMkdtemp(join(tmpdir(), "runwield-handoff-legacy-"));
    await savePlan(root, "legacy", "# Legacy\n\nApproved", {
        planId: "plan-legacy",
        status: "ready_for_work",
        classification: "PLANNED_CHANGE",
    });
    const preparedEvidence = {
        planId: "plan-legacy",
        planName: "legacy",
        revision: "old-revision",
        status: "ready_for_work",
        worktree: { kind: "none" as const },
    };
    const legacyMarker = {
        ...buildExecutionSegmentContinuation({
            runwieldSessionId: "session-legacy",
            planId: "plan-legacy",
            planName: "legacy",
            approvedRevision: "old-revision",
            approvedStatus: "ready_for_work",
            approvedMarkdown: "# Legacy\n\nApproved",
            preparedEvidence,
            activeWorkflow: { planName: "legacy", triageMeta: {}, executionAgent: "engineer" },
            executionOwner: "plan-engineer",
            collaborationStyle: "autonomous",
            collaborationRecommendation: "autonomous",
        }),
        executionOwner: "engineer" as const,
    };

    const result = await resolvePendingSegmentHandoff({
        marker: { payload: legacyMarker, entryIndex: 0, entries: [{ type: "custom" }] },
        projectRoot: root,
        runwieldSessionId: "session-legacy",
    });

    // Evidence drift is what stops it, not an unrecognized owner.
    assertEquals(result.kind, "refresh_required");
    assertEquals(
        "message" in result && result.message.includes("invalid execution owner"),
        false,
    );
});
