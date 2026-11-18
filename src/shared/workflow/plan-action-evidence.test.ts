import { seedPlan } from "../testing/plan-state-fixture.ts";
import { enterProjectRuntime } from "../project-runtime-layout.ts";
import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { dirname } from "node:path";
import { loadPlan } from "../../plan-store/index.ts";

import { getWorktreeRegistryPath } from "../worktree-registry.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { executePlanAction, loadPlanActionEvidence } from "./plan-actions.ts";

const fixture = defineCommittedGitFixture();

async function makeProject(existingRoot?: string): Promise<{ root: string; revision: string }> {
    const root = existingRoot || (await fixture.checkout());
    await seedPlan(root, "demo", "# Demo\n\nBody\n", {
        planId: "plan-demo",
        status: "draft",
        classification: "FEATURE",
    });
    const plan = await loadPlan(root, "demo");
    if (!plan?.revision) throw new Error("fixture Plan was not saved");
    return { root, revision: plan.revision };
}

async function withRetainedProject(run: (project: { root: string; revision: string }) => Promise<void>) {
    const root = await fixture.checkout();
    await withRetainedPlanFixture(root, async () => run(await makeProject(root)));
}

async function writeRegistry(root: string, entries: Array<Record<string, string>>): Promise<void> {
    const registryPath = getWorktreeRegistryPath(root);
    await fsMkdir(dirname(registryPath), { recursive: true });
    await fsWriteFile(registryPath, JSON.stringify({ version: 2, entries }));
}

test("rejects stale Plan revision before lifecycle mutation", async () => {
    const { root, revision } = await makeProject();
    await seedPlan(
        root,
        "demo",
        "# Demo\n\nBody changed\n",
        {
            planId: "plan-demo",
            status: "draft",
            classification: "FEATURE",
        },
        { expectedRevision: revision },
    );

    const result = await executePlanAction(root, {
        planId: "plan-demo",
        expectedRevision: revision,
        expectedStatus: "draft",
        expectedWorktree: { kind: "none" },
        action: "put_on_hold",
    });

    assertEquals(result.kind, "refresh_required");
    const current = await loadPlan(root, "demo");
    assertEquals(current?.attrs.status, "draft");
});

test("rejects replaced worktree evidence before lifecycle mutation", async () => {
    await withRetainedProject(async ({ root, revision }) => {
        await seedPlan(
            root,
            "demo",
            "# Demo\n\nBody\n",
            {
                planId: "plan-demo",
                status: "on_hold",
                heldFromStatus: "in_progress",
                classification: "FEATURE",
            },
            { expectedRevision: revision },
        );
        const executionRoot = await attachExecutionWorktree(root, "rw/demo-2");
        await seedPlan(executionRoot, "demo", "# Demo\n\nBody\n", {
            planId: "plan-demo",
            status: "on_hold",
            heldFromStatus: "in_progress",
            classification: "FEATURE",
            executionMode: "worktree",
            worktreeId: "attempt-two",
        });
        const loaded = await loadPlan(executionRoot, "demo");
        if (!loaded?.revision) throw new Error("fixture Plan was not reloaded");
        await writeRegistry(root, [
            {
                id: "attempt-two",
                planName: "demo",
                planId: "plan-demo",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
                branch: "rw/demo-2",
                path: executionRoot,
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        ]);

        const result = await executePlanAction(root, {
            planId: "plan-demo",
            expectedRevision: loaded.revision,
            expectedStatus: "on_hold",
            expectedWorktree: {
                kind: "attempt",
                id: "attempt-one",
                planId: "plan-demo",
                status: "active",
                branch: "rw/demo-1",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
            },
            action: "resume_from_hold",
        });

        assertEquals(result.kind, "recovery_required");
        const current = await loadPlan(root, "demo");
        assertEquals(current?.attrs.status, "on_hold");
    });
});

test("applies a valid lifecycle action and returns new evidence", async () => {
    const { root } = await makeProject();
    const evidence = await loadPlanActionEvidence(root, "plan-demo");
    if (evidence.kind !== "success") throw new Error(evidence.message);

    const result = await executePlanAction(root, {
        planId: "plan-demo",
        expectedRevision: evidence.evidence.revision,
        expectedStatus: evidence.evidence.status,
        expectedWorktree: evidence.evidence.worktree,
        action: "put_on_hold",
        holdReason: "pause",
    });

    assertEquals(result.kind, "success");
    const current = await loadPlan(root, "demo");
    assertEquals(current?.attrs.status, "on_hold");
});

test("requires recovery when the registered execution Plan is missing", async () => {
    const root = await fixture.checkout();
    await withRetainedPlanFixture(root, async () => {
        await seedPlan(root, "demo", "# Demo\n\nBody\n", {
            planId: "plan-demo",
            status: "draft",
            classification: "FEATURE",
        });
        const revision = (await loadPlan(root, "demo"))!.revision;
        const executionRoot = await attachExecutionWorktree(root, "rw/demo-1");
        await seedPlan(
            root,
            "demo",
            "# Demo\n\nBody\n",
            {
                planId: "plan-demo",
                status: "in_progress",
                classification: "FEATURE",
                worktreeId: "attempt-one",
                worktreeStatus: "active",
                worktreeBranch: "rw/demo-1",
                worktreeBaseBranch: "main",
            },
            { expectedRevision: revision },
        );
        await writeRegistry(root, [
            {
                id: "attempt-one",
                planName: "demo",
                planId: "plan-demo",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
                branch: "rw/demo-1",
                path: executionRoot,
                status: "completed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        ]);

        const evidence = await loadPlanActionEvidence(root, "plan-demo");

        assertEquals(evidence.kind, "recovery_required");
    });
});

test("registry owns mutable worktree facts while Plan validation state owns lifecycle", async () => {
    await withRetainedProject(async ({ root, revision }) => {
        const executionRoot = await attachExecutionWorktree(root, "rw/demo-1");
        await seedPlan(
            root,
            "demo",
            "# Demo\n\nPrimary copy\n",
            {
                planId: "plan-demo",
                status: "ready_for_work",
                classification: "FEATURE",
            },
            { expectedRevision: revision },
        );
        await seedPlan(executionRoot, "demo", "# Demo\n\nImplemented\n", {
            planId: "plan-demo",
            status: "implemented",
            classification: "FEATURE",
            executionMode: "worktree",
            worktreeId: "attempt-one",
            worktreePath: "/stale/path",
            worktreeBranch: "stale/branch",
            worktreeBaseBranch: "stale-base",
            worktreeStatus: "validation_failed",
            validationCheckpoint: {
                version: 1,
                attemptId: "attempt-one",
                generation: "generation-one",
                expectedStatus: "implemented",
                nextPhase: "mechanical",
                state: "awaiting_repair",
                repairKind: "semantic",
                repairGeneration: "repair-one",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        });
        await writeRegistry(root, [
            {
                id: "attempt-one",
                planName: "demo",
                planId: "plan-demo",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
                branch: "rw/demo-1",
                path: executionRoot,
                status: "completed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        ]);

        const evidence = await loadPlanActionEvidence(root, "plan-demo");

        assertEquals(evidence.kind, "success");
        if (evidence.kind === "success") {
            assertEquals(evidence.evidence.status, "implemented");
            assertEquals(evidence.evidence.worktree, {
                kind: "attempt",
                id: "attempt-one",
                planId: "plan-demo",
                status: "completed",
                branch: "rw/demo-1",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
            });
        }
    });
});

test("live execution Plan owns action evidence when the primary copy is stale", async () => {
    await withRetainedProject(async ({ root }) => {
        const executionRoot = await attachExecutionWorktree(root, "rw/demo-1");
        await seedPlan(executionRoot, "demo", "# Demo\n\nImplemented\n", {
            planId: "plan-demo",
            status: "implemented",
            classification: "FEATURE",
            executionMode: "worktree",
            worktreeId: "attempt-one",
            worktreePath: executionRoot,
            worktreeBranch: "rw/demo-1",
            worktreeBaseBranch: "main",
            worktreeStatus: "completed",
        });
        await writeRegistry(root, [
            {
                id: "attempt-one",
                planName: "demo",
                planId: "plan-demo",
                baseBranch: "main",
                baseRef: "refs/heads/main",
                baseCommit: await git(root, ["rev-parse", "HEAD"]),
                branch: "rw/demo-1",
                path: executionRoot,
                status: "completed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
        ]);

        const evidence = await loadPlanActionEvidence(root, "plan-demo");

        assertEquals(evidence.kind, "success");
        if (evidence.kind === "success") {
            assertEquals(evidence.evidence.status, "implemented");
            assertEquals(evidence.evidence.worktree.kind, "attempt");
            const action = await executePlanAction(root, {
                planId: "plan-demo",
                expectedRevision: evidence.evidence.revision,
                expectedStatus: evidence.evidence.status,
                expectedWorktree: evidence.evidence.worktree,
                action: "put_on_hold",
                holdReason: "pause the execution attempt",
            });
            assertEquals(action.kind, "success");
            assertEquals((await loadPlan(executionRoot, "demo"))?.attrs.status, "on_hold");
            assertEquals((await loadPlan(root, "demo"))?.attrs.status, "draft");
        }
    });
});

test("rejects ambiguous registry integrity issues before lifecycle mutation", async () => {
    const { root } = await makeProject();
    const evidence = await loadPlanActionEvidence(root, "plan-demo");
    if (evidence.kind !== "success") throw new Error(evidence.message);
    const executionRoot = await attachExecutionWorktree(root, "rw/demo-1");
    const otherRoot = await attachExecutionWorktree(root, "rw/other");
    await writeRegistry(root, [
        {
            id: "duplicate",
            planName: "demo",
            planId: "plan-demo",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await git(root, ["rev-parse", "HEAD"]),
            branch: "rw/demo-1",
            path: executionRoot,
            status: "merged",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
            id: "duplicate",
            planName: "other",
            planId: "plan-other",
            baseBranch: "main",
            baseRef: "main",
            baseCommit: await git(root, ["rev-parse", "HEAD"]),
            branch: "rw/other",
            path: otherRoot,
            status: "merged",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        },
    ]);

    const registryBefore = await fsReadFile(getWorktreeRegistryPath(root), "utf8");
    const result = await executePlanAction(root, {
        planId: "plan-demo",
        expectedRevision: evidence.evidence.revision,
        expectedStatus: evidence.evidence.status,
        expectedWorktree: evidence.evidence.worktree,
        action: "put_on_hold",
    });

    assertEquals(result.kind, "recovery_required");
    if (result.kind === "recovery_required") assertEquals(result.entryIds, ["duplicate"]);
    assertEquals(await fsReadFile(getWorktreeRegistryPath(root), "utf8"), registryBefore);
    assertEquals((await loadPlanActionEvidence(root, "plan-demo")).kind, "recovery_required");
    const current = await loadPlan(root, "demo");
    assertEquals(current?.attrs.status, "draft");
});

async function attachExecutionWorktree(root: string, branch: string): Promise<string> {
    const path = join(root, branch.replaceAll("/", "-"));
    await git(root, ["worktree", "add", "-b", branch, path]);
    await enterProjectRuntime(path);
    return path;
}
