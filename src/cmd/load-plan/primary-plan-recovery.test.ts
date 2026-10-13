import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { getDeclaredPlanStatus, loadPlan, savePlan } from "../../plan-store.js";
import { createTestWorktreeAttempt, makeRepo } from "../../shared/worktree-test-helpers.ts";
import { removeWorktreeGitArtifacts } from "../../shared/worktree.js";
import { resolvePlanWithPrimaryRecovery } from "./primary-plan-recovery.ts";

test("load-plan reads the execution Plan without recreating a missing primary Plan", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "runwield-primary-plan-recovery-"));
    const planName = "restore-me";
    const planId = "restore-me-id";
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        worktree = await createTestWorktreeAttempt({ projectRoot, worktreeRoot, planName, planId });
        await savePlan(worktree.path, planName, "# Restored Plan\n\nExecution copy wins.\n", {
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Restore me",
            affectedPaths: [],
            status: "implemented",
            planId,
            executionMode: "worktree",
            worktreeId: worktree.id,
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
            worktreeBaseBranch: worktree.baseBranch,
        });

        const result = await resolvePlanWithPrimaryRecovery(projectRoot, planName);

        assertEquals(result.plan.path, join(worktree.path, "docs", "plans", `${planName}.md`));
        assertEquals(result.plan.attrs.planId, planId);
        assertStringIncludes(result.plan.markdown, "Execution copy wins.");
        assertEquals(await loadPlan(projectRoot, planName), null);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("load-plan leaves a malformed primary Plan untouched and reads the execution Plan", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "runwield-primary-plan-malformed-"));
    const planName = "repair-malformed";
    const planId = "repair-malformed-id";
    let worktree: Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined;
    try {
        worktree = await createTestWorktreeAttempt({ projectRoot, worktreeRoot, planName, planId });
        await savePlan(worktree.path, planName, "# Recovered\n", {
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Repair malformed",
            affectedPaths: [],
            status: "implemented",
            planId,
            executionMode: "worktree",
            worktreeId: worktree.id,
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
            worktreeBaseBranch: worktree.baseBranch,
        });
        await fsMkdir(`${projectRoot}/docs/plans`, { recursive: true });
        const malformed = '---\nstatus: "unterminated\n---\n# Broken\n';
        await fsWriteFile(`${projectRoot}/docs/plans/${planName}.md`, malformed);

        const result = await resolvePlanWithPrimaryRecovery(projectRoot, planName);

        assertEquals(
            await fsReadFile(`${projectRoot}/docs/plans/${planName}.md`, "utf8"),
            malformed,
        );
        assertStringIncludes(result.plan.markdown, "# Recovered");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("load-plan resolves an active Plan by durable planId", async () => {
    const projectRoot = await makeRepo();
    const planName = "resolve-by-id";
    const planId = "123e4567-e89b-12d3-a456-426614174000";
    try {
        await savePlan(projectRoot, planName, "# Resolve By ID\n", {
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Resolve by ID",
            affectedPaths: [],
            status: "draft",
            planId,
        });

        const result = await resolvePlanWithPrimaryRecovery(projectRoot, planId);

        assertEquals(result.plan.planName, planName);
        assertEquals(result.plan.attrs.planId, planId);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});

test("load-plan repairs retired ready_for_review status to implemented", async () => {
    const projectRoot = await makeRepo();
    const planName = "retired-review-status";
    try {
        await savePlan(projectRoot, planName, "# Retired Review Status\n", {
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Repair a retired status",
            affectedPaths: [],
            status: "implemented",
            planId: "retired-review-status-id",
        });
        const path = `${projectRoot}/docs/plans/${planName}.md`;
        const current = await fsReadFile(path, "utf8");
        await fsWriteFile(path, current.replace('status: "implemented"', 'status: "ready_for_review"'));

        const result = await resolvePlanWithPrimaryRecovery(projectRoot, planName);

        assertEquals(result.recoveredStatus, { from: "ready_for_review", to: "implemented" });
        assertEquals(result.plan.attrs.status, "implemented");
        assertEquals(getDeclaredPlanStatus(await fsReadFile(path, "utf8")), "implemented");
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
    }
});
