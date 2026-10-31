// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    rename as fsRename,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { parsePlanFrontMatter, savePlan } from "../../plan-store.js";
import { addEntry, getWorktreeRegistryPath } from "../../shared/worktree-registry.js";
import { createPublicationAttempt, recordPublicationFailure } from "../../shared/workflow/publication-attempt.ts";
import { makeValidationCheckpoint } from "../../shared/workflow/validation-checkpoint.ts";
import { loadOwnerPlanProgress } from "./server/owner-plan-progress.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";

const publicationFixture = defineCommittedGitFixture({ "README.md": "Before publication\n" });

type StoreProject = { currentRoot: string };
type StoreSession = { runwieldSessionId: string; projectId: string; displayName: string; transcriptCwd: string };

function makeStore(projectRoot: string) {
    return {
        getProjectById(projectId: string): StoreProject | null {
            return projectId === "project-1" ? { currentRoot: projectRoot } : null;
        },
        requireEnabledProjectRoot(projectId: string): string {
            if (projectId !== "project-1") throw new Error("Project not found.");
            return projectRoot;
        },
        getSessionById(_runwieldSessionId: string): StoreSession | null {
            return null;
        },
        inspectSessionActivation(_runwieldSessionId: string) {
            return {};
        },
        listSessionTranscriptSegments(_runwieldSessionId: string) {
            return [];
        },
    };
}

async function readIfExists(path: string) {
    try {
        return await fsReadFile(path, "utf8");
    } catch {
        return "";
    }
}

test("Workspace progress does not infer publication from a remote or tracking ref without saved proof", async () => {
    const projectRoot = await publicationFixture.checkout();
    const remoteRoot = await fsMkdtemp(join(tmpdir(), "workspace-progress-upstream-"));
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        const originalHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["switch", "-c", "candidate"]);
        await fsWriteFile(`${projectRoot}/README.md`, "Published wording\n");
        await git(projectRoot, ["commit", "-am", "Update wording"]);
        const candidate = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["switch", "main"]);
        await savePlan(projectRoot, "wording", "# Wording", {
            planId: "wording-id",
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            validatedAt: "2026-09-10T20:00:00.000Z",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: candidate,
                targetBranch: "main",
                targetHeadBeforeMerge: originalHead,
            },
        });
        const options = { projectId: "project-1", planId: "wording-id" };
        const before = await loadOwnerPlanProgress(makeStore(projectRoot), options);
        assertEquals(before.overall.settled, false);
        const planPath = `${projectRoot}/docs/plans/wording.md`;
        const originalPlan = await fsReadFile(planPath, "utf8");
        await git(projectRoot, ["push", "origin", "candidate:main"]);

        const after = await loadOwnerPlanProgress(makeStore(projectRoot), options);
        assertEquals(after.overall.state, before.overall.state);
        assertEquals(after.overall.settled, false);
        assertEquals(after.plan.status, "ready_for_work");
        // Even a refreshed local ref cannot establish fresh remote publication proof.
        await git(projectRoot, ["fetch", "origin"]);
        assertEquals((await loadOwnerPlanProgress(makeStore(projectRoot), options)).overall.settled, false);
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), originalHead);
        assertEquals(await fsReadFile(`${projectRoot}/README.md`, "utf8"), "Before publication\n");
        assertEquals(await fsReadFile(planPath, "utf8"), originalPlan);
    } finally {
        await fsRm(projectRoot, { recursive: true });
        await fsRm(remoteRoot, { recursive: true });
    }
});

test("Workspace progress accepts a Session whose workflow stores the Plan name", async () => {
    await withRuntimeCommandFixture("workspace-progress-session-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        try {
            await savePlan(projectRoot, "readme-wording", "# README wording", {
                planId: "readme-plan-id",
                classification: "PLANNED_CHANGE",
                status: "approved",
            });
            let proof = fixture.store.acquireSessionActivation({
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                ownerInstanceId: "progress-fixture",
                ownerProcessKind: "test",
                expectedGeneration: 0,
                phase: "bootstrap",
            });
            await fsWriteFile(
                fixture.transcriptPath,
                JSON.stringify({
                    type: "custom",
                    id: "workflow-context",
                    parentId: "entry-assistant",
                    timestamp: "2026-01-01T00:00:01.000Z",
                    customType: "runwield.workflow_context",
                    data: { planName: "readme-wording", routingIntent: "PLANNED_CHANGE" },
                }) + "\n",
                { flag: "a" },
            );
            proof = fixture.store.changeSessionActivationPhase(proof, "checkpointing");
            fixture.store.publishGenerationAndRelease(proof, {
                generation: 1,
                currentSegmentId: fixture.store.getCurrentSessionSegment(fixture.session.runwieldSessionId).segmentId,
                ...(await readTranscriptEvidence(fixture.transcriptPath)),
            });
            const progress = await loadOwnerPlanProgress(fixture.store, {
                projectId: fixture.project.projectId,
                planId: "readme-plan-id",
                runwieldSessionId: fixture.session.runwieldSessionId,
            });
            assertEquals(progress.ok, true);
            assertEquals(progress.plan.planId, "readme-plan-id");
            assertEquals(progress.session?.projectionState, "ok");
        } finally {
            await fixture.cleanup();
        }
    });
});

test("Workspace progress uses the authoritative execution Plan and never mutates workflow state", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-progress-"));
    const projectRoot = `${dir}/project`;
    const worktreeRoot = `${dir}/worktree`;
    await fsRename(await publicationFixture.checkout(), projectRoot);
    await git(projectRoot, ["worktree", "add", "-b", "runwield/progress", worktreeRoot]);
    await savePlan(projectRoot, "feature-a", "# Feature A\n\nPrimary copy", {
        planId: "feature-a-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Feature A",
        status: "in_progress",
        executionAgent: "frontend-engineer",
    });
    await savePlan(worktreeRoot, "feature-a", "# Feature A\n\nExecution copy", {
        planId: "feature-a-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Feature A",
        status: "implemented",
        validationPhase: "semantic",
        executionAgent: "frontend-engineer",
        validationCheckpoint: makeValidationCheckpoint({
            attemptId: "attempt-1",
            generation: "generation-1",
            status: "implemented",
            phase: "semantic",
            state: "awaiting_repair",
        }),
    });
    await addEntry(projectRoot, {
        id: "attempt-1",
        planName: "feature-a",
        planId: "feature-a-id",
        baseBranch: "main",
        baseRef: "main",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        branch: "runwield/feature-a",
        path: worktreeRoot,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
    });
    const { writeControllerState } = await import("../../shared/workflow/controller-registry.ts");
    await writeControllerState(
        projectRoot,
        { planName: "feature-a", planId: "feature-a-id" },
        {
            validationPhase: "semantic",
            validationCheckpoint: makeValidationCheckpoint({
                attemptId: "attempt-1",
                generation: "generation-1",
                status: "implemented",
                phase: "semantic",
                state: "awaiting_repair",
            }),
        },
    );
    const primaryPath = `${projectRoot}/docs/plans/feature-a.md`;
    const worktreePath = `${worktreeRoot}/docs/plans/feature-a.md`;
    const registryPath = getWorktreeRegistryPath(projectRoot);
    const before = {
        primary: await readIfExists(primaryPath),
        worktree: await readIfExists(worktreePath),
        registry: await readIfExists(registryPath),
    };
    try {
        const progress = await loadOwnerPlanProgress(makeStore(projectRoot), {
            projectId: "project-1",
            planId: "feature-a-id",
        });
        assertEquals(progress.plan.status, "implemented");
        assertEquals(progress.stages.find((stage) => stage.id === "execution")?.state, "passed");
        assertEquals(progress.stages.find((stage) => stage.id === "mechanical")?.state, "passed");
        assertEquals(progress.stages.find((stage) => stage.id === "semantic")?.state, "needs_attention");
        assertEquals(progress.stages.find((stage) => stage.id === "mechanical")?.state, "passed");
        assertEquals(
            progress.progressFacts.some((fact) => fact.kind === "validation_checkpoint" && fact.phase === "semantic"),
            true,
        );
        assertEquals(progress.readOnly, true);
        const serialized = JSON.stringify(progress);
        assertEquals(serialized.includes(dir), false);
        assertEquals(serialized.includes(worktreeRoot), false);
        assertEquals(serialized.includes("attempt-1"), false);
        assertStringIncludes(serialized, "AI review");
        assertStringIncludes(serialized, "Verification Command");
        assertEquals(serialized.includes("Semantic Code Review"), false);
        assertEquals(serialized.includes("Mechanical Validation"), false);
        assertEquals(await readIfExists(primaryPath), before.primary);
        assertEquals(await readIfExists(worktreePath), before.worktree);
        assertEquals(await readIfExists(registryPath), before.registry);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("Workspace progress shows publication states without treating reviewed work as complete", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-progress-publication-"));
    const projectRoot = `${dir}/project`;
    const worktreeRoot = `${dir}/worktree`;
    await fsRename(await publicationFixture.checkout(), projectRoot);
    await git(projectRoot, ["worktree", "add", "-b", "runwield/progress", worktreeRoot]);
    await savePlan(projectRoot, "feature-b", "# Feature B\n\nBody", {
        planId: "feature-b-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Feature B",
        status: "reviewed",
    });
    await savePlan(worktreeRoot, "feature-b", "# Feature B\n\nBody", {
        planId: "feature-b-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Feature B",
        status: "reviewed",
    });
    const publication = recordPublicationFailure(
        createPublicationAttempt({
            attemptId: "attempt-b",
            planId: "feature-b-id",
            planName: "feature-b",
            targetBranch: "main",
            executionBranch: "runwield/feature-b",
            executionCwd: worktreeRoot,
            publicationRoot: `${dir}/publication`,
            validatedCommit: "0123456789abcdef0123456789abcdef01234567",
            targetHeadAtSeal: "fedcba9876543210fedcba9876543210fedcba98",
            now: "2026-01-01T00:00:00.000Z",
        }),
        {
            kind: "remote_unavailable",
            message: "Remote unavailable.",
            recordedAt: "2026-01-01T00:00:01.000Z",
        },
        "2026-01-01T00:00:01.000Z",
    );
    await addEntry(projectRoot, {
        id: "attempt-b",
        planName: "feature-b",
        planId: "feature-b-id",
        baseBranch: "main",
        baseRef: "main",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        branch: "runwield/feature-b",
        path: worktreeRoot,
        status: "validated",
        publication,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
    });
    try {
        const progress = await loadOwnerPlanProgress(makeStore(projectRoot), {
            projectId: "project-1",
            planId: "feature-b-id",
        });
        assertEquals(progress.overall.state, "needs_attention");
        assertEquals(progress.stages.find((stage) => stage.id === "delivery")?.state, "needs_attention");
        assertEquals(progress.stages.find((stage) => stage.id === "completion")?.state, "pending");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("Workspace progress retains saved publication proof after cleanup and invalidates it on reopen and execution", async () => {
    const projectRoot = await publicationFixture.checkout();
    try {
        const { writeControllerState } = await import("../../shared/workflow/controller-registry.ts");
        const { recordPlanEvent } = await import("../../shared/workflow/plan-lifecycle.js");
        await savePlan(projectRoot, "receipt", "# Saved publication", {
            planId: "receipt-id",
            classification: "PLANNED_CHANGE",
            status: "reviewed",
        });
        await writeControllerState(
            projectRoot,
            { planId: "receipt-id", planName: "receipt" },
            {
                publicationReceipt: {
                    validatedCommit: "a".repeat(40),
                    publishedCommit: "b".repeat(40),
                    targetBranch: "main",
                },
            },
        );
        // No registry, remote, or tracking ref is needed to retain already-recorded proof.
        const before = await fsReadFile(`${projectRoot}/docs/plans/receipt.md`, "utf8");
        const options = { projectId: "project-1", planId: "receipt-id" };
        for (let repeat = 0; repeat < 2; repeat++) {
            const progress = await loadOwnerPlanProgress(makeStore(projectRoot), options);
            assertEquals(progress.overall.state, "completed");
            assertEquals(progress.plan.status, "verified");
        }
        assertEquals(await fsReadFile(`${projectRoot}/docs/plans/receipt.md`, "utf8"), before);
        await recordPlanEvent({
            cwd: projectRoot,
            planName: "receipt",
            event: "review_reopened",
            currentStatus: "verified",
        });
        const reopened = await loadOwnerPlanProgress(makeStore(projectRoot), options);
        assertEquals(reopened.overall.settled, false);
        assertEquals(reopened.plan.status, "draft");
        await recordPlanEvent({
            cwd: projectRoot,
            planName: "receipt",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: projectRoot,
            planName: "receipt",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        await recordPlanEvent({
            cwd: projectRoot,
            planName: "receipt",
            event: "execution_started",
            currentStatus: "ready_for_work",
            details: { nonGitInPlace: true },
        });
        const execution = await loadOwnerPlanProgress(makeStore(projectRoot), options);
        assertEquals(execution.plan.status, "in_progress");
        assertEquals(execution.overall.settled, false);
        const { findPlanById } = await import("../../plan-store.js");
        assertEquals((await findPlanById(projectRoot, "receipt-id")).attrs.publicationReceipt ?? null, null);
    } finally {
        await fsRm(projectRoot, { recursive: true, force: true });
    }
});

test("raw verified status without publication proof stays unconfirmed and unsettled", async () => {
    const projectRoot = await publicationFixture.checkout();
    try {
        const commit = await git(projectRoot, ["rev-parse", "HEAD"]);
        await savePlan(projectRoot, "unconfirmed", "# Unconfirmed", {
            planId: "unconfirmed-id",
            status: "verified",
            targetBranch: "main",
            deliveryEvidence: {
                version: 1,
                mode: "worktree_merge",
                executionCommit: commit,
                targetBranch: "main",
                targetHeadBeforeMerge: commit,
            },
        });
        const progress = await loadOwnerPlanProgress(makeStore(projectRoot), {
            projectId: "project-1",
            planId: "unconfirmed-id",
        });
        assertEquals(progress.overall.state, "delivering");
        assertEquals(progress.plan.status, "reviewed");
        assertEquals(
            parsePlanFrontMatter(await fsReadFile(`${projectRoot}/docs/plans/unconfirmed.md`, "utf8")).attrs.status,
            "verified",
        );
        assertEquals(progress.overall.settled, false);
        assertStringIncludes(progress.overall.detail, "Publication is unconfirmed");
        assertEquals(
            progress.stages.some((item) => item.id === "completion" && item.state === "completed"),
            false,
        );
    } finally {
        await fsRm(projectRoot, { recursive: true, force: true });
    }
});
