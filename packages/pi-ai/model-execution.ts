import { isRemovedAgyProvider, removedAgyModelError } from "./removed-providers.ts";
import type { ModelExecutionMetadata, ModelReference } from "./model-catalog.ts";
import { remotePersonalResourcesActive } from "@runwield/resources/personal";

/** Whether the provider runs an installed CLI instead of a hosted API. */
export function isExternalCliProvider(provider: string): provider is "claude-cli" {
    return provider === "claude-cli";
}

/** A model declares a backend that is unavailable in this context. */
export class UnsupportedModelExecutionBackendError extends Error {
    readonly provider: string;
    readonly model: string;
    readonly executionBackend: string;

    constructor(model: ModelReference & ModelExecutionMetadata) {
        const backend = model.executionBackend || (isExternalCliProvider(model.provider) ? model.provider : "pi");
        super(`Unsupported model execution backend "${backend}" for ${model.provider}/${model.id}.`);
        this.name = "UnsupportedModelExecutionBackendError";
        this.provider = model.provider;
        this.model = model.id;
        this.executionBackend = backend;
    }
}

/** Identify a model backend rejection so callers can report it without changing selection. */
export function isUnsupportedModelExecutionBackendError(
    error: Error | string,
): error is UnsupportedModelExecutionBackendError {
    return error instanceof UnsupportedModelExecutionBackendError;
}

/** Reject removed engines and external CLI models on a remote host. */
export function assertModelExecutionBackendSupported(
    model: (ModelReference & ModelExecutionMetadata) | undefined,
    remoteContext = remotePersonalResourcesActive(),
): void {
    if (!model) return;
    if (isRemovedAgyProvider(model.provider) || isRemovedAgyProvider(model.executionBackend)) {
        throw removedAgyModelError(
            `${model.provider}/${model.id}`,
            "Choose a supported model with /model or update settings.",
        );
    }
    const backend = model.executionBackend || "pi";
    // A remote project must never launch an external CLI on the remote host.
    // Check the provider as well as metadata: saved selections only retain provider/id.
    if (remoteContext && (backend === "claude-cli" || isExternalCliProvider(model.provider)))
        throw new UnsupportedModelExecutionBackendError(model);
    if (backend === "pi" || backend === "claude-cli") return;
    throw new UnsupportedModelExecutionBackendError(model);
}
