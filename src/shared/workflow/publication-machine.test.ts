import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { ProjectRuntimeEntryRefusedError, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { addEntry } from "../worktree-registry.js";
import {
    advanceStoredPublication,
    cleanupStoredPublication,
    failStoredPublication,
    loadPublicationAttempt,
    publicationRootForAttempt,
    reconcileStoredPublication,
    startPublicationAttempt,
} from "./publication-machine.ts";

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
        const started = await startPublicationAttempt(request);
        const layout = resolveProjectRuntimeLayout(projectRoot);
        const before = await fsReadFile(layout.primary.worktreeRegistryPath, "utf8");
        const hazardDirectory = join(projectRoot, ".wld", "internal");
        await fsMkdir(hazardDirectory, { recursive: true });
        const hazard = join(hazardDirectory, "staged-runtime.json");
        await fsWriteFile(hazard, "{}\n");
        await git(projectRoot, ["add", "-f", "--", hazard]);

        const operations = [
            { name: "load", run: () => loadPublicationAttempt(projectRoot, "attempt-1") },
            { name: "start or resume", run: () => startPublicationAttempt(request) },
            {
                name: "advance",
                run: () =>
                    advanceStoredPublication(projectRoot, started, "artifacts_committed", {
                        artifactCommit: head,
                        planPaths: ["docs/plans/demo.md"],
                    }),
            },
            { name: "repeat phase", run: () => advanceStoredPublication(projectRoot, started, "candidate_sealed", {}) },
            {
                name: "record failure",
                run: () => failStoredPublication(projectRoot, started, { kind: "test", message: "Publication failed" }),
            },
            { name: "reconcile", run: () => reconcileStoredPublication(projectRoot, started) },
            { name: "cleanup", run: () => cleanupStoredPublication(projectRoot, started) },
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
        const advanced = await advanceStoredPublication(projectRoot, started, "artifacts_committed", {
            artifactCommit: head,
            planPaths: ["docs/plans/demo.md"],
        });
        assertEquals(advanced.phase, "artifacts_committed");
        assertEquals((await loadPublicationAttempt(projectRoot, "attempt-1"))?.revision, advanced.revision);
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
        const started = await startPublicationAttempt({
            projectRoot,
            attemptId: "attempt-1",
            planName: "demo",
            targetBranch: "main",
            executionBranch: "worktree/demo",
            executionCwd: join(projectRoot, "execution"),
            validatedCommit: "b".repeat(40),
            targetHeadAtSeal: "a".repeat(40),
        });
        assertEquals(started.publicationRoot, publicationRootForAttempt(projectRoot, "attempt-1"));
        assertStringIncludes(started.publicationRoot, join(".wld", "internal", "plan-staging", "attempt-1"));
        const artifacts = await advanceStoredPublication(projectRoot, started, "artifacts_committed", {
            artifactCommit: "c".repeat(40),
            planPaths: ["docs/plans/demo.md"],
        });
        assertEquals((await loadPublicationAttempt(projectRoot, "attempt-1"))?.phase, "artifacts_committed");
        const repeated = await advanceStoredPublication(projectRoot, started, "artifacts_committed", {
            artifactCommit: "c".repeat(40),
            planPaths: ["docs/plans/demo.md"],
        });
        assertEquals(repeated, artifacts);
        await assertRejects(
            () =>
                advanceStoredPublication(projectRoot, started, "artifacts_committed", {
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
        const started = await startPublicationAttempt({
            projectRoot,
            attemptId: "attempt-1",
            planName: "demo",
            targetBranch: "main",
            executionBranch: "worktree/demo",
            executionCwd: join(projectRoot, "execution"),
            validatedCommit: "b".repeat(40),
            targetHeadAtSeal: "a".repeat(40),
        });
        const resumed = await startPublicationAttempt({
            projectRoot,
            attemptId: "attempt-1",
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
        const started = await startPublicationAttempt({
            projectRoot,
            attemptId: "attempt-1",
            planName: "demo",
            targetBranch: "main",
            executionBranch: "worktree/demo",
            executionCwd: join(projectRoot, "execution"),
            validatedCommit: "b".repeat(40),
            targetHeadAtSeal: "a".repeat(40),
        });
        const artifacts = await advanceStoredPublication(projectRoot, started, "artifacts_committed", {
            artifactCommit: "c".repeat(40),
            planPaths: ["docs/plans/demo.md"],
        });
        const firstIntegration = await advanceStoredPublication(projectRoot, artifacts, "target_integrated", {
            targetBaseCommit: "d".repeat(40),
            integrationCommit: "e".repeat(40),
        });
        const refreshedIntegration = await advanceStoredPublication(
            projectRoot,
            firstIntegration,
            "target_integrated",
            {
                targetBaseCommit: "f".repeat(40),
                integrationCommit: "1".repeat(40),
            },
        );

        assertEquals(refreshedIntegration.phase, "target_integrated");
        assertEquals(refreshedIntegration.targetBaseCommit, "f".repeat(40));
        assertEquals(refreshedIntegration.integrationCommit, "1".repeat(40));
        assertEquals(refreshedIntegration.revision, firstIntegration.revision + 1);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});
