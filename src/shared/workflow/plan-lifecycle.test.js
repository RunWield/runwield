import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
    buildPlanEventUpdates,
    getAllowedManualPlanStatuses,
    getPlanLifecycleActionMetadata,
    isEpicPlan,
    isExecutablePlanStatus,
    isManualBoardStatusChangeAllowed,
    recordPlanEvent,
    stageValidationPassedInExecutionWorktree,
} from "./plan-lifecycle.js";
import { injectFrontMatter, loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { COLLABORATION_STATE_REMOTE_CANONICAL, SharedPlanLockError } from "../collaboration/lock.js";

/**
 * @param {string} cwd
 * @param {string} planName
 * @param {Partial<import('../../plan-store.js').PlanFrontMatter>} updates
 */
async function updatePlanFrontMatterForTest(cwd, planName, updates) {
    const plan = await loadPlan(cwd, planName);
    return await updatePlanFrontMatter(cwd, planName, updates, undefined, { expectedRevision: plan?.revision });
}

/** @type {import('./plan-lifecycle.js').PlanEventDetails} */
const TEST_DELIVERY_DETAILS = {
    executionMode: "worktree",
    deliveryEvidence: {
        version: 1,
        mode: "worktree_merge",
        executionCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        targetBranch: "main",
        targetHeadBeforeMerge: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
};

Deno.test("validation lifecycle phase transitions are ordered", () => {
    const ciPassed = buildPlanEventUpdates("mechanical_validation_passed", "implemented");
    assertEquals(ciPassed.status, "implemented");
    assertEquals(ciPassed.validationPhase, "semantic");

    const reviewerPassed = buildPlanEventUpdates("semantic_review_passed", "implemented", { triageMeta: ciPassed });
    assertEquals(reviewerPassed.status, "reviewed");

    const verified = buildPlanEventUpdates("validation_passed", "reviewed", TEST_DELIVERY_DETAILS);
    assertEquals(verified.status, "verified");

    assertThrows(
        () => buildPlanEventUpdates("semantic_review_passed", "implemented"),
        Error,
        'semantic_review_passed cannot apply to status "implemented" before CI passes',
    );
    assertThrows(
        () => buildPlanEventUpdates("semantic_review_passed", "verified"),
        Error,
        'semantic_review_passed cannot apply to status "verified"',
    );
});

Deno.test("validation retry counters increment and reset on implemented re-entry", () => {
    const failedCi = buildPlanEventUpdates("mechanical_validation_failed", "implemented", {
        triageMeta: { validationCiAttempts: 2 },
    });
    assertEquals(failedCi.status, "implemented");
    assertEquals(failedCi.validationCiAttempts, 3);

    const failedValidation = buildPlanEventUpdates("validation_failed", "validated_ci", {
        triageMeta: {
            validationCiAttempts: 3,
            validationSemanticRounds: 2,
        },
    });
    assertEquals(failedValidation.status, "implemented");
    assertEquals(failedValidation.validationCiAttempts, 0);
    assertEquals(failedValidation.validationSemanticRounds, 0);
});

Deno.test("buildPlanEventUpdates promotes approved plans to ready_for_work", () => {
    const updates = buildPlanEventUpdates("readiness_passed", "approved", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    assertEquals(updates.status, "ready_for_work");
    assertEquals(updates.updatedAt, "2026-01-02T03:04:05.000Z");
    assertEquals(updates.failureReason, null);
});

Deno.test("buildPlanEventUpdates marks approved Epics ready for decomposition", () => {
    const updates = buildPlanEventUpdates("epic_readiness_passed", "approved", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    assertEquals(updates.status, "ready_for_decomposition");
    assertEquals(updates.updatedAt, "2026-01-02T03:04:05.000Z");
    assertEquals(updates.failureReason, null);
});

Deno.test("buildPlanEventUpdates captures execution baseline when work starts", () => {
    const updates = buildPlanEventUpdates("execution_started", "ready_for_work", {
        executionBaselineTree: "abc123",
        now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    assertEquals(updates.status, "in_progress");
    assertEquals(updates.executionBaselineTree, "abc123");
    assertEquals(updates.worktreeStatus, "active");
    assertEquals(updates.implementedAt, null);
});

Deno.test("buildPlanEventUpdates omits worktree metadata for non-Git in-place execution", () => {
    const updates = buildPlanEventUpdates("execution_started", "ready_for_work", {
        nonGitInPlace: true,
        executionBaselineTree: "abc123",
        worktreeId: "wt-1",
        worktreeStatus: "active",
    });

    assertEquals(updates.status, "in_progress");
    assertEquals(updates.executionBaselineTree, null);
    assertEquals(updates.worktreeId, null);
    assertEquals(updates.worktreeStatus, null);
});

Deno.test("buildPlanEventUpdates records worktree metadata when execution starts", () => {
    const updates = buildPlanEventUpdates("execution_started", "ready_for_work", {
        executionBaselineTree: "abc123",
        worktreeId: "wt-1",
        worktreePath: "/tmp/repo-runwield-plan-wt-1",
        worktreeBranch: "runwield/worktree/plan-wt-1",
        worktreeBaseBranch: "feature-base",
    });

    assertEquals(updates.worktreeId, "wt-1");
    assertEquals(updates.worktreePath, "/tmp/repo-runwield-plan-wt-1");
    assertEquals(updates.worktreeBranch, "runwield/worktree/plan-wt-1");
    assertEquals(updates.worktreeBaseBranch, "feature-base");
    assertEquals(updates.worktreeStatus, "active");
});

Deno.test("buildPlanEventUpdates restores durable worktree identity when implementation finishes", () => {
    const updates = buildPlanEventUpdates("implementation_finished", "in_progress", {
        executionMode: "worktree",
        executionBaselineTree: "attempt-tree",
        worktreeId: "wt-1",
        worktreePath: "/tmp/repo-runwield-plan-wt-1",
        worktreeBranch: "runwield/worktree/plan-wt-1",
        worktreeBaseBranch: "main",
    });

    assertEquals(updates.executionMode, "worktree");
    assertEquals(updates.executionBaselineTree, "attempt-tree");
    assertEquals(updates.worktreeId, "wt-1");
    assertEquals(updates.worktreePath, "/tmp/repo-runwield-plan-wt-1");
    assertEquals(updates.worktreeBranch, "runwield/worktree/plan-wt-1");
    assertEquals(updates.worktreeBaseBranch, "main");
    assertEquals(updates.worktreeStatus, "completed");
});

Deno.test("buildPlanEventUpdates keeps implemented status when validation fails", () => {
    const updates = buildPlanEventUpdates("validation_failed", "implemented", {
        failureReason: "CI failed",
    });

    assertEquals(updates.status, "implemented");
    assertEquals(updates.worktreeStatus, undefined);
    assertEquals(updates.failureReason, "CI failed");
});

Deno.test("buildPlanEventUpdates tracks implementation worktree statuses", () => {
    assertEquals(
        buildPlanEventUpdates("implementation_finished", "in_progress").worktreeStatus,
        "completed",
    );
    assertEquals(
        buildPlanEventUpdates("execution_failed", "in_progress").worktreeStatus,
        "execution_failed",
    );
    assertEquals(
        buildPlanEventUpdates("validation_passed", "reviewed", { cleanupMergedWorktrees: false })
            .worktreeStatus,
        null,
    );
    const passed = buildPlanEventUpdates("validation_passed", "reviewed");
    assertEquals(passed.executionBaselineTree, null);
    assertEquals(passed.worktreeId, null);
    assertEquals(passed.worktreePath, null);
    assertEquals(passed.worktreeBranch, null);
    assertEquals(passed.worktreeBaseBranch, null);
    assertEquals(passed.worktreeStatus, null);

    const retained = buildPlanEventUpdates("validation_passed", "reviewed", {
        cleanupMergedWorktrees: false,
    });
    assertEquals(retained.executionBaselineTree, null);
    assertEquals(retained.worktreeId, null);
    assertEquals(retained.worktreePath, null);
    assertEquals(retained.worktreeBranch, null);
    assertEquals(retained.worktreeBaseBranch, null);
    assertEquals(retained.worktreeStatus, null);
});

Deno.test("buildPlanEventUpdates records and clears human review metadata", () => {
    const passed = buildPlanEventUpdates("validation_passed", "reviewed", {
        humanReviewMode: "always",
        humanReviewDecision: "approved",
        humanReviewedAt: "2026-06-23T12:00:00.000Z",
    });
    assertEquals(passed.humanReviewMode, "always");
    assertEquals(passed.humanReviewDecision, "approved");
    assertEquals(passed.humanReviewedAt, "2026-06-23T12:00:00.000Z");

    const started = buildPlanEventUpdates("execution_started", "ready_for_work");
    assertEquals(started.humanReviewMode, null);
    assertEquals(started.humanReviewDecision, null);
    assertEquals(started.humanReviewedAt, null);

    const reset = buildPlanEventUpdates("recovery_reset", "implemented");
    assertEquals(reset.humanReviewMode, null);
    assertEquals(reset.humanReviewDecision, null);
    assertEquals(reset.humanReviewedAt, null);

    const reopened = buildPlanEventUpdates("review_reopened", "verified");
    assertEquals(reopened.humanReviewMode, null);
    assertEquals(reopened.humanReviewDecision, null);
    assertEquals(reopened.humanReviewedAt, null);
});

Deno.test("buildPlanEventUpdates records continue recovery as ready_for_work", () => {
    const updates = buildPlanEventUpdates("recovery_continue", "failed", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    assertEquals(updates.status, "ready_for_work");
    assertEquals(updates.failureReason, null);
    assertEquals(updates.failedAt, null);
});

Deno.test("buildPlanEventUpdates marks Epics done enough as deliberate closure with metadata", () => {
    const updates = buildPlanEventUpdates("epic_done_enough", "ready_for_work", {
        triageMeta: { classification: "PROJECT" },
        now: () => new Date("2026-06-17T00:00:00.000Z"),
        epicDoneEnoughSummary: "Done enough: 1/2 verified.",
    });

    assertEquals(updates.status, "closed_without_verification");
    assertEquals(updates.validatedAt, "2026-06-17T00:00:00.000Z");
    assertEquals(updates.epicCompletionMode, "done_enough");
    assertEquals(updates.epicDoneEnoughAt, "2026-06-17T00:00:00.000Z");
    assertEquals(updates.epicDoneEnoughSummary, "Done enough: 1/2 verified.");
    assertEquals(updates.failureReason, null);
    assertEquals(updates.failedAt, null);
});

Deno.test("buildPlanEventUpdates allows manual board movement only within safe statuses", () => {
    const updates = buildPlanEventUpdates("manual_status_change", "implemented", {
        manualTargetStatus: "ready_for_work",
        now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    assertEquals(updates.status, "ready_for_work");
    assertEquals(updates.updatedAt, "2026-01-02T03:04:05.000Z");
    assertEquals(updates.implementedAt, null);
    assertEquals(updates.verifiedAt, null);
    assertEquals(updates.failureReason, undefined);
    assertEquals(updates.worktreeId, undefined);
});

Deno.test("manual board movement blocks movement into implemented without execution proof", () => {
    assertThrows(
        () =>
            buildPlanEventUpdates("manual_status_change", "implemented", {
                manualTargetStatus: "implemented",
                triageMeta: {
                    failureReason: "Workflow Validation failed.",
                    worktreeStatus: "validation_failed",
                    humanReviewMode: "ask",
                    humanReviewDecision: "skipped",
                    humanReviewedAt: "2026-01-02T03:04:05.000Z",
                },
            }),
        Error,
        'manual_status_change cannot move from "implemented" to "implemented"',
    );
});

Deno.test("manual board movement clears stale completion metadata when moving before implemented", () => {
    const updates = buildPlanEventUpdates("manual_status_change", "implemented", {
        manualTargetStatus: "approved",
        triageMeta: {
            implementedAt: "2026-01-02T03:04:05.000Z",
            verifiedAt: "2026-01-03T03:04:05.000Z",
            humanReviewMode: "ask",
            humanReviewDecision: "approved",
            humanReviewedAt: "2026-01-03T03:04:05.000Z",
            failureReason: "Stale failure reason.",
            failedAt: "2026-01-01T03:04:05.000Z",
        },
    });

    assertEquals(updates.status, "approved");
    assertEquals(updates.implementedAt, null);
    assertEquals(updates.verifiedAt, null);
    assertEquals(updates.humanReviewMode, null);
    assertEquals(updates.humanReviewDecision, null);
    assertEquals(updates.humanReviewedAt, null);
    assertEquals(updates.failureReason, null);
    assertEquals(updates.failedAt, null);
});

Deno.test("manual board movement preserves recovery context for retry statuses", () => {
    const updates = buildPlanEventUpdates("manual_status_change", "implemented", {
        manualTargetStatus: "ready_for_work",
        triageMeta: {
            failureReason: "Workflow Validation failed.",
            worktreeStatus: "validation_failed",
            worktreeId: "wt-1",
            worktreePath: "/tmp/wt-1",
            worktreeBranch: "runwield/wt-1",
        },
    });

    assertEquals(updates.status, "ready_for_work");
    assertEquals(updates.failureReason, "Workflow Validation failed.");
    assertEquals(updates.worktreeStatus, "validation_failed");
    assertEquals(updates.worktreeId, "wt-1");
    assertEquals(updates.worktreePath, "/tmp/wt-1");
    assertEquals(updates.worktreeBranch, "runwield/wt-1");
});

Deno.test("manual board movement allows ready_for_decomposition only for Epic plans", () => {
    assertEquals(
        buildPlanEventUpdates("manual_status_change", "approved", {
            manualTargetStatus: "ready_for_decomposition",
            triageMeta: { classification: "PROJECT" },
        }).status,
        "ready_for_decomposition",
    );

    assertThrows(
        () =>
            buildPlanEventUpdates("manual_status_change", "approved", {
                manualTargetStatus: "ready_for_decomposition",
                triageMeta: { classification: "FEATURE" },
            }),
        Error,
        'manual_status_change cannot move from "approved" to "ready_for_decomposition"',
    );
});

Deno.test("manual board movement blocks protected and terminal shortcuts", () => {
    assertThrows(
        () => buildPlanEventUpdates("manual_status_change", "approved", {}),
        Error,
        "manual_status_change requires manualTargetStatus",
    );
    assertThrows(
        () => buildPlanEventUpdates("manual_status_change", "implemented", { manualTargetStatus: "verified" }),
        Error,
        'manual_status_change cannot move from "implemented" to "verified"',
    );
    assertThrows(
        () => buildPlanEventUpdates("manual_status_change", "ready_for_work", { manualTargetStatus: "failed" }),
        Error,
        'manual_status_change cannot move from "ready_for_work" to "failed"',
    );
    assertThrows(
        () => buildPlanEventUpdates("manual_status_change", "failed", { manualTargetStatus: "ready_for_work" }),
        Error,
        'manual_status_change cannot move from "failed" to "ready_for_work"',
    );
    assertThrows(
        () => buildPlanEventUpdates("manual_status_change", "on_hold", { manualTargetStatus: "approved" }),
        Error,
        'manual_status_change cannot move from "on_hold" to "approved"',
    );
    assertThrows(
        () =>
            buildPlanEventUpdates("manual_status_change", "ready_for_work", {
                manualTargetStatus: "closed_without_verification",
            }),
        Error,
        'manual_status_change cannot move from "ready_for_work" to "closed_without_verification"',
    );
});

Deno.test("manual closure is terminal and does not pretend validation passed", () => {
    const updates = buildPlanEventUpdates("manual_closed_without_verification", "implemented", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        closedWithoutVerificationReason: "Verified manually in staging.",
    });

    assertEquals(updates.status, "closed_without_verification");
    assertEquals(updates.updatedAt, "2026-01-02T03:04:05.000Z");
    assertEquals(updates.closedWithoutVerificationReason, "Verified manually in staging.");
    assertEquals(updates.closedWithoutVerificationAt, "2026-01-02T03:04:05.000Z");
    assertEquals(updates.verifiedAt, undefined);
    assertEquals(updates.humanReviewDecision, undefined);
    assertEquals(updates.epicCompletionMode, undefined);

    assertThrows(
        () => buildPlanEventUpdates("manual_closed_without_verification", "implemented"),
        Error,
        "manual_closed_without_verification requires closedWithoutVerificationReason",
    );

    assertThrows(
        () => buildPlanEventUpdates("manual_closed_without_verification", "verified"),
        Error,
        'manual_closed_without_verification cannot apply to status "verified"',
    );
});

Deno.test("manual user verification records user attestation without RunWield proof", () => {
    const updates = buildPlanEventUpdates("manual_user_verified", "implemented", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        userVerificationNote: "Checked in staging with Alice.",
        triageMeta: {
            failureReason: "Workflow Validation failed.",
            worktreeStatus: "validation_failed",
            deliveryEvidence: { version: 1, mode: "non_git_in_place" },
            verifiedAt: "2026-01-01T00:00:00.000Z",
        },
    });

    assertEquals(updates.status, "user_verified");
    assertEquals(updates.userVerifiedAt, "2026-01-02T03:04:05.000Z");
    assertEquals(updates.userVerificationNote, "Checked in staging with Alice.");
    assertEquals(updates.verifiedAt, "2026-01-01T00:00:00.000Z");
    assertEquals(updates.failureReason, "Workflow Validation failed.");
    assertEquals(updates.worktreeStatus, "validation_failed");

    const reviewed = buildPlanEventUpdates("manual_user_verified", "reviewed", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        userVerificationNote: "Implementation was merged and checked by the owner.",
        triageMeta: {
            humanReviewDecision: "approved",
            humanReviewedAt: "2026-01-01T00:00:00.000Z",
            executionMode: "worktree",
        },
    });
    assertEquals(reviewed.status, "user_verified");
    assertEquals(reviewed.verifiedAt, undefined);
    assertEquals(reviewed.humanReviewDecision, "approved");
    assertEquals(reviewed.executionMode, "worktree");

    assertThrows(
        () => buildPlanEventUpdates("manual_user_verified", "implemented", { userVerificationNote: "  " }),
        Error,
        "manual_user_verified requires userVerificationNote",
    );
    assertThrows(
        () => buildPlanEventUpdates("manual_user_verified", "verified", { userVerificationNote: "done" }),
        Error,
        'manual_user_verified cannot apply to status "verified"',
    );
});

Deno.test("validated Plans expose user verification without exposing generic board movement", () => {
    const actions = getPlanLifecycleActionMetadata("reviewed", { classification: "PLANNED_CHANGE" });
    assertEquals(actions.canUserVerify, true);
    assertEquals(actions.allowedManualTargetStatuses, []);
    assertEquals(actions.canCloseWithoutVerification, false);
});

Deno.test("hold events create, resume, and reset hold metadata", () => {
    const held = buildPlanEventUpdates("plan_held", "failed", {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        holdReason: "priority shifted",
        holdStalenessBaseline: "2026-01-01T00:00:00.000Z",
    });
    assertEquals(held.status, "on_hold");
    assertEquals(held.heldFromStatus, "failed");
    assertEquals(held.heldAt, "2026-01-02T03:04:05.000Z");
    assertEquals(held.holdReason, "priority shifted");
    assertEquals(held.holdStalenessBaseline, "2026-01-01T00:00:00.000Z");

    const resumed = buildPlanEventUpdates("hold_resumed", "on_hold", { heldFromStatus: "failed" });
    assertEquals(resumed.status, "failed");
    assertEquals(resumed.heldFromStatus, null);
    assertEquals(resumed.heldAt, null);
    assertEquals(resumed.holdReason, null);
    assertEquals(resumed.holdStalenessBaseline, null);

    const reset = buildPlanEventUpdates("hold_reset_to_draft", "on_hold");
    assertEquals(reset.status, "draft");
    assertEquals(reset.worktreeId, null);
    assertEquals(reset.worktreePath, null);
    assertEquals(reset.worktreeBranch, null);
    assertEquals(reset.worktreeStatus, null);
    assertEquals(reset.executionBaselineTree, null);
    assertEquals(reset.failureReason, null);
    assertEquals(reset.failedAt, null);
    assertEquals(reset.implementedAt, null);
    assertEquals(reset.verifiedAt, null);
    assertEquals(reset.humanReviewMode, null);
    assertEquals(reset.humanReviewDecision, null);
    assertEquals(reset.humanReviewedAt, null);
});

Deno.test("hold blocks terminal statuses and resume requires held-from status", () => {
    assertThrows(
        () => buildPlanEventUpdates("plan_held", "verified"),
        Error,
        'plan_held cannot apply to status "verified"',
    );
    assertThrows(
        () => buildPlanEventUpdates("plan_held", "closed_without_verification"),
        Error,
        'plan_held cannot apply to status "closed_without_verification"',
    );
    assertThrows(
        () => buildPlanEventUpdates("hold_resumed", "on_hold"),
        Error,
        "hold_resumed requires heldFromStatus",
    );
    assertThrows(
        () => buildPlanEventUpdates("hold_resumed", "on_hold", { heldFromStatus: "verified" }),
        Error,
        'hold_resumed cannot restore terminal/protected status "verified"',
    );
});

Deno.test("manual board helper exports expose lifecycle-owned rules", () => {
    assertEquals(getAllowedManualPlanStatuses("approved"), [
        "draft",
        "feedback",
        "approved",
        "ready_for_work",
    ]);
    assertEquals(getAllowedManualPlanStatuses("approved", { classification: "PROJECT" }), [
        "draft",
        "feedback",
        "approved",
        "ready_for_work",
        "ready_for_decomposition",
    ]);
    assertEquals(getAllowedManualPlanStatuses("failed"), []);
    assertEquals(isManualBoardStatusChangeAllowed("approved", "implemented"), false);
    assertEquals(isManualBoardStatusChangeAllowed("approved", "verified"), false);
    assertEquals(
        isManualBoardStatusChangeAllowed("approved", "ready_for_decomposition", {
            classification: "PROJECT",
        }),
        true,
    );
});

Deno.test("recordPlanEvent mutates only the selected held plan file", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await Deno.mkdir(`${cwd}/docs/plans/epic`, { recursive: true });
        await Deno.writeTextFile(
            `${cwd}/docs/plans/epic.md`,
            [
                "---",
                'classification: "PROJECT"',
                'complexity: "HIGH"',
                'summary: "Epic"',
                "affectedPaths:",
                "  []",
                'createdAt: "2026-01-01T00:00:00.000Z"',
                'status: "ready_for_work"',
                "---",
                "# Epic",
            ].join("\n"),
        );
        await Deno.writeTextFile(
            `${cwd}/docs/plans/epic/child.md`,
            [
                "---",
                'classification: "FEATURE"',
                'complexity: "MEDIUM"',
                'summary: "Child"',
                "affectedPaths:",
                "  []",
                'createdAt: "2026-01-01T00:00:00.000Z"',
                'status: "ready_for_work"',
                'parentPlan: "epic"',
                "---",
                "# Child",
            ].join("\n"),
        );

        await recordPlanEvent({ cwd, planName: "epic", event: "plan_held", currentStatus: "ready_for_work" });
        assertEquals((await Deno.readTextFile(`${cwd}/docs/plans/epic.md`)).includes('status: "on_hold"'), true);
        assertEquals(
            (await Deno.readTextFile(`${cwd}/docs/plans/epic/child.md`)).includes('status: "ready_for_work"'),
            true,
        );

        await recordPlanEvent({ cwd, planName: "epic/child", event: "plan_held", currentStatus: "ready_for_work" });
        assertEquals((await Deno.readTextFile(`${cwd}/docs/plans/epic.md`)).includes('status: "on_hold"'), true);
        assertEquals((await Deno.readTextFile(`${cwd}/docs/plans/epic/child.md`)).includes('status: "on_hold"'), true);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("recordPlanEvent verifies parent Epic when the final child feature is verified", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic", "# Epic", {
            classification: "PROJECT",
            complexity: "HIGH",
            summary: "Epic",
            affectedPaths: [],
            status: "ready_for_work",
        });
        await savePlan(cwd, "epic/01-first", "# First", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "First",
            affectedPaths: [],
            status: "verified",
            ...TEST_DELIVERY_DETAILS,
            parentPlan: "epic",
            order: 1,
        });
        await savePlan(cwd, "epic/02-last", "# Last", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Last",
            affectedPaths: [],
            status: "reviewed",
            parentPlan: "epic",
            order: 2,
        });

        await recordPlanEvent({
            cwd,
            planName: "epic/02-last",
            event: "validation_passed",
            currentStatus: "reviewed",
            details: {
                ...TEST_DELIVERY_DETAILS,
                triageMeta: { classification: "FEATURE", parentPlan: "epic" },
                now: () => new Date("2026-01-02T03:04:05.000Z"),
            },
        });

        const parent = await loadPlan(cwd, "epic");
        const child = await loadPlan(cwd, "epic/02-last");
        assertEquals(child?.attrs.status, "verified");
        assertEquals(parent?.attrs.status, "verified");
        assertEquals(parent?.attrs.validatedAt, "2026-01-02T03:04:05.000Z");
        assertEquals(parent?.attrs.epicCompletionMode, "done_enough");
        assertEquals(
            parent?.attrs.epicDoneEnoughSummary,
            "All 2 child plans are completed after epic/02-last.",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("recordPlanEvent keeps parent Epic open while child features remain unverified", async () => {
    const cwd = await Deno.makeTempDir();
    try {
        await savePlan(cwd, "epic", "# Epic", {
            classification: "PROJECT",
            complexity: "HIGH",
            summary: "Epic",
            affectedPaths: [],
            status: "ready_for_work",
        });
        await savePlan(cwd, "epic/01-first", "# First", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "First",
            affectedPaths: [],
            status: "implemented",
            parentPlan: "epic",
            order: 1,
        });
        await savePlan(cwd, "epic/02-last", "# Last", {
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Last",
            affectedPaths: [],
            status: "reviewed",
            parentPlan: "epic",
            order: 2,
        });

        await recordPlanEvent({
            cwd,
            planName: "epic/02-last",
            event: "validation_passed",
            currentStatus: "reviewed",
            details: { ...TEST_DELIVERY_DETAILS, triageMeta: { classification: "FEATURE", parentPlan: "epic" } },
        });

        const parent = await loadPlan(cwd, "epic");
        assertEquals(parent?.attrs.status, "ready_for_work");
        assertEquals(parent?.attrs.epicCompletionMode, undefined);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("buildPlanEventUpdates only allows documented transitions", () => {
    assertThrows(
        () => buildPlanEventUpdates("execution_started", "approved"),
        Error,
        'execution_started cannot apply to status "approved"',
    );
    assertThrows(
        () => buildPlanEventUpdates("epic_done_enough", "approved"),
        Error,
        'epic_done_enough cannot apply to status "approved"',
    );
});

Deno.test("buildPlanEventUpdates only marks PROJECT Epic plans done enough", () => {
    assertThrows(
        () =>
            buildPlanEventUpdates("epic_done_enough", "ready_for_work", {
                triageMeta: { classification: "FEATURE" },
            }),
        Error,
        "epic_done_enough can only apply to PROJECT Epic plans",
    );
});

Deno.test("isExecutablePlanStatus only accepts ready_for_work", () => {
    assertEquals(isExecutablePlanStatus("ready_for_work"), true);
    assertEquals(isExecutablePlanStatus("ready_for_decomposition"), false);
    assertEquals(isExecutablePlanStatus("approved"), false);
    assertEquals(isExecutablePlanStatus("implemented"), false);
});

Deno.test("isEpicPlan detects PROJECT plans by classification", () => {
    assertEquals(isEpicPlan({ classification: "PROJECT" }), true);
    assertEquals(isEpicPlan({ type: "epic" }), false);
    assertEquals(isEpicPlan({ classification: "FEATURE" }), false);
    assertEquals(isEpicPlan(undefined), false);
});

Deno.test("stageValidationPassedInExecutionWorktree validates only the execution Plan and is idempotent", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        const canonicalPath = `${projectRoot}/docs/plans/feature.md`;
        await Deno.mkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await Deno.writeTextFile(
            canonicalPath,
            injectFrontMatter(
                "# Feature",
                /** @type {any} */ ({
                    status: "implemented",
                    implementedAt: "2026-01-01T00:00:00.000Z",
                    worktreeId: "wt-1",
                    worktreePath: executionCwd,
                    worktreeBranch: "runwield/worktree/feature-wt-1",
                    worktreeBaseBranch: "main",
                    worktreeStatus: "completed",
                    customFlag: true,
                }),
            ),
        );
        await savePlan(executionCwd, "feature", "# Execution Feature", {
            status: "reviewed",
            implementedAt: "2026-01-01T00:00:00.000Z",
            customFlag: true,
        });

        const first = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "feature",
            details: {
                ...TEST_DELIVERY_DETAILS,
                cleanupMergedWorktrees: false,
                humanReviewMode: "always",
                humanReviewDecision: "approved",
                humanReviewedAt: "2026-01-02T00:00:00.000Z",
                now: () => new Date("2026-01-03T00:00:00.000Z"),
            },
        });
        const firstExecutionMarkdown = (await loadPlan(executionCwd, "feature"))?.markdown || "";
        assertStringIncludes(firstExecutionMarkdown, 'status: "reviewed"');
        const second = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "feature",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-04T00:00:00.000Z") },
        });

        assertEquals(first.attrs.status, "reviewed");
        assertEquals(first.attrs.validatedAt, "2026-01-03T00:00:00.000Z");
        assertEquals(first.attrs.implementedAt, "2026-01-01T00:00:00.000Z");
        assertEquals(first.attrs.worktreeStatus ?? null, null);
        assertEquals(first.attrs.humanReviewDecision, "approved");
        assertEquals(second.attrs.validatedAt, first.attrs.validatedAt);
        assertEquals(first.planPaths, ["docs/plans/feature.md"]);
        assertEquals((await loadPlan(projectRoot, "feature"))?.attrs.status, "implemented");
        const executionMarkdown = (await loadPlan(executionCwd, "feature"))?.markdown || "";
        assertStringIncludes(executionMarkdown, "customFlag: true");
        assertStringIncludes(executionMarkdown, 'status: "reviewed"');
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree keeps reviewed evidence immutable on retry", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        await savePlan(projectRoot, "feature", "# Feature", { status: "implemented", classification: "FEATURE" });
        await savePlan(executionCwd, "feature", "# Feature", {
            status: "reviewed",
            validatedAt: "2026-01-03T00:00:00.000Z",
            classification: "FEATURE",
            executionMode: "worktree",
            deliveryEvidence: TEST_DELIVERY_DETAILS.deliveryEvidence,
        });

        const suppliedDeliveryEvidence = /** @type {import('../../plan-store.js').DeliveryEvidence} */ ({
            ...TEST_DELIVERY_DETAILS.deliveryEvidence,
            executionCommit: "dddddddddddddddddddddddddddddddddddddddd",
            targetHeadBeforeMerge: "cccccccccccccccccccccccccccccccccccccccc",
        });
        const result = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "feature",
            details: {
                executionMode: "worktree",
                deliveryEvidence: suppliedDeliveryEvidence,
                cleanupMergedWorktrees: false,
                now: () => new Date("2026-01-04T00:00:00.000Z"),
            },
        });

        assertEquals(result.attrs.status, "reviewed");
        assertEquals(result.attrs.validatedAt, "2026-01-03T00:00:00.000Z");
        assertEquals(result.attrs.deliveryEvidence, TEST_DELIVERY_DETAILS.deliveryEvidence);
        assertEquals((await loadPlan(projectRoot, "feature"))?.attrs.status, "implemented");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree preserves execution Plan human review evidence", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        await savePlan(projectRoot, "feature", "# Feature", {
            status: "implemented",
            humanReviewMode: "always",
            humanReviewDecision: "approved",
            humanReviewedAt: "2026-01-02T00:00:00.000Z",
        });
        await savePlan(executionCwd, "feature", "# Execution Feature", {
            status: "reviewed",
            humanReviewMode: "always",
            humanReviewDecision: "approved",
            humanReviewedAt: "2026-01-02T00:00:00.000Z",
        });

        const result = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "feature",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-03T00:00:00.000Z") },
        });

        assertEquals(result.attrs.status, "reviewed");
        assertEquals(result.attrs.humanReviewMode, "always");
        assertEquals(result.attrs.humanReviewDecision, "approved");
        assertEquals(result.attrs.humanReviewedAt, "2026-01-02T00:00:00.000Z");

        await savePlan(projectRoot, "staged-retry", "# Staged Retry", {
            status: "implemented",
            humanReviewMode: "always",
            humanReviewDecision: "approved",
            humanReviewedAt: "2026-01-02T00:00:00.000Z",
        });
        await savePlan(executionCwd, "staged-retry", "# Staged Retry", {
            status: "reviewed",
            executionMode: "worktree",
            deliveryEvidence: TEST_DELIVERY_DETAILS.deliveryEvidence,
            validatedAt: "2026-01-03T00:00:00.000Z",
            humanReviewMode: "always",
            humanReviewDecision: "approved",
            humanReviewedAt: "2026-01-02T00:00:00.000Z",
        });
        const retried = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "staged-retry",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-04T00:00:00.000Z") },
        });
        assertEquals(retried.attrs.validatedAt, "2026-01-03T00:00:00.000Z");
        assertEquals(retried.attrs.humanReviewMode, "always");
        assertEquals(retried.attrs.humanReviewDecision, "approved");
        assertEquals(retried.attrs.humanReviewedAt, "2026-01-02T00:00:00.000Z");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree advances the execution-worktree parent only", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        const epicAttrs = /** @type {any} */ ({
            status: "ready_for_work",
            classification: "PROJECT",
        });
        await savePlan(projectRoot, "epic", "# Epic", epicAttrs);
        await savePlan(projectRoot, "child-a", "# Child A", {
            status: "verified",
            classification: "FEATURE",
            ...TEST_DELIVERY_DETAILS,
            parentPlan: "epic",
        });
        await savePlan(projectRoot, "child-b", "# Child B", {
            status: "implemented",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        await savePlan(executionCwd, "epic", "# Stale Epic", epicAttrs);
        await savePlan(executionCwd, "child-a", "# Stale Child A", {
            status: "verified",
            classification: "FEATURE",
            parentPlan: "epic",
            ...TEST_DELIVERY_DETAILS,
        });
        await savePlan(executionCwd, "child-b", "# Stale Child B", {
            status: "reviewed",
            classification: "FEATURE",
            parentPlan: "epic",
        });

        const result = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-b",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-03T00:00:00.000Z") },
        });
        await updatePlanFrontMatterForTest(projectRoot, "epic", /** @type {any} */ ({ customFlag: true }));
        const retried = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-b",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-04T00:00:00.000Z") },
        });
        const retriedParent = await loadPlan(executionCwd, "epic");

        assertEquals((await loadPlan(executionCwd, "child-a"))?.attrs.status, "verified");
        assertEquals(retriedParent?.attrs.status, "reviewed");
        assertEquals(retriedParent?.attrs.validatedAt, "2026-01-03T00:00:00.000Z");
        assertEquals(/** @type {any} */ (retriedParent?.attrs).customFlag, undefined);
        assertEquals(retriedParent?.body, "# Stale Epic");
        assertEquals(result.planPaths, ["docs/plans/child-b.md", "docs/plans/epic.md"]);
        assertEquals(retried.planPaths, result.planPaths);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree idempotent retry does not reread the primary hierarchy", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        const epicAttrs = /** @type {any} */ ({
            status: "ready_for_work",
            classification: "PROJECT",
        });
        await savePlan(projectRoot, "epic", "# Epic", epicAttrs);
        await savePlan(projectRoot, "child-a", "# Child A", {
            status: "implemented",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        await savePlan(projectRoot, "child-b", "# Child B", {
            status: "in_progress",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        await savePlan(executionCwd, "epic", "# Epic", epicAttrs);
        for (const name of ["child-a", "child-b"]) {
            await savePlan(executionCwd, name, `# ${name}`, {
                status: name === "child-a" ? "reviewed" : "in_progress",
                classification: "FEATURE",
                parentPlan: "epic",
            });
        }

        const first = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-a",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-03T00:00:00.000Z") },
        });
        await updatePlanFrontMatterForTest(projectRoot, "child-b", {
            status: "verified",
            classification: "FEATURE",
            ...TEST_DELIVERY_DETAILS,
            parentPlan: "epic",
        });
        const retried = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-a",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-04T00:00:00.000Z") },
        });

        assertEquals(first.attrs.validatedAt, "2026-01-03T00:00:00.000Z");
        assertEquals(retried.attrs.validatedAt, first.attrs.validatedAt);
        assertEquals(retried.planPaths, ["docs/plans/child-a.md"]);
        assertEquals((await loadPlan(executionCwd, "epic"))?.attrs.status, "ready_for_work");
        assertEquals((await loadPlan(executionCwd, "child-b"))?.attrs.status, "in_progress");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree ignores a sibling reopened only in the primary checkout", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        const epicAttrs = /** @type {any} */ ({
            status: "ready_for_work",
            classification: "PROJECT",
        });
        await savePlan(projectRoot, "epic", "# Epic", epicAttrs);
        await savePlan(projectRoot, "child-a", "# Child A", {
            status: "implemented",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        await savePlan(projectRoot, "child-b", "# Child B", {
            status: "verified",
            classification: "FEATURE",
            ...TEST_DELIVERY_DETAILS,
            parentPlan: "epic",
        });
        await savePlan(executionCwd, "epic", "# Epic", epicAttrs);
        for (const name of ["child-a", "child-b"]) {
            await savePlan(executionCwd, name, `# ${name}`, {
                status: name === "child-a" ? "reviewed" : "verified",
                classification: "FEATURE",
                parentPlan: "epic",
                ...(name === "child-b" ? TEST_DELIVERY_DETAILS : {}),
            });
        }

        const first = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-a",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-03T00:00:00.000Z") },
        });
        await updatePlanFrontMatterForTest(projectRoot, "child-b", {
            status: "feedback",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        const retried = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-a",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-04T00:00:00.000Z") },
        });

        assertEquals(first.planPaths, ["docs/plans/child-a.md", "docs/plans/epic.md"]);
        assertEquals(retried.planPaths, ["docs/plans/child-a.md", "docs/plans/epic.md"]);
        assertEquals(retried.attrs.validatedAt, first.attrs.validatedAt);
        assertEquals((await loadPlan(executionCwd, "epic"))?.attrs.status, "reviewed");
        assertEquals((await loadPlan(executionCwd, "child-b"))?.attrs.status, "verified");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree does not import a newer primary parent state", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        const epicAttrs = /** @type {any} */ ({
            status: "ready_for_work",
            classification: "PROJECT",
        });
        await savePlan(projectRoot, "epic", "# Epic", epicAttrs);
        await savePlan(projectRoot, "child-a", "# Child A", {
            status: "implemented",
            classification: "FEATURE",
            parentPlan: "epic",
        });
        await savePlan(projectRoot, "child-b", "# Child B", {
            status: "verified",
            classification: "FEATURE",
            ...TEST_DELIVERY_DETAILS,
            parentPlan: "epic",
        });
        await savePlan(executionCwd, "epic", "# Epic", epicAttrs);
        await savePlan(executionCwd, "child-a", "# Child A", {
            status: "reviewed",
            classification: "FEATURE",
            parentPlan: "epic",
            ...TEST_DELIVERY_DETAILS,
        });
        await savePlan(executionCwd, "child-b", "# Child B", {
            status: "verified",
            classification: "FEATURE",
            parentPlan: "epic",
            ...TEST_DELIVERY_DETAILS,
        });

        const first = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-a",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-03T00:00:00.000Z") },
        });
        await updatePlanFrontMatterForTest(projectRoot, "epic", {
            status: "on_hold",
            holdReason: "Canonical parent changed while merge recovery was pending.",
        });
        const retried = await stageValidationPassedInExecutionWorktree({
            projectRoot,
            executionCwd,
            planName: "child-a",
            details: { ...TEST_DELIVERY_DETAILS, now: () => new Date("2026-01-04T00:00:00.000Z") },
        });

        assertEquals(first.planPaths, ["docs/plans/child-a.md", "docs/plans/epic.md"]);
        assertEquals(retried.planPaths, ["docs/plans/child-a.md", "docs/plans/epic.md"]);
        assertEquals(retried.attrs.validatedAt, first.attrs.validatedAt);
        assertEquals((await loadPlan(projectRoot, "epic"))?.attrs.status, "on_hold");
        assertEquals((await loadPlan(executionCwd, "epic"))?.attrs.status, "reviewed");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("stageValidationPassedInExecutionWorktree rejects a Plan outside Workflow Validation", async () => {
    const projectRoot = await Deno.makeTempDir();
    const executionCwd = await Deno.makeTempDir();
    try {
        // Publishing is legal from any status validation actually runs from, so the
        // guard rejects statuses outside validation rather than one exact status. It
        // used to demand `implemented`, which refused every publication once the Plan
        // reached `reviewed` before merge.
        await savePlan(projectRoot, "feature", "# Feature", { status: "in_progress" });
        await savePlan(executionCwd, "feature", "# Execution Feature", { status: "in_progress" });
        await assertRejects(
            () => stageValidationPassedInExecutionWorktree({ projectRoot, executionCwd, planName: "feature" }),
            Error,
            'at "in_progress"',
        );
        assertEquals((await loadPlan(executionCwd, "feature"))?.attrs.status, "in_progress");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(executionCwd, { recursive: true });
    }
});

Deno.test("recordPlanEvent enforces FEATURE Delivery Evidence without supplied triage metadata", async () => {
    const projectRoot = await Deno.makeTempDir();
    try {
        await savePlan(projectRoot, "feature", "# Feature", {
            status: "reviewed",
            classification: "FEATURE",
        });
        await assertRejects(
            () =>
                recordPlanEvent({
                    cwd: projectRoot,
                    planName: "feature",
                    event: "validation_passed",
                    currentStatus: "reviewed",
                }),
            Error,
            "planned change validation_passed requires executionMode",
        );
        assertEquals((await loadPlan(projectRoot, "feature"))?.attrs.status, "reviewed");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("recordPlanEvent rejects invalid transitions before writing", async () => {
    const projectRoot = await Deno.makeTempDir();
    try {
        await assertRejects(
            () =>
                recordPlanEvent({
                    cwd: projectRoot,
                    planName: "missing",
                    event: "validation_passed",
                    currentStatus: "approved",
                }),
            Error,
            "Plan not found: missing",
        );
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("recordPlanEvent explains stale Plan status with a validation action", async () => {
    const projectRoot = await Deno.makeTempDir();
    try {
        await savePlan(projectRoot, "feature", "# Feature", { status: "implemented" });

        const error = await assertRejects(
            () =>
                recordPlanEvent({
                    cwd: projectRoot,
                    planName: "feature",
                    event: "semantic_review_passed",
                    currentStatus: "validated_ci",
                }),
            Error,
        );

        assertStringIncludes(error.message, "RunWield had old status data for Plan feature.");
        assertStringIncludes(error.message, "It thought the Plan was at validated_ci (the checks passed)");
        assertStringIncludes(error.message, "the saved Plan is at implemented (the work is done)");
        assertStringIncludes(error.message, "run validation again for this Plan");
        assertStringIncludes(error.message, "Do not reset your worktree.");
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("getPlanLifecycleActionMetadata keeps protected states behind dedicated actions", () => {
    const draft = getPlanLifecycleActionMetadata("draft", { classification: "FEATURE" });
    assertEquals(draft.allowedManualTargetStatuses.includes("verified"), false);
    assertEquals(draft.allowedManualTargetStatuses.includes("failed"), false);
    assertEquals(draft.allowedManualTargetStatuses.includes("on_hold"), false);
    assertEquals(draft.canPutOnHold, true);
    assertEquals(draft.canCloseWithoutVerification, true);

    const failed = getPlanLifecycleActionMetadata("failed", { classification: "FEATURE" });
    assertEquals(failed.allowedManualTargetStatuses, []);
    assertEquals(failed.canPutOnHold, true);

    const verified = getPlanLifecycleActionMetadata("verified", { classification: "FEATURE" });
    assertEquals(verified.canPutOnHold, false);
    assertEquals(verified.canCloseWithoutVerification, false);

    const held = getPlanLifecycleActionMetadata("on_hold", {
        classification: "FEATURE",
        heldFromStatus: "ready_for_work",
    });
    assertEquals(held.canResumeFromHold, true);
    assertEquals(held.canResetToDraft, true);
});

Deno.test({
    name: "recordPlanEvent blocks shared Plan lifecycle writes without mutating siblings",
    permissions: { read: true, write: true },
    fn: async () => {
        const cwd = await Deno.makeTempDir();
        try {
            const lockedPath = await savePlan(cwd, "locked", "# Locked", {
                status: "approved",
                collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL,
                collaborationServerUrl: "https://plans.example.test",
                collaborationSpaceId: "space-1",
            });
            const siblingPath = await savePlan(cwd, "sibling", "# Sibling", { status: "approved" });
            const lockedBefore = await Deno.readTextFile(lockedPath);
            const siblingBefore = await Deno.readTextFile(siblingPath);

            const error = await assertRejects(
                () =>
                    recordPlanEvent({
                        cwd,
                        planName: "locked",
                        event: "readiness_passed",
                        currentStatus: "approved",
                    }),
                SharedPlanLockError,
            );
            assertStringIncludes(error.repair, "wld plans pull");
            assertEquals(await Deno.readTextFile(lockedPath), lockedBefore);
            assertEquals(await Deno.readTextFile(siblingPath), siblingBefore);
            assertEquals((await loadPlan(cwd, "sibling"))?.attrs.status, "approved");
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    },
});

Deno.test("passing CI retains durable semantic review state across a fresh Plan load", async () => {
    const root = await Deno.makeTempDir({ prefix: "lifecycle-ci-review-state-" });
    /** @type {import("./validation-checkpoint.ts").ValidationCheckpoint} */
    const checkpoint = {
        version: 1,
        attemptId: "attempt-review",
        generation: "generation-review",
        expectedStatus: "implemented",
        nextPhase: "mechanical",
        state: "ready",
        updatedAt: "2026-01-01T00:00:00.000Z",
        reviewState: {
            semanticRound: 2,
            reviewLedger: {
                items: [{
                    id: "R1-1",
                    openedInRound: 1,
                    resolvedInRound: null,
                    title: "Filter type",
                    requirement: "Reject non-string queries",
                    evidence: "The prior run accepted a number",
                    status: "fix_claimed",
                }],
                sequence: 1,
            },
            repairBaselineTree: "baseline-tree",
            lastRepairReport: "Fixed the rejected behavior",
        },
    };
    try {
        await savePlan(root, "review", "# Review", {
            status: "implemented",
            validationSemanticRounds: 2,
            validationCheckpoint: checkpoint,
        });
        await recordPlanEvent({
            cwd: root,
            planName: "review",
            event: "mechanical_validation_passed",
            currentStatus: "implemented",
        });
        const resumed = await loadPlan(root, "review");
        assertEquals(resumed?.attrs.status, "implemented");
        assertEquals(resumed?.attrs.validationPhase, "semantic");
        assertEquals(resumed?.attrs.validationSemanticRounds, 2);
        assertEquals(resumed?.attrs.validationCheckpoint, checkpoint);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
