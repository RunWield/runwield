import {
    parseProjectId,
    projects,
    type ProjectId,
    type ProjectRegistry,
    type ProjectStoreIdentity,
} from "@runwield/projects";
import { captureManagedProjectPlanAccess, managedPersonalStoreActive } from "./managed.ts";
import { hasRetainedCheckoutSource } from "./retained-source.ts";
import { currentPackageProject, currentPackageSelection, withPackageProject } from "./workflows.ts";

export class PlanAccessMismatchError extends Error {}

export type ProjectPlanStoreOptions = RegisteredProjectPlanOptions | AdmittedProjectPlanOptions;

interface RegisteredProjectPlanOptions {
    /** Trusted registration already opened by the application. */
    registry?: ProjectRegistry;
    admitted?: never;
}

interface AdmittedProjectPlanOptions {
    /** The checkout or owner already admitted by Projects. */
    admitted: ProjectStoreIdentity;
    registry?: never;
}

function registeredRoot(projectId: ProjectId, registry: ProjectPlanStoreOptions["registry"]): string {
    if (registry) return projects.registrations.requireActiveRoot(registry, projectId);
    const opened = projects.registrations.open();
    try {
        return projects.registrations.requireActiveRoot(opened, projectId);
    } finally {
        opened.close();
    }
}

function checkoutIdentity(projectId: ProjectId, root: string) {
    const inspected = projects.checkout.inspect(root);
    if (inspected.kind !== "existing" || inspected.identity.projectId !== projectId)
        throw new Error("Plan access requires this Project's admitted checkout.");
    return inspected.identity;
}

export function bindProjectPlanStore(projectId: ProjectId, options: ProjectPlanStoreOptions) {
    if (!parseProjectId(projectId)) throw new Error("Invalid Project ID.");
    const admitted = options.admitted && structuredClone(options.admitted);
    if (admitted && admitted.projectId !== projectId) throw new Error("Plan access belongs to a different Project.");
    const managed = captureManagedProjectPlanAccess(projectId, admitted);
    const registry = options.registry;
    const verifyLocal = () => {
        if (managedPersonalStoreActive()) throw new Error("The Project's Plan owner changed after opening.");
        if (admitted) {
            projects.home.assertStoreIdentity(admitted);
            if (projects.home.isOwner(admitted)) return admitted;
        }
        const current = checkoutIdentity(projectId, admitted?.checkoutRoot ?? registeredRoot(projectId, registry));
        if (current.personalOwner.kind !== "execution-account") throw new Error("Managed Plan owner is unavailable.");
        if (
            admitted &&
            (projects.home.isOwner(admitted) ||
                current.repositoryId !== admitted.repositoryId ||
                current.checkoutId !== admitted.checkoutId ||
                current.personalOwner.identity !== admitted.personalOwner.identity ||
                current.executionAccountHome !== admitted.executionAccountHome)
        )
            throw new Error("Project Plan authority changed.");
        return current;
    };
    const verifyManagedRegistration = () => {
        if (registry) checkoutIdentity(projectId, projects.registrations.requireActiveRoot(registry, projectId));
    };
    if (managed) verifyManagedRegistration();
    const initialLocal = managed ? undefined : verifyLocal();
    return async <Result>(
        operation: (cwd: string) => Promise<Result>,
        mode: "read" | "write" | "workflow-read" = "write",
    ): Promise<Result> => {
        if (managed) {
            verifyManagedRegistration();
            return await managed(operation);
        }
        const local = verifyLocal();
        if (
            !initialLocal ||
            local.personalOwner.identity !== initialLocal.personalOwner.identity ||
            local.executionAccountHome !== initialLocal.executionAccountHome
        )
            throw new Error("The Project's Plan owner changed after opening.");
        projects.launch.verifyAccountHome(initialLocal);
        const cwd = projects.home.storeLocation(local);
        const scope = mode === "workflow-read" ? currentPackageProject() : undefined;
        if (scope) {
            if (
                scope.projectId !== local.projectId ||
                scope.personalOwner.identity !== local.personalOwner.identity ||
                scope.executionAccountHome !== local.executionAccountHome
            )
                throw new PlanAccessMismatchError("Plan read belongs to a different Project or personal owner.");
            if (scope.repositoryId === local.repositoryId) return await operation(cwd);
            if (currentPackageSelection())
                throw new PlanAccessMismatchError("Selected Plan read belongs to a different repository.");
        }
        if (projects.home.isOwner(local))
            return await projects.home.withOwner(local, () => withPackageProject(cwd, local, () => operation(cwd)));
        if (hasRetainedCheckoutSource(cwd)) {
            if (mode === "write") throw new Error("Plan mutation requires the canonical Project owner.");
            return await operation(cwd);
        }
        return await withPackageProject(cwd, local, () => operation(cwd));
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
