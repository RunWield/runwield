import { seedPlan } from "../../testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../../testing/retained-plan-fixture.ts";
import { readdir as fsReaddir, rmdir as fsRmdir } from "node:fs/promises";
import { readFile as fsReadFile } from "node:fs/promises";
import {
    writeFile as fsWriteFile,
    mkdir as fsMkdir,
    rename as fsRename,
    rm as fsRm,
    mkdtemp as fsMkdtemp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeFrontMatterText } from "@runwield/plans/format";

import { publishExecutionWorktreeIsolated } from "../../isolated-publication.ts";
import { defineGitFixture, git } from "../../git-test-fixture.ts";
import { addEntry, updatePublication } from "../../worktree-registry.ts";
import { advancePublicationAttempt, type PublicationAttempt } from "@runwield/workflow/publication";
import { openPublication } from "@runwield/workflow/publication-runtime";

const repository = defineGitFixture((root) =>
    withRetainedPlanFixture(root, async () => {
        await fsWriteFile(join(root, ".git", "info", "exclude"), "\n.wld/settings.json\n", { flag: "a" });
        await seedPlan(root, "demo", "# Demo\n", {
            planId: "plan-demo",
            classification: "PLANNED_CHANGE",
            status: "implemented",
            humanReviewMode: "none",
        });
        await git(root, ["add", "."]);
        await git(root, ["commit", "-m", "Plan"]);
    }),
);

export async function makePublicationOutcomeFixture(projectRoot: string, remote = false) {
    const copy = await repository.checkout();
    async function moveContents(source: string, target: string): Promise<void> {
        await fsMkdir(target, { recursive: true });
        for await (const entry of await fsReaddir(source, { withFileTypes: true })) {
            if (entry.isDirectory()) await moveContents(join(source, entry.name), join(target, entry.name));
            else await fsRename(join(source, entry.name), join(target, entry.name));
        }
        await fsRmdir(source);
    }
    await moveContents(copy, projectRoot);
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "outcome-worktree-"));
    const executionCwd = join(worktreeRoot, "execution");
    const baseCommit = await git(projectRoot, ["rev-parse", "HEAD"]);
    if (remote) {
        const upstream = join(worktreeRoot, "remote.git");
        await git(projectRoot, ["clone", "--bare", ".", upstream]);
        await git(projectRoot, ["remote", "add", "origin", upstream]);
    }
    await git(projectRoot, ["worktree", "add", "-b", "worktree/demo", executionCwd]);
    await addEntry(projectRoot, {
        id: "attempt-demo",
        planId: "plan-demo",
        planName: "demo",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit,
        branch: "worktree/demo",
        path: executionCwd,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    return {
        executionCwd,
        async confirm() {
            const validatedCommit = await git(executionCwd, ["rev-parse", "HEAD"]);
            const planPath = join(executionCwd, "docs/plans/demo.md");
            await fsWriteFile(
                planPath,
                mergeFrontMatterText(await fsReadFile(planPath, "utf8"), {
                    status: "reviewed",
                }),
            );
            await fsWriteFile(join(executionCwd, "feature.txt"), "delivered feature\n");
            await git(executionCwd, ["add", "."]);
            await git(executionCwd, ["commit", "-m", "Publication artifacts"]);
            const artifactCommit = await git(executionCwd, ["rev-parse", "HEAD"]);
            let attempt = await openPublication(projectRoot).attempt("attempt-demo").start({
                planName: "demo",
                targetBranch: "main",
                executionBranch: "worktree/demo",
                executionCwd,
                validatedCommit,
                targetHeadAtSeal: baseCommit,
            });
            const planPaths = ["docs/plans/demo.md"];
            attempt = await openPublication(projectRoot).resume(attempt).advance("artifacts_committed", {
                artifactCommit,
                planPaths,
            });
            await publishExecutionWorktreeIsolated({
                projectRoot,
                executionCwd,
                executionBranch: attempt.executionBranch,
                targetBranch: attempt.targetBranch,
                planName: attempt.planName,
                sealedExecutionCommit: artifactCommit,
                allowedPlanPaths: planPaths,
                publicationRoot: attempt.publicationRoot,
                onIntegrated: async (evidence) => {
                    attempt = await openPublication(projectRoot).resume(attempt).advance("target_integrated", evidence);
                },
                onPublished: async (evidence) => {
                    attempt = await openPublication(projectRoot).resume(attempt).advance("target_published", evidence);
                },
                onVerified: async () => {
                    attempt = await openPublication(projectRoot).resume(attempt).verify();
                },
            });
            return attempt;
        },
        async interruptAfterCleanup(attempt: PublicationAttempt) {
            await git(projectRoot, ["worktree", "remove", executionCwd]);
            await git(projectRoot, ["branch", "-D", attempt.executionBranch]);
            await fsRm(attempt.publicationRoot, { recursive: true, force: true });
            const completed = advancePublicationAttempt(attempt, "cleanup_complete", {
                cleanedAt: new Date().toISOString(),
            });
            await updatePublication(projectRoot, attempt.attemptId, attempt, completed);
            return completed;
        },
        async dispose() {
            await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        },
    };
}
