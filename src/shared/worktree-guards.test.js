import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";

import { loadPlan, savePlan } from "../plan-store.js";

/**
 * @param {string} cwd
 * @param {string} planName
 * @param {string} content
 * @param {import('../plan-store.js').PlanFrontMatterInput} attrs
 */
async function savePlanForTest(cwd, planName, content, attrs) {
    const existing = await loadPlan(cwd, planName).catch(() => null);
    return await savePlan(cwd, planName, content, attrs, existing ? { expectedRevision: existing.revision } : {});
}
import { GitRepositoryRequiredError } from "./git.ts";

import {
    checkpointExecutionPreparation,
    checkpointExecutionWorktree,
    deleteMergedWorktreeBranch,
    deleteRemotelyPublishedWorktreeBranch,
    discardWorktreeGitArtifacts,
    hasExecutionChangesSince,
    hasOnlyExecutionPreparationChangesSince,
    mergeExecutionWorktree,
    prepareTargetBranchRef,
    removeWorktreeGitArtifacts,
    validateWorktreeDiscard,
} from "./worktree.js";

import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";

Deno.test("worktree helpers report Git requirement outside Git", async () => {
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-non-git-worktree-" });
    try {
        await assertRejects(
            () =>
                createTestWorktreeAttempt({
                    projectRoot,
                    planName: "Non Git Plan",
                }),
            GitRepositoryRequiredError,
            "Creating an execution worktree requires a Git repository",
        );
        await assertRejects(
            () => prepareTargetBranchRef(projectRoot, "main"),
            GitRepositoryRequiredError,
            "Preparing an execution target branch requires a Git repository",
        );
        await assertRejects(
            () => mergeExecutionWorktree({ projectRoot, branch: "runwield/worktree/non-git" }),
            GitRepositoryRequiredError,
            "Merging an execution worktree requires a Git repository",
        );
        await assertRejects(
            () =>
                removeWorktreeGitArtifacts({
                    projectRoot,
                    path: `${projectRoot}/missing`,
                }),
            GitRepositoryRequiredError,
            "Removing an execution worktree requires a Git repository",
        );
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
    }
});

Deno.test("mergeExecutionWorktree rejects post-seal implementation edits outside finalized Plan paths", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await savePlanForTest(projectRoot, "feature", "# Feature", { status: "ready_for_work" });
        await git(projectRoot, ["add", "docs/plans/feature.md"]);
        await git(projectRoot, ["commit", "-m", "add feature plan"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Feature",
            worktreeRoot,
        });
        const activeWorktree = worktree;
        await Deno.writeTextFile(`${activeWorktree.path}/feature.txt`, "validated\n");
        const sealed = await checkpointExecutionWorktree({
            worktreePath: activeWorktree.path,
            branch: activeWorktree.branch,
            planName: "feature",
        });
        await savePlanForTest(activeWorktree.path, "feature", "# Feature", { status: "verified" });
        await Deno.writeTextFile(`${activeWorktree.path}/post-seal.txt`, "late edit\n");

        await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch: activeWorktree.branch,
                    targetBranch: "main",
                    worktreePath: activeWorktree.path,
                    preservePlanPaths: ["docs/plans/feature.md"],
                    sealedExecutionCommit: sealed.executionCommit,
                    planName: "feature",
                }),
            Error,
            "changed after candidate sealing outside finalized Plan paths",
        );
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("execution preparation retry still rejects branches containing implementation commits", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Prepared retry",
            worktreeRoot,
        });
        const activeWorktree = worktree;
        await savePlanForTest(activeWorktree.path, "prepared-retry", "# Prepared retry", {
            status: "ready_for_work",
        });
        await Deno.writeTextFile(`${activeWorktree.path}/unexpected.txt`, "Preserve unrelated work\n");
        await assertRejects(
            () =>
                checkpointExecutionPreparation({
                    worktreePath: activeWorktree.path,
                    branch: activeWorktree.branch,
                    baseCommit: activeWorktree.baseCommit,
                    planName: "prepared-retry",
                    planRelativePath: "docs/plans/prepared-retry.md",
                }),
            Error,
            "Execution worktree contains changes outside preparation Plan paths:\n  - unexpected.txt",
        );
        assertEquals(await Deno.readTextFile(`${activeWorktree.path}/unexpected.txt`), "Preserve unrelated work\n");
        assertEquals(await git(activeWorktree.path, ["rev-parse", "HEAD"]), activeWorktree.baseCommit);
        await Deno.remove(`${activeWorktree.path}/unexpected.txt`);
        await checkpointExecutionPreparation({
            worktreePath: activeWorktree.path,
            branch: activeWorktree.branch,
            baseCommit: activeWorktree.baseCommit,
            planName: "prepared-retry",
            planRelativePath: "docs/plans/prepared-retry.md",
        });
        await Deno.writeTextFile(`${activeWorktree.path}/implementation.txt`, "Agent work\n");
        await git(activeWorktree.path, ["add", "implementation.txt"]);
        await git(activeWorktree.path, ["commit", "-m", "Implement feature"]);

        await assertRejects(
            () =>
                checkpointExecutionPreparation({
                    worktreePath: activeWorktree.path,
                    branch: activeWorktree.branch,
                    baseCommit: activeWorktree.baseCommit,
                    planName: "prepared-retry",
                    planRelativePath: "docs/plans/prepared-retry.md",
                }),
            Error,
            "branch",
        );
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            }).catch(() => {});
        }
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("deleteMergedWorktreeBranch deletes a merged branch and keeps an unmerged one", async () => {
    // Real Git on purpose. This is the most destructive operation in the system and it
    // has no injection seam by design, so the only honest proof is running it. A fake
    // here would assert our assumption about `branch --merged`, not Git's answer.
    const projectRoot = await Deno.makeTempDir({ prefix: "runwield-branch-delete-" });
    try {
        await git(projectRoot, ["init", "-b", "main"]);
        await git(projectRoot, ["config", "user.email", "tests@example.com"]);
        await git(projectRoot, ["config", "user.name", "RunWield Tests"]);
        await Deno.writeTextFile(`${projectRoot}/file.txt`, "base\n");
        await git(projectRoot, ["add", "."]);
        await git(projectRoot, ["commit", "-m", "base"]);

        // Merged: branched and merged back, so nothing is lost by deleting it.
        await git(projectRoot, ["checkout", "-b", "runwield/worktree/merged"]);
        await Deno.writeTextFile(`${projectRoot}/file.txt`, "merged work\n");
        await git(projectRoot, ["commit", "-am", "merged work"]);
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["merge", "--no-ff", "--no-edit", "runwield/worktree/merged"]);

        const merged = await deleteMergedWorktreeBranch({ projectRoot, branch: "runwield/worktree/merged" });
        assertEquals(merged.deleted, true);
        assertStringIncludes(merged.reason, "deleted");
        assertEquals(
            (await git(projectRoot, ["branch", "--list", "runwield/worktree/merged"])).trim(),
            "",
            "a proven-merged branch is gone",
        );

        // Unmerged: holds a commit main has never seen. Deleting it would destroy work.
        await git(projectRoot, ["checkout", "-b", "runwield/worktree/unmerged"]);
        await Deno.writeTextFile(`${projectRoot}/file.txt`, "unmerged work\n");
        await git(projectRoot, ["commit", "-am", "unmerged work"]);
        await git(projectRoot, ["checkout", "main"]);

        // A branch that never moved off its base carries no work, so rollback can clean it
        // up. This is the case that used to leave an orphan branch behind forever.
        const baseCommit = await git(projectRoot, ["rev-parse", "main"]);
        await git(projectRoot, ["branch", "runwield/worktree/untouched", baseCommit]);
        const untouched = await deleteMergedWorktreeBranch({
            projectRoot,
            branch: "runwield/worktree/untouched",
            baseCommit,
        });
        assertEquals(untouched.deleted, true);
        assertStringIncludes(untouched.reason, "carried no work");

        await git(projectRoot, ["checkout", "-b", "runwield/worktree/prepared", baseCommit]);
        await Deno.writeTextFile(`${projectRoot}/prepared-plan.md`, "RunWield preparation\n");
        await git(projectRoot, ["add", "prepared-plan.md"]);
        await git(projectRoot, ["commit", "-m", "Prepare execution"]);
        const ownedPreparationCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["checkout", "main"]);
        const prepared = await deleteMergedWorktreeBranch({
            projectRoot,
            branch: "runwield/worktree/prepared",
            baseCommit,
            ownedPreparationCommit,
        });
        assertEquals(prepared.deleted, true);
        assertStringIncludes(prepared.reason, "preparation commit");

        const kept = await deleteMergedWorktreeBranch({ projectRoot, branch: "runwield/worktree/unmerged" });
        assertEquals(kept.deleted, false);
        assertStringIncludes(kept.reason, "not proven merged");
        assertStringIncludes(
            await git(projectRoot, ["branch", "--list", "runwield/worktree/unmerged"]),
            "runwield/worktree/unmerged",
            "an unproven branch survives, per PR-4",
        );

        // The origin proof must not become a loophole: a branch that moved off its base
        // holds work, even when a stale base commit is offered.
        const stillKept = await deleteMergedWorktreeBranch({
            projectRoot,
            branch: "runwield/worktree/unmerged",
            baseCommit,
        });
        assertEquals(stillKept.deleted, false, "a branch with commits beyond its base survives");

        await git(projectRoot, ["branch", "release/next", "runwield/worktree/unmerged"]);
        const released = await deleteMergedWorktreeBranch({
            projectRoot,
            branch: "runwield/worktree/unmerged",
            targetBranch: "release/next",
        });
        assertEquals(released.deleted, true, "the actual publication target proves the work is safe");
        assertEquals(await git(projectRoot, ["rev-parse", "main"]), baseCommit);
        const targetKept = await deleteMergedWorktreeBranch({
            projectRoot,
            branch: "release/next",
            targetBranch: "release/next",
        });
        assertEquals(targetKept.deleted, false, "cleanup never deletes the publication target itself");
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("remote publication cleanup deletes only empty source-branch commits after the published artifact", async () => {
    const projectRoot = await makeRepo();
    const remoteRoot = await Deno.makeTempDir({ prefix: "runwield-branch-cleanup-remote-" });
    try {
        await git(remoteRoot, ["init", "--bare"]);
        await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
        await git(projectRoot, ["push", "-u", "origin", "main"]);

        await git(projectRoot, ["checkout", "-b", "worktree/published-with-empty-checkpoint"]);
        await Deno.writeTextFile(`${projectRoot}/published.txt`, "published\n");
        await git(projectRoot, ["add", "published.txt"]);
        await git(projectRoot, ["commit", "-m", "Seal publication artifact"]);
        const artifactCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["merge", "--no-ff", "--no-edit", artifactCommit]);
        await git(projectRoot, ["push", "origin", "main"]);
        const publicationCommit = await git(projectRoot, ["rev-parse", "main"]);

        await git(projectRoot, ["checkout", "worktree/published-with-empty-checkpoint"]);
        await git(projectRoot, ["commit", "--allow-empty", "-m", "Redundant publication checkpoint"]);
        await git(projectRoot, ["checkout", "main"]);

        const cleaned = await deleteRemotelyPublishedWorktreeBranch({
            projectRoot,
            branch: "worktree/published-with-empty-checkpoint",
            remote: "origin",
            upstreamBranch: "main",
            publicationCommit,
            artifactCommit,
        });
        assertEquals(cleaned.deleted, true);
        assertEquals(await git(projectRoot, ["branch", "--list", "worktree/published-with-empty-checkpoint"]), "");

        await git(projectRoot, ["branch", "worktree/published-with-new-work", artifactCommit]);
        await git(projectRoot, ["checkout", "worktree/published-with-new-work"]);
        await Deno.writeTextFile(`${projectRoot}/not-published.txt`, "keep me\n");
        await git(projectRoot, ["add", "not-published.txt"]);
        await git(projectRoot, ["commit", "-m", "New work after publication"]);
        await git(projectRoot, ["checkout", "main"]);

        const kept = await deleteRemotelyPublishedWorktreeBranch({
            projectRoot,
            branch: "worktree/published-with-new-work",
            remote: "origin",
            upstreamBranch: "main",
            publicationCommit,
            artifactCommit,
        });
        assertEquals(kept.deleted, false);
        assertStringIncludes(kept.reason, "was kept");
        assertStringIncludes(
            await git(projectRoot, ["branch", "--list", "worktree/published-with-new-work"]),
            "worktree/published-with-new-work",
        );
    } finally {
        await Deno.remove(projectRoot, { recursive: true }).catch(() => {});
        await Deno.remove(remoteRoot, { recursive: true }).catch(() => {});
    }
});

Deno.test("discard blocks primary and reports branch checkout races after directory removal", async () => {
    const projectRoot = await makeRepo();
    const parent = await Deno.makeTempDir();
    try {
        await assertRejects(
            () => validateWorktreeDiscard({ projectRoot, path: projectRoot, branch: "missing" }),
            Error,
            "primary checkout",
        );
        await assertRejects(
            () => removeWorktreeGitArtifacts({ projectRoot, path: projectRoot, force: true }),
            Error,
            "primary checkout",
        );
        const attempt = await createTestWorktreeAttempt({ projectRoot, planName: "discard", worktreeRoot: parent });
        const cleanup = discardWorktreeGitArtifacts({ projectRoot, ...attempt });
        const removed = await cleanup.next();
        assertEquals(removed.value?.status, "path_removed");
        const rescuePath = `${parent}/rescue`;
        await git(projectRoot, ["worktree", "add", rescuePath, attempt.branch]);
        await Deno.writeTextFile(`${rescuePath}/keep.txt`, "keep the new checkout\n");
        const blocked = await cleanup.next();
        assertEquals(blocked.value?.status, "blocked");
        assertEquals(blocked.value?.branchDeleted, false);
        assertEquals(await Deno.readTextFile(`${rescuePath}/keep.txt`), "keep the new checkout\n");
        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(parent, { recursive: true });
    }
});

Deno.test("discard removes a missing linked checkout through its saved symlinked parent", async () => {
    const projectRoot = await makeRepo();
    const parent = await Deno.makeTempDir();
    try {
        const realParent = `${parent}/real`;
        const aliasParent = `${parent}/alias`;
        await Deno.mkdir(realParent);
        await Deno.symlink(realParent, aliasParent);
        const attempt = await createTestWorktreeAttempt({
            projectRoot,
            planName: "missing",
            worktreeRoot: aliasParent,
        });
        await Deno.remove(attempt.path, { recursive: true });
        const results = [];
        for await (const result of discardWorktreeGitArtifacts({ projectRoot, ...attempt })) results.push(result);
        assertEquals(results.at(-1)?.status, "complete");
        assertEquals(await git(projectRoot, ["branch", "--list", attempt.branch]), "");
        assertEquals((await git(projectRoot, ["worktree", "list", "--porcelain"])).includes(attempt.branch), false);
    } finally {
        await Deno.remove(projectRoot, { recursive: true });
        await Deno.remove(parent, { recursive: true });
    }
});

Deno.test("preparation never adopts staged, unstaged, or committed user ignore rules", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await Deno.makeTempDir();
    try {
        const worktree = await createTestWorktreeAttempt({ projectRoot, planName: "Ignore ownership", worktreeRoot });
        const { ensureRunWieldOwnedGitignoreBlock } = await import("./runwield-owned-paths.ts");
        await ensureRunWieldOwnedGitignoreBlock(worktree.path);
        await savePlanForTest(worktree.path, "ignore-ownership", "# Ignore ownership", { status: "ready_for_work" });
        const owned = await Deno.readTextFile(`${worktree.path}/.gitignore`);
        for (const staged of [false, true]) {
            const mixed = owned + "user-only-secret-path/\n";
            await Deno.writeTextFile(`${worktree.path}/.gitignore`, mixed);
            if (staged) {
                await git(worktree.path, ["add", ".gitignore"]);
                // A clean-looking working file must not hide unrelated staged content.
                await Deno.writeTextFile(`${worktree.path}/.gitignore`, owned);
            }
            const indexBefore = await git(worktree.path, ["diff", "--cached"]);
            assertEquals(
                await hasExecutionChangesSince({
                    worktreePath: worktree.path,
                    baseRef: worktree.baseCommit,
                    includeWorkingTree: true,
                }),
                true,
            );
            await assertRejects(
                () =>
                    checkpointExecutionPreparation({
                        worktreePath: worktree.path,
                        branch: worktree.branch,
                        baseCommit: worktree.baseCommit,
                        planName: "ignore-ownership",
                        planRelativePath: "docs/plans/ignore-ownership.md",
                    }),
                Error,
                "outside preparation",
            );
            assertEquals(await git(worktree.path, ["diff", "--cached"]), indexBefore);
            assertEquals(await Deno.readTextFile(`${worktree.path}/.gitignore`), staged ? owned : mixed);
            await git(worktree.path, ["reset", "--", ".gitignore"]);
        }
        await Deno.writeTextFile(`${worktree.path}/.gitignore`, owned);
        await checkpointExecutionPreparation({
            worktreePath: worktree.path,
            branch: worktree.branch,
            baseCommit: worktree.baseCommit,
            planName: "ignore-ownership",
            planRelativePath: "docs/plans/ignore-ownership.md",
        });
        assertEquals(
            await hasOnlyExecutionPreparationChangesSince({
                worktreePath: worktree.path,
                baseRef: worktree.baseCommit,
            }),
            true,
        );
        await Deno.writeTextFile(`${worktree.path}/.gitignore`, owned + "implementation-cache/\n");
        await git(worktree.path, ["add", ".gitignore"]);
        await git(worktree.path, ["commit", "-m", "user ignore change"]);
        assertEquals(
            await hasOnlyExecutionPreparationChangesSince({
                worktreePath: worktree.path,
                baseRef: worktree.baseCommit,
            }),
            false,
        );
        assertEquals(
            await hasExecutionChangesSince({ worktreePath: worktree.path, baseRef: worktree.baseCommit }),
            true,
        );
    } finally {
        await Deno.remove(worktreeRoot, { recursive: true });
        await Deno.remove(projectRoot, { recursive: true });
    }
});
