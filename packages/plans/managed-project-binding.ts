import { projects, type ProjectId, type ProjectStoreIdentity } from "@runwield/projects";

/** Capture the configured checkout's authority and recheck it for each managed operation. */
export function captureManagedCheckoutBinding(cwd: string, projectId: ProjectId, admitted?: ProjectStoreIdentity) {
    const inspect = () => {
        const checkout = projects.checkout.inspect(cwd);
        if (checkout.kind !== "existing" || checkout.identity.projectId !== projectId)
            throw new Error("Managed Plan access belongs to a different Project.");
        return checkout.identity;
    };
    const initial = inspect();
    const verifyAdmission = () => {
        if (!admitted) return cwd;
        projects.home.assertStoreIdentity(admitted);
        if (
            projects.home.isOwner(admitted) ||
            initial.repositoryId !== admitted.repositoryId ||
            initial.personalOwner.kind !== admitted.personalOwner.kind ||
            initial.personalOwner.identity !== admitted.personalOwner.identity ||
            initial.executionAccountHome !== admitted.executionAccountHome
        )
            throw new Error("Managed Plan access requires its configured Project repository and account.");
        return admitted.checkoutRoot;
    };
    verifyAdmission();
    return () => {
        const current = inspect();
        if (
            current.repositoryId !== initial.repositoryId ||
            current.checkoutId !== initial.checkoutId ||
            current.personalOwner.kind !== initial.personalOwner.kind ||
            current.personalOwner.identity !== initial.personalOwner.identity ||
            current.executionAccountHome !== initial.executionAccountHome
        )
            throw new Error("Managed Plan Project authority changed.");
        return verifyAdmission();
    };
}
