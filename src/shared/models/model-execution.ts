import { isRemovedAgyProvider, removedAgyModelError } from "./removed-providers.ts";
import type { RunWieldModel } from "./model-registry.ts";
import { remotePersonalResourcesActive } from "../remote/personal-resources.ts";

export class UnsupportedModelExecutionBackendError extends Error {
    readonly provider: string;
    readonly model: string;
    readonly executionBackend: string;

    constructor(model: RunWieldModel | Pick<RunWieldModel, "provider" | "id" | "executionBackend">) {
        const backend = model.executionBackend || (model.provider === "claude-cli" ? model.provider : "pi");
        super(`Unsupported model execution backend "${backend}" for ${model.provider}/${model.id}.`);
        this.name = "UnsupportedModelExecutionBackendError";
        this.provider = model.provider;
        this.model = model.id;
        this.executionBackend = backend;
    }
}

export function isUnsupportedModelExecutionBackendError(
    error: Error | string,
): error is UnsupportedModelExecutionBackendError {
    return error instanceof UnsupportedModelExecutionBackendError;
}

export function assertModelExecutionBackendSupported(
    model: RunWieldModel | Pick<RunWieldModel, "provider" | "id" | "executionBackend"> | undefined,
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
    if (remoteContext && (backend === "claude-cli" || model.provider === "claude-cli"))
        throw new UnsupportedModelExecutionBackendError(model);
    if (backend === "pi" || backend === "claude-cli") return;
    throw new UnsupportedModelExecutionBackendError(model);
}
