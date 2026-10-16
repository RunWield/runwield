import { assertEquals } from "../testing/assertions.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { platform } from "node:process";
import { captureForegroundProcess } from "./captured-process.ts";
import { mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    gitIndexEvidence,
    gitWorktreeListEvidence,
    observeGitEvidence,
    rememberGitRead,
    reusedGitRead,
} from "./git-evidence-cache.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Git evidence fixture\n" });

/** Let repository metadata age past the window in which Git answers are never reused. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
}

async function rememberIndexRead(root: string, value: string[]) {
    const observation = await observeGitEvidence(`index\0${root}`, await gitIndexEvidence(root));
    await rememberGitRead(observation, value);
}

async function reusedIndexRead(root: string): Promise<string[] | undefined> {
    return reusedGitRead<string[]>(await observeGitEvidence(`index\0${root}`, await gitIndexEvidence(root)));
}

test("an index read is reused until Git rewrites the index", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        await settle();
        await rememberIndexRead(root, ["README.md"]);
        assertEquals(await reusedIndexRead(root), ["README.md"]);

        await writeFile(join(root, "added.txt"), "added\n");
        await git(root, ["add", "added.txt"]);
        await settle();
        assertEquals(await reusedIndexRead(root), undefined);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("evidence changed within the timestamp window is never remembered", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        await settle();
        await writeFile(join(root, "added.txt"), "added\n");
        await git(root, ["add", "added.txt"]);
        await rememberIndexRead(root, ["README.md", "added.txt"]);
        assertEquals(await reusedIndexRead(root), undefined);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("a linked worktree's index evidence follows its .git pointer", async () => {
    const root = await realpath(await fixture.checkout());
    const linked = await mkdtemp(join(tmpdir(), "runwield-git-evidence-linked-"));
    try {
        await git(root, ["worktree", "add", "-b", "linked", linked]);
        const gitDir = (await git(linked, ["rev-parse", "--absolute-git-dir"])).trim();
        const evidence = await gitIndexEvidence(linked);
        assertEquals(evidence?.includes(join(await realpath(gitDir), "index")), true);
    } finally {
        await git(root, ["worktree", "remove", "--force", linked]).catch(() => "");
        await rm(linked, { recursive: true }).catch(() => {});
        await rm(root, { recursive: true });
    }
});

test("attaching a worktree changes worktree-list evidence", async () => {
    const root = await realpath(await fixture.checkout());
    const linked = await mkdtemp(join(tmpdir(), "runwield-git-evidence-attach-"));
    try {
        await settle();
        const before = await observeGitEvidence(`worktrees\0${root}`, await gitWorktreeListEvidence(root));
        await rememberGitRead(before, [root]);
        assertEquals(reusedGitRead<string[]>(before), [root]);

        await git(root, ["worktree", "add", "-b", "attached", linked]);
        await settle();
        const after = await observeGitEvidence(`worktrees\0${root}`, await gitWorktreeListEvidence(root));
        assertEquals(reusedGitRead<string[]>(after), undefined);
    } finally {
        await git(root, ["worktree", "remove", "--force", linked]).catch(() => "");
        await rm(linked, { recursive: true }).catch(() => {});
        await rm(root, { recursive: true });
    }
});

test("a directory that is not a Git checkout has no reusable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-git-evidence-plain-"));
    try {
        assertEquals(await gitIndexEvidence(root), null);
        assertEquals(await gitWorktreeListEvidence(root), null);
        const observation = await observeGitEvidence(`index\0${root}`, null);
        await rememberGitRead(observation, ["anything"]);
        assertEquals(reusedGitRead<string[]>(observation), undefined);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("an index symlink cannot hide changes to its target behind cached evidence", async () => {
    if (platform === "win32") return; // Creating symlinks requires elevated privileges there.
    const root = await realpath(await fixture.checkout());
    try {
        const index = join(root, ".git", "index");
        const target = join(root, ".git", "external-index");
        await rename(index, target);
        await symlink(target, index);
        await settle();
        await rememberIndexRead(root, ["README.md"]);

        // Replace the target without changing the symlink's own stat metadata.
        await writeFile(join(root, "added.txt"), "added\n");
        const result = await captureForegroundProcess("git", {
            cwd: root,
            args: ["add", "added.txt"],
            env: { GIT_INDEX_FILE: target },
        });
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertEquals((await git(root, ["ls-files"])).trim().split("\n"), ["README.md", "added.txt"]);
        await settle();
        assertEquals(await reusedIndexRead(root), undefined);
    } finally {
        await rm(root, { recursive: true });
    }
});
