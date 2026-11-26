import { isExternalCliProvider } from "./model-execution.ts";
import { isRemovedAgyProvider, removedAgyModelError } from "./removed-providers.ts";
import type {
    CredentialInteraction,
    CredentialKind,
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
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync as fsReadFileSync, statSync as fsStatSync } from "node:fs";
import { env } from "node:process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Credential, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { parseProviderModel, type ProviderModelParseResult } from "./model-validation.ts";
import { parse as parseJsonc, type JsonRecord, type JsonValue } from "@runwield/parsing/jsonc";
import { getHomeDir } from "@runwield/resources/home";
import { personalGlobalRoot, remotePersonalResourcesActive } from "@runwield/resources/personal";
import { openNativeFileLock } from "@runwield/resources/fs";
import { createRemoteModelRuntime, fetchRemoteModelCatalog, type RemoteModelConnection } from "./remote-models.ts";

type ExternalCliExecutionBackend = Exclude<ExecutionBackend, "pi">;

/** A native Pi chat model with RunWield execution metadata. */
export type RunWieldModel = Model<Api> & ModelExecutionMetadata;

type ConfigValue = JsonValue | undefined;
interface ConfigObject {
    [key: string]: ConfigValue;
}

interface ConfiguredCredential extends ConfigObject {
    type?: string;
    key?: ConfigValue;
}

interface CredentialData {
    [providerId: string]: ConfiguredCredential | undefined;
}

interface ConfiguredModelInput extends ConfigObject {
    id?: ConfigValue;
    name?: ConfigValue;
    api?: ConfigValue;
    baseUrl?: ConfigValue;
    reasoning?: ConfigValue;
    input?: ConfigValue;
    cost?: ConfigValue;
    contextWindow?: ConfigValue;
    maxTokens?: ConfigValue;
    headers?: ConfigValue;
    compat?: ConfigValue;
}

interface ConfiguredProviderInput extends ConfigObject {
    name?: ConfigValue;
    api?: ConfigValue;
    baseUrl?: ConfigValue;
    apiKey?: ConfigValue;
    authHeader?: ConfigValue;
    headers?: ConfigValue;
    models?: ConfigValue;
    imageInputModels?: ConfigValue;
}

interface ModelsConfig extends ConfigObject {
    providers?: ConfigValue;
}

interface AuthResultValue {
    auth: { apiKey?: string; headers?: Record<string, string> };
    env?: Record<string, string>;
}

interface CompatibilityRequestConfig {
    headers?: Record<string, string>;
}

/** Override input capabilities when configured purpose makes them explicit. */
interface DiscoverProviderModelOptions {
    input?: ("text" | "image")[];
}

/** Fetch a model list over an OpenAI-compatible endpoint. */
export interface ModelDiscoveryNetworkPort {
    /** Send the discovery request and return the HTTP response. */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const SYSTEM_MODEL_DISCOVERY_NETWORK: ModelDiscoveryNetworkPort = Object.freeze({
    fetch: globalThis.fetch.bind(globalThis),
});

/** Bind to another local config directory or an authenticated remote Pi runtime. */
interface ModelRegistryOptions {
    /** Credential-free catalog from an authenticated laptop control connection. */
    remote?: boolean;
    runtime?: ModelRuntime | null;
    runtimePromise?: Promise<ModelRuntime>;
    configDir?: string;
}

const MODEL_CONFIG_FILES = ["models.json", "auth.json"] as const;
const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_CLI_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;
const CLAUDE_CLI_DISPLAY_NAMES: Record<(typeof CLAUDE_CLI_ALIASES)[number], string> = {
    sonnet: "Claude CLI Sonnet",
    opus: "Claude CLI Opus",
    haiku: "Claude CLI Haiku",
    fable: "Claude CLI Fable",
};
interface ExternalCliProviderDefinition {
    provider: ExternalCliExecutionBackend;
    displayName: string;
    modelNamePrefix: string;
    api: Api;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    aliases?: readonly string[];
    modelDisplayNames?: Record<string, string>;
}

const EXTERNAL_CLI_PROVIDER_DEFINITIONS: Record<ExternalCliExecutionBackend, ExternalCliProviderDefinition> = {
    [CLAUDE_CLI_PROVIDER]: {
        provider: CLAUDE_CLI_PROVIDER,
        displayName: "Claude CLI",
        modelNamePrefix: "Claude CLI",
        api: "anthropic-messages",
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 16384,
        aliases: CLAUDE_CLI_ALIASES,
        modelDisplayNames: CLAUDE_CLI_DISPLAY_NAMES,
    },
};

let bundledOAuthFlowsRegistered = false;
let modelRuntimePromise: Promise<ModelRuntime> | null = null;
let resolvedModelRuntime: ModelRuntime | null = null;
let modelRuntimeConfigDir: string | null = null;
let modelCredentialStore: RunWieldCredentialStore | null = null;

interface RemoteModelComposition {
    runtime: ModelRuntime;
    registry: RunWieldModelRegistry;
}

let remoteModelComposition: RemoteModelComposition | undefined;
let remoteModelConnectionToken: symbol | undefined;

/** Persist one agent host identity, shared by concurrent login processes and later launches. */
function getInstallationDeviceId(configDir: string): string {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const path = join(configDir, "device-id");
    const file = openNativeFileLock(path);
    try {
        file.lockSync(true);
        const saved = file.readSnapshotSync().text.trim();
        if (saved) {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)) {
                throw new Error(`Invalid installation device ID in ${path}: expected a UUID`);
            }
            return saved;
        }
        const id = crypto.randomUUID();
        file.replaceTextSync(`${id}\n`);
        return id;
    } finally {
        file.close();
    }
}

function fileExists(path: string): boolean {
    try {
        return fsStatSync(path).isFile();
    } catch {
        return false;
    }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJsoncObject(path: string): JsonRecord | null {
    try {
        const parsed = parseJsonc(fsReadFileSync(path, "utf8"));
        return isJsonRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function resolveLiteralConfigValue(value: ConfigValue): string | undefined {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (isJsonRecord(value)) {
        const envName = value.env;
        if (typeof envName === "string" && envName.trim()) return env[envName.trim()];
    }
    return undefined;
}

function readOpenAiModelIds(payload: JsonValue): string[] {
    const data = isJsonRecord(payload) ? payload.data : undefined;
    const models = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
    return models
        .map((item) => (isJsonRecord(item) ? item.id : undefined))
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim());
}

function errorMessage(error: Error | string): string {
    return error instanceof Error ? error.message : String(error);
}

/** RunWield auth.json storage for the native Pi runtime. */
export class RunWieldCredentialStore {
    readonly authPath: string;
    private readonly providerMutations = new Map<string, Promise<void>>();

    constructor(authPath: string) {
        this.authPath = authPath;
    }

    private ensureFile(): void {
        mkdirSync(dirname(this.authPath), { recursive: true, mode: 0o700 });
        try {
            fsStatSync(this.authPath);
        } catch {
            writeFileSync(this.authPath, "{}", { mode: 0o600 });
        }
    }

    readData(): CredentialData {
        this.ensureFile();
        const parsed = readJsoncObject(this.authPath);
        if (!parsed) return {};
        const data: CredentialData = {};
        for (const [providerId, credential] of Object.entries(parsed)) {
            if (!isJsonRecord(credential)) continue;
            data[providerId] = {
                ...credential,
                type: typeof credential.type === "string" ? credential.type : undefined,
            };
        }
        return data;
    }

    private writeData(data: CredentialData): void {
        this.ensureFile();
        writeFileSync(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
        try {
            chmodSync(this.authPath, 0o600);
        } catch {
            // Best effort on platforms that do not support chmod.
        }
    }

    read(providerId: string): Promise<Credential | undefined> {
        if (isExternalCliProvider(providerId) || isRemovedAgyProvider(providerId)) return Promise.resolve(undefined);
        const credential = this.readData()[providerId];
        if (!credential) return Promise.resolve(undefined);
        if (credential.type !== "api_key" || credential.key === undefined) {
            return Promise.resolve(credential as Credential);
        }
        return Promise.resolve({ ...credential, key: resolveLiteralConfigValue(credential.key) } as Credential);
    }

    list(): Promise<CredentialInfo[]> {
        return Promise.resolve(
            Object.entries(this.readData())
                .filter((entry): entry is [string, ConfiguredCredential] => {
                    const [providerId, credential] = entry;
                    if (isExternalCliProvider(providerId) || isRemovedAgyProvider(providerId)) return false;
                    return credential?.type === "oauth" || credential?.type === "api_key";
                })
                .map(([providerId, credential]) => ({ providerId, type: credential.type as "oauth" | "api_key" })),
        );
    }

    private enqueueProviderMutation<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.providerMutations.get(providerId) || Promise.resolve();
        const operationPromise = previous.catch(() => {}).then(operation);
        const queuePromise = operationPromise
            .catch(() => {})
            .then(() => {
                if (this.providerMutations.get(providerId) === queuePromise) this.providerMutations.delete(providerId);
            });
        this.providerMutations.set(providerId, queuePromise);
        return operationPromise;
    }

    modify(
        providerId: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
        return this.enqueueProviderMutation(providerId, async () => {
            const data = this.readData();
            const current = await this.read(providerId);
            const next = await fn(current);
            if (next === undefined) return current;
            data[providerId] = next as ConfiguredCredential;
            this.writeData(data);
            return next;
        });
    }

    delete(providerId: string): Promise<void> {
        return this.enqueueProviderMutation(providerId, () => {
            const data = this.readData();
            delete data[providerId];
            this.writeData(data);
            return Promise.resolve();
        });
    }
}

/** Get the file-backed credential store for a RunWield configuration directory. */
export function getRunWieldCredentialStore(configDir: string): RunWieldCredentialStore {
    const authPath = join(configDir, "auth.json");
    if (!modelCredentialStore || modelCredentialStore.authPath !== authPath) {
        modelCredentialStore = new RunWieldCredentialStore(authPath);
    }
    return modelCredentialStore;
}

function asString(value: ConfigValue, fallback: string): string {
    return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: ConfigValue, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: ConfigValue, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function asHeaders(value: ConfigValue): Record<string, string> | undefined {
    if (!isJsonRecord(value)) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") headers[key] = entry;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

function asInputList(value: ConfigValue): ("text" | "image")[] {
    if (!Array.isArray(value)) return ["text"];
    const input = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
    return input.length > 0 ? input : ["text"];
}

function asModelCost(value: ConfigValue): Model<Api>["cost"] {
    if (!isJsonRecord(value)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        input: asNumber(value.input, 0),
        output: asNumber(value.output, 0),
        cacheRead: asNumber(value.cacheRead, 0),
        cacheWrite: asNumber(value.cacheWrite, 0),
    };
}

function readConfiguredModels(providerId: string, providerConfig: ConfiguredProviderInput): RunWieldModel[] {
    const models = providerConfig.models;
    const entries: ConfiguredModelInput[] = Array.isArray(models)
        ? models.filter(isJsonRecord).map((item) => item as ConfiguredModelInput)
        : isJsonRecord(models)
          ? (Object.entries(models).map(([id, value]) => ({
                ...(isJsonRecord(value) ? value : {}),
                id,
            })) as ConfiguredModelInput[])
          : [];
    return entries
        .filter((item): item is ConfiguredModelInput & { id: string } => typeof item.id === "string")
        .map((item) => ({
            provider: providerId,
            name: asString(item.name, item.id),
            api: asString(item.api, asString(providerConfig.api, "openai-completions")) as Api,
            baseUrl: asString(item.baseUrl, asString(providerConfig.baseUrl, "")),
            reasoning: asBoolean(item.reasoning, false),
            input: asInputList(item.input),
            cost: asModelCost(item.cost),
            contextWindow: asNumber(item.contextWindow, 128000),
            maxTokens: asNumber(item.maxTokens, 16384),
            headers: asHeaders(item.headers),
            compat: item.compat as Model<Api>["compat"],
            id: item.id,
        }));
}

function readBuiltinModels(): RunWieldModel[] {
    return builtinProviders().flatMap((provider) => {
        try {
            return Array.from(provider.getModels()) as RunWieldModel[];
        } catch {
            return [];
        }
    });
}

function registerBundledOAuthFlowsOnce(): void {
    if (bundledOAuthFlowsRegistered) return;
    registerBunOAuthFlows();
    bundledOAuthFlowsRegistered = true;
}

function isConfiguredStoredCredential(credential: ConfiguredCredential | undefined): boolean {
    if (!credential) return false;
    if (credential.type === "oauth") return true;
    if (credential.type === "api_key") return Boolean(resolveLiteralConfigValue(credential.key));
    return false;
}

function isExternalCliBackend(backend: string | undefined): backend is ExternalCliExecutionBackend {
    return backend === CLAUDE_CLI_PROVIDER;
}

function isExternalCliModel(model: Pick<RunWieldModel, "provider" | "executionBackend"> | undefined): boolean {
    if (!model) return false;
    return isExternalCliProvider(model.provider) || isExternalCliBackend(model.executionBackend);
}

function createExternalCliModelDescriptor(provider: string, selector: string): RunWieldModel | undefined {
    if (!isExternalCliProvider(provider)) return undefined;
    const id = selector.trim();
    if (!id) return undefined;
    const definition = EXTERNAL_CLI_PROVIDER_DEFINITIONS[provider];
    return {
        provider,
        id,
        name: definition.modelDisplayNames?.[id] || `${definition.modelNamePrefix} ${id}`,
        api: definition.api,
        baseUrl: "",
        reasoning: definition.reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: definition.contextWindow,
        maxTokens: definition.maxTokens,
        executionBackend: definition.provider,
        authenticationKind: "external-cli",
        healthCheck: "execution-preflight",
    };
}

function getExternalCliAliasModels(): RunWieldModel[] {
    return Object.values(EXTERNAL_CLI_PROVIDER_DEFINITIONS).flatMap((definition) =>
        (definition.aliases || [])
            .map((selector) => createExternalCliModelDescriptor(definition.provider, selector))
            .filter((model): model is RunWieldModel => Boolean(model)),
    );
}

function dedupeModels(models: RunWieldModel[]): RunWieldModel[] {
    return models.filter(
        (model, index) =>
            index === models.findIndex((item) => item.provider === model.provider && item.id === model.id),
    );
}

function modelDescriptor(model: RunWieldModel): ModelDescriptor {
    return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        executionBackend: model.executionBackend,
        authenticationKind: model.authenticationKind,
        healthCheck: model.healthCheck,
    };
}

/** A RunWield registry with access to native Pi models for execution integrations. */
export class RunWieldModelRegistry {
    private runtime: ModelRuntime | null;
    private readonly runtimePromise?: Promise<ModelRuntime>;
    private readonly configDir: string;
    private readonly credentialStore: RunWieldCredentialStore;
    private readonly registeredModels = new Map<string, RunWieldModel>();
    readonly remote: boolean;

    /** Give product callers catalog fields and auth operations without exposing Pi objects. */
    readonly catalog: ModelRegistry = {
        ready: () => this.ready(),
        getAll: () => this.getAll().map(modelDescriptor),
        getAvailable: () => this.getAvailable().map(modelDescriptor),
        getSelectable: () => this.getSelectable().map(modelDescriptor),
        find: (provider, id) => {
            const model = this.find(provider, id);
            return model && modelDescriptor(model);
        },
        resolveTemplateModel: (reference) => this.resolveTemplateModel(reference),
        isSelectable: (model) => this.isSelectable(model),
        getRegisteredProviderIds: () => this.getRegisteredProviderIds(),
        refresh: (options) => this.refresh(options),
        getError: () => this.getError(),
        getProviderDisplayName: (provider) => this.getProviderDisplayName(provider),
        getOAuthProviders: () => this.getOAuthProviders(),
        listStoredCredentialProviders: () => this.listStoredCredentialProviders(),
        getStoredCredentialType: (provider) => this.getStoredCredentialType(provider),
        getProviderAuthStatus: (provider) => this.getProviderAuthStatus(provider),
        loginProvider: async (provider, type, interaction) => {
            try {
                await this.loginProvider(provider, type, interaction);
            } catch (error) {
                throw new Error(error instanceof Error ? error.message : String(error));
            }
        },
        setProviderApiKey: (provider, apiKey) => this.setProviderApiKey(provider, apiKey),
        logoutProvider: (provider) => this.logoutProvider(provider),
    };

    /** Read local configuration, or bind to the supplied credential-free remote runtime. */
    constructor(options: ModelRegistryOptions = {}) {
        this.remote = options.remote === true;
        if (this.remote && (!remotePersonalResourcesActive() || !options.runtime)) {
            throw new Error("Remote model registry requires an explicit mounted context and runtime");
        }
        this.runtime = this.remote ? options.runtime! : options.runtime || resolvedModelRuntime;
        this.runtimePromise = this.remote ? undefined : options.runtimePromise || modelRuntimePromise || undefined;
        this.configDir = options.configDir || personalGlobalRoot();
        this.credentialStore = getRunWieldCredentialStore(this.configDir);
        if (this.runtimePromise && !this.runtime) {
            this.runtimePromise
                .then((runtime) => {
                    this.runtime = runtime;
                })
                .catch(() => {});
        }
    }

    /** Return the initialized Pi runtime backing this registry. */
    async getRuntime(): Promise<ModelRuntime> {
        if (this.remote) return this.runtime!;
        const runtime = this.runtime || (await (this.runtimePromise || getModelRuntime()));
        this.runtime = runtime;
        return runtime;
    }

    /** Wait for a compatible snapshot before reading it. */
    async ready(): Promise<void> {
        await this.getRuntime();
    }

    /** List providers that support OAuth login. */
    getOAuthProviders(): ProviderDescriptor[] {
        return (this.runtime?.getProviders() || [])
            .filter(
                (provider) =>
                    !(isExternalCliProvider(provider.id) || isRemovedAgyProvider(provider.id)) &&
                    Boolean(provider.auth?.oauth),
            )
            .map((provider) => ({ id: provider.id, name: provider.name }));
    }

    /** Read saved credential kinds without loading their secret values. */
    async listStoredCredentialProviders(): Promise<StoredCredentialProvider[]> {
        const runtime = await this.getRuntime();
        const credentials = await runtime.listCredentials();
        return credentials
            .filter(
                (credential) =>
                    !(isExternalCliProvider(credential.providerId) || isRemovedAgyProvider(credential.providerId)),
            )
            .map((credential) => ({
                id: credential.providerId,
                name: this.getProviderDisplayName(credential.providerId),
                authType: credential.type,
            }));
    }

    /** Read the saved authentication kind for one provider. */
    async getStoredCredentialType(providerId: string): Promise<CredentialKind | undefined> {
        const credential = (await this.listStoredCredentialProviders()).find((item) => item.id === providerId);
        return credential?.authType;
    }

    /** Run provider login using this installation's persistent device ID. */
    async loginProvider(
        providerId: string,
        authType: CredentialKind,
        interaction: CredentialInteraction,
    ): Promise<void> {
        if (this.remote) throw new Error("Remote provider auth is laptop-owned");
        const runtime = await this.getRuntime();
        await runtime.login(providerId, authType, interaction, {
            getDeviceId: () => getInstallationDeviceId(this.configDir),
        });
    }

    /** Save an API key and refresh availability without a network request. */
    async setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
        if (this.remote) throw new Error("Remote provider auth is laptop-owned");
        if (isExternalCliProvider(providerId) || isRemovedAgyProvider(providerId)) return;
        await this.credentialStore.modify(providerId, () => Promise.resolve({ type: "api_key", key: apiKey }));
        const runtime = await this.getRuntime();
        await runtime.refresh({ allowNetwork: false });
    }

    /** Remove the saved provider credential. */
    async logoutProvider(providerId: string): Promise<void> {
        if (this.remote) throw new Error("Remote provider auth is laptop-owned");
        const runtime = await this.getRuntime();
        await runtime.logout(providerId);
    }

    /** Refresh the catalog and report errors by provider. */
    async refresh(options: ModelRefreshOptions = {}): Promise<void> {
        if (this.remote) throw new Error("Remote model catalog requires a new control connection");
        const runtime = await this.getRuntime();
        const result = await runtime.refresh(options);
        if (result.aborted) throw new Error("Model catalog refresh was cancelled or timed out.");
        if (result.errors.size > 0) {
            throw new Error(
                Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; "),
            );
        }
    }

    /** Read the current runtime diagnostic. */
    getError(): string | undefined {
        return this.runtime?.getError();
    }

    /** List native chat models known to the current catalog. */
    getAll(): RunWieldModel[] {
        if (this.remote) {
            return (Array.from(this.runtime!.getModels()) as RunWieldModel[]).filter(
                (model) => !isRemovedAgyProvider(model.provider),
            );
        }
        const runtimeModels = this.runtime
            ? (Array.from(this.runtime.getModels()) as RunWieldModel[])
            : readBuiltinModels();
        return dedupeModels([
            ...runtimeModels.filter((model) => !isExternalCliModel(model) && !isRemovedAgyProvider(model.provider)),
            ...Array.from(this.registeredModels.values()).filter(
                (model) => !isExternalCliModel(model) && !isRemovedAgyProvider(model.provider),
            ),
            ...this.getConfiguredModels(),
            ...getExternalCliAliasModels(),
        ]);
    }

    /** List native chat models eligible for selection. */
    getSelectable(): RunWieldModel[] {
        if (this.remote) return this.getAvailable();
        return dedupeModels([...this.getAvailable(), ...getExternalCliAliasModels()]);
    }

    /** List native chat models available through API authentication. */
    getAvailable(): RunWieldModel[] {
        const models = this.runtime
            ? (Array.from(this.runtime.getAvailableSnapshot()) as RunWieldModel[])
            : this.getAll().filter((model) => this.hasConfiguredAuth(model));
        return dedupeModels(
            models.filter((model) => !isExternalCliModel(model) && !isRemovedAgyProvider(model.provider)),
        );
    }

    /** Find the native model for a provider and ID. */
    find(provider: string, modelId: string): RunWieldModel | undefined {
        if (isRemovedAgyProvider(provider)) return undefined;
        if (this.remote) {
            const model = this.runtime!.getModel(provider, modelId) as RunWieldModel | undefined;
            return model && this.getAvailable().some((item) => item.provider === provider && item.id === modelId)
                ? model
                : undefined;
        }
        if (isExternalCliProvider(provider)) return createExternalCliModelDescriptor(provider, modelId);
        return (
            (this.runtime?.getModel(provider, modelId) as RunWieldModel | undefined) ||
            this.registeredModels.get(`${provider}/${modelId}`) ||
            this.getConfiguredModels().find((model) => model.provider === provider && model.id === modelId) ||
            readBuiltinModels().find((model) => model.provider === provider && model.id === modelId)
        );
    }

    /** Resolve a template's strict provider/id against current selection eligibility. */
    resolveTemplateModel(reference: string): ProviderModelParseResult {
        const parsed = parseProviderModel(reference);
        if (!parsed.ok) return parsed;
        const model = this.find(parsed.provider, parsed.id);
        if (!model || !this.isSelectable(model)) return { ok: false };
        return { ok: true, provider: model.provider, id: model.id };
    }

    /** Check whether a model can be selected in this catalog. */
    isSelectable(model: (ModelReference & ModelExecutionMetadata) | undefined): boolean {
        if (!model || isRemovedAgyProvider(model.provider)) return false;
        if (this.remote) {
            return this.getAvailable().some((item) => item.provider === model.provider && item.id === model.id);
        }
        if (isExternalCliModel(model)) return true;
        return this.hasConfiguredAuth(model);
    }

    /** Check whether the model has configured API authentication. */
    hasConfiguredAuth(model: (ModelReference & ModelExecutionMetadata) | undefined): boolean {
        if (!model || isRemovedAgyProvider(model.provider)) return false;
        if (this.remote) return this.isSelectable(model);
        if (isExternalCliModel(model)) return false;
        if (this.runtime?.hasConfiguredAuth(model.provider)) return true;
        const status = this.getProviderAuthStatus(model.provider);
        return Boolean(status.configured);
    }

    /** Resolve credentials and request headers for local execution. */
    async getApiKeyAndHeaders(model: RunWieldModel): Promise<
        | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
        | {
              ok: false;
              error: string;
          }
    > {
        if (isRemovedAgyProvider(model.provider)) {
            return {
                ok: false,
                error: removedAgyModelError(`${model.provider}/${model.id}`, "Choose a supported model.").message,
            };
        }
        if (this.remote) return { ok: false, error: "Remote model credentials stay on the laptop" };
        if (isExternalCliModel(model)) {
            return { ok: false, error: `No API auth for external CLI provider ${model.provider}` };
        }
        const runtime = this.runtime || (await (this.runtimePromise || getModelRuntime()));
        this.runtime = runtime;
        const auth = (await runtime.getAuth(model)) as AuthResultValue | undefined;
        if (auth) return { ok: true, apiKey: auth.auth.apiKey, headers: auth.auth.headers, env: auth.env };
        const compatibility =
            typeof runtime.getCompatibilityRequestConfig === "function"
                ? (runtime.getCompatibilityRequestConfig(model) as CompatibilityRequestConfig)
                : undefined;
        const providerConfig = this.getProviderConfig(model.provider);
        const apiKey = resolveLiteralConfigValue(providerConfig?.apiKey);
        const headers = compatibility?.headers;
        if (apiKey || headers) return { ok: true, apiKey, headers };
        return { ok: false, error: `No configured auth for provider ${model.provider}` };
    }

    /** Read the credential source for a provider. */
    getProviderAuthStatus(provider: string): ProviderAuthStatus {
        if (this.remote) return { configured: this.runtime!.hasConfiguredAuth(provider) };
        if (isExternalCliProvider(provider) || isRemovedAgyProvider(provider)) return { configured: false };
        const runtimeStatus = this.runtime?.getProviderAuthStatus(provider) as ProviderAuthStatus | undefined;
        if (runtimeStatus?.configured) return runtimeStatus;
        const providerConfig = this.getProviderConfig(provider);
        if (resolveLiteralConfigValue(providerConfig?.apiKey)) {
            return { configured: true, source: "models_json_key", label: "models.json apiKey" };
        }
        if (isConfiguredStoredCredential(this.credentialStore.readData()[provider])) {
            return { configured: true, source: "auth_json", label: "auth.json credential" };
        }
        return runtimeStatus || { configured: false };
    }

    /** Resolve a display name, falling back to the provider ID. */
    getProviderDisplayName(provider: string): string {
        if (this.remote) return this.runtime!.getProvider(provider)?.name || provider;
        if (isExternalCliProvider(provider)) return EXTERNAL_CLI_PROVIDER_DEFINITIONS[provider].displayName;
        return (
            this.runtime?.getProvider(provider)?.name ||
            (this.getProviderConfig(provider)?.name as string | undefined) ||
            provider
        );
    }

    /** Resolve the native request credential for a local provider. */
    async getProviderAuth(provider: string): Promise<AuthResultValue | undefined> {
        if (this.remote) return undefined;
        if (isExternalCliProvider(provider) || isRemovedAgyProvider(provider)) return undefined;
        const runtime = this.runtime || (await (this.runtimePromise || getModelRuntime()));
        this.runtime = runtime;
        return (await runtime.getAuth(provider)) as AuthResultValue | undefined;
    }

    /** Read the API key for a local provider, when configured. */
    async getApiKeyForProvider(provider: string): Promise<string | undefined> {
        if (isExternalCliProvider(provider) || isRemovedAgyProvider(provider)) return undefined;
        const auth = await this.getProviderAuth(provider);
        return auth?.auth.apiKey || resolveLiteralConfigValue(this.getProviderConfig(provider)?.apiKey);
    }

    /** Register a provider and retain its models for synchronous lookup. */
    registerProvider(provider: string | ConfiguredProviderInput, config?: ConfiguredProviderInput): void {
        if (this.remote) throw new Error("Remote model catalog is laptop-owned");
        const providerId = typeof provider === "string" ? provider : asString(provider.id, "");
        const providerConfig = typeof provider === "string" ? config : provider;
        if (!providerId || !providerConfig || isExternalCliProvider(providerId) || isRemovedAgyProvider(providerId))
            return;
        this.runtime?.registerProvider(providerId, providerConfig as Parameters<ModelRuntime["registerProvider"]>[1]);
        if (this.runtimePromise && !this.runtime) {
            this.runtimePromise
                .then((runtime) =>
                    runtime.registerProvider(
                        providerId,
                        providerConfig as Parameters<ModelRuntime["registerProvider"]>[1],
                    ),
                )
                .catch(() => {});
        }
        for (const model of readConfiguredModels(providerId, providerConfig)) {
            this.registeredModels.set(`${providerId}/${model.id}`, model);
        }
    }

    /** Remove a provider and forget models registered through it. */
    unregisterProvider(provider: string): void {
        if (this.remote) throw new Error("Remote model catalog is laptop-owned");
        this.runtime?.unregisterProvider(provider);
        for (const key of this.registeredModels.keys()) {
            if (key.startsWith(`${provider}/`)) this.registeredModels.delete(key);
        }
    }

    /** List providers configured in models.json or registered in Pi. */
    getRegisteredProviderIds(): readonly string[] {
        const providers = this.readModelsConfig().providers;
        const configured = Object.keys(isJsonRecord(providers) ? providers : {}).filter(
            (provider) => !(isExternalCliProvider(provider) || isRemovedAgyProvider(provider)),
        );
        const runtime = (this.runtime?.getRegisteredProviderIds() || []).filter(
            (provider) => !(isExternalCliProvider(provider) || isRemovedAgyProvider(provider)),
        );
        return [...new Set([...runtime, ...configured])];
    }

    private readModelsConfig(): ModelsConfig {
        if (this.remote) return {};
        return (readJsoncObject(join(this.configDir, "models.json")) as ModelsConfig) || {};
    }

    /** Read one provider's local models.json entry. */
    getProviderConfig(provider: string): ConfiguredProviderInput | undefined {
        if (this.remote) return undefined;
        if (isExternalCliProvider(provider) || isRemovedAgyProvider(provider)) return undefined;
        const providers = this.readModelsConfig().providers;
        const config = isJsonRecord(providers) ? providers[provider] : undefined;
        return isJsonRecord(config) ? (config as ConfiguredProviderInput) : undefined;
    }

    private getConfiguredModels(): RunWieldModel[] {
        if (this.remote) return [];
        const providers = this.readModelsConfig().providers;
        if (!isJsonRecord(providers)) return [];
        return Object.entries(providers).flatMap(([provider, config]) =>
            !(isExternalCliProvider(provider) || isRemovedAgyProvider(provider)) && isJsonRecord(config)
                ? readConfiguredModels(provider, config as ConfiguredProviderInput)
                : [],
        );
    }
}

/** Discover a configured provider's unlisted native model through its /models endpoint. */
export async function discoverProviderModel(
    modelRegistry: RunWieldModelRegistry,
    provider: string,
    modelId: string,
    options: DiscoverProviderModelOptions = {},
    network = SYSTEM_MODEL_DISCOVERY_NETWORK,
): Promise<RunWieldModel | undefined> {
    if (modelRegistry.remote || isExternalCliProvider(provider) || isRemovedAgyProvider(provider)) return undefined;
    const existing = modelRegistry.find(provider, modelId);
    if (existing) return existing;

    const providerConfig = modelRegistry.getProviderConfig(provider);
    if (!providerConfig) return undefined;

    const baseUrl = typeof providerConfig.baseUrl === "string" ? providerConfig.baseUrl.trim() : "";
    const api = typeof providerConfig.api === "string" ? providerConfig.api.trim() : "";
    const apiKey = resolveLiteralConfigValue(providerConfig.apiKey);
    if (!baseUrl || !api || !apiKey) return undefined;

    const response = await network.fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
        throw new Error(
            `model discovery failed for provider "${provider}" (${response.status} ${response.statusText})`,
        );
    }

    const ids = readOpenAiModelIds((await response.json()) as JsonValue);
    if (!ids.includes(modelId)) return undefined;

    const imageInputModels = Array.isArray(providerConfig.imageInputModels) ? providerConfig.imageInputModels : [];
    const resolvedInput = options.input ?? (imageInputModels.includes(modelId) ? ["text", "image"] : ["text"]);

    modelRegistry.registerProvider(provider, {
        name: asString(providerConfig.name, provider),
        baseUrl,
        apiKey,
        api,
        authHeader: providerConfig.authHeader,
        headers: providerConfig.headers,
        models: [
            {
                id: modelId,
                name: modelId,
                api,
                baseUrl,
                reasoning: false,
                input: resolvedInput,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
            },
        ],
    });

    return modelRegistry.find(provider, modelId);
}

function getPiConfigMigrationCandidates(fileName: string, homeDir: string): string[] {
    if (!homeDir) return [];
    return [join(homeDir, ".pi", "agent", fileName), join(homeDir, ".pi", fileName)];
}

function migrateModelConfigFilesOnce(options: {
    targetDir: string;
    sourceCandidatesByFile: (fileName: string) => string[];
}): {
    copied: string[];
    skipped: string[];
    failed: Array<{ file: string; error: string }>;
} {
    const copied: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ file: string; error: string }> = [];
    for (const fileName of MODEL_CONFIG_FILES) {
        const targetPath = join(options.targetDir, fileName);
        if (fileExists(targetPath)) {
            skipped.push(fileName);
            continue;
        }
        const sourcePath = options.sourceCandidatesByFile(fileName).find(fileExists);
        if (!sourcePath) {
            skipped.push(fileName);
            continue;
        }
        try {
            mkdirSync(options.targetDir, { recursive: true });
            copyFileSync(sourcePath, targetPath);
            copied.push(fileName);
        } catch (error) {
            failed.push({ file: fileName, error: errorMessage(error as Error | string) });
        }
    }
    return { copied, skipped, failed };
}

/** Copy missing RunWield model configuration from legacy Pi paths. */
export function migratePiModelConfigOnce(options: { homeDir?: string; runwieldDir?: string } = {}): {
    copied: string[];
    skipped: string[];
    failed: Array<{ file: string; error: string }>;
} {
    const homeDir = options.homeDir ?? getHomeDir();
    const runwieldDir = options.runwieldDir ?? personalGlobalRoot();
    return migrateModelConfigFilesOnce({
        targetDir: runwieldDir,
        sourceCandidatesByFile: (fileName) => getPiConfigMigrationCandidates(fileName, homeDir),
    });
}

/** Create a native runtime backed by RunWield's models.json and auth.json. */
export async function createRunWieldModelRuntime(): Promise<ModelRuntime> {
    registerBundledOAuthFlowsOnce();
    const agentDir = personalGlobalRoot();
    const piMigration = migratePiModelConfigOnce({ runwieldDir: agentDir });
    for (const failure of piMigration.failed) {
        console.warn(`Failed to migrate Pi ${failure.file} to RunWield config: ${failure.error}`);
    }
    const credentialStore = getRunWieldCredentialStore(agentDir);
    return await ModelRuntime.create({
        credentials: credentialStore,
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
    });
}

/**
 * Install the laptop catalog and credential-free runtime for normal model consumers.
 * Call after control authentication and configureRemotePersonalResources. Installation is atomic:
 * consumers fail closed while setup is pending or if it fails. The returned cleanup is idempotent;
 * call it when this connection ends, before installing a successor. It does not close the transport,
 * dispose caller-owned Sessions, or revoke runtime references already held by those Sessions.
 */
export async function configureRemoteModelConnection(connection: RemoteModelConnection): Promise<() => void> {
    if (
        !remotePersonalResourcesActive() ||
        remoteModelConnectionToken ||
        !Number.isInteger(connection.port) ||
        connection.port < 1 ||
        connection.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(connection.credential)
    )
        throw new Error("Remote model composition requires a mounted context and a fresh valid control connection");
    const token = Symbol("remote model connection");
    remoteModelConnectionToken = token;
    try {
        // Retain our connection values, not a caller-mutable transport descriptor.
        // The normal RunWield root loader disables extensions, just as the bounded
        // loader does. Pi's no-op provider hooks stay in the remote Agent loop.
        const configuredConnection: RemoteModelConnection = { ...connection, callbackPolicy: "no-extensions" };
        const catalog = await fetchRemoteModelCatalog(configuredConnection);
        const runtime = await createRemoteModelRuntime(configuredConnection, catalog);
        const registry = new RunWieldModelRegistry({ remote: true, runtime, configDir: personalGlobalRoot() });
        remoteModelComposition = { runtime, registry };
    } catch (error) {
        remoteModelConnectionToken = undefined;
        throw error;
    }
    return () => {
        if (remoteModelConnectionToken !== token) return;
        remoteModelComposition = undefined;
        remoteModelConnectionToken = undefined;
    };
}

/** Get the native runtime for the current local or mounted remote context. */
export function getModelRuntime(): Promise<ModelRuntime> {
    if (remotePersonalResourcesActive()) {
        if (remoteModelComposition) return Promise.resolve(remoteModelComposition.runtime);
        throw new Error("Remote model runtime requires explicit control connection");
    }
    const configDir = personalGlobalRoot();
    if (!modelRuntimePromise || modelRuntimeConfigDir !== configDir) {
        modelRuntimeConfigDir = configDir;
        resolvedModelRuntime = null;
        const pendingRuntime = createRunWieldModelRuntime();
        const configuredRuntimePromise = pendingRuntime.then((runtime) => {
            if (modelRuntimePromise === configuredRuntimePromise) resolvedModelRuntime = runtime;
            return runtime;
        });
        modelRuntimePromise = configuredRuntimePromise;
    }
    return modelRuntimePromise;
}

/** Read the native model registry for execution integrations. */
export function getNativeModelRegistry(): RunWieldModelRegistry {
    if (remotePersonalResourcesActive()) {
        if (remoteModelComposition) return remoteModelComposition.registry;
        throw new Error("Remote model registry requires explicit control connection");
    }
    const agentDir = personalGlobalRoot();
    const piMigration = migratePiModelConfigOnce({ runwieldDir: agentDir });
    for (const failure of piMigration.failed) {
        console.warn(`Failed to migrate Pi ${failure.file} to RunWield config: ${failure.error}`);
    }
    modelRuntimePromise = getModelRuntime();
    return new RunWieldModelRegistry({
        runtime: resolvedModelRuntime,
        runtimePromise: modelRuntimePromise,
        configDir: agentDir,
    });
}
