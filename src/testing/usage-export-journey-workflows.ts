import { loadPlanActionEvidence } from "../shared/workflow/plan-actions.ts";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { assertEquals } from "./assertions.ts";
import { loadPlan, savePlan, updatePlanFrontMatter } from "../plan-store.js";
import { createGitPort } from "../shared/git-port.ts";
import { git } from "../shared/git-test-fixture.ts";
import { setExactProjectCustomSetting } from "../shared/settings.js";
import { HostedSession } from "../shared/session/hosted-session.js";
import { ensureRootAgentSession } from "../shared/session/session.js";
import type { SessionRuntime } from "../shared/session/session-runtime.ts";
import { findById } from "../shared/worktree-registry.js";
import { createTestWorktreeAttempt } from "../shared/worktree-test-helpers.ts";
import { cleanupStoredPublication } from "../shared/workflow/publication-machine.ts";
import { buildPlanEventUpdates, type PlanEvent, type PlanEventDetails } from "../shared/workflow/plan-lifecycle.js";
import { runPlanLifecycleEventTransition } from "../shared/workflow/state-transition.ts";
import { makePublicationOutcomeFixture } from "../shared/workflow/testing/publication-outcome-fixture.ts";
import { runValidationPhase } from "../shared/workflow/validation.ts";
import { runLocalCI } from "../shared/workflow/validation-local-ci.ts";
import { attachRecorder, makeUi, UNEXPECTED_VALIDATION_PORTS } from "../shared/workflow/validation-test-helpers.js";
import { handlePlanRecovery, SYSTEM_RECOVERY_FLOW_PORTS } from "../cmd/load-plan/plan-recovery-flow.ts";
import { createPlanSessionSurface } from "../cmd/load-plan/plan-session-surface.ts";

/** Real failed CI, Agent repair using real tools, rerun, publication and idempotent cleanup. */
export async function runJourneyPublication(
    root: string,
    publication: Awaited<ReturnType<typeof makePublicationOutcomeFixture>>,
    respond: (...messages: AssistantMessage[]) => void,
) {
    const session = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: root }), makeUi());
    try {
        await ensureRootAgentSession({ hostedSession: session, agentName: "engineer", cwd: publication.executionCwd });
        setExactProjectCustomSetting("verification_command", "test -f repair-done", publication.executionCwd);
        const plan = await loadPlan(publication.executionCwd, "demo");
        assert(plan);
        session.setActiveExecutionWorkflow({
            planName: "demo",
            triageMeta: plan.attrs,
            executionAgent: "engineer",
            projectRoot: root,
            executionCwd: publication.executionCwd,
            executionMode: "worktree",
            worktreeId: "attempt-demo",
            worktreeBranch: "worktree/demo",
            worktreeBaseBranch: "main",
            baselineTree: await git(publication.executionCwd, ["rev-parse", "HEAD^{tree}"]),
            validationContinuation: true,
        });
        respond(
            fauxAssistantMessage(fauxToolCall("bash", { command: "touch repair-done" })),
            fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Fixed the failed check." })),
        );
        const result = await runValidationPhase({
            hostedSession: session,
            planName: "demo",
            planContent: plan.markdown,
            triageMeta: plan.attrs,
            git: createGitPort(),
            localCI: { run: (args) => runLocalCI({ ...args, settingsPolicy: "exact-project" }) },
            workRecordMnemotecaPort: UNEXPECTED_VALIDATION_PORTS.workRecordMnemotecaPort,
        });
        assertEquals(result.kind, "paused");
        assert("continueValidation" in result && result.continueValidation);
        const cleanup = await cleanupStoredPublication(root, await publication.confirm());
        assert(cleanup.complete);
        assert((await cleanupStoredPublication(root, cleanup.attempt)).complete);
    } finally {
        session.dispose();
    }
}

/** Commit actual lifecycle events in the execution checkout, with their actual attempt identity. */
async function lifecycle(root: string, name: string, attemptId: string, event: PlanEvent, details: PlanEventDetails) {
    const result = await runPlanLifecycleEventTransition({
        projectRoot: root,
        planName: name,
        worktreeId: attemptId,
        event,
        record: async ({ beforePlan }) => {
            assert(beforePlan);
            return await updatePlanFrontMatter(
                root,
                name,
                buildPlanEventUpdates(event, beforePlan.attrs.status, { ...details, triageMeta: beforePlan.attrs }),
                beforePlan.attrs,
                { expectedRevision: beforePlan.revision },
            );
        },
    });
    assertEquals(result.status, "committed", JSON.stringify(result));
}

/** One interrupted execution and one separately confirmed recovery abandonment, with no repair rounds. */
export async function runJourneyRecovery(
    home: string,
    root: string,
    runtime: SessionRuntime,
    interruptNext: (cancel: () => void) => void,
) {
    for (const name of ["ongoing", "abandon"]) {
        await savePlan(root, name, `# ${name}\n`, {
            planId: `plan-${name}`,
            classification: "PLANNED_CHANGE",
            status: "ready_for_work",
            executionAgent: "engineer",
            humanReviewMode: "none",
        });
    }
    await git(root, ["add", "docs/plans/ongoing.md", "docs/plans/abandon.md"]);
    await git(root, ["commit", "-m", "Journey recovery Plans"]);
    for (const name of ["ongoing", "abandon"]) {
        if (name === "ongoing") {
            const created = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
            let interrupted = false;
            interruptNext(() => {
                interrupted = runtime.cancelSession(created.sessionId).aborted;
            });
            const plan = await loadPlan(root, name);
            assert(plan);
            const evidence = await loadPlanActionEvidence(root, `plan-${name}`);
            assert(evidence.kind === "success");
            await runtime.executePlan(created.sessionId, {
                planName: name,
                triageMeta: {
                    ...plan.attrs,
                    revision: evidence.evidence.revision,
                    status: evidence.evidence.status,
                    worktree: evidence.evidence.worktree,
                },
            });
            assert(interrupted, "Execution must reach the model and be canceled");
            const workflow = runtime.getRuntimeActiveExecutionWorkflow(created.sessionId);
            assert(workflow?.executionCwd);
            const ongoing = await loadPlan(workflow.executionCwd, name);
            assertEquals(ongoing?.attrs.status, "in_progress");
            await runtime.closeSessionWhenIdle(created.sessionId);
            continue;
        }
        const entry = await createTestWorktreeAttempt({
            projectRoot: root,
            planName: name,
            planId: `plan-${name}`,
            attemptId: `attempt-${name}`,
            baseBranch: "main",
            baseRef: "main",
            worktreeRoot: join(home, "journey-worktrees"),
        });
        await lifecycle(entry.path, name, entry.id, "execution_started", {
            worktreeId: entry.id,
            worktreePath: entry.path,
            worktreeBranch: entry.branch,
            worktreeBaseBranch: entry.baseBranch,
            executionBaselineTree: await git(entry.path, ["rev-parse", "HEAD^{tree}"]),
        });
        const created = await runtime.createInteractiveSession({ cwd: root, mode: "new" });
        const surface = createPlanSessionSurface(runtime, created.sessionId, {
            executePlan: (options) => runtime.executePlan(created.sessionId, options),
            runPlanningAgent: (options) => runtime.runPlanningAgent(created.sessionId, options),
            runValidation: (options) => runtime.runValidation(created.sessionId, options),
            runSlicerAgent: (options) => runtime.runSlicerAgent(created.sessionId, options),
        });
        const ui = makeUi();
        const answers = ["abandon", "confirm", "cancel"];
        ui.promptSelect = () => Promise.resolve(answers.shift() || "cancel");
        const plan = await loadPlan(entry.path, name);
        assert(plan);
        await handlePlanRecovery({
            projectRoot: root,
            plan: { ...plan, planName: name },
            agentName: "engineer",
            uiAPI: ui,
            session: surface,
            recordedAttempt: entry,
            ports: SYSTEM_RECOVERY_FLOW_PORTS,
        });
        assertEquals((await findById(root, entry.id))?.status, "abandoned");
        await runtime.closeSessionWhenIdle(created.sessionId);
    }
}
