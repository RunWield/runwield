import { StalePlanWriteError } from "@runwield/plans/store";
import {
    managedPlanStoreActive,
    captureManagedReview,
    currentManagedPlanSelection,
    managedExecutionRoot,
    readManagedPlan,
} from "./managed.ts";
/** Coherent review documents and retained inputs; surfaces never assemble package snapshots. */
import { loadPlanFileStrict, loadPlan } from "../plan-store.ts";
import { withLocalPlanWorkflow } from "./access.ts";
import { capturePlanAccess } from "./handles.ts";
import {
    currentPackageSelection,
    packageWorkflowLocks,
    loadPackageWorkflowPlan,
    capturePackageWorkflowInput,
    assertPackageWorkflowInput,
} from "./workflows.ts";

export async function preparePlanReviewDocument(path: string, expectedRevision?: string) {
    if (managedPlanStoreActive()) {
        const selected = currentManagedPlanSelection();
        const cwd = managedExecutionRoot();
        const document = await readManagedPlan(cwd, selected?.planId || path);
        if (!document) throw new Error("Review Plan is unavailable.");
        const packageInput = await captureManagedReview(
            cwd,
            document.attrs.planId!,
            expectedRevision || document.revision,
        );
        return { document, packageInput, access: capturePlanAccess() };
    }
    const selection = currentPackageSelection();
    if (!selection) {
        const document = await loadPlanFileStrict(path);
        if (document.kind !== "loaded") {
            if (document.kind === "malformed") throw document.error;
            throw new Error("The Plan could not be opened for review. Your files have not been changed.");
        }
        if (expectedRevision && document.revision !== expectedRevision)
            throw new StalePlanWriteError(expectedRevision, document.revision);
        return { document, packageInput: undefined, access: undefined };
    }
    return await packageWorkflowLocks([{ planId: selection.planId }], async () => {
        const document = await loadPackageWorkflowPlan({ planId: selection.planId });
        if (expectedRevision && document.revision !== expectedRevision)
            throw new StalePlanWriteError(expectedRevision, document.revision);
        const packageInput = await capturePackageWorkflowInput({ planId: selection.planId });
        await assertPackageWorkflowInput({ planId: selection.planId }, packageInput);
        const current = await loadPackageWorkflowPlan({ planId: selection.planId });
        if (document.revision !== current.revision) throw new StalePlanWriteError(document.revision, current.revision);
        return { document, packageInput, access: capturePlanAccess() };
    });
}

/** Capture against an already displayed revision; retained legacy review needs no package input. */
export async function capturePlanReviewInput(cwd: string, planName: string, expectedRevision: string) {
    if (managedPlanStoreActive()) return await captureManagedReview(cwd, planName, expectedRevision);
    return await withLocalPlanWorkflow(cwd, planName, async () => {
        if (!currentPackageSelection()) return undefined;
        const plan = await loadPlan(cwd, planName);
        if (!plan) throw new Error("The selected Plan is unavailable.");
        return (await preparePlanReviewDocument(plan.path, expectedRevision)).packageInput;
    });
}
