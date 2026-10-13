import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { addEntry, getWorktreeRegistryPath } from "../worktree-registry.js";
import { HostedSession } from "./hosted-session.js";
import { restoreExecutionWorkflow } from "./execution-workflow-recovery.ts";
import { resolvePersistedExecutionRootConfiguration } from "./runtime/support.ts";
import { createPlanDeviationTool } from "../../tools/plan-deviation.ts";

const repository = defineGitFixture(async (root) => {
    await fsWriteFile(`${root}/README.md`, "fixture\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "fixture"]);
});

type DeviationContext = Parameters<ReturnType<typeof createPlanDeviationTool>["execute"]>[4];

type RecoveryCase =
    | "legacy_pair_completed"
    | "legacy_pair"
    | "matching"
    | "implemented"
    | "wrong_checkout_id"
    | "abandoned"
    | "unattached_checkout"
    | "wrong_id"
    | "ambiguous"
    | "finished"
    | "cleared"
    | "pair_stopped"
    | "pair_cleared"
    | "other_owner"
    | "missing_checkout"
    | "planning_association"
    | "task_completed";

for (
    const scenario of [
        "legacy_pair_completed",
        "legacy_pair",
        "matching",
        "implemented",
        "wrong_checkout_id",
        "abandoned",
        "unattached_checkout",
        "wrong_id",
        "ambiguous",
        "finished",
        "cleared",
        "pair_stopped",
        "pair_cleared",
        "other_owner",
        "missing_checkout",
        "planning_association",
        "task_completed",
    ] as RecoveryCase[]
) {
    test(`legacy execution recovery ${scenario} preserves writable ownership safety`, async () => {
        await withRuntimeCommandFixture("execution-recovery-", async () => {
            const root = await repository.checkout();
            const checkout = `${root}-execution`;
            try {
                await savePlan(root, "feature", "# Original requirement", {
                    classification: "PLANNED_CHANGE",
                    status: "ready_for_work",
                    planId: "execution-plan",
                    executionAgent: "engineer",
                });
                await git(root, ["add", "."]);
                await git(root, ["commit", "-m", "Plan"]);
                await git(root, ["worktree", "add", "-b", "execution", checkout]);
                const checkoutPlan = await loadPlan(checkout, "feature");
                if (!checkoutPlan) throw new Error("Expected execution Plan.");
                await savePlan(checkout, "feature", "# Original requirement", {
                    classification: "PLANNED_CHANGE",
                    status: scenario === "finished"
                        ? "verified"
                        : scenario === "implemented"
                        ? "implemented"
                        : "in_progress",
                    planId: scenario === "wrong_checkout_id" ? "different-plan" : "execution-plan",
                    executionAgent: "engineer",
                }, { expectedRevision: checkoutPlan.revision });
                const entry = {
                    id: "execution-attempt",
                    planId: "execution-plan",
                    planName: "feature",
                    baseBranch: "main",
                    baseRef: "refs/heads/main",
                    baseCommit: await git(root, ["rev-parse", "HEAD"]),
                    branch: "execution",
                    path: checkout,
                    status: scenario === "abandoned" ? "abandoned" as const : "active" as const,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                await addEntry(root, entry);
                if (scenario === "ambiguous") {
                    const path = getWorktreeRegistryPath(root);
                    const registry = JSON.parse(await fsReadFile(path, "utf8"));
                    registry.entries.push({ ...entry, id: "conflicting-attempt" });
                    await fsWriteFile(path, JSON.stringify(registry));
                }
                if (scenario === "missing_checkout") await git(root, ["worktree", "remove", "--force", checkout]);
                if (scenario === "unattached_checkout") {
                    await fsRm(`${checkout}/.git`);
                    await git(root, ["worktree", "prune", "--expire", "now"]);
                }
                const manager = SessionManager.inMemory(root);
                manager.appendCustomEntry("runwield.workflow_context", {
                    planName: "feature",
                    planId: "execution-plan",
                    routingIntent: "PLANNED_CHANGE",
                    complexity: "MEDIUM",
                });
                manager.appendCustomEntry("runwield.active_agent", {
                    agentName: scenario === "other_owner" ? "router" : "plan-engineer",
                });
                manager.appendCustomEntry("runwield.plan_association", {
                    planId: scenario === "wrong_id" ? "wrong-plan" : "execution-plan",
                    planName: "feature",
                    purpose: scenario === "planning_association" ? "planning" : "execution",
                    segmentId: "legacy-segment",
                    segmentKind: "execution",
                    recordedAt: new Date().toISOString(),
                });
                if (scenario === "cleared") {
                    manager.appendCustomEntry("runwield.execution_workflow", { version: 1, workflow: null });
                }
                if (scenario === "pair_stopped" || scenario === "pair_cleared") {
                    manager.appendCustomEntry("runwield.pair_checkpoint", {
                        version: 1,
                        state: scenario === "pair_cleared" ? "cleared" : "resolved",
                        reason: "workflow_cleared",
                        decision: scenario === "pair_stopped" ? "stop" : undefined,
                    });
                }
                if (scenario === "task_completed") {
                    manager.appendCustomEntry("runwield.task_completion", { version: 1, state: "accepted" });
                }
                const session = new HostedSession({
                    cwd: root,
                    sessionManager: manager,
                    interactionAdapter: {
                        supportsInteraction: (type) => type === "plan_deviation_confirmation",
                        requestInteraction: () => ({ outcome: "accepted", value: true }),
                    },
                });
                if (scenario === "legacy_pair" || scenario === "legacy_pair_completed") {
                    manager.appendCustomEntry("runwield.pair_checkpoint", {
                        version: 1,
                        state: "reported",
                        checkpointId: "legacy-checkpoint",
                        checkpointNumber: 7,
                        workflowAttemptKey: "worktree:execution-attempt",
                        timestampMs: Date.now(),
                        workflow: {
                            planName: "feature",
                            triageMeta: checkoutPlan.attrs,
                            executionAgent: "engineer",
                            executionStarted: true,
                            executionCwd: checkout,
                            projectRoot: root,
                            worktreeId: "execution-attempt",
                            worktreeBranch: "execution",
                            executionMode: "worktree",
                            collaborationStyle: "autonomous",
                            collaborationRecommendation: "pair",
                            pairCheckpointCount: 7,
                            pairSwitchedToAutonomous: true,
                        },
                        report: { summary: "Legacy checkpoint", final: false },
                        source: {
                            runtimeTurnId: "turn",
                            requestId: "request",
                            attemptId: "attempt",
                            dispatchKind: "user",
                            promptMode: "user",
                        },
                    });
                }
                if (scenario === "legacy_pair_completed") {
                    manager.appendCustomEntry("runwield.task_completion", { version: 1, state: "accepted" });
                }
                await restoreExecutionWorkflow(session);
                resolvePersistedExecutionRootConfiguration(session);
                if (scenario === "legacy_pair") {
                    assertEquals(session.getActiveExecutionWorkflow()?.pairCheckpointCount, 7);
                    assertEquals(session.getActiveExecutionWorkflow()?.collaborationStyle, "autonomous");
                }
                const entriesBeforeResume = manager.getEntries().length;
                await restoreExecutionWorkflow(session);
                assertEquals(
                    manager.getEntries().length,
                    entriesBeforeResume,
                    "Repeated restoration must not append state.",
                );
                const result = await createPlanDeviationTool({ hostedSession: session }).execute(
                    "recovered-deviation",
                    {
                        supersededRequirement: "Original requirement",
                        replacementRequirement: "Confirmed replacement",
                    },
                    undefined,
                    undefined,
                    {} as DeviationContext,
                );
                assertEquals(
                    result.details.decision,
                    scenario === "matching" || scenario === "implemented" || scenario === "legacy_pair"
                        ? "recorded"
                        : "inactive",
                );
                assertEquals((await loadPlan(root, "feature"))?.attrs.planDeviations?.length || 0, 0);
                if (scenario !== "missing_checkout") {
                    assertEquals(
                        (await loadPlan(checkout, "feature"))?.attrs.planDeviations?.length || 0,
                        scenario === "matching" || scenario === "implemented" || scenario === "legacy_pair" ? 1 : 0,
                    );
                }
            } finally {
                await fsRm(root, { recursive: true });
                await fsRm(checkout, { recursive: true }).catch(() => {});
            }
        });
    });
}
