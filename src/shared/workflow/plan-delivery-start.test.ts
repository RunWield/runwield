import { assert, assertEquals } from "@std/assert";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { HostedSession } from "../session/hosted-session.js";
import { setCustomSetting } from "../settings.js";
import { createExecutionStartPorts } from "./execution-start.ts";
import { startActiveExecutionWorkflow } from "./workflow.js";
import { effectiveDeliveryBranch } from "./plan-branch.ts";

const repo = defineCommittedGitFixture();

Deno.test("landing selection honors legacy target edits only when no delivery branch is recorded", () => {
    assertEquals(effectiveDeliveryBranch({ targetBranch: " release " }), "release");
    assertEquals(effectiveDeliveryBranch({ targetBranch: "release", deliveryBranch: " plan/saved " }), "plan/saved");
    assertEquals(effectiveDeliveryBranch({ targetBranch: "release", deliveryBranch: " " }), "release");
});

for (const autoMerge of [false, true]) {
    Deno.test(`legacy standalone FEATURE records the configured default and resumes its landing (${autoMerge})`, async () => {
        await withRuntimeCommandFixture("delivery-start-", async () => {
            const root = await repo.checkout();
            const first = new HostedSession({ id: crypto.randomUUID(), cwd: root });
            const resumed = new HostedSession({ id: crypto.randomUUID(), cwd: root });
            try {
                await git(root, ["branch", "-m", "trunk"]);
                await git(root, ["config", "init.defaultBranch", "trunk"]);
                await git(root, ["switch", "-c", "scratch"]);
                await git(root, ["commit", "--allow-empty", "-m", "Scratch"]);
                await setCustomSetting("plans", { autoMergeIntoTargetBranch: autoMerge }, "project", root);
                await savePlan(root, "legacy", "# Legacy\n", {
                    planId: "legacy",
                    classification: "FEATURE",
                    status: "ready_for_work",
                    affectedPaths: [],
                });
                const started = await startActiveExecutionWorkflow({
                    planName: "legacy",
                    triageMeta: {},
                    currentStatus: "ready_for_work",
                    hostedSession: first,
                    ports: createExecutionStartPorts(),
                });
                const landing = autoMerge ? "trunk" : "plan/legacy";
                assertEquals(started.worktreeBaseBranch, landing);
                const source = await loadPlan(root, "legacy");
                assertEquals(source?.attrs.targetBranch, "trunk");
                assertEquals(source?.attrs.deliveryBranch, landing);
                await setCustomSetting("plans", { autoMergeIntoTargetBranch: !autoMerge }, "project", root);
                const continued = await startActiveExecutionWorkflow({
                    planName: "legacy",
                    triageMeta: {},
                    currentStatus: "ready_for_work",
                    hostedSession: resumed,
                    ports: createExecutionStartPorts(),
                });
                assertEquals(continued.worktreeId, started.worktreeId);
                assertEquals(continued.worktreeBaseBranch, landing);
                assert(continued.executionCwd);
                assertEquals((await loadPlan(continued.executionCwd, "legacy"))?.attrs.targetBranch, "trunk");
            } finally {
                first.dispose();
                resumed.dispose();
                await Deno.remove(root, { recursive: true });
            }
        });
    });
}

for (const scenario of ["authored", "child", "quick-fix"] as const) {
    Deno.test(`${scenario} retains its explicit target without automatic Plan Branch routing`, async () => {
        await withRuntimeCommandFixture("delivery-exclusions-", async () => {
            const root = await repo.checkout();
            const session = new HostedSession({ id: crypto.randomUUID(), cwd: root });
            try {
                const target = scenario === "authored" ? "plan/custom" : "release";
                await git(root, ["branch", target]);
                if (scenario === "child") {
                    await savePlan(root, "epic", "# Epic\n", {
                        planId: "epic",
                        classification: "PROJECT",
                        status: "ready_for_work",
                        targetBranch: target,
                    });
                }
                await savePlan(root, "p", "# Plan\n", {
                    planId: "p",
                    classification: scenario === "quick-fix" ? "QUICK_FIX" : "PLANNED_CHANGE",
                    status: "ready_for_work",
                    targetBranch: target,
                    ...(scenario === "child" ? { parentPlan: "epic" } : {}),
                });
                const workflow = await startActiveExecutionWorkflow({
                    planName: "p",
                    triageMeta: {},
                    currentStatus: "ready_for_work",
                    hostedSession: session,
                    ports: createExecutionStartPorts(),
                });
                assertEquals(workflow.worktreeBaseBranch, target);
                assert(workflow.executionCwd);
                const execution = await loadPlan(workflow.executionCwd, "p");
                assert(execution);
                assertEquals(execution.attrs.targetBranch, target);
                if (scenario !== "authored") assertEquals(execution.attrs.deliveryBranch, undefined);
                assertEquals(await git(root, ["branch", "--list", "plan/p"]), "");
            } finally {
                session.dispose();
                await Deno.remove(root, { recursive: true });
            }
        });
    });
}
