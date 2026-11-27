import type { RequestManagedPlanStore } from "@runwield/plans/project-store-wire";

/** Authenticate requests to the laptop's Plan store and cancel them when the SSH host disconnects. */
export function authenticatedProjectStoreRequest(
    endpoint: string,
    credential: string,
    lifetime?: AbortSignal,
): RequestManagedPlanStore {
    return async (request, signal) => {
        lifetime?.throwIfAborted();
        switch (request.route) {
            case "/project-store":
            case "/project-store/admit":
            case "/project-store/inspect":
                return await fetch(new URL(request.route, endpoint), {
                    method: "POST",
                    redirect: "error",
                    headers: {
                        Authorization: `Bearer ${credential}`,
                        ...(request.route === "/project-store" && { "Content-Type": "application/json" }),
                    },
                    body: request.route === "/project-store" ? request.body : undefined,
                    signal: lifetime && signal ? AbortSignal.any([lifetime, signal]) : (lifetime ?? signal),
                });
            default:
                throw new Error("Unsupported managed Plan store route.");
        }
    };
}
