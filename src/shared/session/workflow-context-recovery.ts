import type { WorkflowContext } from "./workflow-context-session.js";
import { loadPlanActionEvidence } from "../workflow/plan-actions.ts";

// Legacy transcripts lack accepted progress. Reconcile only confirmed same-Plan delivery,
// including after a metadata-only activation; neither Plan nor transcript is rewritten.
export async function reconcileLegacyCompletion(
    cwd: string,
    context: WorkflowContext | null,
): Promise<WorkflowContext | null> {
    if (!context?.planId || context.validationProgress || context.status === "verified") return context;
    const result = await loadPlanActionEvidence(cwd, context.planId);
    return result.kind === "success" && result.evidence.status === "verified"
        ? { ...context, status: "verified", planName: result.evidence.planName }
        : context;
}

/** Reconnect projects remote authority into memory. It never resumes a workflow or writes its evidence. */
export async function reconcileRemoteWorkflow(
    cwd: string,
    context: WorkflowContext | null,
): Promise<WorkflowContext | null> {
    if (!context?.planId || !context.validationProgress || context.validationProgress.outcome === "verified")
        return await reconcileLegacyCompletion(cwd, context);
    if (!["running", "paused"].includes(context.validationProgress.outcome)) return context;
    const { withProjectRuntimeReadScope } = await import("../project-runtime-layout.ts");
    return await withProjectRuntimeReadScope(async () => {
        const { healSettledTransitionRecords } = await import("../workflow/transition-recovery.ts");
        const { listEntries } = await import("../worktree-registry.js");
        const { reconcileStoredPublication } = await import("../workflow/publication-machine.ts");
        let verified = false;
        let status = context.status;
        try {
            const transitions = await healSettledTransitionRecords(cwd, {
                planName: context.planName || undefined,
                apply: false,
            });
            const plan = await loadPlanActionEvidence(cwd, context.planId!);
            const attempts = (await listEntries(cwd, { migrate: false })).filter(
                (entry) => entry.planId === context.planId,
            );
            const publication =
                attempts.length === 1 && attempts[0].publication
                    ? await reconcileStoredPublication(cwd, attempts[0].publication, { apply: false })
                    : null;
            if (plan.kind === "success") status = plan.evidence.status;
            verified =
                transitions.remaining.length === 0 &&
                ((plan.kind === "success" && plan.evidence.status === "verified") ||
                    publication?.phase === "publication_verified" ||
                    publication?.phase === "cleanup_complete");
        } catch {
            // No permission to infer a result from absent or contradictory evidence.
        }
        const { completeValidationProgress } = await import("../workflow/validation-progress.ts");
        return {
            ...context,
            status: verified ? "verified" : status,
            validationProgress: verified
                ? completeValidationProgress(
                      {
                          ...context.validationProgress!,
                          checks: {
                              ...context.validationProgress!.checks,
                              merge: context.validationProgress!.kind === "workflow" ? "passed" : "skipped",
                          },
                      },
                      true,
                      "Publication confirmed from remote delivery evidence. No workflow was repeated.",
                  )
                : {
                      ...context.validationProgress!,
                      outcome: "paused",
                      message:
                          "The interrupted result is uncertain. Remote evidence does not prove completion. No workflow was repeated.",
                  },
        };
    });
}
