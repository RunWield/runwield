import { existsSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { WORKTREE_REGISTRY_FILE } from "../../constants.js";
import { loadPlan, savePlan } from "../../plan-store.js";
import { assertEquals } from "../../testing/assertions.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { HostedSession } from "../session/hosted-session.js";
import { inspectWorktreeRegistry } from "../worktree-registry.js";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "./execution-start.ts";

const fixture = defineCommittedGitFixture({ "sentinel.txt": "original\n" });

test("isolated execution uses the Plan saved only in the selected unregistered linked checkout", async () => {
    // This fixture holds withProcessGlobalTestLock while changing HOME, cwd, and PATH.
    // Only external executables (including cymbal) are fixtures; execution ports are real.
    await withRuntimeCommandFixture("execution-start-linked-", async ({ alternateRoot }) => {
        const primary = await realpath(await fixture.checkout());
        const linked = join(alternateRoot, "linked");
        let hostedSession: HostedSession | undefined;
        try {
            await git(primary, ["worktree", "add", "-b", "selected-plan", linked]);
            await savePlan(
                linked,
                "remote-delivery",
                "# Remote delivery\n\n## Context\n\nUse the selected source.\n\n## Implementation\n\n- Update sentinel.txt.\n\n## Verification\n\n- Read sentinel.txt.\n",
                {
                    planId: "remote-delivery-plan",
                    classification: "PLANNED_CHANGE",
                    status: "ready_for_work",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    targetBranch: "main",
                    affectedPaths: ["sentinel.txt"],
                },
            );
            const selectedPlan = await loadPlan(linked, "remote-delivery");
            assert(selectedPlan);
            assertEquals(existsSync(join(primary, "docs")), false);
            assertEquals((await inspectWorktreeRegistry(linked)).entries, []);
            hostedSession = new HostedSession({ id: "linked-execution-start", cwd: linked });

            await startActiveExecutionWorkflow({
                planName: "remote-delivery",
                triageMeta: selectedPlan.attrs,
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            });

            const workflow = hostedSession.getActiveExecutionWorkflow();
            assert(workflow);
            assertEquals(workflow.executionStarted, true);
            assertEquals(workflow.executionMode, "worktree");
            assertEquals(workflow.projectRoot, primary);
            assert(workflow.executionCwd);
            assert(workflow.executionCwd !== linked && workflow.executionCwd !== primary);
            assertEquals(workflow.executionAgent, "engineer");
            assertEquals(workflow.collaborationStyle, "autonomous");
            const executionPlan = await loadPlan(workflow.executionCwd, "remote-delivery");
            assert(executionPlan);
            assertEquals(executionPlan.attrs.planId, selectedPlan.attrs.planId);
            assertEquals(executionPlan.attrs.classification, selectedPlan.attrs.classification);
            assertEquals(executionPlan.attrs.targetBranch, "main");
            assertEquals(executionPlan.attrs.executionAgent, "engineer");
            assertEquals(executionPlan.attrs.status, "in_progress");
            assertEquals(executionPlan.body, selectedPlan.body);
            assertEquals(existsSync(join(primary, "docs")), false);
            assertEquals(await readFile(join(linked, "sentinel.txt"), "utf8"), "original\n");

            const registry = await inspectWorktreeRegistry(primary);
            assertEquals(registry.entries.length, 1);
            const entry = registry.entries[0];
            assert(entry);
            assertEquals(entry.id, workflow.worktreeId);
            assertEquals(entry.planId, "remote-delivery-plan");
            assertEquals(entry.planName, "remote-delivery");
            assertEquals(entry.path, workflow.executionCwd);
            assertEquals(entry.branch, workflow.worktreeBranch);
            assertEquals(entry.status, "active");
            assertEquals((await inspectWorktreeRegistry(linked)).entries, registry.entries);
            const layout = resolveProjectRuntimeLayout(linked);
            assertEquals(
                layout.primary.worktreeRegistryPath,
                resolveProjectRuntimeLayout(primary).primary.worktreeRegistryPath,
            );
            assertEquals(existsSync(layout.primary.worktreeRegistryPath), true);
            assertEquals(existsSync(join(layout.selected.internalRoot, WORKTREE_REGISTRY_FILE)), false);
        } finally {
            hostedSession?.dispose();
            await rm(primary, { recursive: true, force: true });
        }
    });
});
