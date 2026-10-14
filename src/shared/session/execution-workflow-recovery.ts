import { captureForegroundProcess } from "../captured-process.ts";
import { realpath as fsRealpath } from "node:fs/promises";
import type { HostedSession } from "./hosted-session.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ActiveExecutionWorkflow } from "../types.js";
import { readExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import { readPersistedActiveAgentName } from "./active-agent-session.js";
import { readPersistedWorkflowContext } from "./workflow-context-session.js";
import { readPlanAssociations } from "./plan-association.ts";
import { listEntries } from "../worktree-registry.js";
import { loadPlan } from "../../plan-store.js";
import { resolvePlanExecutionRuntimeAgent } from "../workflow/execution-agent.ts";
import { readCurrentPairCheckpoint } from "./pair-checkpoint-session.ts";

interface LifecycleEntry {
    type: string;
    customType?: string;
    data?: { state?: string; reason?: string; decision?: string; planId?: string; purpose?: string };
}

/** Restore only while the caller holds the managed Session writer lock. */
export async function restoreExecutionWorkflow(session: HostedSession): Promise<void> {
    const manager = session.getRootSessionManager();
    const snapshot = readExecutionWorkflowSnapshot(manager);
    if (snapshot) {
        const workflow = snapshot.workflow;
        if (workflow?.executionCwd) {
            const executionCwd = await fsRealpath(workflow.executionCwd);
            // Keep the current root spelling when it already names this checkout.
            // A reloaded root has its canonical spelling; do not restore a stale alias.
            if (await fsRealpath(session.cwd) === executionCwd) workflow.executionCwd = session.cwd;
        }
        session.restoreActiveExecutionWorkflow(workflow, null);
        return;
    }
    // Missing state is not permission to retain another generation's ownership.
    session.restoreActiveExecutionWorkflow(null, null);
    if (!manager) return;
    // A legacy Pair journal owns the complete choice, counter, and pause state.
    // Root configuration restores it; do not replace it with inferred defaults.
    if (readCurrentPairCheckpoint(session)) return;
    const owner = readPersistedActiveAgentName(manager);
    if (owner !== "plan-engineer" && owner !== "frontend-engineer") return;
    const context = readPersistedWorkflowContext(manager as SessionManager);
    const entries = manager.getBranch?.() || [];
    const association = readPlanAssociations(entries).at(-1);
    if (
        !association || association.purpose !== "execution" || !context?.planName ||
        context.planName !== association.planName ||
        (context.planId && context.planId !== association.planId)
    ) return;
    // A new typed execution association starts a new attempt. Older terminal
    // events do not release that attempt; later events must never be inferred away.
    const lifecycleEntries = entries as LifecycleEntry[];
    const associationIndex = lifecycleEntries.findLastIndex((entry) =>
        entry.type === "custom" && entry.customType === "runwield.plan_association" &&
        entry.data?.planId === association.planId && entry.data.purpose === "execution"
    );
    for (const entry of lifecycleEntries.slice(associationIndex + 1)) {
        if (entry.type !== "custom") continue;
        if (entry.customType === "runwield.task_completion" && entry.data?.state === "accepted") return;
        if (
            entry.customType === "runwield.pair_checkpoint" &&
            (entry.data?.decision === "stop" ||
                (entry.data?.state === "cleared" && entry.data.reason !== "superseded"))
        ) return;
    }
    let recoveredWorkflow: ActiveExecutionWorkflow | null = null;
    try {
        const candidates = (await listEntries(session.cwd, { migrate: false })).filter((entry) =>
            entry.planId === association.planId && entry.status === "active"
        );
        if (candidates.length !== 1) return;
        const entry = candidates[0];
        if (entry.status !== "active" || entry.planName !== association.planName) return;
        const output = await captureForegroundProcess("git", {
            cwd: session.cwd,
            args: ["worktree", "list", "--porcelain"],
        });
        if (output.code !== 0) return;
        const expectedPath = await fsRealpath(entry.path);
        let attachedCount = 0;
        for (const block of new TextDecoder().decode(output.stdout).trim().split(/\n\n+/)) {
            const lines = block.split("\n");
            const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
            if (
                path && lines.includes(`branch refs/heads/${entry.branch}`) &&
                await fsRealpath(path) === expectedPath
            ) attachedCount++;
        }
        if (attachedCount !== 1) return;
        const plan = await loadPlan(entry.path, association.planName);
        if (
            !plan || plan.attrs.planId !== association.planId ||
            !["in_progress", "implemented"].includes(String(plan.attrs.status))
        ) return;
        const executionAgent = plan.attrs.executionAgent;
        if (executionAgent !== "engineer" && executionAgent !== "frontend-engineer") return;
        if (resolvePlanExecutionRuntimeAgent(executionAgent) !== owner) return;
        const workflow: ActiveExecutionWorkflow = {
            planName: association.planName,
            triageMeta: plan.attrs,
            executionAgent,
            executionStarted: true,
            executionMode: "worktree",
            projectRoot: session.cwd,
            executionCwd: entry.path,
            worktreeId: entry.id,
            worktreeBranch: entry.branch,
            worktreeBaseBranch: entry.baseBranch,
            worktreeBaseRef: entry.baseRef,
            worktreeBaseCommit: entry.baseCommit,
            baselineTree: entry.executionBaselineTree || entry.baseTree,
            collaborationStyle: plan.attrs.collaborationRecommendation === "pair" ? "pair" : "autonomous",
            collaborationRecommendation: plan.attrs.collaborationRecommendation === "pair" ? "pair" : "autonomous",
        };
        recoveredWorkflow = workflow;
    } catch {
        // Missing, conflicting, or inaccessible evidence is not writable ownership.
        return;
    }
    // Do not hide a failure to persist RunWield-owned state as missing evidence.
    if (recoveredWorkflow) session.setActiveExecutionWorkflow(recoveredWorkflow);
}
