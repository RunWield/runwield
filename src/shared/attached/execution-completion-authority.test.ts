import { openPlanFixturePackageLocks } from "../testing/plan-state-fixture.ts";
import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

import { loadPlan } from "../../plan-store/index.ts";
import { findById } from "../worktree-registry.ts";
import { spawnAttachedCli, withProject } from "./attached-test-fixture.ts";
import { completionInput, implementing } from "./execution-test-fixture.ts";

test("completion rejects a Plan body edit made while Core waits for the real Plan lock", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId);
        const plan = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(plan);
        const locks = await openPlanFixturePackageLocks(execution.executionCwd, "dark-mode-toggle");
        let completion: ReturnType<typeof spawnAttachedCli> | undefined;
        try {
            assert(locks.catalog.tryLockSync(true), "The catalog must be free before completion starts.");
            locks.catalog.unlockSync();
            assert(locks.plan.tryLockSync(true), "The fixture must hold the canonical Plan lock.");
            completion = spawnAttachedCli("task_completed", root, completionInput(started.workflow));
            // Core takes the catalog before the Plan lock. Native contention proves the
            // subprocess reached that ordering while this fixture still owns the Plan.
            let waiting = false;
            for (let attempt = 0; attempt < 300 && !waiting; attempt++) {
                waiting = !locks.catalog.tryLockSync(true);
                if (!waiting) {
                    locks.catalog.unlockSync();
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            }
            assert(waiting, "Completion must reach the canonical Plan locks before the body edit.");
            await fsWriteFile(plan.path, `${plan.markdown}\nChanged scope while completion waits.\n`);
            locks.plan.unlockSync();
            const { result } = await completion;
            assert(!result.ok, JSON.stringify(result));
            assertStringIncludes(result.rejection.message, "Required Plan documents changed");
            assertEquals((await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs.status, "in_progress");
            assertEquals((await findById(root, execution.worktreeId))?.status, "active");
        } finally {
            locks.plan.close();
            locks.catalog.close();
            await completion;
        }
    });
});
