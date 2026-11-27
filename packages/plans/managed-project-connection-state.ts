import { AsyncLocalStorage } from "node:async_hooks";
import { projects, type ProjectId, type ProjectIdentity, type ProjectStoreIdentity } from "@runwield/projects";
import { captureManagedCheckoutBinding } from "./managed-project-binding.ts";
import { operationHash } from "./operation-receipts.ts";
import {
    readProjectStoreBody,
    sameProjectStoreBinding,
    validateProjectStoreBinding,
    type ProjectStoreBinding,
    type RequestManagedPlanStore,
} from "./project-store-wire.ts";

interface ManagedConnection {
    cwd: string;
    request: RequestManagedPlanStore;
    lifetime: AbortSignal;
    binding?: ProjectStoreBinding;
    admitted?: boolean;
}

const projectConnections = new AsyncLocalStorage<ManagedConnection>();
let active: ManagedConnection | undefined;

/** Bind the remote host's request function at bootstrap. The host aborts its lifetime when it disconnects. */
export function configureManagedPlanStore(cwd: string, request: RequestManagedPlanStore, lifetime: AbortSignal): void {
    if (active && !active.lifetime.aborted) throw new Error("Managed Plan owner is already configured.");
    lifetime.throwIfAborted();
    active = { cwd, request, lifetime };
}

/** Managed routing stays selected after a disconnect so it cannot fall back to an execution account. */
export function managedPersonalStoreActive(): boolean {
    return (projectConnections.getStore() ?? active) !== undefined && !projects.home.current();
}

function requireConnection(configured = projectConnections.getStore() ?? active): ManagedConnection {
    if (!configured || configured !== active || configured.lifetime.aborted || !managedPersonalStoreActive())
        throw new Error("Managed Plan owner is unavailable.");
    return configured;
}

/** Check the pinned connection immediately before committing local managed operation state. */
export function assertManagedProjectConnection(): void {
    requireConnection();
}

/** Carry host cancellation into a local managed operation that holds an OS resource. */
export function managedProjectConnectionLifetime(): AbortSignal {
    return requireConnection().lifetime;
}

/** The current managed connection's configured execution root. */
export function managedExecutionRoot(): string {
    return requireConnection().cwd;
}

/** Keep each async operation on the connection it started with and reject results from a revoked connection. */
export async function withManagedProjectConnection<Result>(operation: () => Promise<Result>): Promise<Result> {
    const configured = requireConnection();
    const result = await projectConnections.run(configured, operation);
    requireConnection(configured);
    return result;
}

/** Preserve the selected connection while an operation handles its own local effects. */
export function withCurrentManagedProjectConnection<Result>(operation: () => Promise<Result>): Promise<Result> {
    const configured = projectConnections.getStore() ?? active;
    return configured && !projects.home.current() ? projectConnections.run(configured, operation) : operation();
}

/** Bind a Project store handle to its configured connection and verified checkout for its lifetime. */
export function captureManagedProjectPlanAccess(projectId: ProjectId, admitted?: ProjectStoreIdentity) {
    if (!managedPersonalStoreActive()) return undefined;
    const configured = requireConnection();
    const verifyCheckout = captureManagedCheckoutBinding(configured.cwd, projectId, admitted);
    return async <Result>(operation: (cwd: string) => Promise<Result>): Promise<Result> => {
        requireConnection(configured);
        return await projectConnections.run(configured, () =>
            withManagedProjectConnection(() => operation(verifyCheckout())),
        );
    };
}

/** Check that a local checkout belongs to the admitted managed owner. */
export function matchesManagedOwner(checkout: ProjectIdentity, binding: ProjectStoreBinding): boolean {
    return (
        checkout.projectId === binding.projectId &&
        checkout.repositoryId === binding.repositoryId &&
        operationHash(checkout.personalOwner.identity) === binding.ownerId
    );
}

/** Resolve the managed owner using passive inspection or deliberate admission. */
export async function managedProjectStoreAccess(cwd: string, admit: boolean) {
    const configured = requireConnection();
    const request: RequestManagedPlanStore = async (input, signal) => {
        requireConnection(configured);
        const response = await configured.request(input, signal);
        requireConnection(configured);
        return response;
    };
    if (!configured.binding || (admit && !configured.admitted)) {
        const response = await request({ route: admit ? "/project-store/admit" : "/project-store/inspect" });
        if (!response.ok) throw new Error("Managed Plan owner admission is unavailable.");
        const binding: ProjectStoreBinding | null = JSON.parse(await readProjectStoreBody(response));
        requireConnection(configured);
        if (!binding && !admit) return undefined;
        if (!binding) throw new Error("Managed Plan owner admission returned no binding.");
        validateProjectStoreBinding(binding);
        if (configured.binding && !sameProjectStoreBinding(binding, configured.binding))
            throw new Error("Managed Plan owner changed during admission.");
        configured.binding = binding;
        if (admit) configured.admitted = true;
    }
    const inspection = projects.checkout.inspect(cwd);
    if (inspection.kind !== "existing" || !matchesManagedOwner(inspection.identity, configured.binding))
        throw new Error("Managed Plan request belongs to another execution repository.");
    return { binding: configured.binding, checkout: inspection.identity, request };
}
