import { projects, type ProjectId } from "@runwield/projects";
import { checkoutPlanIdentity } from "./project-binding.ts";
import { managedPersonalStoreActive, withManagedProjectConnection } from "@runwield/plans/managed-project-connection";
import {
    managedPlanStoreActive,
    currentManagedPlanSelection,
    currentManagedRetainedExecution,
    selectManagedPlan,
    withManagedPlan,
    readManagedExecution,
    readManagedRetainedExecution,
    type ManagedPlanSelection,
} from "./managed.ts";
/** Opaque request continuation. Its JSON representation remains the existing saved admission record. */
import { PlanAccessMismatchError, selectLocalPlanWorkflow } from "./access.ts";
import {
    currentPackageSelection,
    withPackageWorkflow,
    withRecordedPlanAttempt,
    type PackageWorkflowSelection,
} from "./workflows.ts";

const planAccess = Symbol("Plan access");
export interface PlanAccess {
    readonly [planAccess]: true;
}

/** Private conversion; authority is checked against the actual owner when entering a request. */
export function retainPlanAccess(selection: PackageWorkflowSelection): PlanAccess {
    return Object.assign(structuredClone(selection), { [planAccess]: true as const });
}

/** Old saved selections have the same representation and are subject to the same authoritative checks. */
export function decodePlanAccess(access: PlanAccess): PackageWorkflowSelection {
    return access as PlanAccess & PackageWorkflowSelection;
}

export function capturePlanAccess(): PlanAccess | undefined {
    const managed = currentManagedPlanSelection();
    if ((managedPlanStoreActive() || currentManagedRetainedExecution()) && managed)
        return retainManagedPlanAccess(managed);
    const selection = currentPackageSelection();
    return selection ? retainPlanAccess(selection) : undefined;
}

/** Whether the admitted source uses canonical package publication rather than retained checkout documents. */
export function hasCanonicalPlanAccess(): boolean {
    return !currentManagedRetainedExecution() && Boolean(capturePlanAccess());
}

export async function selectPlanAccess(
    cwd: string,
    reference: string,
    expectedPlanId?: string,
    expectedProjectId?: ProjectId,
): Promise<PlanAccess | undefined> {
    if (expectedProjectId && checkoutPlanIdentity(cwd)?.projectId !== expectedProjectId)
        throw new PlanAccessMismatchError("The selected Plan belongs to another Project.");
    if (managedPlanStoreActive())
        return retainManagedPlanAccess(
            await selectManagedPlan(cwd, expectedPlanId || reference, Boolean(expectedPlanId)),
        );
    const selection = await selectLocalPlanWorkflow(cwd, expectedPlanId || reference, Boolean(expectedPlanId));
    return selection ? retainPlanAccess(selection) : undefined;
}

export async function withPlanAccess<T>(
    cwd: string,
    access: PlanAccess,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    const managed = decodeManagedPlanAccess(access);
    if (managed) {
        if (planName && managed.planName !== planName) throw new Error("Managed Plan admission names another Plan.");
        return await withManagedPlan(cwd, managed, run);
    }
    return await withPackageWorkflow(cwd, decodePlanAccess(access), run, planName);
}

export async function resumePlanAttempt<T>(
    cwd: string,
    access: PlanAccess,
    attemptId: string | undefined,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    const managed = decodeManagedPlanAccess(access);
    if (managed) {
        return await withManagedProjectConnection(async () => {
            if (managed.retainedAttemptId) {
                const retained = await readManagedRetainedExecution(cwd, managed.planId, managed.retainedAttemptId);
                if (
                    managed.retainedAttemptId !== attemptId ||
                    !retained ||
                    retained.cleanupComplete ||
                    retained.abandonmentComplete
                )
                    throw new Error("Retained execution attempt changed.");
                const current = await selectManagedPlan(cwd, managed.planId);
                if (current.retainedAttemptId !== attemptId) throw new Error("Retained execution attempt changed.");
                if (planName && current.planName !== planName)
                    throw new Error("Retained continuation names another Plan.");
                return await withManagedPlan(cwd, current, run);
            }
            const current = await selectManagedPlan(cwd, managed.planId, true);
            const execution = await readManagedExecution(cwd, managed.planId);
            if (!execution || execution.attemptId !== attemptId) throw new Error("Managed execution attempt changed.");
            if (planName && current.planName !== planName) throw new Error("Managed continuation names another Plan.");
            return await withManagedPlan(cwd, current, run);
        });
    }
    if (managedPersonalStoreActive()) {
        return await withManagedProjectConnection(async () => {
            const historical = decodePlanAccess(access);
            const inspected = projects.checkout.inspect(cwd);
            const selected = await selectManagedPlan(cwd, historical.planId);
            const retained = attemptId
                ? await readManagedRetainedExecution(cwd, historical.planId, attemptId)
                : undefined;
            if (
                inspected.kind !== "existing" ||
                !retained ||
                retained.cleanupComplete ||
                retained.abandonmentComplete ||
                historical.identity.projectId !== inspected.identity.projectId ||
                historical.identity.repositoryId !== inspected.identity.repositoryId ||
                historical.identity.executionAccountHome !== inspected.identity.executionAccountHome ||
                !("checkoutId" in historical.identity) ||
                historical.identity.checkoutId !== retained.checkoutId ||
                !(
                    historical.identity.personalOwner.identity === inspected.identity.personalOwner.identity ||
                    (historical.identity.personalOwner.kind === "execution-account" &&
                        historical.identity.personalOwner.identity === inspected.identity.executionAccountHome)
                )
            )
                throw new Error("Saved execution continuation does not match its adopted original owner.");
            if (planName && planName !== retained.planName)
                throw new Error("Saved execution continuation names another Plan.");
            return await withManagedPlan(cwd, selected, run);
        });
    }
    return await withRecordedPlanAttempt(cwd, decodePlanAccess(access), attemptId, run, planName);
}

export function retainManagedPlanAccess(selection: ManagedPlanSelection): PlanAccess {
    return Object.assign(structuredClone(selection), { [planAccess]: true as const });
}
export function decodeManagedPlanAccess(access: PlanAccess): ManagedPlanSelection | undefined {
    const selection = access as PlanAccess & Partial<ManagedPlanSelection>;
    return selection.kind === "managed-plan" ? (access as PlanAccess & ManagedPlanSelection) : undefined;
}
