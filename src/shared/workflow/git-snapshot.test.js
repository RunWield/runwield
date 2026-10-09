import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
    captureWorktreeTree,
    getWorkflowDiff,
    getWorktreeReviewDiff,
    listCommitsTouchingPathsSince,
    restoreWorktreeTree,
    WorktreeReviewComparisonError,
    WorktreeReviewTargetError,
} from "./git-snapshot.ts";
import { GitRepositoryRequiredError } from "../git.ts";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, args) {
    const command = new Deno.Command("git", {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const decoder = new TextDecoder();
    const out = decoder.decode(stdout);
    const err = decoder.decode(stderr);
    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
    }
    return out;
}

Deno.test("getWorkflowDiff excludes dirty worktree changes that existed before the baseline", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-snapshot-test-" });
    try {
        await git(dir, ["init"]);
        await Deno.writeTextFile(`${dir}/preexisting.js`, "before baseline\n");

        const baselineTree = await captureWorktreeTree(dir);

        await Deno.writeTextFile(`${dir}/preexisting.js`, "before baseline\n");
        await Deno.writeTextFile(`${dir}/changed.js`, "workflow change\n");

        const diff = await getWorkflowDiff(dir, baselineTree);

        assertEquals(diff.includes("preexisting.js"), false);
        assertStringIncludes(diff, "changed.js");
        assertStringIncludes(diff, "workflow change");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff excludes target work imported after the execution baseline", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/shared.js`, "base\n");
        await git(dir, ["add", "shared.js"]);
        await git(dir, ["commit", "-m", "base"]);
        await git(dir, ["switch", "-c", "execution"]);
        const executionBaseline = await captureWorktreeTree(dir);
        await Deno.writeTextFile(`${dir}/execution.js`, "execution commit\n");
        await git(dir, ["add", "execution.js"]);
        await git(dir, ["commit", "-m", "execution behavior"]);

        await git(dir, ["switch", "target"]);
        await Deno.writeTextFile(`${dir}/inherited.js`, "target behavior\n");
        await git(dir, ["add", "inherited.js"]);
        await git(dir, ["commit", "-m", "target behavior"]);
        await git(dir, ["switch", "execution"]);
        await git(dir, ["merge", "--no-edit", "target"]);
        await Deno.writeTextFile(`${dir}/plan-change.js`, "plan behavior\n");

        const oldDiff = await getWorkflowDiff(dir, executionBaseline);
        const reviewDiff = await getWorktreeReviewDiff(dir, "target");

        assertStringIncludes(oldDiff, "inherited.js");
        assertEquals(reviewDiff.includes("inherited.js"), false);
        assertStringIncludes(reviewDiff, "execution.js");
        assertStringIncludes(reviewDiff, "plan-change.js");
        assertStringIncludes(reviewDiff, "plan behavior");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff returns one net patch and preserves checkout state", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/committed.js`, "target committed\n");
        await Deno.writeTextFile(`${dir}/mixed.js`, "target mixed\n");
        await Deno.writeTextFile(`${dir}/deleted.js`, "target deleted\n");
        await Deno.writeTextFile(`${dir}/undone.js`, "target bytes\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target"]);
        const targetTip = (await git(dir, ["rev-parse", "target"])).trim();
        await git(dir, ["switch", "-c", "execution"]);

        await Deno.writeTextFile(`${dir}/committed.js`, "execution commit\n");
        await git(dir, ["add", "committed.js"]);
        await git(dir, ["commit", "-m", "execution commit"]);
        await Deno.writeTextFile(`${dir}/staged.js`, "staged addition\n");
        await Deno.writeTextFile(`${dir}/mixed.js`, "staged mixed\n");
        await git(dir, ["add", "staged.js", "mixed.js"]);
        await Deno.writeTextFile(`${dir}/mixed.js`, "final mixed\n");
        await Deno.writeTextFile(`${dir}/unstaged.js`, "unstaged addition\n");
        await Deno.writeTextFile(`${dir}/untracked.js`, "untracked addition\n");
        await Deno.remove(`${dir}/deleted.js`);
        await Deno.writeTextFile(`${dir}/undone.js`, "temporary\n");
        await Deno.writeTextFile(`${dir}/undone.js`, "target bytes\n");

        const statusBefore = await git(dir, ["status", "--porcelain=v1"]);
        const indexBefore = await Deno.readFile(`${dir}/.git/index`).catch(() => new Uint8Array());
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
        assertEquals(await Deno.readFile(`${dir}/.git/index`).catch(() => new Uint8Array()), indexBefore);
        assertEquals((await git(dir, ["rev-parse", "HEAD"])).trim(), executionTip);
        assertEquals((await git(dir, ["rev-parse", "target"])).trim(), targetTip);
        assertEquals(await Deno.readTextFile(`${dir}/mixed.js`), "final mixed\n");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff preserves unchanged tracked files that match ignore rules", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/.gitignore`, "ignored.txt\n");
        await Deno.writeTextFile(`${dir}/ignored.txt`, "tracked target bytes\n");
        await git(dir, ["add", ".gitignore"]);
        await git(dir, ["add", "-f", "ignored.txt"]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "-c", "execution"]);

        const diff = await getWorktreeReviewDiff(dir, "target");

        assertEquals(diff, "");
        assertEquals(await Deno.readTextFile(`${dir}/ignored.txt`), "tracked target bytes\n");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff includes ignored files tracked only by the real index", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/.gitignore`, "ignored.txt\n");
        await git(dir, ["add", ".gitignore"]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "-c", "execution"]);
        await Deno.writeTextFile(`${dir}/ignored.txt`, "staged ignored bytes\n");
        await git(dir, ["add", "-f", "ignored.txt"]);

        const diff = await getWorktreeReviewDiff(dir, "target");

        assertStringIncludes(diff, "ignored.txt");
        assertStringIncludes(diff, "+staged ignored bytes");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff does not delete a restored ignored file tracked by the real index", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/.gitignore`, "ignored.txt\n");
        await Deno.writeTextFile(`${dir}/ignored.txt`, "target bytes\n");
        await git(dir, ["add", ".gitignore"]);
        await git(dir, ["add", "-f", "ignored.txt"]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "-c", "execution"]);
        await git(dir, ["rm", "ignored.txt"]);
        await git(dir, ["commit", "-m", "delete ignored file"]);
        await Deno.writeTextFile(`${dir}/ignored.txt`, "target bytes\n");
        await git(dir, ["add", "-f", "ignored.txt"]);

        const diff = await getWorktreeReviewDiff(dir, "target");

        assertEquals(diff, "");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff shows proposed branch work without reversing target-only changes", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/target-modified.js`, "base target bytes\n");
        await Deno.writeTextFile(`${dir}/target-deleted.js`, "base target deletion\n");
        await Deno.writeTextFile(`${dir}/both.js`, "base shared bytes\n");
        await Deno.writeTextFile(`${dir}/execution-deleted.js`, "base execution deletion\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "base"]);
        const commonAncestor = (await git(dir, ["rev-parse", "HEAD"])).trim();
        await git(dir, ["switch", "-c", "execution"]);

        await git(dir, ["switch", "target"]);
        await Deno.writeTextFile(`${dir}/target-only.js`, "target addition\n");
        await Deno.writeTextFile(`${dir}/target-modified.js`, "target modification\n");
        await Deno.writeTextFile(`${dir}/both.js`, "target shared bytes\n");
        await Deno.remove(`${dir}/target-deleted.js`);
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-m", "target work"]);

        await git(dir, ["switch", "execution"]);
        await Deno.writeTextFile(`${dir}/execution-committed.js`, "execution commit\n");
        await git(dir, ["add", "execution-committed.js"]);
        await git(dir, ["commit", "-m", "execution work"]);
        await Deno.writeTextFile(`${dir}/both.js`, "execution shared bytes\n");
        await Deno.writeTextFile(`${dir}/execution-untracked.js`, "execution untracked\n");
        await Deno.remove(`${dir}/execution-deleted.js`);

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
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff is empty when only the target advances", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/base.js`, "base\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "base"]);
        await git(dir, ["switch", "-c", "execution"]);
        await git(dir, ["switch", "target"]);
        await Deno.writeTextFile(`${dir}/target-only.js`, "target addition\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target work"]);
        await git(dir, ["switch", "execution"]);

        assertEquals(await getWorktreeReviewDiff(dir, "target"), "");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff rejects a missing target", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "execution"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/base.js`, "base\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "base"]);

        await assertRejects(
            () => getWorktreeReviewDiff(dir, "missing-target"),
            WorktreeReviewTargetError,
            "refs/heads/missing-target",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff rejects an unavailable execution HEAD", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/target.js`, "target\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["symbolic-ref", "HEAD", "refs/heads/execution"]);

        await assertRejects(
            () => getWorktreeReviewDiff(dir, "target"),
            WorktreeReviewComparisonError,
            "execution HEAD is unavailable",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("getWorktreeReviewDiff rejects unrelated target and execution histories", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-review-diff-test-" });
    try {
        await git(dir, ["init", "-b", "target"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.writeTextFile(`${dir}/target.js`, "target\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "target"]);
        await git(dir, ["switch", "--orphan", "execution"]);
        await Deno.writeTextFile(`${dir}/execution.js`, "execution\n");
        await git(dir, ["add", "."]);
        await git(dir, ["commit", "-m", "execution"]);

        await assertRejects(
            () => getWorktreeReviewDiff(dir, "target"),
            WorktreeReviewComparisonError,
            "no common ancestor",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("listCommitsTouchingPathsSince returns commits scoped to affected paths", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-snapshot-test-" });
    try {
        await git(dir, ["init"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test User"]);
        await Deno.mkdir(`${dir}/src`);

        await Deno.writeTextFile(`${dir}/src/a.js`, "a1\n");
        await git(dir, ["add", "src/a.js"]);
        await git(dir, ["commit", "-m", "touch a"]);

        await Deno.writeTextFile(`${dir}/src/b.js`, "b1\n");
        await git(dir, ["add", "src/b.js"]);
        await git(dir, ["commit", "-m", "touch b"]);

        const commits = await listCommitsTouchingPathsSince(dir, "1970-01-01T00:00:00Z", ["src/a.js"]);
        assertEquals(commits.length, 1);
        assertEquals(commits[0].subject, "touch a");

        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const futureCommits = await listCommitsTouchingPathsSince(dir, tomorrow, ["src/a.js"]);
        assertEquals(futureCommits, []);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("workflow snapshots include later tracked edits and preserve the real index", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-snapshot-test-" });
    try {
        await git(dir, ["init"]);
        await Deno.writeTextFile(`${dir}/tracked.js`, "baseline\n");
        await Deno.writeTextFile(`${dir}/staged.js`, "staged before\n");
        await git(dir, ["add", "tracked.js", "staged.js"]);
        const statusBefore = await git(dir, ["status", "--short"]);

        const baselineTree = await captureWorktreeTree(dir);

        await Deno.writeTextFile(`${dir}/tracked.js`, "baseline\nworkflow edit\n");
        const diff = await getWorkflowDiff(dir, baselineTree);
        const statusAfter = await git(dir, ["status", "--short"]);

        assertStringIncludes(diff, "tracked.js");
        assertStringIncludes(diff, "workflow edit");
        assertEquals(statusAfter, statusBefore.replace("A  tracked.js", "AM tracked.js"));
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("restoreWorktreeTree refuses to overwrite checkout changes", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-snapshot-test-" });
    try {
        await git(dir, ["init"]);
        await Deno.writeTextFile(`${dir}/kept.js`, "baseline\n");
        await Deno.mkdir(`${dir}/nested`);
        await Deno.writeTextFile(`${dir}/nested/baseline.js`, "nested baseline\n");
        const baselineTree = await captureWorktreeTree(dir);

        await Deno.writeTextFile(`${dir}/kept.js`, "changed after baseline\n");
        await Deno.writeTextFile(`${dir}/added.js`, "added after baseline\n");
        await Deno.writeTextFile(`${dir}/nested/later.js`, "later nested\n");

        await assertRejects(
            () => restoreWorktreeTree(dir, baselineTree),
            Error,
            "Refusing to restore execution baseline tree",
        );

        assertEquals(await Deno.readTextFile(`${dir}/kept.js`), "changed after baseline\n");
        assertEquals(await Deno.readTextFile(`${dir}/added.js`), "added after baseline\n");
        assertEquals(await Deno.readTextFile(`${dir}/nested/later.js`), "later nested\n");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("restoreWorktreeTree keeps a matching checkout unchanged", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-snapshot-test-" });
    try {
        await git(dir, ["init"]);
        await Deno.writeTextFile(`${dir}/kept.js`, "baseline\n");
        const baselineTree = await captureWorktreeTree(dir);

        await restoreWorktreeTree(dir, baselineTree);

        assertEquals(await Deno.readTextFile(`${dir}/kept.js`), "baseline\n");
        assertEquals(await captureWorktreeTree(dir), baselineTree);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("git snapshot helpers fail gracefully outside Git", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-non-git-snapshot-" });
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
        await Deno.remove(dir, { recursive: true });
    }
});
