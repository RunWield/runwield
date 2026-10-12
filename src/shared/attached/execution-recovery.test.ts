import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { archivePlan, loadPlan, updatePlanFrontMatter } from "../../plan-store.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";
import { createWorktreeGitArtifacts, settleWorktreeAttempt } from "../worktree.js";
import { finalizePlanImplementation } from "../workflow/implementation-checkpoint.ts";
import {
    getTransitionJournalDir,
    getTransitionJournalPath,
    listTransitionRecoveryRecords,
} from "../workflow/state-transition.ts";
import { findById, listEntries, updateEntry } from "../worktree-registry.js";
import {
    reachPlanning,
    readRecordBytes,
    runOperation,
    spawnAttachedCli,
    withProject,
} from "./attached-test-fixture.ts";
import { completionInput, executionInput, implementing, readyPlan } from "./execution-test-fixture.ts";
import { locateAttachedWorkflows } from "./record-store.ts";

Deno.test("start rejects preapproval and stale revisions; completion requires the issued action and report envelope", async () => {
    await withProject(async (root) => {
        const planning = await reachPlanning(root);
        assert(planning.result.ok);
        const early = await runOperation("start_execution", root, executionInput(planning.result.workflow, "early"));
        assert(!early.ok && early.rejection.code === "action_superseded");
        const ready = await readyPlan(root);
        const stale = await runOperation("start_execution", root, {
            ...executionInput(ready, "stale"),
            expectedRevision: 1,
        });
        assert(!stale.ok && stale.rejection.code === "revision_conflict");
        const started = await runOperation("start_execution", root, executionInput(ready, "start"));
        assert(started.ok && started.workflow.nextAction.kind === "implementation");
        const wrong = await runOperation(
            "task_completed",
            root,
            executionInput(started.workflow, "wrong", { actionId: "superseded", message: "- Done" }),
        );
        assert(!wrong.ok && wrong.rejection.code === "action_superseded");
        const missing = await runOperation(
            "task_completed",
            root,
            executionInput(started.workflow, "no-action", { message: "done" }),
        );
        assert(!missing.ok && missing.rejection.code === "invalid_input");
        const empty = await runOperation(
            "task_completed",
            root,
            executionInput(started.workflow, "empty", { actionId: started.workflow.nextAction.actionId, message: "" }),
        );
        assert(!empty.ok && empty.rejection.code === "invalid_input");
        const staleComplete = await runOperation("task_completed", root, {
            ...completionInput(started.workflow),
            expectedRevision: 1,
        });
        assert(!staleComplete.ok && staleComplete.rejection.code === "revision_conflict");
        assertEquals((await listEntries(root)).length, 1);
        assertEquals((await listEntries(root))[0].status, "active");
    });
});

Deno.test("fresh start heals an unsettled preparation journal and adopts the same authority after a lost Attached write", async () => {
    await withProject(async (root) => {
        const ready = await readyPlan(root);
        const oldRecord = await readRecordBytes(root, ready.workflowId);
        const started = await runOperation("start_execution", root, executionInput(ready, "lost-start"));
        assert(started.ok);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId);
        const transitionId = crypto.randomUUID();
        await Deno.mkdir(getTransitionJournalDir(execution.executionCwd), { recursive: true });
        await Deno.writeTextFile(
            getTransitionJournalPath(execution.executionCwd, transitionId),
            JSON.stringify({
                version: 1,
                transitionId,
                operation: "execution_preparation",
                planName: "dark-mode-toggle",
                resources: [{ kind: "plan", id: "dark-mode-toggle" }, { kind: "attempt", id: execution.worktreeId }],
                state: "applying",
                intendedPostconditions: { status: "in_progress" },
                completedEffects: [
                    {
                        effect: "git_worktree_reused",
                        proof: { path: execution.executionCwd, worktreeId: execution.worktreeId },
                        completedAt: new Date().toISOString(),
                    },
                    {
                        effect: "execution_prepared",
                        proof: { worktreeId: execution.worktreeId },
                        completedAt: new Date().toISOString(),
                    },
                ],
                updatedAt: new Date().toISOString(),
            }),
        );
        assertEquals((await listTransitionRecoveryRecords(execution.executionCwd)).length, 1);
        await Deno.writeTextFile(
            join(locateAttachedWorkflows(root).workflowsDir, `${ready.workflowId}.json`),
            oldRecord,
        );
        const projected = await runOperation("status", root, { workflowId: ready.workflowId });
        assert(projected.ok);
        assertEquals(projected.workflow.execution, null, "Projection must not fabricate execution authority.");
        const retry = await spawnAttachedCli("start_execution", root, executionInput(ready, "retry-start"));
        assert(retry.result.ok, JSON.stringify(retry.result));
        assertEquals(retry.result.workflow.state, "implementing");
        assertEquals(retry.result.workflow.execution?.worktreeId, execution.worktreeId);
        assertEquals(retry.result.workflow.execution?.baselineTree, execution.baselineTree);
        assertEquals((await listTransitionRecoveryRecords(execution.executionCwd)).length, 0);
        assertEquals((await listEntries(root)).length, 1);
    });
});

Deno.test("completion retry settles the Attached result after Core committed before the record write", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId && started.workflow.plan);
        await finalizePlanImplementation({
            projectRoot: root,
            planName: "dark-mode-toggle",
            executionContext: execution,
            triageMeta: { ...execution.triageMeta, planId: started.workflow.plan.planId },
            executionReport: "- Completed before transport loss",
        });
        const fresh = await spawnAttachedCli("task_completed", root, completionInput(started.workflow));
        assert(fresh.result.ok, JSON.stringify(fresh.result));
        assertEquals(fresh.result.workflow.state, "implemented");
        assertEquals((await findById(root, execution.worktreeId))?.status, "completed");
        const status = await runOperation("status", root, { workflowId: started.workflow.workflowId });
        assert(status.ok);
        assertEquals(status.workflow.state, "implemented");
        assertEquals(status.workflow.nextAction.kind, "implemented");
    });
});

Deno.test("status retains the pending implementation action and resolves frontend role layers on each result", async () => {
    await withProject(async (root) => {
        const ready = await readyPlan(root);
        const plan = await loadPlan(root, "dark-mode-toggle");
        assert(plan);
        await updatePlanFrontMatter(root, "dark-mode-toggle", { executionAgent: "frontend-engineer" }, {}, {
            expectedRevision: plan.revision,
        });
        const started = await runOperation("start_execution", root, executionInput(ready, "constructor"));
        assert(started.ok && started.workflow.nextAction.kind === "implementation");
        assertEquals(started.workflow.nextAction.role, "frontend-engineer");
        await Deno.mkdir(join(root, ".wld/agents"), { recursive: true });
        await Deno.writeTextFile(
            join(root, ".wld/agents/frontend-engineer.md"),
            "---\npromptOverride: true\n---\nProject frontend override after handoff\n",
        );
        const status = await runOperation("status", root, { workflowId: ready.workflowId });
        assert(status.ok && status.instructions);
        assertEquals(status.workflow.state, "implementing");
        assertEquals(status.workflow.nextAction, started.workflow.nextAction);
        assertStringIncludes(status.instructions.text, "Project frontend override after handoff");
        const replay = await runOperation("start_execution", root, executionInput(ready, "constructor"));
        assert(replay.ok && replay.instructions);
        assertEquals(JSON.stringify(replay.workflow), JSON.stringify(started.workflow));
        assertStringIncludes(replay.instructions.text, "Project frontend override after handoff");
        assertStringIncludes(status.instructions.text, "Do not call any RunWield lifecycle tool");
        assertEquals((await readRecordBytes(root, ready.workflowId)).includes('"instructions"'), false);
    });
});

Deno.test("execution evidence projects Core feedback and later AI review from the worker Plan, not the invoking Plan", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd);
        const plan = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(plan);
        await updatePlanFrontMatter(execution.executionCwd, "dark-mode-toggle", { status: "feedback" }, {}, {
            expectedRevision: plan.revision,
        });
        const feedback = await runOperation("status", root, { workflowId: started.workflow.workflowId });
        assert(feedback.ok && feedback.workflow.nextAction.kind === "plan");
        assertEquals(feedback.workflow.state, "awaiting_planning");
        const current = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(current);
        // Core now keeps mechanical validation at implemented; AI review advances to reviewed.
        await updatePlanFrontMatter(execution.executionCwd, "dark-mode-toggle", { status: "reviewed" }, {}, {
            expectedRevision: current.revision,
        });
        const advanced = await runOperation("status", root, { workflowId: started.workflow.workflowId });
        assert(advanced.ok && advanced.workflow.nextAction.kind === "return_to_host");
        assertEquals(advanced.workflow.state, "closed");
        assertEquals(advanced.workflow.nextAction.reason, "plan_advanced_in_core");
    });
});

Deno.test("partial Core completion retains the handoff and retry finishes checkpoint and registry settlement", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId && started.workflow.plan);
        const before = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(before);
        await Deno.writeTextFile(join(execution.executionCwd, "toggle.ts"), "export const enabled = true;\n");
        await recordPlanEvent({
            cwd: execution.executionCwd,
            planName: "dark-mode-toggle",
            event: "implementation_finished",
            currentStatus: "in_progress",
            details: { executionReport: "- Finished before the process stopped" },
        });
        const transitionId = crypto.randomUUID();
        await Deno.mkdir(getTransitionJournalDir(execution.executionCwd), { recursive: true });
        await Deno.writeTextFile(
            getTransitionJournalPath(execution.executionCwd, transitionId),
            JSON.stringify({
                version: 1,
                transitionId,
                operation: "implementation_checkpoint",
                planName: "dark-mode-toggle",
                resources: [{ kind: "plan", id: "dark-mode-toggle" }, { kind: "attempt", id: execution.worktreeId }],
                state: "applying",
                beforeFacts: { plan: { path: before.path, revision: before.revision, status: before.attrs.status } },
                intendedPostconditions: {},
                updatedAt: new Date().toISOString(),
                completedEffects: [],
            }),
        );
        assertEquals((await findById(root, execution.worktreeId))?.status, "active");
        const pending = await runOperation("status", root, { workflowId: started.workflow.workflowId });
        assert(pending.ok && pending.workflow.nextAction.kind === "implementation", JSON.stringify(pending));
        assertEquals(pending.workflow.nextAction.actionId, execution.actionId);
        const finished = await spawnAttachedCli("task_completed", root, completionInput(pending.workflow));
        assert(finished.result.ok, JSON.stringify(finished.result));
        assertEquals(finished.result.workflow.state, "implemented");
        assertEquals((await findById(root, execution.worktreeId))?.status, "completed");
        assertEquals((await listTransitionRecoveryRecords(execution.executionCwd)).length, 0);
        const diff = await new Deno.Command("git", {
            args: ["status", "--porcelain"],
            cwd: execution.executionCwd,
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(new TextDecoder().decode(diff.stdout).trim(), "");
        const committed = await new Deno.Command("git", {
            args: ["show", "HEAD:toggle.ts"],
            cwd: execution.executionCwd,
            stdout: "piped",
            stderr: "piped",
        }).output();
        assert(committed.success, "Core must commit the worker changes, not only change registry status.");
    });
});

Deno.test("first preparation retry heals its source journal before selecting an unmaterialized worktree", async () => {
    await withProject(async (root) => {
        const ready = await readyPlan(root);
        const source = await loadPlan(root, "dark-mode-toggle");
        assert(source && ready.plan);
        const artifacts = await createWorktreeGitArtifacts({
            projectRoot: root,
            planName: "dark-mode-toggle",
            planId: ready.plan.planId,
            attemptId: "interrupted-first",
            baseRef: "HEAD",
            baseBranch: "main",
        });
        const entry = await settleWorktreeAttempt(root, artifacts);
        assertEquals(await loadPlan(entry.path, "dark-mode-toggle"), null);
        const transitionId = crypto.randomUUID();
        await Deno.mkdir(getTransitionJournalDir(root), { recursive: true });
        await Deno.writeTextFile(
            getTransitionJournalPath(root, transitionId),
            JSON.stringify({
                version: 1,
                transitionId,
                operation: "execution_preparation",
                planName: "dark-mode-toggle",
                resources: [{ kind: "plan", id: "dark-mode-toggle" }, { kind: "attempt", id: entry.id }],
                state: "applying",
                beforeFacts: { plan: { path: source.path, revision: source.revision, status: "ready_for_work" } },
                intendedPostconditions: {},
                updatedAt: new Date().toISOString(),
                completedEffects: [
                    {
                        effect: "git_worktree_created",
                        proof: { worktreeId: entry.id, path: entry.path, branch: entry.branch },
                    },
                    {
                        effect: "worktree_registry_settled",
                        proof: { worktreeId: entry.id, path: entry.path, status: "active" },
                    },
                ],
            }),
        );
        const retry = await spawnAttachedCli("start_execution", root, executionInput(ready, "retry-first"));
        assert(retry.result.ok, JSON.stringify(retry.result));
        assertEquals(retry.result.workflow.state, "implementing");
        assertEquals(retry.result.workflow.execution?.worktreeId, entry.id);
        assertEquals((await loadPlan(entry.path, "dark-mode-toggle"))?.attrs.status, "in_progress");
        assertEquals((await listTransitionRecoveryRecords(root)).length, 0);
        assertEquals((await listEntries(root)).length, 1);
    });
});

Deno.test("status closes an execution workflow when Core archives its authoritative Plan", async () => {
    await withProject(async (root) => {
        const started = await implementing(root);
        const execution = started.workflow.execution;
        assert(execution?.executionCwd && execution.worktreeId);
        const plan = await loadPlan(execution.executionCwd, "dark-mode-toggle");
        assert(plan);
        await updateEntry(root, execution.worktreeId, { status: "validated" });
        await updatePlanFrontMatter(
            execution.executionCwd,
            "dark-mode-toggle",
            {
                status: "verified",
                worktreeStatus: "merged",
            },
            {},
            { expectedRevision: plan.revision },
        );
        await archivePlan(root, "dark-mode-toggle");
        assertEquals(await loadPlan(execution.executionCwd, "dark-mode-toggle"), null);
        const status = await spawnAttachedCli("status", root, { workflowId: started.workflow.workflowId });
        assert(status.result.ok && status.result.workflow.nextAction.kind === "return_to_host", JSON.stringify(status));
        assertEquals(status.result.workflow.state, "closed");
        assertEquals(status.result.workflow.nextAction.reason, "plan_advanced_in_core");
    });
});

for (const checkpoint of ["retained", "missing"] as const) {
    Deno.test(`fresh preparation reconciles its source journal only when the checkpoint is ${checkpoint}`, async () => {
        await withProject(async (root) => {
            const ready = await readyPlan(root);
            const oldRecord = await readRecordBytes(root, ready.workflowId);
            const started = await runOperation("start_execution", root, executionInput(ready, "lost-start"));
            assert(started.ok);
            const execution = started.workflow.execution;
            assert(execution?.executionCwd && execution.worktreeId && execution.worktreeBranch);
            const git = await new Deno.Command("git", {
                args: ["rev-parse", "HEAD"],
                cwd: execution.executionCwd,
                stdout: "piped",
                stderr: "piped",
            }).output();
            assert(git.success);
            const preparationCommit = checkpoint === "retained"
                ? new TextDecoder().decode(git.stdout).trim()
                : "0000000000000000000000000000000000000000";
            const transitionId = crypto.randomUUID();
            await Deno.mkdir(getTransitionJournalDir(root), { recursive: true });
            await Deno.writeTextFile(
                getTransitionJournalPath(root, transitionId),
                JSON.stringify({
                    version: 1,
                    transitionId,
                    operation: "execution_preparation",
                    planName: "dark-mode-toggle",
                    resources: [{ kind: "plan", id: "dark-mode-toggle" }, {
                        kind: "attempt",
                        id: execution.worktreeId,
                    }],
                    state: "applying",
                    intendedPostconditions: { status: "in_progress" },
                    completedEffects: [{
                        effect: "execution_preparation_checkpoint_settled",
                        proof: {
                            preparationCommit,
                            worktreeId: execution.worktreeId,
                            worktreeBranch: execution.worktreeBranch,
                        },
                        completedAt: new Date().toISOString(),
                    }],
                    updatedAt: new Date().toISOString(),
                }),
            );
            await Deno.writeTextFile(
                join(locateAttachedWorkflows(root).workflowsDir, `${ready.workflowId}.json`),
                oldRecord,
            );
            const retry = await spawnAttachedCli("start_execution", root, executionInput(ready, "retry-start"));
            assertEquals(retry.result.ok, checkpoint === "retained", JSON.stringify(retry.result));
            assertEquals((await listTransitionRecoveryRecords(root)).length, checkpoint === "retained" ? 0 : 1);
            assertEquals((await listEntries(root)).length, 1);
            if (retry.result.ok) assertEquals(retry.result.workflow.execution?.worktreeId, execution.worktreeId);
        });
    });
}
