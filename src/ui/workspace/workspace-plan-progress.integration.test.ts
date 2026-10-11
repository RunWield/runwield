// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { savePlan } from "../../plan-store.js";
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
        return await Deno.readTextFile(path);
    } catch {
        return "";
    }
}

Deno.test("Workspace progress recognizes publication with an unchanged local checkout and no worktree", async () => {
    const projectRoot = await publicationFixture.checkout();
    const remoteRoot = await Deno.makeTempDir({ prefix: "workspace-progress-upstream-" });
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);
        const originalHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["switch", "-c", "candidate"]);
        await Deno.writeTextFile(`${projectRoot}/README.md`, "Published wording\n");
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
        const originalPlan = await Deno.readTextFile(planPath);
        await git(projectRoot, ["push", "origin", "candidate:main"]);

        const after = await loadOwnerPlanProgress(makeStore(projectRoot), options);
        assertEquals(after.overall.state, "completed");
        assertEquals(after.overall.settled, true);
        assertEquals(after.plan.status, "verified");
        assertEquals(after.stages.find((stage) => stage.id === "delivery")?.state, "completed");
        assertEquals(after.stages.find((stage) => stage.id === "mechanical")?.state, "passed");
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), originalHead);
        assertEquals(await Deno.readTextFile(`${projectRoot}/README.md`), "Before publication\n");
        assertEquals(await Deno.readTextFile(planPath), originalPlan);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(remoteRoot, { recursive: true });
    }
});

Deno.test("Workspace progress accepts a Session whose workflow stores the Plan name", async () => {
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
            await Deno.writeTextFile(
                fixture.transcriptPath,
                JSON.stringify({
                    type: "custom",
                    id: "workflow-context",
                    parentId: "entry-assistant",
                    timestamp: "2026-01-01T00:00:01.000Z",
                    customType: "runwield.workflow_context",
                    data: { planName: "readme-wording", routingIntent: "PLANNED_CHANGE" },
                }) + "\n",
                { append: true },
            );
            proof = fixture.store.changeSessionActivationPhase(proof, "checkpointing");
            fixture.store.publishGenerationAndRelease(proof, {
                generation: 1,
                currentSegmentId: fixture.store.getCurrentSessionSegment(fixture.session.runwieldSessionId).segmentId,
                ...await readTranscriptEvidence(fixture.transcriptPath),
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

Deno.test("Workspace progress uses the authoritative execution Plan and never mutates workflow state", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-progress-" });
    const projectRoot = `${dir}/project`;
    const worktreeRoot = `${dir}/worktree`;
    await Deno.mkdir(projectRoot);
    await Deno.mkdir(worktreeRoot);
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
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Workspace progress shows publication states without treating reviewed work as complete", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-progress-publication-" });
    const projectRoot = `${dir}/project`;
    const worktreeRoot = `${dir}/worktree`;
    await Deno.mkdir(projectRoot);
    await Deno.mkdir(worktreeRoot);
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
        await Deno.remove(dir, { recursive: true });
    }
});
