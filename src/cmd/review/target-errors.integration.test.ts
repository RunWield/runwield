import { doesNotMatch, equal } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env, execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { makeTempDirectory } from "../../testing/temp-file.ts";

const fixture = defineCommittedGitFixture();

test("review reports a mismatched PR repository without a runtime crash in a linked worktree", async () => {
    const cwd = await fixture.checkout();
    const home = await makeTempDirectory();
    try {
        await git(cwd, ["remote", "add", "origin", "git@github.com:other/repo.git"]);
        const worktree = join(cwd, "review-worktree");
        await git(cwd, ["worktree", "add", "--detach", worktree, "HEAD"]);
        await writeFile(join(worktree, "README.md"), "Keep this local edit.\n");
        const before = await git(worktree, ["status", "--porcelain"]);
        const refs = await git(cwd, ["show-ref"]);
        const result = spawnSync(
            execPath,
            [
                "--no-env-file",
                "--no-install",
                fileURLToPath(new URL("../../cli.ts", import.meta.url)),
                "review",
                "https://github.com/RunWield/runwield/pull/279",
            ],
            {
                cwd: worktree,
                env: { ...env, HOME: home, USERPROFILE: home, WLD_RUNTIME_SUPERVISOR_PID: "" },
                encoding: "utf8",
                timeout: 30_000,
            },
        );
        if (result.error) throw result.error;
        equal(result.signal, null);
        equal(result.status, 1);
        equal(
            result.stderr.trim(),
            "[RunWield] The PR repository must match a remote of this checkout. RunWield does not clone repositories.",
        );
        doesNotMatch(result.stdout, /Code Review:|No review worktree/);
        equal(await git(worktree, ["status", "--porcelain"]), before);
        equal(await readFile(join(worktree, "README.md"), "utf8"), "Keep this local edit.\n");
        equal(await git(cwd, ["show-ref"]), refs);
    } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
    }
});
