import { AsyncLocalStorage } from "node:async_hooks";
import { inspectProjectIdentity, type ProjectIdentity } from "../shared/project-identity.ts";

/** Checkout parsing is reserved for explicit import and the retained original execution owner. */
const sources = new AsyncLocalStorage<ProjectIdentity>();
export function currentRetainedCheckoutSource(): ProjectIdentity | undefined {
    return sources.getStore();
}
export function hasRetainedCheckoutSource(cwd: string): boolean {
    const source = sources.getStore();
    if (!source) return false;
    const inspected = inspectProjectIdentity(cwd);
    if (
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== source.projectId ||
        inspected.identity.repositoryId !== source.repositoryId ||
        inspected.identity.personalOwner.identity !== source.personalOwner.identity
    )
        throw new Error("Retained checkout source belongs to another Project or repository.");
    return true;
}
export function withRetainedCheckoutSource<T>(identity: ProjectIdentity, read: () => Promise<T>): Promise<T> {
    return sources.run(identity, read);
}

export function withoutRetainedCheckoutSource<T>(run: () => Promise<T>): Promise<T> {
    return sources.exit(run);
}
