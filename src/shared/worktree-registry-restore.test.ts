import { rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { defineGitFixture, git } from "./git-test-fixture.ts";
import { addEntry, removeEntry, restoreEntryFromPlanEvidence } from "./worktree-registry.js";
import type { WorktreeRegistryEntry, WorktreeRestoreEvidence } from "./worktree-registry.js";

type LiveWorktreeEntry = WorktreeRegistryEntry & WorktreeRestoreEvidence;

const repo = defineGitFixture(async (repoPath) => {
    await fsWriteFile(join(repoPath, "README.md"), "base\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
});

async function setupLiveWorktree(cwd: string, id = "restore1", branch = "restore-side"): Promise<LiveWorktreeEntry> {
    const path = `${cwd}-${id}`;
    await git(cwd, ["worktree", "add", "-b", branch, path, "main"]);
    return {
        id,
        planName: "plan",
        planId: `plan-${id}`,
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: (await git(cwd, ["rev-parse", "main"])).trim(),
        branch,
        path,
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

test("restoreEntryFromPlanEvidence rebuilds a deleted live worktree entry", async () => {
    const cwd = await repo.checkout();
    const entry = await setupLiveWorktree(cwd);
    try {
        const restored = await restoreEntryFromPlanEvidence(cwd, entry);
        assertEquals(restored.restored, true);
        assertEquals(restored.entry?.id, entry.id);
        assertEquals(restored.entry?.path, entry.path);
    } finally {
        await git(cwd, ["worktree", "remove", "--force", entry.path]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("restoreEntryFromPlanEvidence refuses when branch evidence disagrees", async () => {
    const cwd = await repo.checkout();
    const entry = await setupLiveWorktree(cwd, "restore2", "real-side");
    try {
        const restored = await restoreEntryFromPlanEvidence(cwd, { ...entry, branch: "wrong-side" });
        assertEquals(restored.restored, false);
        assertStringIncludes(restored.reason || "", "does not show");
    } finally {
        await git(cwd, ["worktree", "remove", "--force", entry.path]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("restoreEntryFromPlanEvidence refuses when worktree path is gone", async () => {
    const cwd = await repo.checkout();
    const entry = await setupLiveWorktree(cwd, "restore3", "gone-side");
    try {
        await git(cwd, ["worktree", "remove", "--force", entry.path]);
        const restored = await restoreEntryFromPlanEvidence(cwd, entry);
        assertEquals(restored.restored, false);
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});

test("restoreEntryFromPlanEvidence refuses a duplicate live attempt for the same plan", async () => {
    const cwd = await repo.checkout();
    const existing = await setupLiveWorktree(cwd, "restore4", "first-side");
    const duplicate = await setupLiveWorktree(cwd, "restore5", "second-side");
    try {
        await addEntry(cwd, existing);
        const restored = await restoreEntryFromPlanEvidence(cwd, { ...duplicate, planId: existing.planId });
        assertEquals(restored.restored, false);
        assertStringIncludes(restored.reason || "", "more than one unfinished worktree attempt");
        await removeEntry(cwd, existing.id);
    } finally {
        await git(cwd, ["worktree", "remove", "--force", existing.path]).catch(() => {});
        await git(cwd, ["worktree", "remove", "--force", duplicate.path]).catch(() => {});
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});
