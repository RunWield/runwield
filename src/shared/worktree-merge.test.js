import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { match as assertMatch } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { dirname } from "node:path";

import {
    assertPublicationCandidateContainsTarget,
    checkpointExecutionWorktree,
    mergeExecutionWorktree,
    removeWorktreeGitArtifacts,
} from "./worktree.js";

import { createTestWorktreeAttempt, git, makeRepo } from "./worktree-test-helpers.ts";

/** @typedef {Error & { mergeFailureKind?: string }} TestMergeRepairError */

test("publication candidate must contain the current target commit", async () => {
    const projectRoot = await makeRepo();
    try {
        const targetCommit = await git(projectRoot, ["rev-parse", "main"]);
        await git(projectRoot, ["checkout", "--orphan", "unrelated-publication"]);
        await fsWriteFile(`${projectRoot}/unrelated.txt`, "unrelated\n");
        await git(projectRoot, ["add", "unrelated.txt"]);
        await git(projectRoot, ["commit", "-m", "unrelated candidate"]);
        const unrelatedCandidate = await git(projectRoot, ["rev-parse", "HEAD"]);

        const error = await assertRejects(
            () =>
                assertPublicationCandidateContainsTarget(
                    projectRoot,
                    targetCommit,
                    unrelatedCandidate,
                    "main",
                ),
            Error,
            "Publication candidate would discard commits already on main",
        );
        assertEquals(/** @type {TestMergeRepairError} */ (error).mergeFailureKind, "target_history_rewrite");
        assertEquals(await git(projectRoot, ["rev-parse", "main"]), targetCommit);
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("mergeExecutionWorktree targets recorded branch without changing primary checkout", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Target Branch Merge",
            worktreeRoot,
        });
        assertEquals(worktree.baseBranch, "feature-base");
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");

        const mergeResult = await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: worktree.baseBranch,
            worktreePath: worktree.path,
        });

        assertEquals(mergeResult?.updatedPrimaryCheckout, false);
        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
        assertEquals(await git(projectRoot, ["show", "feature-base:feature.txt"]), "feature");
        await assertRejects(() => git(projectRoot, ["show", "main:feature.txt"]), Error);
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

test("mergeExecutionWorktree refuses to update target branch checked out in another worktree", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const targetCheckout = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Checked Out Target",
            worktreeRoot,
        });
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["worktree", "add", targetCheckout, "feature-base"]);
        const worktreePath = worktree.path;
        const worktreeBranch = worktree.branch;
        await fsWriteFile(`${worktreePath}/feature.txt`, "feature\n");

        await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch: worktreeBranch,
                    targetBranch: "feature-base",
                    worktreePath,
                }),
            Error,
            "Target branch feature-base is checked out",
        );
        await assertRejects(() => git(projectRoot, ["show", "feature-base:feature.txt"]), Error);
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

test("mergeExecutionWorktree refuses checked-out target before mutating execution branch", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const targetCheckout = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Checked Out Target No Side Effects",
            worktreeRoot,
        });
        await fsMkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await fsWriteFile(`${projectRoot}/docs/plans/demo.md`, "target\n");
        await git(projectRoot, ["add", "docs/plans/demo.md"]);
        await git(projectRoot, ["commit", "-m", "target plan metadata"]);
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["worktree", "add", targetCheckout, "feature-base"]);

        await fsMkdir(`${worktree.path}/docs/plans`, { recursive: true });
        await fsWriteFile(`${worktree.path}/docs/plans/demo.md`, "execution\n");
        await git(worktree.path, ["add", "docs/plans/demo.md"]);
        await git(worktree.path, ["commit", "-m", "execution plan metadata"]);
        const beforeExecutionHead = await git(projectRoot, ["rev-parse", worktree.branch]);

        await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch: worktree?.branch || "",
                    targetBranch: "feature-base",
                    worktreePath: worktree?.path,
                }),
            Error,
            "Target branch feature-base is checked out",
        );

        assertEquals(await git(projectRoot, ["rev-parse", worktree.branch]), beforeExecutionHead);
        assertEquals(await git(projectRoot, ["show", `${worktree.branch}:docs/plans/demo.md`]), "execution");
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

test("mergeExecutionWorktree keeps a Plan deleted on both sides", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await fsMkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await fsWriteFile(`${projectRoot}/docs/plans/deleted.md`, "base\n");
        await git(projectRoot, ["add", "docs/plans/deleted.md"]);
        await git(projectRoot, ["commit", "-m", "base plan"]);
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Target Deleted Plan",
            worktreeRoot,
        });

        await fsRm(`${projectRoot}/docs/plans/deleted.md`);
        await git(projectRoot, ["add", "docs/plans/deleted.md"]);
        await git(projectRoot, ["commit", "-m", "target deletes obsolete plan"]);

        await fsRm(`${worktree.path}/docs/plans/deleted.md`);
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");
        await git(worktree.path, ["add", "docs/plans/deleted.md", "feature.txt"]);
        await git(worktree.path, ["commit", "-m", "execution also deletes obsolete plan"]);

        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
            worktreePath: worktree.path,
        });

        await assertRejects(() => git(projectRoot, ["show", "feature-base:docs/plans/deleted.md"]), Error);
        assertEquals(await git(projectRoot, ["show", "feature-base:feature.txt"]), "feature");
    } finally {
        await git(projectRoot, ["merge", "--abort"]).catch(() => {});
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

test("publication resolves unrelated Plan drift without rewriting the execution worktree", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await fsMkdir(`${projectRoot}/docs/plans`, { recursive: true });
        await fsWriteFile(`${projectRoot}/docs/plans/unrelated.md`, 'status: "draft"\n');
        await git(projectRoot, ["add", "docs/plans/unrelated.md"]);
        await git(projectRoot, ["commit", "-m", "base unrelated plan"]);
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Do Not Rewrite Other Plans",
            worktreeRoot,
        });

        await fsWriteFile(`${projectRoot}/docs/plans/unrelated.md`, 'status: "draft"\nupdated: target\n');
        await git(projectRoot, ["add", "docs/plans/unrelated.md"]);
        await git(projectRoot, ["commit", "-m", "target updates unrelated plan"]);
        await git(projectRoot, ["checkout", "main"]);

        const executionPlanText = 'status: "in_progress"\nupdated: execution\n';
        await fsWriteFile(`${worktree.path}/docs/plans/unrelated.md`, executionPlanText);
        await fsWriteFile(`${worktree.path}/feature.txt`, "validated work\n");
        await git(worktree.path, ["add", "docs/plans/unrelated.md", "feature.txt"]);
        await git(worktree.path, ["commit", "-m", "execution branch state"]);
        const executionHead = await git(worktree.path, ["rev-parse", "HEAD"]);

        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
            worktreePath: worktree.path,
        });

        assertEquals(await fsReadFile(`${worktree.path}/docs/plans/unrelated.md`, "utf8"), executionPlanText);
        assertEquals(await git(worktree.path, ["rev-parse", "HEAD"]), executionHead);
        assertEquals(
            await git(projectRoot, ["show", "feature-base:docs/plans/unrelated.md"]),
            'status: "draft"\nupdated: target',
        );
        assertEquals(await git(projectRoot, ["show", "feature-base:feature.txt"]), "validated work");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true }).catch(() => {});
        }
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("mergeExecutionWorktree requires targetBranch to be a local branch, not a tag", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Tag Is Not Target",
            worktreeRoot,
        });
        await git(projectRoot, ["tag", "release-target"]);
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");

        await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch: worktree?.branch || "",
                    targetBranch: "release-target",
                    worktreePath: worktree?.path,
                }),
            Error,
            "refs/heads/release-target",
        );
        await assertRejects(() => git(projectRoot, ["show", "HEAD:feature.txt"]), Error);
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

test("mergeExecutionWorktree publishes and cleans up a repaired detached merge worktree", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    /** @type {string | undefined} */
    let mergeWorktreePath;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Repaired Detached Merge",
            worktreeRoot,
        });
        await fsWriteFile(`${projectRoot}/README.md`, "base\ntarget\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "target change"]);
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/README.md`, "base\nexecution\n");

        try {
            await mergeExecutionWorktree({
                projectRoot,
                branch: worktree.branch,
                targetBranch: "feature-base",
                worktreePath: worktree.path,
            });
        } catch (error) {
            mergeWorktreePath = /** @type {{ mergeWorktreePath?: string }} */ (error).mergeWorktreePath;
        }
        if (!mergeWorktreePath) throw new Error("Expected detached merge repair worktree path");
        assertEquals(dirname(mergeWorktreePath), worktreeRoot);

        await fsWriteFile(`${mergeWorktreePath}/README.md`, "base\ntarget\nexecution\n");
        await git(mergeWorktreePath, ["add", "README.md"]);
        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
            worktreePath: worktree.path,
            repairMergeWorktreePath: mergeWorktreePath,
        });

        assertEquals(await git(projectRoot, ["show", "feature-base:README.md"]), "base\ntarget\nexecution");
        await assertRejects(() => fsStat(mergeWorktreePath || ""), Error, "ENOENT");
    } finally {
        if (mergeWorktreePath) {
            await git(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(() => {});
        }
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

test("mergeExecutionWorktree abandons repaired worktree when Engineer made branch retryable", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    /** @type {string | undefined} */
    let mergeWorktreePath;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Retryable Branch Repair",
            worktreeRoot,
        });
        await fsWriteFile(`${projectRoot}/README.md`, "base\ntarget\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "target change"]);
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/README.md`, "base\nexecution\n");

        try {
            await mergeExecutionWorktree({
                projectRoot,
                branch: worktree.branch,
                targetBranch: "feature-base",
                worktreePath: worktree.path,
            });
        } catch (error) {
            mergeWorktreePath = /** @type {{ mergeWorktreePath?: string }} */ (error).mergeWorktreePath;
        }
        if (!mergeWorktreePath) throw new Error("Expected detached merge repair worktree path");

        await git(mergeWorktreePath, ["merge", "--abort"]);
        await git(worktree.path, ["merge", "feature-base"]).catch(() => Promise.resolve());
        await fsWriteFile(`${worktree.path}/README.md`, "base\ntarget\nexecution\n");
        await git(worktree.path, ["add", "README.md"]);
        await git(worktree.path, ["commit", "-m", "make execution branch retryable"]);

        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
            worktreePath: worktree.path,
            repairMergeWorktreePath: mergeWorktreePath,
        });

        assertEquals(await git(projectRoot, ["show", "feature-base:README.md"]), "base\ntarget\nexecution");
        await assertRejects(() => fsStat(mergeWorktreePath || ""), Error, "ENOENT");
    } finally {
        if (mergeWorktreePath) {
            await git(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(() => {});
        }
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

test("mergeExecutionWorktree abandons stale repaired worktree and retries current target", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    /** @type {string | undefined} */
    let mergeWorktreePath;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Stale Repaired Merge",
            worktreeRoot,
        });
        await fsWriteFile(`${projectRoot}/README.md`, "base\ntarget\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "target change"]);
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/README.md`, "base\nexecution\n");

        try {
            await mergeExecutionWorktree({
                projectRoot,
                branch: worktree.branch,
                targetBranch: "feature-base",
                worktreePath: worktree.path,
            });
        } catch (error) {
            mergeWorktreePath = /** @type {{ mergeWorktreePath?: string }} */ (error).mergeWorktreePath;
        }
        if (!mergeWorktreePath) throw new Error("Expected detached merge repair worktree path");

        await fsWriteFile(`${mergeWorktreePath}/README.md`, "base\ntarget\nexecution\n");
        await git(mergeWorktreePath, ["add", "README.md"]);
        await git(mergeWorktreePath, ["-c", "core.editor=true", "merge", "--continue"]);
        await git(worktree.path, ["merge", "feature-base"]).catch(() => Promise.resolve());
        await fsWriteFile(`${worktree.path}/README.md`, "base\ntarget\nexecution\n");
        await git(worktree.path, ["add", "README.md"]);
        await git(worktree.path, ["commit", "-m", "make execution branch retryable"]);

        await git(projectRoot, ["checkout", "feature-base"]);
        await fsWriteFile(`${projectRoot}/advanced.txt`, "advanced\n");
        await git(projectRoot, ["add", "advanced.txt"]);
        await git(projectRoot, ["commit", "-m", "advance target during repair"]);
        await git(projectRoot, ["checkout", "main"]);

        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
            worktreePath: worktree.path,
            repairMergeWorktreePath: mergeWorktreePath,
        });

        assertEquals(await git(projectRoot, ["show", "feature-base:README.md"]), "base\ntarget\nexecution");
        assertEquals(await git(projectRoot, ["show", "feature-base:advanced.txt"]), "advanced");
        await assertRejects(() => fsStat(mergeWorktreePath || ""), Error, "ENOENT");
    } finally {
        if (mergeWorktreePath) {
            await git(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(() => {});
        }
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

test("mergeExecutionWorktree abandons repaired worktree for current-root checked-out target fallback", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    /** @type {string | undefined} */
    let mergeWorktreePath;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Checked Out Repair Fallback",
            worktreeRoot,
        });
        await fsWriteFile(`${projectRoot}/README.md`, "base\ntarget\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "target change"]);
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/README.md`, "base\nexecution\n");

        try {
            await mergeExecutionWorktree({
                projectRoot,
                branch: worktree.branch,
                targetBranch: "feature-base",
                worktreePath: worktree.path,
            });
        } catch (error) {
            mergeWorktreePath = /** @type {{ mergeWorktreePath?: string }} */ (error).mergeWorktreePath;
        }
        if (!mergeWorktreePath) throw new Error("Expected detached merge repair worktree path");

        await fsWriteFile(`${mergeWorktreePath}/README.md`, "base\ntarget\nexecution\n");
        await git(mergeWorktreePath, ["add", "README.md"]);
        await git(mergeWorktreePath, ["-c", "core.editor=true", "merge", "--continue"]);
        await git(worktree.path, ["merge", "feature-base"]).catch(() => Promise.resolve());
        await fsWriteFile(`${worktree.path}/README.md`, "base\ntarget\nexecution\n");
        await git(worktree.path, ["add", "README.md"]);
        await git(worktree.path, ["commit", "-m", "make execution branch retryable"]);

        await git(projectRoot, ["checkout", "feature-base"]);
        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            targetBranch: "feature-base",
            worktreePath: worktree.path,
            repairMergeWorktreePath: mergeWorktreePath,
        });

        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "feature-base");
        assertEquals(await git(projectRoot, ["show", "feature-base:README.md"]), "base\ntarget\nexecution");
        await assertRejects(() => fsStat(mergeWorktreePath || ""), Error, "ENOENT");
    } finally {
        if (mergeWorktreePath) {
            await git(projectRoot, ["worktree", "remove", "--force", mergeWorktreePath]).catch(() => {});
        }
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

test("mergeExecutionWorktree annotates current-root target fallback conflicts for repair", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Checked Out Target Conflict Metadata",
            worktreeRoot,
        });
        await fsWriteFile(`${projectRoot}/README.md`, "base\ntarget\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "target change"]);
        await fsWriteFile(`${worktree.path}/README.md`, "base\nexecution\n");

        try {
            await mergeExecutionWorktree({
                projectRoot,
                branch: worktree.branch,
                targetBranch: "feature-base",
                worktreePath: worktree.path,
            });
            throw new Error("Expected merge conflict");
        } catch (error) {
            assertEquals(/** @type {{ repairCwd?: string }} */ (error).repairCwd, projectRoot);
            assertEquals(
                /** @type {{ mergeFailureKind?: string }} */ (error).mergeFailureKind,
                "current_checkout_merge_conflict",
            );
            assertEquals(/** @type {{ mergeWorktreePath?: string }} */ (error).mergeWorktreePath, undefined);
        }
    } finally {
        await git(projectRoot, ["merge", "--abort"]).catch(() => {});
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

test("mergeExecutionWorktree annotates legacy current-checkout conflicts for repair", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Legacy Checkout Conflict Metadata",
            worktreeRoot,
        });
        await fsWriteFile(`${projectRoot}/README.md`, "base\ncurrent\n");
        await git(projectRoot, ["add", "README.md"]);
        await git(projectRoot, ["commit", "-m", "current change"]);
        await fsWriteFile(`${worktree.path}/README.md`, "base\nexecution\n");

        try {
            await mergeExecutionWorktree({
                projectRoot,
                branch: worktree.branch,
                worktreePath: worktree.path,
            });
            throw new Error("Expected merge conflict");
        } catch (error) {
            assertEquals(/** @type {{ repairCwd?: string }} */ (error).repairCwd, projectRoot);
            assertEquals(
                /** @type {{ mergeFailureKind?: string }} */ (error).mergeFailureKind,
                "current_checkout_merge_conflict",
            );
            assertEquals(/** @type {{ mergeWorktreePath?: string }} */ (error).mergeWorktreePath, undefined);
        }
    } finally {
        await git(projectRoot, ["merge", "--abort"]).catch(() => {});
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

test("mergeExecutionWorktree handles target branch advancing before a later merge", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let first;
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let second;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        first = await createTestWorktreeAttempt({
            projectRoot,
            planName: "First Merge",
            worktreeRoot,
        });
        second = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Second Merge",
            worktreeRoot,
        });
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${first.path}/first.txt`, "first\n");
        await fsWriteFile(`${second.path}/second.txt`, "second\n");

        await mergeExecutionWorktree({
            projectRoot,
            branch: first.branch,
            targetBranch: "feature-base",
            worktreePath: first.path,
        });
        await mergeExecutionWorktree({
            projectRoot,
            branch: second.branch,
            targetBranch: "feature-base",
            worktreePath: second.path,
        });

        assertEquals(await git(projectRoot, ["show", "feature-base:first.txt"]), "first");
        assertEquals(await git(projectRoot, ["show", "feature-base:second.txt"]), "second");
        assertEquals(await git(projectRoot, ["branch", "--show-current"]), "main");
    } finally {
        for (const worktree of [first, second]) {
            if (worktree) {
                await removeWorktreeGitArtifacts({
                    projectRoot,
                    path: worktree.path,
                    force: true,
                });
            }
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("mergeExecutionWorktree marks target branch advancement as non-repairable", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        await git(projectRoot, ["checkout", "-b", "feature-base"]);
        const expectedTargetHead = await git(projectRoot, ["rev-parse", "feature-base"]);
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Target Advance",
            worktreeRoot,
        });
        await git(projectRoot, ["checkout", "main"]);
        await git(projectRoot, ["checkout", "feature-base"]);
        await fsWriteFile(`${projectRoot}/target.txt`, "target advanced\n");
        await git(projectRoot, ["add", "target.txt"]);
        await git(projectRoot, ["commit", "-m", "advance target"]);
        await git(projectRoot, ["checkout", "main"]);
        await fsWriteFile(`${worktree.path}/work.txt`, "work\n");

        const error = await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch: worktree?.branch || "",
                    targetBranch: "feature-base",
                    worktreePath: worktree?.path,
                    expectedTargetHead,
                }),
            Error,
            "Target branch feature-base advanced before publication; rerun Workflow Validation.",
        );
        assertEquals(/** @type {any} */ (error).mergeFailureKind, "target_branch_advanced");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({ projectRoot, path: worktree.path, force: true });
        }
        await fsRm(projectRoot, { recursive: true });
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("mergeExecutionWorktree reports missing target branch without merging into current checkout", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Missing Target",
            worktreeRoot,
        });
        const worktreePath = worktree.path;
        const worktreeBranch = worktree.branch;
        await fsWriteFile(`${worktreePath}/feature.txt`, "feature\n");

        await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch: worktreeBranch,
                    targetBranch: "missing-target",
                    worktreePath,
                }),
            Error,
            "missing-target",
        );
        await assertRejects(() => git(projectRoot, ["show", "HEAD:feature.txt"]), Error);
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

test("mergeExecutionWorktree includes uncommitted worktree changes", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Uncommitted Merge",
            worktreeRoot,
        });
        await fsWriteFile(`${worktree.path}/README.md`, "base\nchanged\n");
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");

        const planName = "session-host-multi-session-refactor/05-worktree-commit-message-subject";
        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            worktreePath: worktree.path,
            allowedDirtyPaths: [".wld/"],
            planName,
            planDescription: "Reference the plan description in dirty worktree commits.",
        });

        assertEquals(await fsReadFile(`${projectRoot}/README.md`, "utf8"), "base\nchanged\n");
        assertEquals(await fsReadFile(`${projectRoot}/feature.txt`, "utf8"), "feature\n");
        const commitMessage = await git(worktree.path, ["log", "-1", "--format=%B"]);
        assertStringIncludes(commitMessage, `Complete ${planName}`);
        assertStringIncludes(commitMessage, `- Plan: ${planName}`);
        assertStringIncludes(
            commitMessage,
            "- Description: Reference the plan description in dirty worktree commits.",
        );
        assertEquals(commitMessage.includes("Apply execution worktree changes"), false);
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

test("checkpointExecutionWorktree commits tracked and untracked implementation changes", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Checkpoint",
            worktreeRoot,
        });
        await fsWriteFile(`${worktree.path}/README.md`, "base\ncheckpointed\n");
        await fsWriteFile(`${worktree.path}/new-feature.js`, "export const ready = true;\n");

        const checkpoint = await checkpointExecutionWorktree({
            worktreePath: worktree.path,
            branch: worktree.branch,
            planName: "checkpoint-plan",
            planDescription: "Preserve implementation work before lifecycle completion.",
        });

        assertEquals(await git(worktree.path, ["status", "--porcelain"]), "");
        assertEquals(checkpoint.executionCommit, await git(worktree.path, ["rev-parse", "HEAD"]));
        assertEquals(await git(worktree.path, ["show", "HEAD:new-feature.js"]), "export const ready = true;");
        assertStringIncludes(await git(worktree.path, ["log", "-1", "--format=%B"]), "Complete checkpoint-plan");
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            }).catch(() => {});
        }
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("removeWorktreeGitArtifacts preserves unexpected dirty work unless force is explicit", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Preserve Dirty",
            worktreeRoot,
        });
        await fsWriteFile(`${worktree.path}/valuable-repair.js`, "export const repaired = true;\n");

        await assertRejects(
            () =>
                removeWorktreeGitArtifacts({
                    projectRoot,
                    path: worktree?.path || "",
                    force: false,
                }),
            Error,
        );

        assertEquals((await fsStat(`${worktree.path}/valuable-repair.js`)).isFile(), true);
        assertEquals(await git(projectRoot, ["show-ref", "--verify", `refs/heads/${worktree.branch}`]) !== "", true);
    } finally {
        if (worktree) {
            await removeWorktreeGitArtifacts({
                projectRoot,
                path: worktree.path,
                force: true,
            }).catch(() => {});
        }
        await fsRm(projectRoot, { recursive: true }).catch(() => {});
        await fsRm(worktreeRoot, { recursive: true }).catch(() => {});
    }
});

test("mergeExecutionWorktree allows unrelated dirty primary checkout changes", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Unrelated Dirty Merge",
            worktreeRoot,
        });
        await fsWriteFile(`${worktree.path}/feature.txt`, "feature\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "feature"]);
        await fsWriteFile(`${projectRoot}/ODO.md`, "scratch note\n");

        await mergeExecutionWorktree({
            projectRoot,
            branch: worktree.branch,
            worktreePath: worktree.path,
        });

        assertEquals(await fsReadFile(`${projectRoot}/feature.txt`, "utf8"), "feature\n");
        assertEquals(await fsReadFile(`${projectRoot}/ODO.md`, "utf8"), "scratch note\n");
        assertMatch(await git(projectRoot, ["status", "--porcelain"]), /\?\? ODO\.md/);
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

test("mergeExecutionWorktree refuses dirty primary changes that overlap branch changes", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Dirty Merge",
            worktreeRoot,
        });
        await fsWriteFile(`${worktree.path}/README.md`, "base\nfeature\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "feature"]);
        await fsWriteFile(`${projectRoot}/README.md`, "base\nprimary scratch\n");
        const branch = worktree.branch;

        await assertRejects(
            () => mergeExecutionWorktree({ projectRoot, branch }),
            Error,
            "Primary checkout has uncommitted changes that overlap execution worktree changes",
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

test("mergeExecutionWorktree continues an in-progress resolved merge", async () => {
    const projectRoot = await makeRepo();
    const worktreeRoot = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    /** @type {Awaited<ReturnType<typeof createTestWorktreeAttempt>> | undefined} */
    let worktree;
    try {
        worktree = await createTestWorktreeAttempt({
            projectRoot,
            planName: "Continue Merge",
            worktreeRoot,
        });
        const branch = worktree.branch;
        const worktreePath = worktree.path;
        await fsWriteFile(`${worktree.path}/README.md`, "base\nfeature\n");
        await git(worktree.path, ["add", "."]);
        await git(worktree.path, ["commit", "-m", "feature"]);

        await fsWriteFile(`${projectRoot}/README.md`, "base\nprimary\n");
        await git(projectRoot, ["add", "."]);
        await git(projectRoot, ["commit", "-m", "primary"]);

        await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot,
                    branch,
                    worktreePath,
                }),
            Error,
            "CONFLICT",
        );

        await fsWriteFile(`${projectRoot}/README.md`, "base\nprimary\nfeature\n");
        await git(projectRoot, ["add", "README.md"]);

        await mergeExecutionWorktree({
            projectRoot,
            branch,
            worktreePath,
        });

        assertEquals(await fsReadFile(`${projectRoot}/README.md`, "utf8"), "base\nprimary\nfeature\n");
        assertEquals(await git(projectRoot, ["status", "--porcelain"]), "");
        assertEquals(await git(projectRoot, ["log", "-1", "--pretty=%s"]), `Merge branch '${branch}'`);
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
