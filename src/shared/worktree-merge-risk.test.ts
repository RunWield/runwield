import { assertEquals } from "../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { inspectExecutionWorktreeMergeRisk, removeWorktreeGitArtifacts } from "./worktree.js";

import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";
import type { WorktreeRegistryEntry } from "./worktree-registry.js";

test("inspectExecutionWorktreeMergeRisk reports clean target branch as safe without mutating", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree: WorktreeRegistryEntry | undefined;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Clean Risk",
            worktreeRoot,
        });
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "feature"]);

        const beforeHead = await git(projectRoot, ["rev-parse", "HEAD"]);
        const beforeStatus = await git(projectRoot, ["status", "--porcelain"]);
        const result = await inspectExecutionWorktreeMergeRisk({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
        });

        assertEquals(result, { ok: true, warnings: [], failures: [] });
        assertEquals(await git(projectRoot, ["rev-parse", "HEAD"]), beforeHead);
        assertEquals(await git(projectRoot, ["status", "--porcelain"]), beforeStatus);
        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("inspectExecutionWorktreeMergeRisk fails when target branch is checked out elsewhere", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const targetCheckout = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree: WorktreeRegistryEntry | undefined;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Checked Out Target Risk",
            worktreeRoot,
        });
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["worktree", "add", targetCheckout, "feature-base"]);
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "feature"]);

        const result = await inspectExecutionWorktreeMergeRisk({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
        });

        assertEquals(result.ok, false);
        assertEquals(
            result.failures.some(
                (failure) =>
                    failure.includes("Target branch feature-base is checked out") &&
                    failure.replaceAll("\\", "/").includes(targetCheckout.replaceAll("\\", "/")),
            ),
            true,
        );
    } finally {
        await git(projectRoot, ["worktree", "remove", "--force", targetCheckout]).catch(() => {});
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
        await fsRm(targetCheckout, { recursive: true }).catch(() => {});
    }
});

test("inspectExecutionWorktreeMergeRisk requires targetBranch to be a local branch, not a tag", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree: WorktreeRegistryEntry | undefined;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Tag Risk",
            worktreeRoot,
        });
        await git(projectRoot, ["tag", "release-target"]);

        const result = await inspectExecutionWorktreeMergeRisk({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "release-target",
        });

        assertEquals(result.ok, false);
        assertEquals(
            result.failures.some(
                (failure) =>
                    failure.includes("Recorded worktree target branch is not available") &&
                    failure.includes("refs/heads/release-target"),
            ),
            true,
        );
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("inspectExecutionWorktreeMergeRisk warns on overlapping dirty primary changes", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    let worktree: WorktreeRegistryEntry | undefined;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Dirty Risk",
            worktreeRoot,
        });
        await fsWriteFile(`${worktree.path}/README.md`, "base\nfeature\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "feature"]);
        await fsWriteFile(`${projectRoot}/README.md`, "base\nprimary scratch\n");

        const result = await inspectExecutionWorktreeMergeRisk({ projectRoot, branch: worktree.branch });

        assertEquals(result.ok, true);
        assertEquals(
            result.warnings.some(
                (warning) => warning.includes("overlap execution worktree changes") && warning.includes("README.md"),
            ),
            true,
        );
        assertEquals(await fsReadFile(`${projectRoot}/README.md`, "utf8"), "base\nprimary scratch\n");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("inspectExecutionWorktreeMergeRisk fails on missing branch", async () => {
    const projectRoot = await makeRepo();
    try {
        const result = await inspectExecutionWorktreeMergeRisk({ projectRoot, branch: "missing-branch" });

        assertEquals(result.ok, false);
        assertEquals(result.warnings, []);
        assertEquals(
            result.failures.some((failure) => failure.includes("Recorded worktree branch is not available")),
            true,
        );
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});
