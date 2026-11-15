/** Opaque request continuation. Its JSON representation remains the existing saved admission record. */
import { selectLocalPlanWorkflow } from "./access.ts";
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
    const selection = currentPackageSelection();
    return selection ? retainPlanAccess(selection) : undefined;
}

export async function selectPlanAccess(cwd: string, reference: string): Promise<PlanAccess | undefined> {
    const selection = await selectLocalPlanWorkflow(cwd, reference);
    return selection ? retainPlanAccess(selection) : undefined;
}

export async function withPlanAccess<T>(
    cwd: string,
    access: PlanAccess,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    return await withPackageWorkflow(cwd, decodePlanAccess(access), run, planName);
}

export async function resumePlanAttempt<T>(
    cwd: string,
    access: PlanAccess,
    attemptId: string | undefined,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    return await withRecordedPlanAttempt(cwd, decodePlanAccess(access), attemptId, run, planName);
}
