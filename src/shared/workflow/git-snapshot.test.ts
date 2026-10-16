import { captureForegroundProcess } from "../captured-process.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineGitFixture, git as fixtureGit } from "../git-test-fixture.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import {
    captureWorktreeTree,
    getWorkflowDiff,
    getWorktreeReviewDiff,
    listCommitsTouchingPathsSince,
    readWorktreeReviewBaseFile,
    resolveWorktreeReviewBaseTree,
    restoreWorktreeTree,
    WorktreeReviewComparisonError,
    WorktreeReviewTargetError,
} from "./git-snapshot.ts";
import { GitRepositoryRequiredError } from "../git.ts";

async function git(cwd: string, args: string[]): Promise<string> {
    const { code, stdout, stderr } = await captureForegroundProcess("git", { cwd, args });
    const decoder = new TextDecoder();
    const out = decoder.decode(stdout);
    const err = decoder.decode(stderr);
    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
    }
    return out;
}

test("getWorkflowDiff excludes dirty worktree changes that existed before the baseline", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-snapshot-test-"));
    try {
        await git(dir, ["init"]);
        await fsWriteFile(`${dir}/preexisting.js`, "before baseline\n");

        const baselineTree = await captureWorktreeTree(dir);

        await fsWriteFile(`${dir}/preexisting.js`, "before baseline\n");
        await fsWriteFile(`${dir}/changed.js`, "workflow change\n");

        const diff = await getWorkflowDiff(dir, baselineTree);

        assertEquals(diff.includes("preexisting.js"), false);
        assertStringIncludes(diff, "changed.js");
        assertStringIncludes(diff, "workflow change");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff excludes target work imported after the execution baseline", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/shared.js`, "base\n");
        await git(dir, ["add", "shared.js"]);
        await git(dir, ["commit", "-m", "base"]);
        await git(dir, ["switch", "-c", "execution"]);
        const executionBaseline = await captureWorktreeTree(dir);
        await fsWriteFile(`${dir}/execution.js`, "execution commit\n");
        await git(dir, ["add", "execution.js"]);
        await git(dir, ["commit", "-m", "execution behavior"]);

        await git(dir, ["switch", "target"]);
        await fsWriteFile(`${dir}/inherited.js`, "target behavior\n");
        await git(dir, ["add", "inherited.js"]);
        await git(dir, ["commit", "-m", "target behavior"]);
        await git(dir, ["switch", "execution"]);
        await git(dir, ["merge", "--no-edit", "target"]);
        await fsWriteFile(`${dir}/plan-change.js`, "plan behavior\n");

        const oldDiff = await getWorkflowDiff(dir, executionBaseline);
        const reviewDiff = await getWorktreeReviewDiff(dir, "target");

        assertStringIncludes(oldDiff, "inherited.js");
        assertEquals(reviewDiff.includes("inherited.js"), false);
        assertStringIncludes(reviewDiff, "execution.js");
        assertStringIncludes(reviewDiff, "plan-change.js");
        assertStringIncludes(reviewDiff, "plan behavior");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff returns one net patch and preserves checkout state", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/committed.js`, "target committed\n");
        await fsWriteFile(`${dir}/mixed.js`, "target mixed\n");
        await fsWriteFile(`${dir}/deleted.js`, "target deleted\n");
        await fsWriteFile(`${dir}/undone.js`, "target bytes\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target"]);
        const targetTip = (await git(dir, ["rev-parse", "target"])).trim();
        await git(dir, ["switch", "-c", "execution"]);

        await fsWriteFile(`${dir}/committed.js`, "execution commit\n");
        await git(dir, ["add", "committed.js"]);
        await git(dir, ["commit", "-m", "execution commit"]);
        await fsWriteFile(`${dir}/staged.js`, "staged addition\n");
        await fsWriteFile(`${dir}/mixed.js`, "staged mixed\n");
        await git(dir, ["add", "staged.js", "mixed.js"]);
        await fsWriteFile(`${dir}/mixed.js`, "final mixed\n");
        await fsWriteFile(`${dir}/unstaged.js`, "unstaged addition\n");
        await fsWriteFile(`${dir}/untracked.js`, "untracked addition\n");
        await fsRm(`${dir}/deleted.js`);
        await fsWriteFile(`${dir}/undone.js`, "temporary\n");
        await fsWriteFile(`${dir}/undone.js`, "target bytes\n");

        const statusBefore = await git(dir, ["status", "--porcelain=v1"]);
        const indexBefore = await fsReadFile(`${dir}/.git/index`).catch(() => new Uint8Array());
        const executionTip = (await git(dir, ["rev-parse", "HEAD"])).trim();
        const diff = await getWorktreeReviewDiff(dir, "target");

        assertStringIncludes(diff, "+execution commit");
        assertStringIncludes(diff, "+staged addition");
        assertStringIncludes(diff, "+final mixed");
        assertStringIncludes(diff, "+unstaged addition");
        assertStringIncludes(diff, "+untracked addition");
        assertStringIncludes(diff, "-target deleted");
        assertEquals(diff.includes("staged mixed"), false);
        assertEquals(diff.includes("undone.js"), false);
        assertEquals((diff.match(/diff --git a\/mixed\.js b\/mixed\.js/g) || []).length, 1);
        assertEquals(await git(dir, ["status", "--porcelain=v1"]), statusBefore);
        assertEquals(await fsReadFile(`${dir}/.git/index`).catch(() => new Uint8Array()), indexBefore);
        assertEquals((await git(dir, ["rev-parse", "HEAD"])).trim(), executionTip);
        assertEquals((await git(dir, ["rev-parse", "target"])).trim(), targetTip);
        assertEquals(await fsReadFile(`${dir}/mixed.js`, "utf8"), "final mixed\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff preserves unchanged tracked files that match ignore rules", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/.gitignore`, "ignored.txt\n");
        await fsWriteFile(`${dir}/ignored.txt`, "tracked target bytes\n");
        await git(dir, ["add", ".gitignore"]);
        await git(dir, ["add", "-f", "ignored.txt"]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "-c", "execution"]);

        const diff = await getWorktreeReviewDiff(dir, "target");

        assertEquals(diff, "");
        assertEquals(await fsReadFile(`${dir}/ignored.txt`, "utf8"), "tracked target bytes\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff includes ignored files tracked only by the real index", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/.gitignore`, "ignored.txt\n");
        await git(dir, ["add", ".gitignore"]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "-c", "execution"]);
        await fsWriteFile(`${dir}/ignored.txt`, "staged ignored bytes\n");
        await git(dir, ["add", "-f", "ignored.txt"]);

        const diff = await getWorktreeReviewDiff(dir, "target");

        assertStringIncludes(diff, "ignored.txt");
        assertStringIncludes(diff, "+staged ignored bytes");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff does not delete a restored ignored file tracked by the real index", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/.gitignore`, "ignored.txt\n");
        await fsWriteFile(`${dir}/ignored.txt`, "target bytes\n");
        await git(dir, ["add", ".gitignore"]);
        await git(dir, ["add", "-f", "ignored.txt"]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "-c", "execution"]);
        await git(dir, ["rm", "ignored.txt"]);
        await git(dir, ["commit", "-m", "delete ignored file"]);
        await fsWriteFile(`${dir}/ignored.txt`, "target bytes\n");
        await git(dir, ["add", "-f", "ignored.txt"]);

        const diff = await getWorktreeReviewDiff(dir, "target");

        assertEquals(diff, "");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff shows proposed branch work without reversing target-only changes", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/target-modified.js`, "base target bytes\n");
        await fsWriteFile(`${dir}/target-deleted.js`, "base target deletion\n");
        await fsWriteFile(`${dir}/both.js`, "base shared bytes\n");
        await fsWriteFile(`${dir}/execution-deleted.js`, "base execution deletion\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "base"]);
        const commonAncestor = (await git(dir, ["rev-parse", "HEAD"])).trim();
        await git(dir, ["switch", "-c", "execution"]);

        await git(dir, ["switch", "target"]);
        await fsWriteFile(`${dir}/target-only.js`, "target addition\n");
        await fsWriteFile(`${dir}/target-modified.js`, "target modification\n");
        await fsWriteFile(`${dir}/both.js`, "target shared bytes\n");
        await fsRm(`${dir}/target-deleted.js`);
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-m", "target work"]);

        await git(dir, ["switch", "execution"]);
        await fsWriteFile(`${dir}/execution-committed.js`, "execution commit\n");
        await git(dir, ["add", "execution-committed.js"]);
        await git(dir, ["commit", "-m", "execution work"]);
        await fsWriteFile(`${dir}/both.js`, "execution shared bytes\n");
        await fsWriteFile(`${dir}/execution-untracked.js`, "execution untracked\n");
        await fsRm(`${dir}/execution-deleted.js`);

        const currentTree = await captureWorktreeTree(dir);
        const expected = await git(dir, ["diff", `${commonAncestor}..${currentTree}`]);
        const actual = await getWorktreeReviewDiff(dir, "target");

        assertEquals(actual, expected);
        assertStringIncludes(actual, "+execution commit");
        assertStringIncludes(actual, "+execution shared bytes");
        assertStringIncludes(actual, "+execution untracked");
        assertStringIncludes(actual, "-base execution deletion");
        assertEquals(actual.includes("target-only.js"), false);
        assertEquals(actual.includes("target modification"), false);
        assertEquals(actual.includes("target deletion"), false);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff is empty when only the target advances", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/base.js`, "base\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "base"]);
        await git(dir, ["switch", "-c", "execution"]);
        await git(dir, ["switch", "target"]);
        await fsWriteFile(`${dir}/target-only.js`, "target addition\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target work"]);
        await git(dir, ["switch", "execution"]);

        assertEquals(await getWorktreeReviewDiff(dir, "target"), "");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff rejects a missing target", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "execution"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/base.js`, "base\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "base"]);

        await assertRejects(
            () => getWorktreeReviewDiff(dir, "missing-target"),
            WorktreeReviewTargetError,
            "refs/heads/missing-target",
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff rejects an unavailable execution HEAD", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/target.js`, "target\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["symbolic-ref", "HEAD", "refs/heads/execution"]);

        await assertRejects(
            () => getWorktreeReviewDiff(dir, "target"),
            WorktreeReviewComparisonError,
            "execution HEAD is unavailable",
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("getWorktreeReviewDiff rejects unrelated target and execution histories", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-review-diff-test-"));
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${dir}/target.js`, "target\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "--orphan", "execution"]);
        await fsWriteFile(`${dir}/execution.js`, "execution\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "execution"]);

        await assertRejects(
            () => getWorktreeReviewDiff(dir, "target"),
            WorktreeReviewComparisonError,
            "no common ancestor",
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("listCommitsTouchingPathsSince returns commits scoped to affected paths", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-snapshot-test-"));
    try {
        await git(dir, ["init"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await fsMkdir(`${dir}/src`);

        await fsWriteFile(`${dir}/src/a.js`, "a1\n");
        await git(dir, ["add", "src/a.js"]);
        await git(dir, ["commit", "-m", "touch a"]);

        await fsWriteFile(`${dir}/src/b.js`, "b1\n");
        await git(dir, ["add", "src/b.js"]);
        await git(dir, ["commit", "-m", "touch b"]);

        const commits = await listCommitsTouchingPathsSince(dir, "1970-01-01T00:00:00Z", ["src/a.js"]);
        assertEquals(commits.length, 1);
        assertEquals(commits[0].subject, "touch a");

        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const futureCommits = await listCommitsTouchingPathsSince(dir, tomorrow, ["src/a.js"]);
        assertEquals(futureCommits, []);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("workflow snapshots include later tracked edits and preserve the real index", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-snapshot-test-"));
    try {
        await git(dir, ["init"]);
        await fsWriteFile(`${dir}/tracked.js`, "baseline\n");
        await fsWriteFile(`${dir}/staged.js`, "staged before\n");
        await git(dir, ["add", "tracked.js", "staged.js"]);
        const statusBefore = await git(dir, ["status", "--short"]);

        const baselineTree = await captureWorktreeTree(dir);

        await fsWriteFile(`${dir}/tracked.js`, "baseline\nworkflow edit\n");
        const diff = await getWorkflowDiff(dir, baselineTree);
        const statusAfter = await git(dir, ["status", "--short"]);

        assertStringIncludes(diff, "tracked.js");
        assertStringIncludes(diff, "workflow edit");
        assertEquals(statusAfter, statusBefore.replace("A  tracked.js", "AM tracked.js"));
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("restoreWorktreeTree refuses to overwrite checkout changes", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-snapshot-test-"));
    try {
        await git(dir, ["init"]);
        await fsWriteFile(`${dir}/kept.js`, "baseline\n");
        await fsMkdir(`${dir}/nested`);
        await fsWriteFile(`${dir}/nested/baseline.js`, "nested baseline\n");
        const baselineTree = await captureWorktreeTree(dir);

        await fsWriteFile(`${dir}/kept.js`, "changed after baseline\n");
        await fsWriteFile(`${dir}/added.js`, "added after baseline\n");
        await fsWriteFile(`${dir}/nested/later.js`, "later nested\n");

        await assertRejects(
            () => restoreWorktreeTree(dir, baselineTree),
            Error,
            "Refusing to restore execution baseline tree",
        );

        assertEquals(await fsReadFile(`${dir}/kept.js`, "utf8"), "changed after baseline\n");
        assertEquals(await fsReadFile(`${dir}/added.js`, "utf8"), "added after baseline\n");
        assertEquals(await fsReadFile(`${dir}/nested/later.js`, "utf8"), "later nested\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("restoreWorktreeTree keeps a matching checkout unchanged", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-snapshot-test-"));
    try {
        await git(dir, ["init"]);
        await git(dir, ["config", "core.autocrlf", "false"]);
        await fsWriteFile(`${dir}/kept.js`, "baseline\n");
        const baselineTree = await captureWorktreeTree(dir);

        await restoreWorktreeTree(dir, baselineTree);

        assertEquals(await fsReadFile(`${dir}/kept.js`, "utf8"), "baseline\n");
        assertEquals(await captureWorktreeTree(dir), baselineTree);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("git snapshot helpers fail gracefully outside Git", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-non-git-snapshot-"));
    try {
        await assertRejects(
            () => captureWorktreeTree(dir),
            GitRepositoryRequiredError,
            "Capturing an execution baseline tree requires a Git repository",
        );
        await assertRejects(
            () => getWorkflowDiff(dir, undefined),
            GitRepositoryRequiredError,
            "Computing a workflow diff requires a Git repository",
        );
        await assertRejects(
            () => listCommitsTouchingPathsSince(dir, new Date().toISOString(), ["README.md"]),
            GitRepositoryRequiredError,
            "Checking affected path commit history requires a Git repository",
        );
        await assertRejects(
            () => restoreWorktreeTree(dir, "abc123"),
            GitRepositoryRequiredError,
            "Restoring an execution baseline tree requires a Git repository",
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

const reviewBaseFixture = defineGitFixture(async (cwd) => {
    await fsWriteFile(`${cwd}/shared.js`, "merge base\n");
    await fixtureGit(cwd, ["add", "."]);
    await fixtureGit(cwd, ["commit", "-m", "base"]);
    await fixtureGit(cwd, ["switch", "-c", "execution"]);
    await fixtureGit(cwd, ["switch", "main"]);
    await fsWriteFile(`${cwd}/shared.js`, "target advanced\n");
    await fixtureGit(cwd, ["add", "."]);
    await fixtureGit(cwd, ["commit", "-m", "target advance"]);
    await fixtureGit(cwd, ["switch", "execution"]);
    await fsWriteFile(`${cwd}/shared.js`, "execution text\n");
    await fsWriteFile(`${cwd}/added.js`, "addition\n");
});

test("review base file returns merge-base text rather than advanced target or worktree text", async () => {
    const cwd = await reviewBaseFixture.checkout();
    try {
        assertEquals(await readWorktreeReviewBaseFile(cwd, "main", "shared.js"), "merge base\n");
        assertEquals(
            await resolveWorktreeReviewBaseTree(cwd, "main"),
            await fixtureGit(cwd, ["rev-parse", "HEAD^{tree}"]),
        );
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("review base file returns null for a worktree-only addition", async () => {
    const cwd = await reviewBaseFixture.checkout();
    try {
        assertEquals(await readWorktreeReviewBaseFile(cwd, "main", "added.js"), null);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});

test("review base file rejects an unavailable target", async () => {
    const cwd = await reviewBaseFixture.checkout();
    try {
        await assertRejects(() => readWorktreeReviewBaseFile(cwd, "missing", "shared.js"), WorktreeReviewTargetError);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});
