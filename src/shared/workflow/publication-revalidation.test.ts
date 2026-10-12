import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { createTestWorktreeAttempt } from "../worktree-test-helpers.ts";
import { findById, retirePublicationForRevalidation, updatePublication } from "../worktree-registry.js";
import {
    advanceStoredPublication,
    reconcileStoredPublication,
    startPublicationAttempt,
} from "./publication-machine.ts";
import { preparePublicationRevalidation } from "./publication-revalidation.ts";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import { makeRecordedSession, makeUi, NO_ISOLATED_AGENT_PORT, runValidationPhase } from "./validation-test-helpers.js";

const repository = defineGitFixture(async (root) => {
    await savePlan(root, "rewrite", "# Rewrite recovery\n", {
        planId: "rewrite-plan",
        classification: "PLANNED_CHANGE",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: "approved",
    });
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Plan"]);
});

async function fixture() {
    const projectRoot = await repository.checkout();
    const worktreeRoot = await Deno.makeTempDir({ prefix: "publication-revalidation-" });
    const entry = await createTestWorktreeAttempt({
        projectRoot,
        worktreeRoot,
        planName: "rewrite",
        planId: "rewrite-plan",
    });
    await Deno.writeTextFile(join(entry.path, "feature.txt"), "validated implementation\n");
    await git(entry.path, ["add", "."]);
    await git(entry.path, ["commit", "-m", "Implement"]);
    const validatedCommit = await git(entry.path, ["rev-parse", "HEAD"]);
    const plan = await loadPlan(entry.path, entry.planName);
    assert(plan);
    await updatePlanFrontMatter(
        entry.path,
        entry.planName,
        {
            status: "validated",
            validatedCommit,
            targetBranch: "main",
        },
        {},
        { expectedRevision: plan.revision },
    );
    await git(entry.path, ["add", "."]);
    await git(entry.path, ["commit", "-m", "Artifacts"]);
    const artifactCommit = await git(entry.path, ["rev-parse", "HEAD"]);
    const started = await startPublicationAttempt({
        projectRoot,
        attemptId: entry.id,
        planName: entry.planName,
        targetBranch: "main",
        executionBranch: entry.branch,
        executionCwd: entry.path,
        validatedCommit,
        targetHeadAtSeal: entry.baseCommit,
    });
    const attempt = await advanceStoredPublication(projectRoot, started, "artifacts_committed", {
        artifactCommit,
        planPaths: ["docs/plans/rewrite.md"],
    });
    await Deno.mkdir(attempt.publicationRoot, { recursive: true });
    await Deno.writeTextFile(join(attempt.publicationRoot, "repair.txt"), "preserve unfinished repair\n");
    return {
        projectRoot,
        entry,
        attempt,
        async rewrite() {
            await git(entry.path, ["commit", "--amend", "-m", "Rewritten artifacts"]);
        },
        async cleanup() {
            await Deno.remove(worktreeRoot, { recursive: true });
            await Deno.remove(projectRoot, { recursive: true });
        },
    };
}

Deno.test("rewritten publication preserves files and starts fresh validation instead of repeating stale delivery", async () => {
    const f = await fixture();
    try {
        await f.rewrite();
        await Deno.writeTextFile(join(f.entry.path, ".gitignore"), "new-rule\n");
        await git(f.entry.path, ["add", ".gitignore"]);
        await git(f.entry.path, ["commit", "-m", "Ignore policy"]);
        await Deno.writeTextFile(join(f.entry.path, "staged.txt"), "staged work\n");
        await git(f.entry.path, ["add", "staged.txt"]);
        await Deno.writeTextFile(join(f.entry.path, "untracked.txt"), "untracked work\n");
        const head = await git(f.entry.path, ["rev-parse", "HEAD"]);
        const index = await git(f.entry.path, ["diff", "--cached"]);
        const target = await git(f.projectRoot, ["rev-parse", "main"]);
        const archive = await preparePublicationRevalidation(f.projectRoot, f.entry.planName);
        assert(archive);
        assertEquals(await git(f.entry.path, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(f.entry.path, ["diff", "--cached"]), index);
        assertEquals(await git(f.projectRoot, ["rev-parse", "main"]), target);
        assertEquals(await Deno.readTextFile(join(f.entry.path, "untracked.txt")), "untracked work\n");
        assertEquals(await Deno.readTextFile(join(archive, "checkout/repair.txt")), "preserve unfinished repair\n");
        assertStringIncludes(await Deno.readTextFile(join(archive, "publication.json")), f.attempt.artifactCommit!);
        const plan = await loadPlan(f.entry.path, f.entry.planName);
        assertEquals(plan?.attrs.status, "implemented");
        assertEquals(plan?.attrs.validatedCommit, undefined);
        assertEquals(plan?.attrs.humanReviewDecision, null);
        assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, undefined);
        assertEquals(await preparePublicationRevalidation(f.projectRoot, f.entry.planName), null);
    } finally {
        await f.cleanup();
    }
});

Deno.test("unchanged publication and harmless empty commits keep their validation", async () => {
    const f = await fixture();
    try {
        await git(f.entry.path, ["commit", "--allow-empty", "-m", "Empty"]);
        assertEquals(await preparePublicationRevalidation(f.projectRoot, f.entry.planName), null);
        assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, f.attempt);
    } finally {
        await f.cleanup();
    }
});

Deno.test({
    name: "publication recovery uses one Plan lock spelling for aliased execution paths",
    ignore: Deno.build.os === "windows", // Directory symlinks require host privileges on Windows.
    fn: async () => {
        const f = await fixture();
        try {
            const parentAlias = join(dirname(f.entry.path), "parent-alias");
            await Deno.symlink(dirname(f.entry.path), parentAlias, { type: "dir" });
            const alias = join(parentAlias, basename(f.entry.path));
            const attempt = { ...f.attempt, executionCwd: alias, revision: f.attempt.revision + 1 };
            await updatePublication(f.projectRoot, f.entry.id, f.attempt.revision, attempt);
            assertEquals(await preparePublicationRevalidation(f.projectRoot, f.entry.planName), null);
            assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, attempt);
            await Deno.writeTextFile(join(alias, "feature.txt"), "changed implementation\n");
            assert(await preparePublicationRevalidation(f.projectRoot, f.entry.planName));
            assertEquals((await loadPlan(alias, f.entry.planName))?.attrs.status, "implemented");
        } finally {
            await f.cleanup();
        }
    },
});

Deno.test("publication recovery also handles pruned pre-rewrite commits", async () => {
    const f = await fixture();
    try {
        await f.rewrite();
        // The fixture must remove even entries written in the current clock second.
        await git(f.projectRoot, ["reflog", "expire", "--expire=all", "--expire-unreachable=all", "--all"]);
        await git(f.projectRoot, ["gc", "--prune=now"]);
        await assertRejects(() => git(f.projectRoot, ["cat-file", "-e", f.attempt.artifactCommit!]));
        assert(await preparePublicationRevalidation(f.projectRoot, f.entry.planName));
        assertEquals((await loadPlan(f.entry.path, f.entry.planName))?.attrs.status, "implemented");
    } finally {
        await f.cleanup();
    }
});

for (const boundary of ["intent", "preserved_checkout", "plan_reset"]) {
    Deno.test(`fresh process resumes publication revalidation after ${boundary}`, async () => {
        const f = await fixture();
        try {
            await f.rewrite();
            const attempt = {
                ...f.attempt,
                revision: f.attempt.revision + 1,
                revalidation: {
                    sourceHead: await git(f.entry.path, ["rev-parse", "HEAD"]),
                    archiveRoot: `${f.attempt.publicationRoot}.saved-test`,
                },
            };
            await updatePublication(f.projectRoot, f.entry.id, f.attempt.revision, attempt);
            assertEquals(await reconcileStoredPublication(f.projectRoot, attempt), attempt);
            await assertRejects(() =>
                advanceStoredPublication(f.projectRoot, attempt, "target_integrated", {
                    targetBaseCommit: f.entry.baseCommit,
                    integrationCommit: f.attempt.artifactCommit,
                })
            );
            if (boundary !== "intent") {
                await Deno.mkdir(attempt.revalidation.archiveRoot);
                await Deno.writeTextFile(
                    join(attempt.revalidation.archiveRoot, "publication.json"),
                    `${JSON.stringify(attempt, null, 2)}\n`,
                );
                await Deno.rename(attempt.publicationRoot, join(attempt.revalidation.archiveRoot, "checkout"));
            }
            if (boundary === "plan_reset") {
                const plan = await loadPlan(f.entry.path, f.entry.planName);
                assert(plan);
                await updatePlanFrontMatter(f.entry.path, f.entry.planName, { status: "implemented" }, {}, {
                    expectedRevision: plan.revision,
                });
            }
            const moduleUrl = new URL("./publication-revalidation.ts", import.meta.url).href;
            const output = await new Deno.Command(Deno.execPath(), {
                args: [
                    "eval",
                    `import {preparePublicationRevalidation} from ${
                        JSON.stringify(moduleUrl)
                    }; await preparePublicationRevalidation(Deno.args[0], Deno.args[1]);`,
                    f.projectRoot,
                    f.entry.planName,
                ],
                stdout: "piped",
                stderr: "piped",
            }).output();
            assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
            assertEquals((await loadPlan(f.entry.path, f.entry.planName))?.attrs.status, "implemented");
            assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, undefined);
            assertEquals(
                await Deno.readTextFile(join(attempt.revalidation.archiveRoot, "checkout/repair.txt")),
                "preserve unfinished repair\n",
            );
            await assertRejects(() => retirePublicationForRevalidation(f.projectRoot, f.entry.id, attempt.revision));
        } finally {
            await f.cleanup();
        }
    });
}

Deno.test("an integration that may already have been pushed is never retired for source drift", async () => {
    const f = await fixture();
    try {
        const integrated = await advanceStoredPublication(f.projectRoot, f.attempt, "target_integrated", {
            targetBaseCommit: f.entry.baseCommit,
            integrationCommit: f.attempt.artifactCommit,
        });
        await f.rewrite();
        assertEquals(await preparePublicationRevalidation(f.projectRoot, f.entry.planName), null);
        assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, integrated);
    } finally {
        await f.cleanup();
    }
});

Deno.test("validation overrides stale delivery claims and reruns CI after a rewrite", async () => {
    const f = await fixture();
    try {
        await f.rewrite();
        const plan = await loadPlan(f.entry.path, f.entry.planName);
        assert(plan);
        const checkpoint = makeValidationCheckpoint({
            attemptId: f.entry.id,
            generation: "running-owner",
            status: "reviewed",
            phase: "delivery",
            state: "running",
            ownerPid: Deno.pid,
            ownerHostname: "test-host",
        });
        await updatePlanFrontMatter(f.entry.path, f.entry.planName, { validationCheckpoint: checkpoint }, {}, {
            expectedRevision: plan.revision,
        });
        const hostedSession = makeRecordedSession("publication-revalidation", makeUi());
        hostedSession.setActiveExecutionWorkflow({
            planName: f.entry.planName,
            triageMeta: plan.attrs,
            executionAgent: "engineer",
            projectRoot: f.projectRoot,
            executionCwd: f.entry.path,
            executionMode: "worktree",
            worktreeId: f.entry.id,
            worktreeBranch: f.entry.branch,
            worktreeBaseBranch: "main",
        });
        let checks = 0;
        const result = await runValidationPhase({
            hostedSession,
            planName: f.entry.planName,
            planContent: plan.markdown,
            triageMeta: plan.attrs,
            continuationPhase: "delivery",
            validationCheckpoint: checkpoint,
            localCI: {
                run: () => {
                    checks += 1;
                    return Promise.resolve({ kind: "completed", exitCode: 0, output: "passed" });
                },
            },
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        });
        assertEquals(result.kind, "paused");
        assertEquals(checks, 1);
        const current = await loadPlan(f.entry.path, f.entry.planName);
        assertEquals(current?.attrs.status, "implemented");
        assertEquals(current?.attrs.validationCheckpoint?.generation, "running-owner");
        assertEquals(current?.attrs.humanReviewDecision, null);
    } finally {
        await f.cleanup();
    }
});
