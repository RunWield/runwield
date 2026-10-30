import { test } from "node:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { savePlan } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { publishExecutionWorktreeIsolated } from "../isolated-publication.ts";
import { createTestWorktreeAttempt } from "../worktree-test-helpers.ts";
import {
    advanceStoredPublication,
    loadPublicationAttempt,
    reconcileStoredPublication,
    startPublicationAttempt,
} from "./publication-machine.ts";

const planId = "11111111-1111-4111-8111-111111111111";
const planPath = "docs/plans/demo.md";
const repository = defineGitFixture(async (root) => {
    await savePlan(root, "demo", "# Reviewed proposal\n", {
        planId,
        classification: "PLANNED_CHANGE",
        status: "reviewed",
    });
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Reviewed Plan"]);
});

async function deliveredAttempt(root: string, savePublishedReceipt = true) {
    const remote = join(root, ".git", "authority-remote.git");
    await git(root, ["clone", "--bare", ".", remote]);
    await git(root, ["remote", "add", "origin", remote]);
    const base = await git(root, ["rev-parse", "HEAD"]);
    const entry = await createTestWorktreeAttempt({
        projectRoot: root,
        worktreeRoot: join(root, ".git", "authority-worktrees"),
        planName: "demo",
        planId,
    });
    await writeFile(join(entry.path, "implementation.md"), "delivered proposal\n");
    await git(entry.path, ["add", "implementation.md"]);
    await git(entry.path, ["commit", "-m", "validated proposal and artifacts"]);
    const artifactCommit = await git(entry.path, ["rev-parse", "HEAD"]);
    let attempt = await startPublicationAttempt({
        projectRoot: root,
        attemptId: entry.id,
        planName: "demo",
        targetBranch: "main",
        executionBranch: entry.branch,
        executionCwd: entry.path,
        validatedCommit: artifactCommit,
        targetHeadAtSeal: base,
    });
    attempt = await advanceStoredPublication(root, attempt, "artifacts_committed", {
        artifactCommit,
        planPaths: [planPath],
    });
    const delivered = await publishExecutionWorktreeIsolated({
        projectRoot: root,
        executionCwd: entry.path,
        executionBranch: entry.branch,
        targetBranch: "main",
        planName: "demo",
        sealedExecutionCommit: artifactCommit,
        allowedPlanPaths: [planPath],
        publicationRoot: attempt.publicationRoot,
        onIntegrated: async (evidence) => {
            attempt = await advanceStoredPublication(root, attempt, "target_integrated", evidence);
        },
        onPublished: savePublishedReceipt
            ? async (evidence) => {
                  attempt = await advanceStoredPublication(root, attempt, "target_published", evidence);
              }
            : undefined,
    });
    return { attempt, commit: delivered.publicationCommit };
}

test("retained remote publication verifies its saved authority when current branch policy is broken", async () => {
    const root = await repository.checkout();
    try {
        const { attempt, commit } = await deliveredAttempt(root);
        assertEquals(attempt.phase, "target_published");
        await git(root, ["config", "branch.main.remote", "missing"]);
        const refs = await git(root, ["show-ref"]);
        const index = await git(root, ["ls-files", "--stage"]);
        const verified = await reconcileStoredPublication(root, attempt);
        assertEquals(verified.phase, "publication_verified");
        assertEquals(verified.upstreamRemote, "origin");
        assertEquals(verified.publishedCommit, commit);
        assertEquals((await loadPublicationAttempt(root, attempt.attemptId))?.phase, "publication_verified");
        assertEquals(await git(root, ["show-ref"]), refs);
        assertEquals(await git(root, ["ls-files", "--stage"]), index);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("lost saved remote authority cannot be replaced by local target history", async () => {
    const root = await repository.checkout();
    try {
        const { attempt, commit } = await deliveredAttempt(root);
        await git(root, ["fetch", "origin", "main"]);
        await git(root, ["merge", "--ff-only", commit]);
        await git(root, ["remote", "remove", "origin"]);
        await git(root, ["config", "branch.main.remote", "."]);
        assertEquals(await reconcileStoredPublication(root, attempt), attempt);
        assertEquals((await loadPublicationAttempt(root, attempt.attemptId))?.phase, "target_published");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("unpublished integration still requires a valid current publication policy", async () => {
    const root = await repository.checkout();
    try {
        const { attempt } = await deliveredAttempt(root, false);
        assertEquals(attempt.phase, "target_integrated");
        await git(root, ["config", "branch.main.remote", "missing"]);
        await assertRejects(
            () => reconcileStoredPublication(root, attempt),
            Error,
            "Publication remote missing is unavailable",
        );
        assertEquals((await loadPublicationAttempt(root, attempt.attemptId))?.phase, "target_integrated");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
