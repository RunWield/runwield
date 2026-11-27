import { projects, type HomeProjectOwner } from "@runwield/projects";
import { buildPlanEventUpdates } from "./lifecycle.ts";
import {
    packageWorkflowRevision,
    planPackageFamilyIds,
    updatePlanPackageMetadata,
    withPlanPackageLocks,
    type LoadedPlanPackage,
} from "./package-storage.ts";
import { currentExecutionRecoveryObservation, projectPlanFiles } from "./project-plan-files.ts";
import type { ExecutionRecreation } from "./project-store-wire.ts";
import { StalePlanWriteError } from "./store-errors.ts";

interface ManagedExecutionReplacement extends ExecutionRecreation {
    planId: string;
    originalAttemptId: string;
}

async function retainedChecklist(owner: HomeProjectOwner, plan: LoadedPlanPackage, replacementAttemptId: string) {
    const workflow = plan.metadata.workflow;
    const generated = workflow?.generatedArtifact;
    if (
        !generated ||
        (generated.reusedByAttemptId ?? generated.attemptId) !== workflow?.attempt?.attemptId ||
        generated.planId !== plan.metadata.parentPlanId
    )
        return;
    const parent = await projectPlanFiles.forOwner(owner).select({ planId: generated.planId });
    if (parent.documents.some(({ name, hash }) => name === generated.name && hash === generated.hash))
        return { ...generated, reusedByAttemptId: replacementAttemptId };
}

/** Commit the scoped host's replacement of the reserved attempt and reset its execution state in one Plan revision. */
export async function adoptManagedExecutionReplacement(
    owner: HomeProjectOwner,
    replacement: ManagedExecutionReplacement,
): Promise<string> {
    projects.home.assertStoreIdentity(owner);
    const { planId, originalAttemptId, replacementAttemptId, expectedRevision, operationId } = replacement;
    const files = projectPlanFiles.forOwner(owner);
    const target = { planId };
    const selected = await files.select(target);
    return await withPlanPackageLocks(owner, await planPackageFamilyIds(owner, [selected]), async () => {
        const plan = await files.select(target);
        const observedRevision = packageWorkflowRevision(plan);
        if (expectedRevision !== observedRevision) throw new StalePlanWriteError(expectedRevision, observedRevision);
        const original = plan.metadata.workflow?.attempt;
        const observation = currentExecutionRecoveryObservation(owner, plan, original, "recreate");
        if (
            !original ||
            original.executionMode ||
            original.attemptId !== originalAttemptId ||
            observation?.request.recreate?.operationId !== operationId ||
            observation.entry.id !== replacementAttemptId
        )
            throw new Error("Recreation requires proof of the reserved attempt and its replacement.");
        const { attrs } = await files.readWorkflow(target);
        const reset = buildPlanEventUpdates("recovery_reset", attrs.status, { triageMeta: attrs });
        const update = await files.prepareWorkflowUpdate(
            plan,
            attrs,
            {
                ...reset,
                documentWorktreeId: replacementAttemptId,
                executionReport: null,
                validationPhase: "mechanical",
                validationCiAttempts: 0,
                validationSemanticRounds: 0,
                publicationReceipt: null,
                publicationObservation: undefined,
            },
            {
                attempt: { ...original, attemptId: replacementAttemptId },
                publication: undefined,
                publicationPolicy: undefined,
                recordingPreparation: undefined,
                generatedArtifact: await retainedChecklist(owner, plan, replacementAttemptId),
            },
        );
        const metadata = await updatePlanPackageMetadata(
            owner,
            planId,
            plan.metadata.revision,
            update,
            expectedRevision,
        );
        return packageWorkflowRevision({ ...plan, metadata });
    });
}
