import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
    createAssistantMessageEventStream,
    createProvider,
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    InMemoryCredentialStore,
    type ProviderStreams,
} from "@earendil-works/pi-ai";
import { createRemoteModelRuntime, fetchRemoteModelCatalog } from "./model-bridge.ts";
import type { RemoteModelConnection } from "./model-bridge.ts";

/** Synthetic provider only. Pi, persistence, tools and compaction all run normally. */
export async function makeSaveModelRuntime(contexts: string[] = []) {
    const stream: ProviderStreams["streamSimple"] = (_model, context) => {
        const result = createAssistantMessageEventStream();
        contexts.push(JSON.stringify(context));
        const isTurn = context.messages.some(
            (message) => message.role === "system" && Boolean(message.toolsAdded?.length),
        );
        const hasResult = context.messages.some((message) => message.role === "toolResult");
        const message = fauxAssistantMessage(
            isTurn && !hasResult
                ? fauxToolCall("remote_effect", {})
                : fauxText(isTurn ? "Remote effect saved." : "Actual compaction summary."),
        );
        queueMicrotask(() => {
            result.push({ type: "done", reason: "stop", message });
            result.end();
        });
        return result;
    };
    const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    runtime.registerNativeProvider(
        createProvider({
            id: "save-verification",
            name: "Save verification",
            models: [
                {
                    provider: "save-verification",
                    id: "synthetic",
                    name: "Synthetic",
                    api: "openai-completions",
                    baseUrl: "https://verification.invalid",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 1000,
                },
            ],
            auth: {
                apiKey: {
                    name: "Verification",
                    check: () => Promise.resolve({ type: "api_key" }),
                    resolve: () => Promise.resolve({ auth: {} }),
                },
            },
            api: { stream, streamSimple: stream },
        }),
    );
    await runtime.refresh({ allowNetwork: false });
    return runtime;
}

interface SaveAgentOptions {
    cwd: string;
    home: string;
    manager: SessionManager;
    execute: () => Promise<string>;
    modelConnection?: RemoteModelConnection;
    contexts?: string[];
}

export async function makeSaveAgent(options: SaveAgentOptions) {
    const runtime = options.modelConnection
        ? await createRemoteModelRuntime(
              { ...options.modelConnection, callbackPolicy: "no-extensions" },
              await fetchRemoteModelCatalog(options.modelConnection),
          )
        : await makeSaveModelRuntime(options.contexts);
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
    });
    const loader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: options.home,
        settingsManager,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noSkills: true,
        noThemes: true,
        systemPromptOverride: () => "Use remote_effect exactly once, then finish.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd: options.cwd,
        agentDir: options.home,
        modelRuntime: runtime,
        model: runtime.getModel("save-verification", "synthetic"),
        settingsManager,
        resourceLoader: loader,
        sessionManager: options.manager,
        tools: ["remote_effect"],
        customTools: [
            {
                name: "remote_effect",
                label: "Remote effect",
                description: "Write one owned remote project marker",
                parameters: { type: "object", properties: {}, additionalProperties: false },
                execute: async () => ({
                    content: [{ type: "text" as const, text: await options.execute() }],
                    details: null,
                }),
            },
        ],
    });
    return session;
}
