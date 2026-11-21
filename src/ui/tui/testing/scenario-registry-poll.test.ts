import { test } from "node:test";
import { strictEqual, rejects } from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { join } from "node:path";
import { defineCommittedGitFixture, git } from "../../../shared/git-test-fixture.ts";
import { enterProjectRuntime, ProjectRuntimeEntryRefusedError } from "../../../shared/project-runtime-layout.ts";
import { readScenarioRegistryForPoll } from "./scenario-registry-poll.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Registry polling\n" });

test("Golden registry polling retries when publication removes a checkout during inspection", async () => {
    const root = await fs.realpath(await fixture.checkout());
    const linked = `${root}-linked`;
    const originalLstat = fs.lstat;
    let removed = false;
    try {
        await git(root, ["worktree", "add", "-b", "cleanup-race", linked]);
        await enterProjectRuntime(linked);
        Object.defineProperty(fs, "lstat", {
            value: async (...args: Parameters<typeof fs.lstat>) => {
                const result = await originalLstat(...args);
                if (!removed && String(args[0]) === join(linked, ".git")) {
                    removed = true;
                    await git(root, ["worktree", "remove", "--force", linked]);
                }
                return result;
            },
        });
        strictEqual(await readScenarioRegistryForPoll(root), null);
        strictEqual(removed, true);
        strictEqual((await readScenarioRegistryForPoll(root))?.entries.length, 0);
    } finally {
        fs.lstat = originalLstat;
        await rm(linked, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("Golden registry polling waits for admission without reporting an absent worktree", async () => {
    const root = await fixture.checkout();
    try {
        await enterProjectRuntime(root);
        const linked = `${root}-linked`;
        await git(root, ["worktree", "add", "-b", "unadmitted", linked]);
        try {
            strictEqual(await readScenarioRegistryForPoll(root), null);
            await enterProjectRuntime(root);
        } finally {
            await git(root, ["worktree", "remove", "--force", linked]);
        }
        const registry = await readScenarioRegistryForPoll(root);
        strictEqual(registry?.entries.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Golden registry polling reports failed Git evidence for a checkout that still exists", async () => {
    const root = await fs.realpath(await fixture.checkout());
    try {
        await enterProjectRuntime(root);
        await writeFile(join(root, ".git", "index"), "invalid index\n");
        await rejects(() => readScenarioRegistryForPoll(root), /index/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("Golden registry polling does not hide blocked authority", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        await writeFile(layout.primary.layoutMarkerPath, "invalid marker\n");
        await rejects(() => readScenarioRegistryForPoll(root), ProjectRuntimeEntryRefusedError);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
