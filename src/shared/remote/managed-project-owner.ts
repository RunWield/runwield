import type { RemoteInteractiveConfig } from "./entry.ts";

/** Activate the verified connection before loading ordinary Plan consumers. */
export async function activateRemoteProjectOwner(
    config: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection">,
): Promise<() => void> {
    const { configureRemotePersonalResources } = await import("./personal-resources.ts");
    configureRemotePersonalResources(config.resources);
    return await connectRemotePlanOwner(config);
}

/** Bind a new authenticated Plan store connection to the configured remote execution root. */
export async function connectRemotePlanOwner(
    config: Pick<RemoteInteractiveConfig, "cwd" | "connection">,
): Promise<() => void> {
    const { configureManagedPlanStore } = await import("@runwield/plans/managed-store-host");
    const { authenticatedProjectStoreRequest } = await import("./project-store-request.ts");
    const lifetime = new AbortController();
    const request = authenticatedProjectStoreRequest(
        `http://127.0.0.1:${config.connection.port}`,
        config.connection.credential,
        lifetime.signal,
    );
    configureManagedPlanStore(config.cwd, request, lifetime.signal);
    return () => lifetime.abort();
}
