import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { ProjectRuntimeEntryRefusedError, resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { addEntry } from "../worktree-registry.ts";
import { openPublication } from "@runwield/workflow/publication-runtime";

const gitFixture = defineCommittedGitFixture({
    "README.md": "Publication runtime safety\n",
    "docs/plans/demo.md": "# Demo\n",
});

test("publication operations reject newly staged runtime state without changing their receipt", async (test) => {
    const projectRoot = await gitFixture.checkout();
    const directory = await fsMkdtemp(join(tmpdir(), "publication-safety-execution-"));
    const executionCwd = join(directory, "execution");
    try {
        const head = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["worktree", "add", "-b", "worktree/demo", executionCwd]);
        await addEntry(projectRoot, {
            id: "attempt-1",
            planId: "plan-1",
            planName: "demo",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: head,
            branch: "worktree/demo",
            path: executionCwd,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const request = {
            projectRoot,
            attemptId: "attempt-1",
            planName: "demo",
            targetBranch: "main",
            executionBranch: "worktree/demo",
            executionCwd,
            validatedCommit: head,
            targetHeadAtSeal: head,
        };
        const started = await openPublication(request.projectRoot).attempt(request.attemptId).start(request);
        const layout = resolveProjectRuntimeLayout(projectRoot);
        const before = await fsReadFile(layout.primary.worktreeRegistryPath, "utf8");
        const hazardDirectory = join(projectRoot, ".wld", "internal");
        await fsMkdir(hazardDirectory, { recursive: true });
        const hazard = join(hazardDirectory, "staged-runtime.json");
        await fsWriteFile(hazard, "{}\n");
        await git(projectRoot, ["add", "-f", "--", hazard]);

        const operations = [
            { name: "load", run: () => openPublication(projectRoot).attempt("attempt-1").load() },
            {
                name: "start or resume",
                run: () => openPublication(request.projectRoot).attempt(request.attemptId).start(request),
            },
            {
                name: "advance",
                run: () =>
                    openPublication(projectRoot)
                        .resume(started)
                        .advance("artifacts_committed", {
                            artifactCommit: head,
                            planPaths: ["docs/plans/demo.md"],
                        }),
            },
            {
                name: "repeat phase",
                run: () => openPublication(projectRoot).resume(started).advance("candidate_sealed", {}),
            },
            {
                name: "record failure",
                run: () =>
                    openPublication(projectRoot)
                        .resume(started)
                        .recordFailure({ kind: "test", message: "Publication failed" }),
            },
            { name: "reconcile", run: () => openPublication(projectRoot).resume(started).reconcile() },
            { name: "cleanup", run: () => openPublication(projectRoot).resume(started).cleanup() },
        ];
        for (const operation of operations) {
            await test.test(operation.name, async () => {
                await assertRejects(() => operation.run(), ProjectRuntimeEntryRefusedError);
                assertEquals(await fsReadFile(layout.primary.worktreeRegistryPath, "utf8"), before);
                assertEquals(await fsReadFile(hazard, "utf8"), "{}\n");
            });
        }
        // Restoring safe Git state must permit the next real registry write.
        await git(projectRoot, ["reset", "HEAD", "--", hazard]);
        const advanced = await openPublication(projectRoot)
            .resume(started)
            .advance("artifacts_committed", {
                artifactCommit: head,
                planPaths: ["docs/plans/demo.md"],
            });
        assertEquals(advanced.phase, "artifacts_committed");
        assertEquals((await openPublication(projectRoot).attempt("attempt-1").load())?.revision, advanced.revision);
    } finally {
        await fsRm(directory, { recursive: true });
        await fsRm(projectRoot, { recursive: true });
    }
});

async function fixture() {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "publication-machine-"));
    await addEntry(projectRoot, {
        id: "attempt-1",
        planId: "plan-1",
        planName: "demo",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: "a".repeat(40),
        branch: "worktree/demo",
        path: join(projectRoot, "execution"),
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return projectRoot;
}

test("publication machine persists one compare-and-swap attempt in the worktree registry", async () => {
    const projectRoot = await fixture();
    try {
        const started = await openPublication(projectRoot)
            .attempt("attempt-1")
            .start({
                planName: "demo",
                targetBranch: "main",
                executionBranch: "worktree/demo",
                executionCwd: join(projectRoot, "execution"),
                validatedCommit: "b".repeat(40),
                targetHeadAtSeal: "a".repeat(40),
            });
        assertEquals(started.publicationRoot, openPublication(projectRoot).attempt("attempt-1").stagingRoot());
        assertEquals(
            started.publicationRoot,
            join(resolveProjectRuntimeLayout(projectRoot).primary.publicationStagingRoot, "attempt-1"),
        );
        const artifacts = await openPublication(projectRoot)
            .resume(started)
            .advance("artifacts_committed", {
                artifactCommit: "c".repeat(40),
                planPaths: ["docs/plans/demo.md"],
            });
        assertEquals((await openPublication(projectRoot).attempt("attempt-1").load())?.phase, "artifacts_committed");
        const repeated = await openPublication(projectRoot)
            .resume(started)
            .advance("artifacts_committed", {
                artifactCommit: "c".repeat(40),
                planPaths: ["docs/plans/demo.md"],
            });
        assertEquals(repeated, artifacts);
        await assertRejects(
            () =>
                openPublication(projectRoot)
                    .resume(started)
                    .advance("artifacts_committed", {
                        artifactCommit: "d".repeat(40),
                        planPaths: ["docs/plans/demo.md"],
                    }),
            Error,
            "conflicting artifactCommit",
        );
        assertEquals(artifacts.artifactCommit, "c".repeat(40));
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("publication machine resumes the existing attempt instead of replacing its sealed commit", async () => {
    const projectRoot = await fixture();
    try {
        const started = await openPublication(projectRoot)
            .attempt("attempt-1")
            .start({
                planName: "demo",
                targetBranch: "main",
                executionBranch: "worktree/demo",
                executionCwd: join(projectRoot, "execution"),
                validatedCommit: "b".repeat(40),
                targetHeadAtSeal: "a".repeat(40),
            });
        const resumed = await openPublication(projectRoot)
            .attempt("attempt-1")
            .start({
                planName: "demo",
                targetBranch: "main",
                executionBranch: "worktree/demo",
                executionCwd: join(projectRoot, "execution"),
                validatedCommit: "e".repeat(40),
                targetHeadAtSeal: "a".repeat(40),
            });
        assertEquals(resumed.validatedCommit, started.validatedCommit);
        assertEquals(resumed.revision, started.revision);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("publication machine can replace a stale integration before the target is published", async () => {
    const projectRoot = await fixture();
    try {
        const started = await openPublication(projectRoot)
            .attempt("attempt-1")
            .start({
                planName: "demo",
                targetBranch: "main",
                executionBranch: "worktree/demo",
                executionCwd: join(projectRoot, "execution"),
                validatedCommit: "b".repeat(40),
                targetHeadAtSeal: "a".repeat(40),
            });
        const artifacts = await openPublication(projectRoot)
            .resume(started)
            .advance("artifacts_committed", {
                artifactCommit: "c".repeat(40),
                planPaths: ["docs/plans/demo.md"],
            });
        const firstIntegration = await openPublication(projectRoot)
            .resume(artifacts)
            .advance("target_integrated", {
                targetBaseCommit: "d".repeat(40),
                integrationCommit: "e".repeat(40),
            });
        const refreshedIntegration = await openPublication(projectRoot)
            .resume(firstIntegration)
            .advance("target_integrated", {
                targetBaseCommit: "f".repeat(40),
                integrationCommit: "1".repeat(40),
            });

        assertEquals(refreshedIntegration.phase, "target_integrated");
        assertEquals(refreshedIntegration.targetBaseCommit, "f".repeat(40));
        assertEquals(refreshedIntegration.integrationCommit, "1".repeat(40));
        assertEquals(refreshedIntegration.revision, firstIntegration.revision + 1);
        const publication = openPublication(projectRoot);
        await assertRejects(
            () =>
                publication.resume(firstIntegration).advance("target_integrated", {
                    targetBaseCommit: firstIntegration.targetBaseCommit,
                    integrationCommit: firstIntegration.integrationCommit,
                }),
            Error,
            "conflicting targetBaseCommit",
        );
        assertEquals(
            await publication.resume(firstIntegration).advance("target_integrated", {
                targetBaseCommit: refreshedIntegration.targetBaseCommit,
                integrationCommit: refreshedIntegration.integrationCommit,
            }),
            refreshedIntegration,
        );
        assertEquals(await publication.attempt("attempt-1").load(), refreshedIntegration);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("read-only publication reconciliation proves a committed artifact without rewriting the publication receipt", async () => {
    const projectRoot = await gitFixture.checkout();
    const directory = await fsMkdtemp(join(tmpdir(), "publication-read-proof-"));
    const executionCwd = join(directory, "execution");
    try {
        const head = await git(projectRoot, ["rev-parse", "HEAD"]);
        await git(projectRoot, ["worktree", "add", "-b", "worktree/demo", executionCwd]);
        await addEntry(projectRoot, {
            id: "read-attempt",
            planId: "read-plan",
            planName: "demo",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: head,
            branch: "worktree/demo",
            path: executionCwd,
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const started = await openPublication(projectRoot).attempt("read-attempt").start({
            planName: "demo",
            targetBranch: "main",
            executionBranch: "worktree/demo",
            executionCwd,
            validatedCommit: head,
            targetHeadAtSeal: head,
        });
        await fsWriteFile(join(executionCwd, "artifact.txt"), "sealed artifact\n");
        await git(executionCwd, ["add", "artifact.txt"]);
        await git(executionCwd, [
            "commit",
            "-m",
            "Seal delivery\n\nRunWield-Publication-Attempt: read-attempt\nRunWield-Publication-Plan-Path: docs/plans/demo.md",
        ]);
        const artifact = await git(executionCwd, ["rev-parse", "HEAD"]);
        const registryPath = resolveProjectRuntimeLayout(projectRoot).primary.worktreeRegistryPath;
        const before = await fsReadFile(registryPath, "utf8");
        const proven = await openPublication(projectRoot).resume(started).reconcile({ apply: false });
        assertEquals(proven.phase, "artifacts_committed");
        assertEquals(proven.artifactCommit, artifact);
        assertEquals(await fsReadFile(registryPath, "utf8"), before);
        assertEquals((await openPublication(projectRoot).attempt("read-attempt").load())?.phase, "candidate_sealed");
    } finally {
        await fsRm(directory, { recursive: true });
        await fsRm(projectRoot, { recursive: true });
    }
});
