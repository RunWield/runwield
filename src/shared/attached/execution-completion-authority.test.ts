import { test } from "node:test";
import { readdir as fsReaddir, writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { loadPlan, withPlanLock } from "../../plan-store.js";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { findById } from "../worktree-registry.js";
import { runOperation, withProject } from "./attached-test-fixture.ts";
import { completionInput, implementing } from "./execution-test-fixture.ts";

test("completion rejects a Plan body edit made while Core waits for the real Plan lock", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId);
        const plan = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(plan);
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let acquired = () => {};
        const locked = new Promise<void>((resolve) => {
            acquired = resolve;
        });
        const holder = withPlanLock(execution.executionCwd, "dark-mode-toggle", async () => {
            acquired();
            await held;
        });
        await locked;
        try {
            // Start outside the holder's async context: this is real lock contention,
            // not a nested reentrant write. The attempt lock proves completion reached Core.
            const completion = runOperation("task_completed", root, completionInput(started.workflow));
            const locks = resolveProjectRuntimeLayout(execution.executionCwd).selected.planLocksDir;
            let waiting = false;
            for (let attempt = 0; attempt < 300 && !waiting; attempt++) {
                for await (const file of await fsReaddir(locks, { withFileTypes: true })) {
                    if (file.name.includes("attempt") && file.name.endsWith(".lock")) waiting = true;
                }
                if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(waiting, "Completion must reach the ordered authority locks before the body edit.");
            await fsWriteFile(plan.path, `${plan.markdown}\nChanged scope while completion waits.\n`);
            release();
            await holder;
            const result = await completion;
            assert(!result.ok, JSON.stringify(result));
            assertStringIncludes(result.rejection.message, "Plan changed");
            assertEquals((await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs.status, "in_progress");
            assertEquals((await findById(root, execution.worktreeId))?.status, "active");
        } finally {
            release();
            await holder;
        }
    });
});
