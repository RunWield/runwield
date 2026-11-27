import { parseProjectId, projects, type ProjectId, type ProjectStoreIdentity } from "@runwield/projects";
import type { ProjectPlanStoreOptions } from "./store.ts";
export { captureManagedCheckoutBinding } from "./managed-project-binding.ts";

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

/** Capture the inputs shared by each Plan owner without admitting a checkout. */
export function projectPlanStoreBinding(projectId: ProjectId, options: ProjectPlanStoreOptions) {
    if (!parseProjectId(projectId)) throw new Error("Invalid Project ID.");
    const admitted = options.admitted && structuredClone(options.admitted);
    if (admitted && admitted.projectId !== projectId) throw new Error("Plan access belongs to a different Project.");
    const { registry } = options;

    function verifyLocal(): ProjectStoreIdentity {
        if (admitted) {
            projects.home.assertStoreIdentity(admitted);
            if (projects.home.isOwner(admitted)) return admitted;
        }
        const current = checkoutIdentity(projectId, admitted?.checkoutRoot ?? registeredRoot(projectId, registry));
        if (current.personalOwner.kind !== "execution-account") throw new Error("Managed Plan owner is unavailable.");
        if (
            admitted &&
            (current.repositoryId !== admitted.repositoryId ||
                current.checkoutId !== admitted.checkoutId ||
                current.personalOwner.identity !== admitted.personalOwner.identity ||
                current.executionAccountHome !== admitted.executionAccountHome)
        )
            throw new Error("Project Plan authority changed.");
        return current;
    }

    return {
        admitted,
        verifyManagedRegistration() {
            if (registry) checkoutIdentity(projectId, projects.registrations.requireActiveRoot(registry, projectId));
        },
        openLocal() {
            const initial = verifyLocal();
            return () => {
                const current = verifyLocal();
                if (
                    current.personalOwner.identity !== initial.personalOwner.identity ||
                    current.executionAccountHome !== initial.executionAccountHome
                )
                    throw new Error("The Project's Plan owner changed after opening.");
                projects.launch.verifyAccountHome(initial);
                return current;
            };
        },
    };
}
