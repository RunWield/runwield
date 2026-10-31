import process from "node:process";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../testing/assertions.ts";
import { dirname, join } from "node:path";
import { defineGitFixture, git } from "./git-test-fixture.ts";
import { getWorktreeRegistryPath } from "./worktree-registry.js";
import { stageGitChangesExcludingRuntime } from "./git-runtime-safety.ts";
import { checkpointExecutionPreparation, checkpointExecutionWorktree, mergeExecutionWorktree } from "./worktree.js";

const repo = defineGitFixture(async (repoPath) => {
    await fsWriteFile(join(repoPath, "README.md"), "base\n");
    await fsWriteFile(join(repoPath, ".gitignore"), ".wld/plan-locks\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

async function makeWorktree(cwd: string, branch: string) {
    const worktreePath = `${cwd}-${branch}`;
    await git(cwd, ["worktree", "add", "-b", branch, worktreePath, "main"]);
    return worktreePath;
}

test("execution runtime state does not enter the merge when primary .wld is untracked", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-side");
    try {
        const registryPath = getWorktreeRegistryPath(cwd);
        await fsMkdir(dirname(registryPath), { recursive: true });
        await fsWriteFile(registryPath, "primary registry\n");
        const registryBefore = await fsReadFile(registryPath, "utf8");
        await fsMkdir(join(worktreePath, ".wld", "plan-locks"), { recursive: true });
        await fsMkdir(join(worktreePath, ".wld", "plan-transitions"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "plan-transitions", "x.json"), "{}\n");
        await fsWriteFile(join(worktreePath, "feature.txt"), "work\n");

        await checkpointExecutionWorktree({ worktreePath, branch: "runtime-side" });
        await mergeExecutionWorktree({ projectRoot: cwd, branch: "runtime-side", targetBranch: "main", worktreePath });

        assertEquals(await fsReadFile(registryPath, "utf8"), registryBefore);
        assertEquals(await fsReadFile(join(cwd, "feature.txt"), "utf8"), "work\n");
        assertEquals(
            (await git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"])).includes(".wld/plan-transitions/x.json"),
            false,
        );
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint ignores gitignored RunWield runtime state", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "ignored-runtime-side");
    try {
        await fsWriteFile(join(worktreePath, ".gitignore"), ".wld/plan-locks\n");
        await fsMkdir(join(worktreePath, ".wld", "plan-locks"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "plan-locks", "x.json"), "{}\n");
        await fsWriteFile(join(worktreePath, "feature.txt"), "work\n");

        await checkpointExecutionWorktree({ worktreePath, branch: "ignored-runtime-side" });

        const committedPaths = await git(worktreePath, ["ls-tree", "-r", "--name-only", "HEAD"]);
        assertEquals(committedPaths.includes("feature.txt"), true);
        assertEquals(committedPaths.includes(".wld/plan-locks/x.json"), false);
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint preserves removal of a tracked file whose working copy is now ignored", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "ignored-generated-side");
    try {
        await fsWriteFile(join(worktreePath, ".gitignore"), ".wld/plan-locks\n.astro/\n");
        await fsMkdir(join(worktreePath, ".astro"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".astro", "settings.json"), "generated\n");
        await git(worktreePath, ["add", ".gitignore"]);
        await git(worktreePath, ["add", "-f", ".astro/settings.json"]);
        await git(worktreePath, ["commit", "-m", "track old generated settings"]);

        await git(worktreePath, ["rm", "--cached", ".astro/settings.json"]);
        await fsWriteFile(join(worktreePath, "feature.txt"), "work\n");

        await checkpointExecutionWorktree({ worktreePath, branch: "ignored-generated-side" });

        const committedPaths = await git(worktreePath, ["ls-tree", "-r", "--name-only", "HEAD"]);
        assertEquals(committedPaths.includes("feature.txt"), true);
        assertEquals(committedPaths.includes(".astro/settings.json"), false);
        assertEquals(await fsReadFile(join(worktreePath, ".astro", "settings.json"), "utf8"), "generated\n");
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
        await fsRm(worktreePath, { recursive: true }).catch(() => {});
    }
});

test("resumed local merge refuses runtime history before continuing", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-resumed-merge");
    try {
        await fsMkdir(join(cwd, "docs", "plans"), { recursive: true });
        await fsWriteFile(join(cwd, "docs", "plans", "resume.md"), "base\n");
        await git(cwd, ["add", "docs/plans/resume.md"]);
        await git(cwd, ["commit", "-m", "plan base"]);
        await git(worktreePath, ["merge", "main"]);
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "old.json"), "runtime\n");
        await git(worktreePath, ["add", ".wld/internal/old.json"]);
        await git(worktreePath, ["commit", "-m", "track runtime"]);
        await fsRm(join(worktreePath, ".wld", "internal", "old.json"));
        await fsWriteFile(join(worktreePath, "docs", "plans", "resume.md"), "branch\n");
        await git(worktreePath, ["add", "."]);
        await git(worktreePath, ["commit", "-m", "remove runtime with plan change"]);
        await fsWriteFile(join(cwd, "docs", "plans", "resume.md"), "target\n");
        await git(cwd, ["add", "docs/plans/resume.md"]);
        await git(cwd, ["commit", "-m", "target plan change"]);
        const mainBefore = await git(cwd, ["rev-parse", "HEAD"]);
        await git(cwd, ["merge", "--no-ff", "runtime-resumed-merge"]).catch(() => "");

        const error = await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot: cwd,
                    branch: "runtime-resumed-merge",
                    targetBranch: "main",
                    preservePlanPaths: ["docs/plans/resume.md"],
                }),
            Error,
            "publication candidate contains RunWield runtime paths",
        );

        assertStringIncludes(error.message, ".wld/internal/old.json");
        assertEquals(await git(cwd, ["rev-parse", "HEAD"]), mainBefore);
    } finally {
        await git(cwd, ["merge", "--abort"]).catch(() => {});
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("publication refuses runtime history even when the final tree is clean", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-committed-side");
    try {
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "collaboration-secrets.json"), "{}\n");
        await git(worktreePath, ["add", ".wld/internal/collaboration-secrets.json"]);
        await git(worktreePath, ["commit", "-m", "old runtime"]);
        await fsRm(join(worktreePath, ".wld", "internal", "collaboration-secrets.json"));
        await fsWriteFile(join(worktreePath, "feature.txt"), "work\n");
        await git(worktreePath, ["add", "."]);
        await git(worktreePath, ["commit", "-m", "remove runtime and add feature"]);
        const mainBefore = await git(cwd, ["rev-parse", "main"]);
        const branchBefore = await git(worktreePath, ["rev-parse", "HEAD"]);

        const error = await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot: cwd,
                    branch: "runtime-committed-side",
                    targetBranch: "main",
                    worktreePath,
                }),
            Error,
            "publication candidate contains RunWield runtime paths",
        );

        assertStringIncludes(error.message, ".wld/internal/collaboration-secrets.json");
        assertStringIncludes(error.message, "rotate any related capability secret");
        assertEquals(await git(cwd, ["rev-parse", "main"]), mainBefore);
        assertEquals(await git(worktreePath, ["rev-parse", "HEAD"]), branchBefore);
        await assertRejects(() => fsReadFile(join(cwd, "feature.txt"), "utf8"));
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("publication refuses runtime history from a merged side branch", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-merged-side");
    try {
        await git(worktreePath, ["checkout", "-b", "runtime-source-side"]);
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "side.json"), "runtime\n");
        await git(worktreePath, ["add", ".wld/internal/side.json"]);
        await git(worktreePath, ["commit", "-m", "track side runtime"]);
        await fsRm(join(worktreePath, ".wld", "internal", "side.json"));
        await git(worktreePath, ["add", ".wld/internal/side.json"]);
        await git(worktreePath, ["commit", "-m", "remove side runtime"]);
        await git(worktreePath, ["checkout", "runtime-merged-side"]);
        await git(worktreePath, ["merge", "--no-ff", "runtime-source-side", "-m", "Merge side runtime history"]);
        await fsWriteFile(join(worktreePath, "feature.txt"), "safe final tree\n");
        await git(worktreePath, ["add", "feature.txt"]);
        await git(worktreePath, ["commit", "-m", "safe final work"]);
        const mainBefore = await git(cwd, ["rev-parse", "main"]);

        const error = await assertRejects(
            () =>
                mergeExecutionWorktree({
                    projectRoot: cwd,
                    branch: "runtime-merged-side",
                    targetBranch: "main",
                    worktreePath,
                }),
            Error,
            "publication candidate contains RunWield runtime paths",
        );

        assertStringIncludes(error.message, ".wld/internal/side.json");
        assertEquals(await git(cwd, ["rev-parse", "main"]), mainBefore);
        await assertRejects(() => fsReadFile(join(cwd, "feature.txt"), "utf8"));
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("preparation checkpoint refuses tracked runtime state before committing plan metadata", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-preparation");
    try {
        const baseCommit = await git(worktreePath, ["rev-parse", "HEAD"]);
        await fsMkdir(join(worktreePath, "docs", "plans"), { recursive: true });
        await fsWriteFile(join(worktreePath, "docs", "plans", "runtime-preparation.md"), "plan\n");
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "state.json"), "runtime\n");
        await git(worktreePath, ["add", "-N", ".wld/internal/state.json"]);

        await assertRejects(
            () =>
                checkpointExecutionPreparation({
                    worktreePath,
                    branch: "runtime-preparation",
                    baseCommit,
                    planName: "runtime-preparation",
                    planRelativePath: "docs/plans/runtime-preparation.md",
                }),
            Error,
            "runtime paths are tracked or staged",
        );

        assertEquals(await git(worktreePath, ["rev-parse", "HEAD"]), baseCommit);
        await assertRejects(() => git(worktreePath, ["show", "HEAD:docs/plans/runtime-preparation.md"]));
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint keeps current runtime untracked while committing user wld files", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "current-runtime-and-config");
    try {
        await fsMkdir(join(worktreePath, ".wld", "internal", "future"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "future", "state.json"), "runtime\n");
        await fsMkdir(join(worktreePath, ".wld", "agents"), { recursive: true });
        await fsMkdir(join(worktreePath, ".wld", "skills", "local"), { recursive: true });
        await fsMkdir(join(worktreePath, ".wld", "prompts"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "settings.json"), "{}\n");
        await fsWriteFile(join(worktreePath, ".wld", "agents", "agent.md"), "agent\n");
        await fsWriteFile(join(worktreePath, ".wld", "skills", "local", "SKILL.md"), "skill\n");
        await fsWriteFile(join(worktreePath, ".wld", "prompts", "prompt.md"), "prompt\n");

        await checkpointExecutionWorktree({ worktreePath, branch: "current-runtime-and-config" });

        const committedPaths = await git(worktreePath, ["ls-tree", "-r", "--name-only", "HEAD"]);
        assertStringIncludes(committedPaths, ".wld/settings.json");
        assertStringIncludes(committedPaths, ".wld/agents/agent.md");
        assertStringIncludes(committedPaths, ".wld/skills/local/SKILL.md");
        assertStringIncludes(committedPaths, ".wld/prompts/prompt.md");
        assertEquals(committedPaths.includes(".wld/internal/future/state.json"), false);
        assertEquals(
            await fsReadFile(join(worktreePath, ".wld", "internal", "future", "state.json"), "utf8"),
            "runtime\n",
        );
        assertEquals(await git(worktreePath, ["diff", "--cached", "--name-only"]), "");
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint commits safe pathspec-like names while leaving runtime untracked", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "pathspec-like-safe-files");
    const safeName = process.platform === "win32" ? "safe [file].txt" : ":(glob) safe [file].txt";
    const safePath = join(worktreePath, safeName);
    try {
        await fsWriteFile(safePath, "safe\n");
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "state.json"), "runtime\n");

        await checkpointExecutionWorktree({ worktreePath, branch: "pathspec-like-safe-files" });

        const committedPaths = await git(worktreePath, ["ls-tree", "-r", "--name-only", "HEAD"]);
        assertStringIncludes(committedPaths, safeName);
        assertEquals(committedPaths.includes(".wld/internal/state.json"), false);
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint refuses runtime deletions and rename endpoints", async () => {
    const cwd = await repo.checkout();
    const deletionWorktree = await makeWorktree(cwd, "runtime-delete-side");
    const renameWorktree = await makeWorktree(cwd, "runtime-rename-side");
    try {
        await fsMkdir(join(deletionWorktree, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(deletionWorktree, ".wld", "internal", "tracked.json"), "runtime\n");
        await git(deletionWorktree, ["add", "-f", ".wld/internal/tracked.json"]);
        await git(deletionWorktree, ["commit", "-m", "track runtime"]);
        await fsRm(join(deletionWorktree, ".wld", "internal", "tracked.json"));
        await git(deletionWorktree, ["add", ".wld/internal/tracked.json"]);
        const deletionHead = await git(deletionWorktree, ["rev-parse", "HEAD"]);

        const deletionError = await assertRejects(
            () => checkpointExecutionWorktree({ worktreePath: deletionWorktree, branch: "runtime-delete-side" }),
            Error,
            "runtime paths are tracked or staged",
        );
        assertStringIncludes(deletionError.message, ".wld/internal/tracked.json");
        assertEquals(await git(deletionWorktree, ["rev-parse", "HEAD"]), deletionHead);
        assertStringIncludes(await git(deletionWorktree, ["diff", "--cached", "--name-status"]), "D");

        await fsWriteFile(join(renameWorktree, "safe.txt"), "safe\n");
        await git(renameWorktree, ["add", "safe.txt"]);
        await git(renameWorktree, ["commit", "-m", "track safe"]);
        await fsMkdir(join(renameWorktree, ".wld", "internal"), { recursive: true });
        await git(renameWorktree, ["mv", "-f", "safe.txt", ".wld/internal/renamed.json"]);
        const renameHead = await git(renameWorktree, ["rev-parse", "HEAD"]);

        const renameError = await assertRejects(
            () => checkpointExecutionWorktree({ worktreePath: renameWorktree, branch: "runtime-rename-side" }),
            Error,
            "runtime paths are tracked or staged",
        );
        assertStringIncludes(renameError.message, ".wld/internal/renamed.json");
        assertEquals(await git(renameWorktree, ["rev-parse", "HEAD"]), renameHead);
    } finally {
        await git(cwd, ["worktree", "remove", "--force", deletionWorktree]).catch(() => {});
        await git(cwd, ["worktree", "remove", "--force", renameWorktree]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("runtime staging excludes legacy temporary files and Work Record locks while preserving partially staged user content", async () => {
    const cwd = await repo.checkout();
    try {
        await fsWriteFile(join(cwd, "feature.txt"), "one\ntwo\n");
        await git(cwd, ["add", "feature.txt"]);
        await git(cwd, ["commit", "-m", "feature base"]);
        await fsWriteFile(join(cwd, "feature.txt"), "staged\ntwo\n");
        await git(cwd, ["add", "feature.txt"]);
        await fsWriteFile(join(cwd, "feature.txt"), "staged\nunstaged\n");
        await fsMkdir(join(cwd, ".wld"), { recursive: true });
        await fsWriteFile(join(cwd, ".wld", "worktrees.json.token.tmp"), "tmp\n");
        await fsWriteFile(join(cwd, ".wld", "collaboration-secrets.json.token.tmp"), "secret\n");
        await fsWriteFile(join(cwd, ".wld", "work-record-supersession.lock"), "lock\n");
        await fsWriteFile(join(cwd, ".wld", "work-record-supersession-recovery.lock"), "lock\n");

        await stageGitChangesExcludingRuntime(cwd);

        const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
        assertStringIncludes(staged, "feature.txt");
        assertEquals(staged.includes(".wld/worktrees.json.token.tmp"), false);
        assertEquals(staged.includes(".wld/collaboration-secrets.json.token.tmp"), false);
        assertEquals(staged.includes(".wld/work-record-supersession.lock"), false);
        assertEquals(staged.includes(".wld/work-record-supersession-recovery.lock"), false);
        assertStringIncludes(await git(cwd, ["diff", "--cached", "--", "feature.txt"]), "+unstaged");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint refusal preserves partially staged user content", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-index-preserves-partial");
    try {
        await fsWriteFile(join(worktreePath, "feature.txt"), "one\ntwo\n");
        await git(worktreePath, ["add", "feature.txt"]);
        await git(worktreePath, ["commit", "-m", "feature base"]);
        await fsWriteFile(join(worktreePath, "feature.txt"), "staged\ntwo\n");
        await git(worktreePath, ["add", "feature.txt"]);
        const stagedBefore = await git(worktreePath, ["diff", "--cached", "--", "feature.txt"]);
        await fsWriteFile(join(worktreePath, "feature.txt"), "staged\nunstaged\n");
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "staged.json"), "runtime\n");
        await git(worktreePath, ["add", "-N", ".wld/internal/staged.json"]);

        await assertRejects(
            () => checkpointExecutionWorktree({ worktreePath, branch: "runtime-index-preserves-partial" }),
            Error,
            "runtime paths are tracked or staged",
        );

        assertEquals(await git(worktreePath, ["diff", "--cached", "--", "feature.txt"]), stagedBefore);
        assertStringIncludes(await git(worktreePath, ["diff", "--", "feature.txt"]), "+unstaged");
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("checkpoint refuses runtime paths already in the index", async () => {
    const cwd = await repo.checkout();
    const worktreePath = await makeWorktree(cwd, "runtime-index-side");
    try {
        await fsMkdir(join(worktreePath, ".wld", "internal"), { recursive: true });
        await fsWriteFile(join(worktreePath, ".wld", "internal", "staged.json"), "runtime\n");
        await fsWriteFile(join(worktreePath, "feature.txt"), "work\n");
        await git(worktreePath, ["add", "-N", ".wld/internal/staged.json"]);
        const headBefore = await git(worktreePath, ["rev-parse", "HEAD"]);
        const indexBefore = await git(worktreePath, ["ls-files", "--stage", "--", ".wld/internal/staged.json"]);
        assertStringIncludes(indexBefore, ".wld/internal/staged.json");

        const error = await assertRejects(
            () => checkpointExecutionWorktree({ worktreePath, branch: "runtime-index-side" }),
            Error,
            "runtime paths are tracked or staged",
        );

        assertStringIncludes(error.message, ".wld/internal/staged.json");
        assertEquals(await git(worktreePath, ["rev-parse", "HEAD"]), headBefore);
        assertEquals(await git(worktreePath, ["ls-files", "--stage", "--", ".wld/internal/staged.json"]), indexBefore);
        assertEquals(await fsReadFile(join(worktreePath, "feature.txt"), "utf8"), "work\n");
    } finally {
        await git(cwd, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});
