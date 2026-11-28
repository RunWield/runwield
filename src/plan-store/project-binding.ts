import { projects, type ProjectId } from "@runwield/projects";
import { projectPlanStoreBinding } from "@runwield/plans/project-store-binding";
import type { ProjectPlanStoreOptions } from "@runwield/plans/store";
import {
    captureManagedProjectPlanAccess,
    managedPersonalStoreActive,
} from "@runwield/plans/managed-project-connection";
import { currentManagedRetainedExecution } from "./managed.ts";
import { hasRetainedCheckoutSource, validatedRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { currentPackageProject, currentPackageSelection, withPackageProject } from "./workflows.ts";

export class PlanAccessMismatchError extends Error {}

export function bindProjectPlanStore(projectId: ProjectId, options: ProjectPlanStoreOptions) {
    const binding = projectPlanStoreBinding(projectId, options);
    const managed = captureManagedProjectPlanAccess(projectId, binding.admitted);
    const local = managed ? undefined : binding.openLocal();
    if (managed) binding.verifyManagedRegistration();
    return async <Result>(
        operation: (cwd: string) => Promise<Result>,
        mode: "read" | "write" | "workflow-read" | "retained" = "write",
    ): Promise<Result> => {
        if (managed) {
            binding.verifyManagedRegistration();
            if (mode !== "retained" && currentManagedRetainedExecution())
                throw new Error("Managed Plan owner is unavailable.");
            return await managed(operation);
        }
        if (!local || managedPersonalStoreActive()) throw new Error("The Project's Plan owner changed after opening.");
        const identity = local();
        const cwd = projects.home.storeLocation(identity);
        const scope = mode === "workflow-read" || mode === "retained" ? currentPackageProject() : undefined;
        if (scope) {
            if (
                scope.projectId !== identity.projectId ||
                scope.personalOwner.identity !== identity.personalOwner.identity ||
                scope.executionAccountHome !== identity.executionAccountHome
            )
                throw new PlanAccessMismatchError("Plan read belongs to a different Project or personal owner.");
            if (scope.repositoryId === identity.repositoryId) return await operation(cwd);
            if (currentPackageSelection())
                throw new PlanAccessMismatchError("Selected Plan read belongs to a different repository.");
        }
        if (projects.home.isOwner(identity))
            return await projects.home.withOwner(identity, () =>
                withPackageProject(cwd, identity, () => operation(cwd)),
            );
        if (hasRetainedCheckoutSource(cwd)) {
            if (mode === "write") throw new Error("Plan mutation requires the canonical Project owner.");
            return await operation(cwd);
        }
        return await withPackageProject(cwd, identity, () => operation(cwd));
    };
}

/** Inspect at a checkout boundary. Only explicit authoring can admit a new Project. */
export function checkoutPlanIdentity(cwd: string) {
    const owner = projects.home.current();
    if (owner) return owner;
    const inspected = projects.checkout.inspect(cwd);
    if (inspected.kind === "invalid") throw new Error(inspected.message);
    return inspected.kind === "existing" ? inspected.identity : undefined;
}

/** An admitted retained checkout can review its own document without opening the canonical writer. */
export function bindCheckoutPlanLifecycle(cwd: string) {
    const retained = validatedRetainedCheckoutSource(cwd);
    if (retained && !managedPersonalStoreActive()) {
        const run: ReturnType<typeof bindProjectPlanStore> = async (operation, mode = "write") => {
            if (mode !== "retained") throw new Error("This Plan transition requires the canonical Project owner.");
            if (managedPersonalStoreActive() || validatedRetainedCheckoutSource(cwd) !== retained)
                throw new PlanAccessMismatchError("The retained Plan review source changed. Reopen review.");
            return await operation(cwd);
        };
        return { projectId: retained.projectId, run };
    }
    const admitted = checkoutPlanIdentity(cwd);
    if (!admitted) return undefined;
    return { projectId: admitted.projectId, run: bindProjectPlanStore(admitted.projectId, { admitted }) };
}
