import { loadPlan, updatePlanFrontMatter, withPlanLock } from "../plan-store.js";
import { findActiveByPlanName } from "../shared/worktree-registry.js";
import { buildPlanEventUpdates } from "../shared/workflow/plan-lifecycle.js";
import { makeValidationCheckpoint } from "../shared/workflow/validation-checkpoint.ts";
import { currentPackageSelection, recoverGeneratedManualQaArtifact, packageWorkflowLocks } from "./workflows.ts";

type PublicationExecution = Awaited<ReturnType<typeof findActiveByPlanName>>;
/** Publication Git effects run while the owner holds both the primary and recorded execution documents. */
export async function withPlanPublication<T>(
    cwd: string,
    name: string,
    publish: (execution: PublicationExecution) => Promise<T>,
): Promise<T> {
    return await withPlanLock(cwd, name, async () => {
        const execution = await findActiveByPlanName(cwd, name);
        return execution
            ? await withPlanLock(execution.path, name, () => publish(execution))
            : await publish(execution);
    });
}

/** Invalidate stale validation evidence while preserving the active supervisor's ownership. */
export async function restartPlanValidation(
    cwd: string,
    name: string,
    attemptId: string,
    planId?: string,
): Promise<void> {
    await withPlanLock(cwd, name, async () => {
        const plan = await loadPlan(cwd, name);
        if (!plan || plan.attrs.planId !== planId) throw new Error("Publication Plan identity changed.");
        const checkpoint = plan.attrs.validationCheckpoint;
        const updates = buildPlanEventUpdates("validation_invalidated", plan.attrs.status);
        await updatePlanFrontMatter(
            cwd,
            name,
            {
                ...updates,
                validationCheckpoint:
                    checkpoint?.state === "running"
                        ? makeValidationCheckpoint({
                              attemptId,
                              generation: checkpoint.generation,
                              status: "implemented",
                              phase: "mechanical",
                              state: "running",
                              ownerPid: checkpoint.ownerPid,
                              ownerHostname: checkpoint.ownerHostname,
                              ownerIdentity: checkpoint.ownerIdentity,
                              lastSettledOperationId: checkpoint.lastSettledOperationId,
                          })
                        : null,
            },
            {},
            { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
        );
    });
}

export async function preparePlanGeneratedArtifacts(name: string): Promise<void> {
    if (!currentPackageSelection()) return;
    await packageWorkflowLocks([name], () => recoverGeneratedManualQaArtifact(name));
}
