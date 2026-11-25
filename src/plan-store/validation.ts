import { loadPlan, updatePlanFrontMatter, withPlanLock } from "../plan-store.ts";
import { findActiveByPlanName } from "../shared/worktree-registry.ts";
import { buildPlanEventUpdates } from "@runwield/plans/lifecycle";
import { makeValidationCheckpoint } from "../shared/workflow/validation-checkpoint.ts";
import { ProjectRuntimeReadPendingError } from "../shared/project-runtime-layout.ts";
import { hasRetainedCheckoutSource } from "./retained-source.ts";
import { withOrderedTransitionResources, type TransitionResource } from "./transitions.ts";
import { currentPackageSelection, recoverGeneratedManualQaArtifact, packageWorkflowLocks } from "./workflows.ts";

type PublicationExecution = Awaited<ReturnType<typeof findActiveByPlanName>>;
/** Publication Git effects run while the owner holds both the primary and recorded execution documents. */
export async function withPlanPublication<T>(
    cwd: string,
    name: string,
    publish: (execution: PublicationExecution) => Promise<T>,
    options: { lockEpicFamily?: boolean } = {},
): Promise<T> {
    if (options.lockEpicFamily && hasRetainedCheckoutSource(cwd)) {
        const attempt = await findActiveByPlanName(cwd, name);
        const roots = [...new Set([cwd, ...(attempt ? [attempt.path] : [])])];
        const parentAt = async (root: string) => (await loadPlan(root, name))?.attrs.parentPlan?.trim();
        const family = await Promise.all(roots.map(async (root) => ({ root, parent: await parentAt(root) })));
        const resources = family.flatMap<TransitionResource>(({ root, parent }) => [
            { kind: "plan", root, id: name },
            ...(parent ? [{ kind: "plan" as const, root, id: parent }] : []),
        ]);
        return await withOrderedTransitionResources(cwd, resources, async () => {
            const current = await findActiveByPlanName(cwd, name);
            const liveParents = await Promise.all(roots.map(parentAt));
            if (
                current?.id !== attempt?.id ||
                current?.path !== attempt?.path ||
                liveParents.some((parent, index) => parent !== family[index].parent)
            )
                throw new ProjectRuntimeReadPendingError();
            return await publish(current);
        });
    }
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
