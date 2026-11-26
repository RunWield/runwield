import {
    createAgentSession,
    DefaultResourceLoader,
    type AgentSession,
    type CreateAgentSessionOptions,
    type CreateAgentSessionResult,
    type ExtensionFactory,
    type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { generateImage, type GeneratedImage, type GenerateImageOptions } from "./image-generation.ts";
import { assertRemoteProviderExtensionsSupported } from "./provider-hooks.ts";
import { normalizeProviderStream } from "./provider-stream.ts";
import { projectProviderSystemPrompt, projectSystemPromptExtension } from "./provider-system-prompt.ts";
import { applySessionTemperature } from "./temperature.ts";
import { validateToolArguments, toolCallMessage, toolResultMessage } from "./tool-transcript.ts";
import type { CompletedTurn, TurnInput } from "./turn.ts";

export type { GeneratedImage, GenerateImageOptions } from "./image-generation.ts";
export type { ToolCallModel, ToolCallInput, ToolResultMessageInput } from "./tool-transcript.ts";
export { normalizeProviderStream } from "./provider-stream.ts";
export { withModelExecutionCompatibility } from "./temperature.ts";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Provider adaptations applied after the host selects execution settings. */
interface ProviderOptions {
    temperature?: number;
    /** Replace the provider's leading instructions with the active coding Agent's prompt. */
    projectSystemPrompt?: boolean;
}

/** Controls Pi command and template expansion for a prompt. */
interface PromptOptions {
    expandPromptTemplates?: boolean;
}

/** Provider credentials resolved by the caller. */
interface TurnCredentials {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
}

/** Execution settings for a direct model completion. */
export interface CompleteTurnOptions {
    signal?: AbortSignal;
    credentials?: TurnCredentials;
    maxTokens?: number;
    /** Runtime for a request that travels through the authenticated remote model bridge. */
    runtime?: ModelRuntime;
}

type StreamingAgent = Partial<Pick<AgentSession, "isStreaming" | "steer">>;

/** Pi-native SDK integration. The host owns the session manager, subscriptions, and disposal. */
export interface CodingAgent {
    /** Load the Pi resources selected by the host. */
    loadResources(options: ResourceLoaderOptions): Promise<DefaultResourceLoader>;
    /** Open an SDK session and return its loaded extension diagnostics. */
    create(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
    /** Reject provider extension hooks that the remote transport cannot run. */
    validateProviderTransport(session: AgentSession): void;
    /** Extension factory that refreshes leading system instructions before requests. */
    systemPromptExtension: ExtensionFactory;
    /** Apply the chosen prompt and temperature behavior to the session stream. */
    configureProvider(session: AgentSession, options: ProviderOptions): void;
    /** Submit a text and image prompt through Pi's agent loop. */
    prompt(session: Pick<AgentSession, "prompt">, input: TurnInput, options?: PromptOptions): Promise<void>;
    /** Deliver steering to a streaming session and report whether it accepted the input. */
    steer(session: StreamingAgent | null | undefined, input: TurnInput): Promise<boolean>;
    /** Validate and coerce externally supplied tool arguments using its Pi schema. */
    validateToolArguments: typeof validateToolArguments;
    /** Build the transcript message for an external tool call. */
    toolCallMessage: typeof toolCallMessage;
    /** Build the transcript message for an external tool result. */
    toolResultMessage: typeof toolResultMessage;
    /** Request exactly one image from the configured Pi image-output model. */
    generateImage(input: TurnInput, options: GenerateImageOptions): Promise<GeneratedImage>;
    /** Complete a single text and optional image request and return text and usage. */
    complete(model: Model<Api>, input: TurnInput, options?: CompleteTurnOptions): Promise<CompletedTurn>;
}

export const codingAgent: CodingAgent = {
    async loadResources(options) {
        const loader = new DefaultResourceLoader(options);
        await loader.reload();
        return loader;
    },
    create: createAgentSession,
    validateProviderTransport: assertRemoteProviderExtensionsSupported,
    systemPromptExtension: projectSystemPromptExtension,
    configureProvider(session, { temperature, projectSystemPrompt }) {
        if (projectSystemPrompt) {
            const agent = session.agent;
            const convertToLlm = agent.convertToLlm.bind(agent);
            // Compaction calls streamFunction directly with its own summarization prompt.
            agent.convertToLlm = async (messages) =>
                projectProviderSystemPrompt(await convertToLlm(messages), session.systemPrompt);
            const providerStream = agent.streamFunction;
            agent.streamFunction = (model, context, options) => {
                // Extensions can register provider hooks after session construction.
                assertRemoteProviderExtensionsSupported(session);
                return normalizeProviderStream(providerStream, model, context, options);
            };
        }
        applySessionTemperature(session, temperature);
    },
    prompt(session, { text, images }, options) {
        return session.prompt(text, { ...options, ...(images?.length ? { images } : {}) });
    },
    async steer(session, { text, images }) {
        if (!session?.isStreaming || typeof session.steer !== "function") return false;
        await session.steer(text, images?.length ? images : undefined);
        return true;
    },
    validateToolArguments,
    toolCallMessage,
    toolResultMessage,
    generateImage,
    async complete(model, { text, images }, { credentials, signal, maxTokens, runtime } = {}) {
        const context = {
            messages: [
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text }, ...(images ?? [])],
                    timestamp: Date.now(),
                },
            ],
        };
        const options = {
            apiKey: credentials?.apiKey,
            headers: credentials?.headers,
            env: credentials?.env,
            signal,
            maxTokens,
        };
        const response = await (runtime
            ? runtime.streamSimple(model, context, options).result()
            : completeSimple(model, context, options));
        const { content, usage } = response;
        return {
            text:
                typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content
                            .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
                            .join("\n")
                            .trim()
                      : "",
            usage: usage && {
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                costAmount: usage.cost?.total,
            },
            status:
                response.stopReason === "aborted"
                    ? "canceled"
                    : response.stopReason === "error"
                      ? "failed"
                      : "succeeded",
            errorMessage: response.errorMessage,
        };
    },
};
