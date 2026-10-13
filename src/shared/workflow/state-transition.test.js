import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { realpathSync as fsRealpathSync } from "node:fs";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { dirname, join } from "node:path";
import { getRunWieldRuntimeDir, PROJECT_INTERNAL_RUNTIME_DIR_NAME } from "../../constants.js";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import {
    closeTransitionRecordByAttestation,
    getTransitionJournalPath,
    listTransitionRecoveryRecords,
    reconcileTransitionRecoveryRecords,
    runArchiveTransition,
    runExecutionPreparationTransition,
    runImplementationCheckpointTransition,
    runPlanFrontMatterTransition,
    runRecoveryTransition,
    runValidationOutcomeTransition,
    withOrderedTransitionResources,
} from "./state-transition.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { enterProjectRuntime } from "../project-runtime-layout.ts";

const linkedCheckoutFixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n", "app.ts": "// app\n" });

async function makeProject() {
    return await fsMkdtemp(join(tmpdir(), "runwield-state-transition-"));
}

/** @param {string} projectRoot @param {string} transitionId */
function selectedJournalPath(projectRoot, transitionId) {
    return join(
        getRunWieldRuntimeDir(fsRealpathSync(projectRoot)),
        PROJECT_INTERNAL_RUNTIME_DIR_NAME,
        "plan-transitions",
        `${transitionId}.json`,
    );
}

/** @param {string} projectRoot @param {string} fileName */
function selectedLockPath(projectRoot, fileName) {
    return join(
        getRunWieldRuntimeDir(fsRealpathSync(projectRoot)),
        PROJECT_INTERNAL_RUNTIME_DIR_NAME,
        "plan-locks",
        fileName,
    );
}

/** @param {string} path */
async function pathExists(path) {
    return await fsStat(path).then(() => true).catch(() => false);
}

const PLAN_EVENT_TRANSITION_INVENTORY = [
    [
        "review_feedback",
        "Plan review feedback payload",
        "plan",
        "feedback front matter",
        "status feedback",
        "none",
        "review retry",
    ],
    [
        "review_approved",
        "approved Plan markdown",
        "plan",
        "approved front matter",
        "status approved",
        "none",
        "review retry",
    ],
    [
        "readiness_passed",
        "FEATURE approved Plan",
        "plan",
        "ready_for_work status",
        "status ready_for_work",
        "none",
        "review reopen",
    ],
    [
        "epic_readiness_passed",
        "PROJECT approved Plan",
        "plan",
        "ready_for_decomposition status",
        "status ready_for_decomposition",
        "none",
        "review reopen",
    ],
    [
        "decomposition_finalized",
        "Slicer child Plan set",
        "catalog, plan, child plans",
        "Epic ready_for_work",
        "children persisted",
        "CAS-written child drafts only",
        "slicer retry",
    ],
    [
        "execution_started",
        "execution worktree identity",
        "catalog, plan, worktree registry, target ref",
        "Plan in_progress and active attempt",
        "baseline/worktree facts",
        "owned new worktree and registry entry only",
        "load-plan recovery",
    ],
    [
        "execution_failed",
        "Engineer failure report",
        "plan, attempt",
        "failed status",
        "failure reason",
        "none",
        "recovery reset/continue",
    ],
    [
        "implementation_finished",
        "checkpoint commit",
        "plan, attempt",
        "implemented status",
        "implementation commit",
        "none",
        "validation retry",
    ],
    [
        "validation_failed",
        "CI/review failure",
        "catalog, plan, attempt, target ref",
        "validation_failed worktree status",
        "failure reason",
        "none",
        "validation retry",
    ],
    [
        "validation_passed",
        "delivery evidence",
        "catalog, plan, attempt, target ref",
        "verified status",
        "delivery evidence and target proof",
        "primary Plan snapshot restore only",
        "publication recovery",
    ],
    [
        "worktree_merge_failed",
        "merge failure facts",
        "catalog, plan, attempt, target ref",
        "merge_conflict worktree status",
        "merge failure kind",
        "primary Plan snapshot restore only",
        "merge repair",
    ],
    [
        "recovery_continue",
        "resume decision",
        "plan, attempt",
        "ready_for_work status",
        "current attempt retained",
        "none",
        "recovery retry",
    ],
    [
        "recovery_reset",
        "reset decision",
        "plan, attempt",
        "ready_for_work status",
        "attempt abandoned",
        "owned registry/worktree cleanup only",
        "recovery retry",
    ],
    [
        "review_reopened",
        "review reopen decision",
        "plan",
        "feedback status",
        "review feedback status",
        "none",
        "review loop",
    ],
    [
        "epic_done_enough",
        "Epic done-enough attestation",
        "catalog, parent plan, sibling plans",
        "verified Epic",
        "done-enough metadata",
        "none",
        "manual reopen",
    ],
    [
        "manual_status_change",
        "Workspace lifecycle action",
        "plan",
        "requested board-safe status",
        "status and timestamp",
        "none",
        "Workspace retry",
    ],
    [
        "manual_closed_without_verification",
        "closure reason",
        "plan",
        "closed_without_verification",
        "closure reason and timestamp",
        "none",
        "manual reopen",
    ],
    [
        "manual_user_verified",
        "user attestation",
        "catalog, parent/sibling plans when child",
        "user_verified",
        "attestation note and timestamp",
        "none",
        "manual reopen",
    ],
    [
        "plan_held",
        "hold reason/baseline",
        "plan",
        "on_hold",
        "heldFromStatus and hold metadata",
        "none",
        "resume/reset hold",
    ],
    ["hold_resumed", "resume check result", "plan", "heldFromStatus", "hold metadata cleared", "none", "hold reset"],
    [
        "hold_reset_to_draft",
        "reset hold decision",
        "plan",
        "draft",
        "hold/execution fields cleared",
        "none",
        "review loop",
    ],
];

const SEMANTIC_WRITER_TRANSITION_INVENTORY = [
    [
        "plan_review_write",
        "review markdown/front matter",
        "plan",
        "Plan review write committed",
        "written revision",
        "none",
        "review retry",
    ],
    ["plan_front_matter", "front matter updates", "plan", "metadata update", "CAS revision", "none", "caller retry"],
    [
        "execution_preparation",
        "worktree creation facts",
        "catalog, plan, attempt, target ref",
        "prepared execution",
        "registry and Plan facts",
        "owned new worktree/registry only",
        "load-plan recovery",
    ],
    [
        "implementation_checkpoint",
        "checkpoint commit",
        "plan, attempt",
        "checkpoint settled",
        "commit hash",
        "none",
        "execution recovery",
    ],
    [
        "validation_failed",
        "failure proof",
        "catalog, plan, attempt, target ref",
        "validation failure settled",
        "failure reason",
        "none",
        "validation retry",
    ],
    [
        "validation_passed",
        "delivery proof",
        "catalog, plan, attempt, target ref",
        "validation pass settled",
        "delivery evidence",
        "primary Plan snapshot restore only",
        "publication recovery",
    ],
    [
        "validation_retry",
        "retry proof",
        "catalog, plan, attempt, target ref",
        "retry settled",
        "retry reason",
        "none",
        "validation retry",
    ],
    [
        "validation_merge_failed",
        "merge failure proof",
        "catalog, plan, attempt, target ref",
        "merge failure settled",
        "merge failure kind",
        "primary Plan snapshot restore only",
        "merge repair",
    ],
    [
        "direct_delivery_publication",
        "publication proof",
        "catalog, plan, parent/siblings, attempt, target ref",
        "publication settled",
        "target ancestry and sibling eligibility",
        "primary Plan snapshot restore only",
        "transition recovery",
    ],
    [
        "recovery_continue",
        "continue action",
        "plan, attempt",
        "recovery continue settled",
        "attempt identity",
        "none",
        "recovery retry",
    ],
    [
        "recovery_reset",
        "reset action",
        "plan, attempt",
        "recovery reset settled",
        "attempt abandoned",
        "owned cleanup only",
        "recovery retry",
    ],
    [
        "recovery_recreate",
        "recreate action",
        "plan, attempt",
        "recovery recreate settled",
        "new attempt facts",
        "owned cleanup only",
        "recovery retry",
    ],
    [
        "recovery_abandon",
        "abandon action",
        "plan, attempt",
        "recovery abandon settled",
        "attempt abandoned",
        "owned cleanup only",
        "manual recovery",
    ],
    [
        "plan_archive",
        "archive action",
        "catalog, plan",
        "archive settled",
        "archive path",
        "rename CAS only",
        "restore/retry",
    ],
    [
        "plan_restore",
        "restore action",
        "catalog, plan",
        "restore settled",
        "active path",
        "rename CAS only",
        "archive retry",
    ],
];

test("checked-in transition inventory covers Plan Events and semantic writers", () => {
    const expectedEvents = [
        "review_feedback",
        "review_approved",
        "readiness_passed",
        "epic_readiness_passed",
        "decomposition_finalized",
        "execution_started",
        "execution_failed",
        "implementation_finished",
        "validation_failed",
        "validation_passed",
        "worktree_merge_failed",
        "recovery_continue",
        "recovery_reset",
        "review_reopened",
        "epic_done_enough",
        "manual_status_change",
        "manual_closed_without_verification",
        "manual_user_verified",
        "plan_held",
        "hold_resumed",
        "hold_reset_to_draft",
    ];
    assertEquals(PLAN_EVENT_TRANSITION_INVENTORY.map((row) => row[0]), expectedEvents);
    for (const row of [...PLAN_EVENT_TRANSITION_INVENTORY, ...SEMANTIC_WRITER_TRANSITION_INVENTORY]) {
        assertEquals(row.length, 7, `${row[0]} has event/writer, inputs, locks, effects, proof, rollback, recovery`);
        for (const cell of row) assert(Boolean(cell), `${row[0]} has no blank inventory cells`);
    }
});

test("ordered transition resources use each selected checkout root", async () => {
    const operationRoot = await makeProject();
    const resourceRoot = await makeProject();
    try {
        await withOrderedTransitionResources(
            operationRoot,
            [
                { kind: "target_ref", id: "main" },
                { kind: "attempt", id: "attempt-one", root: resourceRoot },
                { kind: "plan", id: "demo", root: resourceRoot },
                { kind: "catalog", root: operationRoot },
            ],
            async () => {
                await fsLstat(selectedLockPath(operationRoot, "catalog.lock"));
                await fsLstat(selectedLockPath(operationRoot, "__target_ref-main.lock"));
                await fsLstat(selectedLockPath(resourceRoot, "__attempt-attempt-one.lock"));
                await fsLstat(selectedLockPath(resourceRoot, "demo.lock"));
                assertEquals(await pathExists(selectedLockPath(operationRoot, "__attempt-attempt-one.lock")), false);
                assertEquals(await pathExists(selectedLockPath(operationRoot, "demo.lock")), false);
            },
        );
    } finally {
        await fsRm(operationRoot, { recursive: true }).catch(() => {});
        await fsRm(resourceRoot, { recursive: true }).catch(() => {});
    }
});

test("failed transitions leave populated journals in the linked checkout that owns the Plan", async () => {
    const root = await linkedCheckoutFixture.checkout({ prefix: "rw-transition-journal-primary-" });
    const container = await fsMkdtemp(join(tmpdir(), "rw-transition-journal-tree-"));
    const selected = join(container, "selected");
    try {
        await savePlan(root, "demo", "# Demo\n", { status: "implemented", classification: "FEATURE" });
        await git(root, ["add", "docs"]);
        await git(root, ["commit", "-m", "add Plan"]);
        await git(root, ["worktree", "add", "-b", "worktree/transition-journal", selected, "HEAD"]);
        const failure = await runValidationOutcomeTransition({
            projectRoot: selected,
            planName: "demo",
            outcome: "failed",
            settle: async ({ beforePlan }) => {
                assert(beforePlan);
                await updatePlanFrontMatter(selected, "demo", { failureReason: "half applied" }, beforePlan.attrs, {
                    expectedRevision: beforePlan.revision,
                });
                const current = await loadPlan(selected, "demo");
                const externalMarkdown = `${current?.markdown}`.replace(
                    'status: "implemented"',
                    'status: "implemented"\nfailureReason: "hand edited"',
                );
                await fsWriteFile(beforePlan.path, externalMarkdown);
                throw new Error("interrupted after an outside edit");
            },
        });

        assertEquals(failure.status, "needs_recovery");
        const [record] = await listTransitionRecoveryRecords(selected);
        assert(record);
        assertEquals(record.planName, "demo");
        assertEquals(record.uncertainty, "plan_bytes_changed");
        assertEquals(
            await fsReadFile(selectedJournalPath(selected, record.transitionId), "utf8"),
            JSON.stringify(record, null, 2) + "\n",
        );
        assertEquals(await pathExists(selectedJournalPath(root, record.transitionId)), false);
        assertEquals(
            await pathExists(
                join(
                    getRunWieldRuntimeDir(fsRealpathSync(selected)),
                    "plan-transitions",
                    `${record.transitionId}.json`,
                ),
            ),
            false,
        );
    } finally {
        await git(root, ["worktree", "remove", "--force", selected]).catch(() => {});
        await fsRm(container, { recursive: true }).catch(() => {});
        await fsRm(root, { recursive: true }).catch(() => {});
    }
});

test("Plan front matter transition commits and removes settled journal", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo", { status: "draft", classification: "FEATURE" });
        const result = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "demo",
            operation: "test_status",
            updates: { status: "approved" },
        });
        assertEquals(result.status, "committed");
        assertEquals((await loadPlan(cwd, "demo"))?.attrs.status, "approved");
        assertEquals(await listTransitionRecoveryRecords(cwd), []);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("Plan front matter transition records its committed metric through the real recorder", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await savePlan(projectRoot, "metric-demo", "# Metric demo", {
            status: "draft",
            classification: "FEATURE",
        });

        const result = await runPlanFrontMatterTransition({
            projectRoot,
            planName: "metric-demo",
            operation: "metric_test_status",
            updates: { status: "approved" },
        });

        assertEquals(result.status, "committed");
        const metrics = await readMetrics();
        assertEquals(
            metrics.some((metric) =>
                metric.category === "recovery" &&
                metric.event === "plan_transition_committed" &&
                metric.planName === "metric-demo" &&
                metric.details?.operation === "metric_test_status"
            ),
            true,
        );
    });
});

test("stale transition preconditions block without leaving unresolved recovery journals", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo", { status: "draft", classification: "FEATURE" });
        const current = await loadPlan(cwd, "demo");
        assert(current?.revision);
        const result = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            outcome: "passed",
            expectedRevision: `${current.revision}-stale`,
            settle: () => Promise.resolve({ ok: true }),
        });
        assertEquals(result.status, "blocked");
        assertEquals(await listTransitionRecoveryRecords(cwd), []);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("execution preparation transition locks resources and journals blocked effects", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo", { status: "ready_for_work", classification: "FEATURE" });
        // Interrupted after the worktree exists: that is the state a journal is for.
        const result = await runExecutionPreparationTransition({
            projectRoot: cwd,
            planName: "demo",
            planId: "plan-1",
            worktreeId: "wt-1",
            targetRef: "main",
            prepare: async ({ markEffect }) => {
                await markEffect("git_worktree_created", { worktreeId: "wt-1" });
                throw new Error("registry settlement interrupted");
            },
        });

        assertEquals(result.status, "needs_recovery");
        const records = await listTransitionRecoveryRecords(cwd);
        assertEquals(records.length, 1);
        assertEquals(records[0].operation, "execution_preparation");
        assertEquals(records[0].state, "needs_recovery");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("Plan front matter transition preserves malformed bytes and stays retryable", async () => {
    const cwd = await makeProject();
    try {
        await fsMkdir(join(cwd, "docs", "plans"), { recursive: true });
        const path = join(cwd, "docs", "plans", "bad.md");
        const malformed = "---\n: bad\n---\n# Bad";
        await fsWriteFile(path, malformed);
        const result = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "bad",
            operation: "test_malformed",
            updates: { status: "approved" },
        });
        assertEquals(result.status, "blocked");
        assertEquals(await fsReadFile(path, "utf8"), malformed, "malformed bytes are evidence and must survive");
        // Unreadable Plan bytes are a precondition, not partial work. Journaling it
        // would leave a record carrying no before-revision — nothing could ever prove
        // it settled — so the Plan would stay blocked even after the file was fixed.
        assertEquals(
            await listTransitionRecoveryRecords(cwd),
            [],
            "a rejected precondition must not strand the Plan behind an unclosable journal",
        );
        assert(
            result.recoveryActions?.some((action) => action.command?.includes("plans doctor")),
            "the user has to be told how to check the file they need to fix",
        );

        // Fixing the file is all it takes: no recovery step, no leftover state.
        await fsWriteFile(path, '---\nstatus: "draft"\n---\n# Bad\n');
        const retried = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "bad",
            operation: "test_malformed",
            updates: { status: "approved" },
        });
        assertEquals(retried.status, "committed");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("implementation checkpoint failure before any effect leaves no recovery journal", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo", { status: "in_progress" });
        const result = await runImplementationCheckpointTransition({
            projectRoot: cwd,
            planName: "demo",
            checkpoint: () => Promise.reject(new Error("checkpoint failed before commit")),
        });
        assertEquals(result.status, "rolled_back");
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 0);
        assertEquals((await loadPlan(cwd, "demo"))?.attrs.status, "in_progress");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("semantic transition matrix records operation-specific resources, effects, proof, and recovery", async () => {
    /** @type {Array<{ name: string, operation: string, run: (cwd: string) => Promise<any>, expectedResources: string[], expectedEffect: string }>} */
    const cases = [
        {
            name: "implementation checkpoint",
            operation: "implementation_checkpoint",
            run: (cwd) =>
                runImplementationCheckpointTransition({
                    projectRoot: cwd,
                    planName: "demo",
                    worktreeId: "wt-1",
                    checkpointProof: { implementationCommit: "a".repeat(40) },
                    checkpoint: () => Promise.resolve({ ok: true }),
                }),
            expectedResources: ["plan:demo", "attempt:wt-1"],
            expectedEffect: "implementation_checkpoint_settled",
        },
        {
            name: "validation failed",
            operation: "validation_failed",
            run: (cwd) =>
                runValidationOutcomeTransition({
                    projectRoot: cwd,
                    planName: "demo",
                    worktreeId: "wt-1",
                    targetRef: "main",
                    outcome: "failed",
                    proof: { reason: "ci" },
                    settle: () => Promise.resolve({ ok: true }),
                }),
            expectedResources: ["catalog:", "plan:demo", "attempt:wt-1", "target_ref:main"],
            expectedEffect: "validation_outcome_settled",
        },
        {
            name: "recovery reset",
            operation: "recovery_reset",
            run: (cwd) =>
                runRecoveryTransition({
                    projectRoot: cwd,
                    planName: "demo",
                    worktreeId: "wt-1",
                    action: "reset",
                    recover: () => Promise.resolve({ ok: true }),
                }),
            expectedResources: ["plan:demo", "attempt:wt-1"],
            expectedEffect: "recovery_reset_settled",
        },
        {
            name: "archive",
            operation: "plan_archive",
            run: (cwd) =>
                runArchiveTransition({
                    projectRoot: cwd,
                    planName: "demo",
                    action: "archive",
                    move: () => Promise.resolve({ ok: true }),
                }),
            expectedResources: ["catalog:", "plan:demo"],
            expectedEffect: "archive_archive_settled",
        },
    ];

    for (const testCase of cases) {
        const cwd = await makeProject();
        try {
            await savePlan(cwd, "demo", "# Demo", { status: "ready_for_work", classification: "FEATURE" });
            await savePlan(cwd, "epic", "# Epic", { status: "ready_for_work", classification: "PROJECT" });
            await savePlan(cwd, "epic/01-demo", "# Demo child", { status: "verified", classification: "FEATURE" });
            await savePlan(cwd, "epic/02-other", "# Other child", { status: "verified", classification: "FEATURE" });
            assert(testCase.expectedResources.length > 0, `${testCase.name} names locked resources`);
            assert(testCase.expectedEffect.length > 0, `${testCase.name} names expected effect`);
            const result = await testCase.run(cwd);
            assertEquals(result.status, "committed", testCase.name);
            assertEquals(await listTransitionRecoveryRecords(cwd), []);
        } finally {
            await fsRm(cwd, { recursive: true }).catch(() => {});
        }

        const failedCwd = await makeProject();
        try {
            await savePlan(failedCwd, "demo", "# Demo", { status: "ready_for_work", classification: "FEATURE" });
            // Fail after a durable effect is marked: that is the case a journal
            // exists for. A fault before any effect is a plain rejection and must
            // stay retryable instead of stranding the Plan.
            const failure = await runValidationOutcomeTransition({
                projectRoot: failedCwd,
                planName: "demo",
                outcome: "failed",
                settle: async ({ markEffect }) => {
                    await markEffect("worktree_registry_updated", { status: "validation_failed" });
                    throw new Error(`${testCase.name} injected fault`);
                },
            });
            assertEquals(failure.status, "needs_recovery");
            const [record] = await listTransitionRecoveryRecords(failedCwd);
            assertEquals(record.operation, "validation_failed");
            assertEquals(record.state, "needs_recovery");
            assert(Array.isArray(record.recoveryActions));
        } finally {
            await fsRm(failedCwd, { recursive: true }).catch(() => {});
        }

        // The same fault raised before any effect is a plain rejection: it must
        // roll back cleanly and leave the Plan operable, not journal and block it.
        const cleanCwd = await makeProject();
        try {
            await savePlan(cleanCwd, "demo", "# Demo", { status: "ready_for_work", classification: "FEATURE" });
            const cleanFailure = await runValidationOutcomeTransition({
                projectRoot: cleanCwd,
                planName: "demo",
                outcome: "failed",
                settle: () => Promise.reject(new Error(`${testCase.name} clean fault`)),
            });
            assertEquals(cleanFailure.status, "rolled_back");
            assertEquals((await listTransitionRecoveryRecords(cleanCwd)).length, 0);
        } finally {
            await fsRm(cleanCwd, { recursive: true }).catch(() => {});
        }
    }
});

test("semantic transitions allow nested same-Plan lifecycle events they own", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "nested", "# Nested", {
            status: "ready_for_work",
            classification: "FEATURE",
            planId: "plan-nested",
        });
        const plan = await loadPlan(cwd, "nested");
        if (!plan) throw new Error("missing test Plan");
        const transition = await runExecutionPreparationTransition({
            projectRoot: cwd,
            planName: "nested",
            planId: "plan-nested",
            worktreeId: "attempt-nested",
            expectedRevision: plan.revision,
            prepare: async ({ markEffect }) => {
                const attrs = await recordPlanEvent({
                    cwd,
                    planName: "nested",
                    event: "execution_started",
                    currentStatus: "ready_for_work",
                    details: {
                        triageMeta: plan.attrs,
                        worktreeId: "attempt-nested",
                        worktreePath: `${cwd}/wt`,
                        worktreeBranch: "runwield/worktree/nested-attempt-nested",
                        worktreeStatus: "active",
                    },
                });
                await markEffect("plan_event_recorded", { event: "execution_started" });
                return attrs;
            },
            verifyPreparation: () => ({ planName: "nested" }),
        });
        assertEquals(transition.status, "committed");
        assertEquals((await loadPlan(cwd, "nested"))?.attrs.status, "in_progress");
        assertEquals(await listTransitionRecoveryRecords(cwd), []);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("transitions block unresolved journals even when the Plan file is missing", async () => {
    const cwd = await makeProject();
    try {
        await enterProjectRuntime(cwd);
        const journalPath = getTransitionJournalPath(cwd, "existing-transition");
        await fsMkdir(dirname(journalPath), { recursive: true });
        await fsWriteFile(
            journalPath,
            JSON.stringify({
                version: 1,
                transitionId: "existing-transition",
                operation: "prior_missing_plan_recovery",
                planName: "missing",
                resources: [{ kind: "plan", id: "missing" }],
                state: "needs_recovery",
            }),
        );
        const semantic = await runExecutionPreparationTransition({
            projectRoot: cwd,
            planName: "missing",
            worktreeId: "wt-missing",
            prepare: () => Promise.resolve({ ok: true }),
        });
        assertEquals(semantic.status, "blocked");
        const planOnly = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "missing",
            operation: "missing_refresh",
            updates: { status: "ready_for_work" },
        });
        assertEquals(planOnly.status, "blocked");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a rejected precondition leaves no journal and the Plan stays usable", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", {
            planId: "p-1",
            classification: "FEATURE",
            status: "draft",
            summary: "s",
            affectedPaths: [],
        });
        // validation_passed is not reachable from draft: a pure rule rejection.
        await recordPlanEvent({ cwd, planName: "demo", event: "validation_passed", currentStatus: "draft" })
            .catch(() => {});
        assertEquals(
            (await listTransitionRecoveryRecords(cwd)).length,
            0,
            "a rejection that changed no bytes must not journal",
        );
        // The Plan must remain operable; a journal here would block it forever.
        const attrs = await recordPlanEvent({
            cwd,
            planName: "demo",
            event: "review_approved",
            currentStatus: "draft",
        });
        assertEquals(attrs.status, "approved");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("Plan Recovery supersedes an unresolved journal and clears it", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", {
            planId: "p-1",
            classification: "FEATURE",
            status: "in_progress",
            summary: "s",
            affectedPaths: [],
        });
        const journalPath = getTransitionJournalPath(cwd, "stranded-transition");
        await fsMkdir(dirname(journalPath), { recursive: true });
        await fsWriteFile(
            journalPath,
            JSON.stringify({
                version: 1,
                transitionId: "stranded-transition",
                operation: "implementation_checkpoint",
                planName: "demo",
                resources: [{ kind: "plan", id: "demo" }],
                state: "needs_recovery",
                completedEffects: [{ effect: "implementation_checkpoint_settled", completedAt: "now" }],
            }),
        );
        // Ordinary work stays blocked while the repository is uncertain.
        const blocked = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "demo",
            operation: "demo_refresh",
            updates: { status: "ready_for_work" },
        });
        assertEquals(blocked.status, "blocked");

        const recovery = await runRecoveryTransition({
            projectRoot: cwd,
            planName: "demo",
            action: "reset",
            recover: () => Promise.resolve({ ok: true }),
        });
        assertEquals(recovery.status, "committed", "recovery must not be blocked by the record it resolves");
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 0, "recovery retires what it superseded");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("reconciliation closes settled journals but keeps ones with durable effects", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", {
            planId: "p-1",
            classification: "FEATURE",
            status: "draft",
            summary: "s",
            affectedPaths: [],
        });
        const plan = await loadPlan(cwd, "demo");
        const dir = dirname(getTransitionJournalPath(cwd, "x"));
        await fsMkdir(dir, { recursive: true });
        const write = async (/** @type {string} */ id, /** @type {Record<string, unknown>} */ record) =>
            await fsWriteFile(
                getTransitionJournalPath(cwd, id),
                JSON.stringify({ version: 1, transitionId: id, planName: "demo", ...record }),
            );
        await write("committed-cleanup-lost", { state: "committed", operation: "plan_event" });
        await write("nothing-happened", {
            state: "needs_recovery",
            operation: "plan_event",
            completedEffects: [],
            beforeFacts: { plan: { revision: plan?.revision } },
        });
        await write("durable-effect", {
            state: "needs_recovery",
            operation: "direct_delivery_publication",
            completedEffects: [{ effect: "direct_delivery_target_ref_moved", completedAt: "now" }],
            beforeFacts: { plan: { revision: plan?.revision } },
        });

        const reconciliations = await reconcileTransitionRecoveryRecords(cwd, { apply: true });
        const byId = new Map(reconciliations.map((entry) => [entry.transitionId, entry]));
        assertEquals(byId.get("committed-cleanup-lost")?.resolved, true);
        assertEquals(byId.get("nothing-happened")?.resolved, true);
        assertEquals(byId.get("durable-effect")?.resolvable, false, "a moved target ref needs human proof");

        const remaining = await listTransitionRecoveryRecords(cwd);
        assertEquals(remaining.length, 1);
        assertEquals(remaining[0].transitionId, "durable-effect");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a transition undoes the Plan write it can prove it made", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", { status: "implemented", classification: "FEATURE" });
        const before = await loadPlan(cwd, "demo");
        assert(before);

        const failure = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            outcome: "failed",
            settle: async ({ beforePlan }) => {
                // A real partial write through RunWield's own writer, then a fault.
                await updatePlanFrontMatter(cwd, "demo", { failureReason: "half applied" }, beforePlan?.attrs || {}, {
                    expectedRevision: beforePlan?.revision,
                });
                throw new Error("interrupted after writing the Plan");
            },
        });

        assertEquals(failure.status, "rolled_back", "an undone partial write must not strand the Plan");
        const after = await loadPlan(cwd, "demo");
        assertEquals(after?.revision, before.revision, "the Plan is byte-identical to its pre-transaction state");
        assertEquals(after?.attrs.failureReason ?? null, null);
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 0);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a transition refuses to undo Front Matter written outside RunWield", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", { status: "implemented", classification: "FEATURE" });
        const before = await loadPlan(cwd, "demo");
        assert(before);

        let externalMarkdown = "";
        const failure = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            outcome: "failed",
            settle: async ({ beforePlan }) => {
                await updatePlanFrontMatter(cwd, "demo", { failureReason: "half applied" }, beforePlan?.attrs || {}, {
                    expectedRevision: beforePlan?.revision,
                });
                // Someone edits the metadata itself outside RunWield's lock. RunWield is
                // no longer the proven author of the Front Matter, so its partial write
                // must not be reverted over theirs.
                const current = await loadPlan(cwd, "demo");
                externalMarkdown = `${current?.markdown}`.replace(
                    'status: "implemented"',
                    'status: "implemented"\nfailureReason: "hand edited"',
                );
                await fsWriteFile(before.path, externalMarkdown);
                throw new Error("interrupted after an outside edit");
            },
        });

        assertEquals(failure.status, "needs_recovery", "unproven authorship must fail closed");
        assertEquals(await fsReadFile(before.path, "utf8"), externalMarkdown, "the outside edit survives untouched");
        const [record] = await listTransitionRecoveryRecords(cwd);
        assertEquals(record.uncertainty, "plan_bytes_changed");
        assertEquals(
            await fsReadFile(selectedJournalPath(cwd, record.transitionId), "utf8"),
            JSON.stringify(record, null, 2) + "\n",
        );
        assertEquals(
            await pathExists(
                join(getRunWieldRuntimeDir(fsRealpathSync(cwd)), "plan-transitions", `${record.transitionId}.json`),
            ),
            false,
            "normal transitions must not leave legacy journals",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a failed transition reverts its own Front Matter without touching an edited body", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n\noriginal prose\n", {
            status: "implemented",
            classification: "FEATURE",
        });
        const before = await loadPlan(cwd, "demo");
        assert(before);

        let userBody = "";
        const failure = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            outcome: "failed",
            settle: async ({ beforePlan }) => {
                await updatePlanFrontMatter(cwd, "demo", { failureReason: "half applied" }, beforePlan?.attrs || {}, {
                    expectedRevision: beforePlan?.revision,
                });
                // The user rewrites the body in their own editor, which they are entitled
                // to do at any time: RunWield owns Front Matter, the user owns the body.
                const current = await loadPlan(cwd, "demo");
                assert(current);
                const rewritten = current.markdown.replace("original prose", "prose the user rewrote in vim");
                await fsWriteFile(before.path, rewritten);
                userBody = rewritten.slice(rewritten.indexOf("# Demo"));
                throw new Error("interrupted after the user edited the body");
            },
        });

        assertEquals(failure.status, "rolled_back", "reverting our own metadata is a clean rollback");
        const after = await loadPlan(cwd, "demo");
        assertEquals(after?.attrs.failureReason ?? null, null, "the half-applied metadata is undone");
        assertEquals(after?.body, userBody, "the body the user wrote is left exactly as they wrote it");
        assertEquals(
            await listTransitionRecoveryRecords(cwd),
            [],
            "a body edit must not leave the Plan blocked behind a recovery record",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a user body edit does not block a Front Matter transition", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n\noriginal prose\n", {
            status: "ready_for_work",
            classification: "FEATURE",
        });
        const before = await loadPlan(cwd, "demo");
        assert(before);
        // The Plan RunWield read is the Plan RunWield is about to change — except the
        // user rewrote the prose in between, which is theirs to do.
        const rewritten = before.markdown.replace("original prose", "prose the user rewrote in vim");
        await fsWriteFile(before.path, rewritten);

        const result = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "demo",
            operation: "hold",
            updates: { status: "on_hold" },
            expectedRevision: before.revision,
        });

        assertEquals(result.status, "committed", "body drift is not a lifecycle conflict");
        const after = await loadPlan(cwd, "demo");
        assertEquals(after?.attrs.status, "on_hold");
        assert(after?.body.includes("rewrote in vim"), "the user's prose survives the lifecycle change");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a stranded Plan does not block lifecycle work on unrelated Plans", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "alpha", "# A\n", { status: "implemented", classification: "FEATURE", planId: "p-a" });
        await savePlan(cwd, "beta", "# B\n", { status: "implemented", classification: "FEATURE", planId: "p-b" });
        const stranded = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "alpha",
            worktreeId: "wt-a",
            outcome: "merge_failed",
            settle: async ({ markEffect }) => {
                await markEffect("worktree_registry_updated", { worktreeId: "wt-a", status: "merge_conflict" });
                throw new Error("interrupted after a durable effect");
            },
        });
        assertEquals(stranded.status, "needs_recovery");

        // Composite transitions all lock the Plan catalog, so treating that lock as
        // ownership would turn one stranded Plan into a project-wide outage.
        const unrelated = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "beta",
            worktreeId: "wt-b",
            outcome: "failed",
            settle: () => Promise.resolve("settled"),
        });
        assertEquals(unrelated.status, "committed", "an unrelated Plan must remain workable");

        const blocked = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "alpha",
            worktreeId: "wt-a",
            outcome: "failed",
            settle: () => Promise.resolve("settled"),
        });
        assertEquals(blocked.status, "blocked", "the stranded Plan itself is still protected");
        assert(
            blocked.recoveryActions?.some((action) => action.command?.includes("plans doctor --repair")),
            "a block on RunWield's own bookkeeping has to name the command that clears it",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("reconciliation closes a record whose effects a prover accounts for", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", { status: "verified", classification: "FEATURE", planId: "p-1" });
        const failure = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            worktreeId: "wt-1",
            outcome: "merge_failed",
            settle: async ({ markEffect }) => {
                await markEffect("worktree_registry_updated", { worktreeId: "wt-1", status: "merged" });
                throw new Error("interrupted after the registry write");
            },
        });
        assertEquals(failure.status, "needs_recovery");

        // Without evidence about Git and the registry, this module must keep the record.
        const unproven = await reconcileTransitionRecoveryRecords(cwd);
        assertEquals(unproven[0].resolvable, false);
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 1);

        const resolved = await reconcileTransitionRecoveryRecords(cwd, {
            apply: true,
            proveEffect: (effect) => ({
                settled: effect.effect === "worktree_registry_updated",
                reason: "registry rows are written atomically",
            }),
        });
        assertEquals(resolved[0].resolved, true);
        assertEquals(resolved[0].effects?.[0].verdict?.settled, true);
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 0, "RunWield closes its own bookkeeping");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("an execution start cancelled mid-apply does not strand the Plan", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", { status: "ready_for_work", classification: "FEATURE" });

        // Killed after prepare, before any effect was marked — what cancelling an
        // approved execution actually leaves behind.
        const failure = await runExecutionPreparationTransition({
            projectRoot: cwd,
            planName: "demo",
            worktreeId: "wt-1",
            prepare: () => Promise.reject(new Error("cancelled by the user")),
        });
        assertEquals(failure.status, "rolled_back");

        // Even a record written at "applying" keeps the before-facts prepare recorded, so
        // reconciliation can prove it settled. Without that the Plan is blocked forever:
        // no effect to prove, no revision to compare, no way back.
        await fsMkdir(dirname(getTransitionJournalPath(cwd, "x")), { recursive: true });
        await fsWriteFile(
            getTransitionJournalPath(cwd, "stranded"),
            JSON.stringify({
                version: 1,
                transitionId: "stranded",
                operation: "execution_preparation",
                planName: "demo",
                state: "applying",
                completedEffects: [],
            }),
        );
        const blocked = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "demo",
            operation: "hold",
            updates: { status: "on_hold" },
        });
        assertEquals(blocked.status, "blocked", "an unresolved record still protects the Plan");

        const reconciliations = await reconcileTransitionRecoveryRecords(cwd, { apply: true });
        const record = reconciliations.find((entry) => entry.transitionId === "stranded");
        assertEquals(record?.resolved, true, "a record naming no durable effect must be closable");
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 0);

        const after = await runPlanFrontMatterTransition({
            projectRoot: cwd,
            planName: "demo",
            operation: "hold",
            updates: { status: "on_hold" },
        });
        assertEquals(after.status, "committed", "and the Plan works again afterwards");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("a journal keeps its before-facts across state changes", async () => {
    const cwd = await makeProject();
    try {
        await savePlan(cwd, "demo", "# Demo\n", { status: "implemented", classification: "FEATURE" });
        // Interrupt after an effect is marked, which rewrites the record at "applying".
        const failure = await runValidationOutcomeTransition({
            projectRoot: cwd,
            planName: "demo",
            worktreeId: "wt-1",
            outcome: "merge_failed",
            settle: async ({ markEffect }) => {
                await markEffect("worktree_registry_updated", { worktreeId: "wt-1" });
                throw new Error("interrupted after the effect");
            },
        });
        assertEquals(failure.status, "needs_recovery");
        const [record] = await listTransitionRecoveryRecords(cwd);
        const beforeFacts = /** @type {{ plan?: { revision?: string } }} */ (record.beforeFacts);
        assertEquals(
            typeof beforeFacts?.plan?.revision,
            "string",
            "the before-revision recorded at prepare survives later state writes",
        );
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("an unprovable record can be closed on user attestation without destroying it", async () => {
    // The last resort in the never-strand chain. RunWield must not close a record it
    // cannot prove, but refusing forever leaves `rm` on a JSON file as the only exit.
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        await enterProjectRuntime(cwd);
        const path = getTransitionJournalPath(cwd, "stuck-1");
        await fsMkdir(dirname(path), { recursive: true });
        await fsWriteFile(
            path,
            JSON.stringify({
                transitionId: "stuck-1",
                planName: "demo",
                operation: "worktree_merge",
                state: "needs_recovery",
                effects: [{ effect: "merge_execution_worktree" }],
            }),
        );
        assertEquals((await listTransitionRecoveryRecords(cwd)).length, 1);

        const closed = await closeTransitionRecordByAttestation(cwd, "stuck-1", { note: "checked by hand" });
        assertEquals(closed.closed, true);

        // Unblocked...
        assertEquals(await listTransitionRecoveryRecords(cwd), [], "the record no longer blocks the Plan");
        // ...but not destroyed. An attestation can be wrong, so the evidence survives.
        const archivePath = join(
            getRunWieldRuntimeDir(fsRealpathSync(cwd)),
            PROJECT_INTERNAL_RUNTIME_DIR_NAME,
            "plan-transitions",
            "attested",
            "stuck-1.json",
        );
        const archived = JSON.parse(await fsReadFile(archivePath, "utf8"));
        assertEquals(
            await pathExists(
                join(getRunWieldRuntimeDir(fsRealpathSync(cwd)), "plan-transitions", "attested", "stuck-1.json"),
            ),
            false,
        );
        assertEquals(archived.state, "closed_by_user_attestation");
        assertEquals(archived.operation, "worktree_merge");
        assertEquals(archived.attestationNote, "checked by hand");
        assertEquals(typeof archived.closedByUserAttestationAt, "string");

        const missing = await closeTransitionRecordByAttestation(cwd, "not-there");
        assertEquals(missing.closed, false);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});
