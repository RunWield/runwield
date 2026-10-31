import { test } from "node:test";
import { strictEqual, rejects } from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { defineCommittedGitFixture } from "../../../shared/git-test-fixture.ts";
import { enterProjectRuntime, ProjectRuntimeEntryRefusedError } from "../../../shared/project-runtime-layout.ts";
import { readScenarioRegistryForPoll } from "./scenario-registry-poll.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Registry polling\n" });

test("Golden registry polling waits for admission without reporting an absent worktree", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        await writeFile(layout.primary.layoutMigrationLockPath, "admission in progress\n");
        strictEqual(await readScenarioRegistryForPoll(root), null);
        await rm(layout.primary.layoutMigrationLockPath);
        const registry = await readScenarioRegistryForPoll(root);
        strictEqual(registry?.entries.length, 0);
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
