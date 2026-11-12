import { loadPlan, StalePlanWriteError } from "../plan-store.js";
import { withLocalPlanWorkflow } from "./access.ts";
import { currentPackageProject, currentPackageSelection, packageWorkflowLocks, selectedPackage } from "./workflows.ts";
import { renamePlanPackage } from "./packages.ts";
import { assertSharedPlanWriteAllowed } from "../shared/collaboration/lock.ts";

/** Rename a live package without changing its durable identity or choosing a physical destination in the caller. */
export async function renamePlan(
    cwd: string,
    reference: string,
    name: string,
    expectedRevision: string,
): Promise<void> {
    await withLocalPlanWorkflow(cwd, reference, async () => {
        const owner = currentPackageProject();
        if (!owner) throw new Error("Renaming requires a canonical Plan; import the retained document first.");
        const identity = { planId: currentPackageSelection()!.planId };
        await packageWorkflowLocks([identity], async () => {
            const selected = await selectedPackage(identity);
            const plan = await loadPlan(cwd, selected.metadata.name);
            if (!plan || plan.revision !== expectedRevision)
                throw new StalePlanWriteError(expectedRevision, plan?.revision || "missing");
            assertSharedPlanWriteAllowed(plan.attrs);
            await renamePlanPackage(owner, selected.metadata.planId, selected.metadata.revision, name);
        });
    });
}
