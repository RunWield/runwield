import type { ModelRegistry } from "./model-catalog.ts";
import { getNativeModelRegistry } from "./model-registry.ts";

export type {
    CredentialEvent,
    CredentialInteraction,
    CredentialKind,
    CredentialPrompt,
    ExecutionBackend,
    ModelDescriptor,
    ModelExecutionMetadata,
    ModelReference,
    ModelRefreshOptions,
    ModelRegistry,
    ProviderAuthStatus,
    ProviderDescriptor,
    StoredCredentialProvider,
} from "./model-catalog.ts";
export {
    assertModelExecutionBackendSupported,
    isExternalCliProvider,
    isUnsupportedModelExecutionBackendError,
} from "./model-execution.ts";
export {
    formatProviderModelReference,
    parseProviderModel,
    type ActiveModelState,
    type ProviderModelParseResult,
} from "./model-validation.ts";

/** Read the RunWield catalog for the current personal-resource context. */
export function getModelRegistry(): ModelRegistry {
    return getNativeModelRegistry().catalog;
}
