import type { ProviderModelParseResult } from "./model-validation.ts";

/** RunWield's supported engines for chat turns. */
export type ExecutionBackend = "pi" | "claude-cli";

/** How a model authenticates and what it needs to be checked before a turn. */
export interface ModelExecutionMetadata {
    executionBackend?: ExecutionBackend;
    authenticationKind?: "api-auth" | "external-cli";
    healthCheck?: "api-auth" | "execution-preflight";
}

/** The identity used to resolve and select a model. */
export interface ModelReference {
    provider: string;
    id: string;
}

/** Catalog fields used to display a model and plan how it will run. */
export interface ModelDescriptor extends ModelReference, ModelExecutionMetadata {
    name: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
}

/** Display information for a provider. */
export interface ProviderDescriptor {
    id: string;
    name: string;
}

/** Credential kinds RunWield can store. */
export type CredentialKind = "oauth" | "api_key";

/** A provider with a saved credential. The credential value stays in the store. */
export interface StoredCredentialProvider extends ProviderDescriptor {
    authType: CredentialKind;
}

/** Whether a provider has auth configured and where it comes from. */
export interface ProviderAuthStatus {
    configured: boolean;
    source?: string;
    label?: string;
}

/** Input requested during provider login. A signal can cancel a pending prompt. */
export type CredentialPrompt = { signal?: AbortSignal } & (
    | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
    | { type: "select"; message: string; options: readonly CredentialOption[] }
);

interface CredentialOption {
    id: string;
    label: string;
    description?: string;
}

interface CredentialLink {
    url: string;
    label?: string;
}

/** Updates shown during provider login, including instructions for browser or device flows. */
export type CredentialEvent =
    | { type: "info"; message: string; links?: readonly CredentialLink[] }
    | { type: "auth_url"; url: string; instructions?: string }
    | {
          type: "device_code";
          userCode: string;
          verificationUri: string;
          openBrowserOnConfirm?: boolean;
          copyCodeOnConfirm?: boolean;
          intervalSeconds?: number;
          expiresInSeconds?: number;
      }
    | { type: "progress"; message: string };

/** Interaction needed to configure a provider credential. */
export interface CredentialInteraction {
    signal?: AbortSignal;
    /** Return the input or selected option ID. Reject if the prompt is cancelled. */
    prompt(prompt: CredentialPrompt): Promise<string>;
    /** Show progress, browser instructions, or device login instructions. */
    notify(event: CredentialEvent): void;
}

/** Controls which providers may refresh their cached model lists. */
export interface ModelRefreshOptions {
    allowNetwork?: boolean;
    providers?: readonly string[];
    force?: boolean;
    signal?: AbortSignal;
}

/** RunWield's model catalog and provider authentication operations. */
export interface ModelRegistry {
    /** Wait for the local catalog or mounted remote catalog to be ready. */
    ready(): Promise<void>;
    /** List known models, including those without credentials. */
    getAll(): ModelDescriptor[];
    /** List models that have configured auth. */
    getAvailable(): ModelDescriptor[];
    /** List models users can select, including local external CLI aliases. */
    getSelectable(): ModelDescriptor[];
    /** Resolve a provider and model ID against the current catalog. */
    find(provider: string, id: string): ModelDescriptor | undefined;
    /** Resolve a strict provider/id and check whether the model can be selected. */
    resolveTemplateModel(reference: string): ProviderModelParseResult;
    /** Check whether the model can be selected in the current catalog. */
    isSelectable(model: (ModelReference & ModelExecutionMetadata) | undefined): boolean;
    /** List providers configured through models.json or registered in the runtime. */
    getRegisteredProviderIds(): readonly string[];
    /** Wait for model providers to refresh their available catalogs. */
    refresh(options?: ModelRefreshOptions): Promise<void>;
    /** Read the catalog's current diagnostic, if any. */
    getError(): string | undefined;
    /** Resolve the display name for a provider ID. */
    getProviderDisplayName(provider: string): string;
    /** List providers supporting OAuth login. */
    getOAuthProviders(): ProviderDescriptor[];
    /** List providers with saved credentials and their credential kinds. */
    listStoredCredentialProviders(): Promise<StoredCredentialProvider[]>;
    /** Return the saved credential kind for a provider, if present. */
    getStoredCredentialType(provider: string): Promise<CredentialKind | undefined>;
    /** Read the source and status of a provider's configured auth. */
    getProviderAuthStatus(provider: string): ProviderAuthStatus;
    /** Run the interactive authentication flow for a provider. */
    loginProvider(provider: string, type: CredentialKind, interaction: CredentialInteraction): Promise<void>;
    /** Save an API key and refresh the local availability snapshot. */
    setProviderApiKey(provider: string, apiKey: string): Promise<void>;
    /** Remove the saved credential for a provider. */
    logoutProvider(provider: string): Promise<void>;
}
