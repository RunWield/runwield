import { captureForegroundProcess } from "../captured-process.ts";
import { test } from "node:test";
import { writeFile as fsWriteFile, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { ok as assert, notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan, parsePlanFrontMatter, updatePlanFrontMatter } from "../../plan-store.js";
import { addEntry, findById, listEntries } from "../worktree-registry.js";
import { runOperation, spawnAttachedCli, withProject } from "./attached-test-fixture.ts";
import { locateAttachedWorkflows, type AttachedWorkflowRecord } from "./record-store.ts";
import { completionInput, executionInput, implementing, readyPlan } from "./execution-test-fixture.ts";

async function git(root: string, ...args: string[]) {
    const result = await captureForegroundProcess("git", { cwd: root, args });
    assert(result.success, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
}

test("approved handoff captures baseline, preserves invoking files, and checkpoints only the worker tree", async () => {
    await withProject(async (root) => {
        const ready = await readyPlan(root);
        await fsWriteFile(join(root, "README.md"), "Invoking dirty work\n");
        await fsWriteFile(join(root, "scratch.txt"), "Untracked user work\n");
        const beforeBranch = await git(root, "branch", "--show-current");
        const beforeHead = await git(root, "rev-parse", "HEAD");
        const primaryPlanPath = join(root, "docs/plans/dark-mode-toggle.md");
        const primaryPlan = parsePlanFrontMatter(await fsReadFile(primaryPlanPath, "utf8"));
        const started = await runOperation("start_execution", root, executionInput(ready, "start"));
        assert(started.ok && started.workflow.nextAction.kind === "implementation", JSON.stringify(started));
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId && execution.baselineTree);
        assertNotEquals(execution.executionCwd, root);
        // Core records delivery identity before handing authority to the worker.
        // This is the only permitted change to the invoking Plan.
        const preparedPrimaryBytes = await fsReadFile(primaryPlanPath, "utf8");
        const preparedPrimaryPlan = parsePlanFrontMatter(preparedPrimaryBytes);
        assertEquals(preparedPrimaryPlan.body, primaryPlan.body);
        assertEquals(preparedPrimaryPlan.attrs, {
            ...primaryPlan.attrs,
            targetBranch: "main",
            deliveryBranch: "plan/dark-mode-toggle",
        });
        assertEquals((await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs.status, "in_progress");
        assertEquals((await findById(root, execution.worktreeId))?.executionBaselineTree, execution.baselineTree);
        assertStringIncludes(
            await git(execution.executionCwd, "show", `${execution.baselineTree}:docs/plans/dark-mode-toggle.md`),
            "# Toggle",
        );
        await fsWriteFile(join(execution.executionCwd, "toggle.ts"), "export const dark = true;\n");
        const completed = await runOperation("task_completed", root, completionInput(started.workflow));
        assert(completed.ok, JSON.stringify(completed));
        assertEquals(completed.workflow.state, "implemented");
        assertEquals((await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs.status, "implemented");
        assertEquals((await findById(root, execution.worktreeId))?.status, "completed");
        assertEquals(await git(execution.executionCwd, "show", "HEAD:toggle.ts"), "export const dark = true;");
        assertEquals(await fsReadFile(join(root, "README.md"), "utf8"), "Invoking dirty work\n");
        assertEquals(await fsReadFile(join(root, "scratch.txt"), "utf8"), "Untracked user work\n");
        assertEquals(await fsReadFile(primaryPlanPath, "utf8"), preparedPrimaryBytes);
        assertEquals(await git(root, "branch", "--show-current"), beforeBranch);
        assertEquals(await git(root, "rev-parse", "HEAD"), beforeHead);
        assertStringIncludes(await fsReadFile(join(root, ".gitignore"), "utf8"), "RunWield");
        assertEquals(await runOperation("task_completed", root, completionInput(started.workflow)), completed);
        const duplicate = await runOperation(
            "task_completed",
            root,
            completionInput(started.workflow, "different-complete"),
        );
        assert(!duplicate.ok && duplicate.rejection.code === "revision_conflict");
        assertEquals((await listEntries(root)).length, 1);
        const events = (await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs;
        assertEquals(events?.executionMode, "worktree");
        assert(events?.implementedAt, "Canonical implementation_finished evidence must be present.");
        assertStringIncludes(events?.executionReport || "", "Added the toggle");
    });
});

test("fresh process restores the issued worktree and current implementer instructions without a second attempt", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const fresh = await spawnAttachedCli("status", root, { workflowId: started.workflow.workflowId });
        assert(fresh.result.ok && fresh.result.instructions);
        assertEquals(fresh.result.workflow.nextAction, started.workflow.nextAction);
        assertStringIncludes(fresh.result.instructions.text, "overrides Core lifecycle instructions");
        assertStringIncludes(fresh.result.instructions.text, "Do not call any RunWield lifecycle tool");
        const retry = await runOperation("start_execution", root, executionInput(started.workflow, "new-start"));
        assert(!retry.ok && retry.rejection.code === "action_superseded");
        const entry = (await listEntries(root))[0];
        await assertRejects(
            () => addEntry(root, { ...entry, id: "competing", path: join(root, "other-worktree") }),
            Error,
        );
        assertEquals((await listEntries(root)).length, 1);
    });
});

for (const change of ["body", "identity", "status", "branch", "registry-path", "missing-worktree"] as const) {
    test(`completion rejects changed ${change} without accepting the action`, async () => {
        await withProject(async (root) => {
            const started = await implementing(root);
            const execution = started.workflow.execution;
            assert(execution?.executionCwd && execution.worktreeId);
            const worktree = execution.executionCwd;
            const planPath = join(worktree, "docs/plans/dark-mode-toggle.md");
            if (change === "body") {
                await fsWriteFile(planPath, (await fsReadFile(planPath, "utf8")) + "\nChanged approved scope\n");
            }
            if (change === "identity") {
                await updatePlanFrontMatter(
                    worktree,
                    "dark-mode-toggle",
                    { planId: crypto.randomUUID() },
                    {},
                    {
                        expectedRevision: (await loadPlan(worktree, "dark-mode-toggle"))?.revision,
                    },
                );
            }
            if (change === "status") {
                await updatePlanFrontMatter(
                    worktree,
                    "dark-mode-toggle",
                    { status: "on_hold" },
                    {},
                    {
                        expectedRevision: (await loadPlan(worktree, "dark-mode-toggle"))?.revision,
                    },
                );
            }
            if (change === "branch") await git(worktree, "checkout", "-b", "wrong-branch");
            if (change === "status") {
                // Seed a matching issued revision at a Core-invalid position. Only shared finalization guards it.
                const path = join(locateAttachedWorkflows(root).workflowsDir, `${started.workflow.workflowId}.json`);
                const record: AttachedWorkflowRecord = JSON.parse(await fsReadFile(path, "utf8"));
                const invalidPlan = await loadPlan(worktree, "dark-mode-toggle");
                assert(record.execution && invalidPlan);
                record.execution.planRevision = invalidPlan.revision;
                await fsWriteFile(path, JSON.stringify(record));
            }
            if (change === "registry-path") {
                const path = join(locateAttachedWorkflows(root).workflowsDir, `${started.workflow.workflowId}.json`);
                const record: AttachedWorkflowRecord = JSON.parse(await fsReadFile(path, "utf8"));
                assert(record.execution);
                record.execution.executionCwd = root;
                await fsWriteFile(path, JSON.stringify(record));
            }
            if (change === "missing-worktree") await fsRm(worktree, { recursive: true });
            const result = await runOperation("task_completed", root, completionInput(started.workflow));
            assert(!result.ok, JSON.stringify(result));
            assertEquals(result.rejection.code, "invalid_outcome");
            if (change === "registry-path") assertStringIncludes(result.rejection.message, "live execution registry");
            if (change === "status") assertStringIncludes(result.rejection.message, 'Plan status is "on_hold"');
            assertEquals((await findById(root, execution.worktreeId))?.status, "active");
        });
    });
}

test("completion restores a deleted execution Plan from its recorded baseline through Core", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId && execution.baselineTree);
        await fsRm(join(execution.executionCwd, "docs/plans/dark-mode-toggle.md"));
        const result = await runOperation("task_completed", root, completionInput(started.workflow));
        assert(result.ok, JSON.stringify(result));
        assertEquals((await loadPlan(execution.executionCwd, "dark-mode-toggle"))?.attrs.status, "implemented");
        assertEquals((await findById(root, execution.worktreeId))?.status, "completed");
    });
});
