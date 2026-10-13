import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rename as fsRename,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { basename, dirname, join } from "node:path";
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
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "publication-revalidation-"));
    const entry = await createTestWorktreeAttempt({
        projectRoot,
        worktreeRoot,
        planName: "rewrite",
        planId: "rewrite-plan",
    });
    await fsWriteFile(join(entry.path, "feature.txt"), "validated implementation\n");
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
    await fsMkdir(attempt.publicationRoot, { recursive: true });
    await fsWriteFile(join(attempt.publicationRoot, "repair.txt"), "preserve unfinished repair\n");
    return {
        projectRoot,
        entry,
        attempt,
        async rewrite() {
            await git(entry.path, ["commit", "--amend", "-m", "Rewritten artifacts"]);
        },
        async cleanup() {
            await fsRm(worktreeRoot, { recursive: true });
            await fsRm(projectRoot, { recursive: true });
        },
    };
}

test("rewritten publication preserves files and starts fresh validation instead of repeating stale delivery", async () => {
    const f = await fixture();
    try {
        await f.rewrite();
        await fsWriteFile(join(f.entry.path, ".gitignore"), "new-rule\n");
        await git(f.entry.path, ["add", ".gitignore"]);
        await git(f.entry.path, ["commit", "-m", "Ignore policy"]);
        await fsWriteFile(join(f.entry.path, "staged.txt"), "staged work\n");
        await git(f.entry.path, ["add", "staged.txt"]);
        await fsWriteFile(join(f.entry.path, "untracked.txt"), "untracked work\n");
        const head = await git(f.entry.path, ["rev-parse", "HEAD"]);
        const index = await git(f.entry.path, ["diff", "--cached"]);
        const target = await git(f.projectRoot, ["rev-parse", "main"]);
        const archive = await preparePublicationRevalidation(f.projectRoot, f.entry.planName);
        assert(archive);
        assertEquals(await git(f.entry.path, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(f.entry.path, ["diff", "--cached"]), index);
        assertEquals(await git(f.projectRoot, ["rev-parse", "main"]), target);
        assertEquals(await fsReadFile(join(f.entry.path, "untracked.txt"), "utf8"), "untracked work\n");
        assertEquals(await fsReadFile(join(archive, "checkout/repair.txt"), "utf8"), "preserve unfinished repair\n");
        assertStringIncludes(await fsReadFile(join(archive, "publication.json"), "utf8"), f.attempt.artifactCommit!);
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

test("unchanged publication and harmless empty commits keep their validation", async () => {
    const f = await fixture();
    try {
        await git(f.entry.path, ["commit", "--allow-empty", "-m", "Empty"]);
        assertEquals(await preparePublicationRevalidation(f.projectRoot, f.entry.planName), null);
        assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, f.attempt);
    } finally {
        await f.cleanup();
    }
});

test("publication recovery uses one Plan lock spelling for aliased execution paths", {
    skip: process.platform === "win32",
}, async () => {
    const f = await fixture();
    try {
        const parentAlias = join(dirname(f.entry.path), "parent-alias");
        await fsSymlink(dirname(f.entry.path), parentAlias, "dir");
        const alias = join(parentAlias, basename(f.entry.path));
        const attempt = { ...f.attempt, executionCwd: alias, revision: f.attempt.revision + 1 };
        await updatePublication(f.projectRoot, f.entry.id, f.attempt.revision, attempt);
        assertEquals(await preparePublicationRevalidation(f.projectRoot, f.entry.planName), null);
        assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, attempt);
        await fsWriteFile(join(alias, "feature.txt"), "changed implementation\n");
        assert(await preparePublicationRevalidation(f.projectRoot, f.entry.planName));
        assertEquals((await loadPlan(alias, f.entry.planName))?.attrs.status, "implemented");
    } finally {
        await f.cleanup();
    }
});

test("publication recovery also handles pruned pre-rewrite commits", async () => {
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
    test(`fresh process resumes publication revalidation after ${boundary}`, async () => {
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
                await fsMkdir(attempt.revalidation.archiveRoot);
                await fsWriteFile(
                    join(attempt.revalidation.archiveRoot, "publication.json"),
                    `${JSON.stringify(attempt, null, 2)}\n`,
                );
                await fsRename(attempt.publicationRoot, join(attempt.revalidation.archiveRoot, "checkout"));
            }
            if (boundary === "plan_reset") {
                const plan = await loadPlan(f.entry.path, f.entry.planName);
                assert(plan);
                await updatePlanFrontMatter(f.entry.path, f.entry.planName, { status: "implemented" }, {}, {
                    expectedRevision: plan.revision,
                });
            }
            const moduleUrl = new URL("./publication-revalidation.ts", import.meta.url).href;
            const output = await captureForegroundProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "eval",
                    `import {preparePublicationRevalidation} from ${
                        JSON.stringify(moduleUrl)
                    }; await preparePublicationRevalidation((await import("node:process")).argv.slice(2)[0], (await import("node:process")).argv.slice(2)[1]);`,
                    f.projectRoot,
                    f.entry.planName,
                ]),
                cwd: getCwd(),
            });
            assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
            assertEquals((await loadPlan(f.entry.path, f.entry.planName))?.attrs.status, "implemented");
            assertEquals((await findById(f.projectRoot, f.entry.id))?.publication, undefined);
            assertEquals(
                await fsReadFile(join(attempt.revalidation.archiveRoot, "checkout/repair.txt"), "utf8"),
                "preserve unfinished repair\n",
            );
            await assertRejects(() => retirePublicationForRevalidation(f.projectRoot, f.entry.id, attempt.revision));
        } finally {
            await f.cleanup();
        }
    });
}

test("an integration that may already have been pushed is never retired for source drift", async () => {
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

test("validation overrides stale delivery claims and reruns CI after a rewrite", async () => {
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
            ownerPid: process.pid,
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
