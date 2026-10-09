import {
    type AgentSession,
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "@std/path";
import { type RunWieldModel, RunWieldModelRegistry, SYSTEM_MODEL_DISCOVERY_NETWORK } from "../models/model-registry.ts";
import {
    applySessionTemperature,
    assembleFinalSystemPrompt,
    getConfiguredAgentTemperature,
    getPromptTemplatePaths,
    resolveModel,
} from "../session/session.js";
import { loadAgentDef } from "../session/agents.js";
import { assertModelExecutionBackendSupported } from "../models/model-execution.ts";
import { parseProviderModel } from "../models/model-validation.ts";
import { modelSupportsImageInput, resolveVisionFallbackModel } from "../session/image-attachments.ts";
import { getResolvedVisionFallbackModelSetting, getSettingsManager } from "../settings.js";
import { createSeeImageTool } from "../../tools/see-image.ts";
import {
    getPackagePromptTemplatePaths,
    mappedRemotePackageSettings,
    resolveInstalledPackagePromptResources,
} from "../package-resources.ts";
import { createRemoteModelRuntime, fetchRemoteModelCatalog, type RemoteModelConnection } from "./model-bridge.ts";
import {
    assertPersonalResourcePath,
    configureRemotePersonalResources,
    personalGlobalRoot,
    remotePersonalResourcesActive,
} from "./personal-resources.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";
import type { RemoteMount } from "./sftp-mount.ts";

interface BoundedModelSelection {
    cwd: string;
    /** A saved model identity, when supplied, is an explicit strict choice. */
    provider?: string;
    modelId?: string;
    /** Invocation choices take priority over settings and the agent definition. */
    modelOverride?: string;
    agentName?: string;
    agentDef?: Parameters<typeof resolveModel>[1];
}

/** Verify a bounded remote choice against the laptop catalog using the normal selection rules. */
export async function resolveBoundedRemoteModelSelection(
    registry: RunWieldModelRegistry,
    selection: BoundedModelSelection,
): Promise<RunWieldModel> {
    if (!registry.remote) throw new Error("Bounded remote model selection requires a remote registry");
    if (Boolean(selection.provider) !== Boolean(selection.modelId)) {
        throw new Error("Saved remote model identity requires both provider and modelId");
    }
    if (selection.modelOverride && selection.provider) {
        throw new Error("Specify either a saved remote model or an invocation override");
    }
    const agentName = selection.agentName || "engineer";
    const agentDef = selection.agentDef || {
        name: agentName,
        displayName: agentName,
        model: "",
        description: "",
        tools: [],
        systemPrompt: "",
    };
    const override = selection.provider ? `${selection.provider}/${selection.modelId}` : selection.modelOverride;
    const model: RunWieldModel = await resolveModel(
        override,
        agentDef,
        agentName,
        registry,
        undefined,
        selection.cwd,
    );
    assertModelExecutionBackendSupported(model, true);
    // Never replace a saved selection with another catalog entry.
    if (selection.provider && (model.provider !== selection.provider || model.id !== selection.modelId)) {
        throw new Error(`Remote model identity changed: ${selection.provider}/${selection.modelId}`);
    }
    return model;
}

/**
 * Integration-only bootstrap. Call after supervisor authentication and mount verification.
 * This does not start a turn, expose tools, or create a managed Session writer.
 * The caller must dispose the returned session when the connection closes.
 */
export async function createBoundedRemoteModelSession(options: {
    mount: RemoteMount;
    connection: RemoteModelConnection;
    cwd: string;
    provider?: string;
    modelId?: string;
    modelOverride?: string;
    agentName?: string;
    agentDef?: Parameters<typeof resolveModel>[1];
    /** Synthetic project tools for bounded integration checks; this does not enable remote user turns. */
    customTools?: NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"];
}): Promise<{ session: AgentSession; registry: RunWieldModelRegistry }> {
    if (remotePersonalResourcesActive()) throw new Error("Remote personal resources are already configured");
    if (
        !isAbsolute(options.cwd) || !options.mount.globalRoot || !Number.isInteger(options.connection.port) ||
        options.connection.port < 1 || options.connection.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(options.connection.credential)
    ) {
        throw new Error("Remote model session requires verified mount and control connection");
    }
    // Refuse explicit CLI selections before requesting a catalog or starting a process.
    if (Boolean(options.provider) !== Boolean(options.modelId)) {
        throw new Error("Saved remote model identity requires both provider and modelId");
    }
    if (options.provider && options.modelId) {
        assertModelExecutionBackendSupported({ provider: options.provider, id: options.modelId }, true);
    }
    if (options.modelOverride) {
        const parsed = parseProviderModel(options.modelOverride);
        if (parsed.ok) assertModelExecutionBackendSupported({ provider: parsed.provider, id: parsed.id }, true);
    }
    configureRemotePersonalResources({
        globalRoot: options.mount.globalRoot,
        agentsRoot: options.mount.agentsRoot,
        packageRoots: options.mount.packageRoots,
    });
    configureRemoteSettingsConnection(options.connection);
    const catalog = await fetchRemoteModelCatalog(options.connection);
    // This loader disables extensions, so Pi's request/response hooks are no-ops.
    // Other callers must not discard custom hooks silently.
    const runtime = await createRemoteModelRuntime({ ...options.connection, callbackPolicy: "no-extensions" }, catalog);
    const registry = new RunWieldModelRegistry({ remote: true, runtime, configDir: personalGlobalRoot() });
    const agentName = options.agentName ?? "engineer";
    const agentDef = options.agentDef ?? await loadAgentDef(agentName, options.cwd);
    const model = await resolveBoundedRemoteModelSelection(registry, { ...options, agentDef });
    const customTools = [...options.customTools ?? []];
    if (
        !modelSupportsImageInput(model) && getResolvedVisionFallbackModelSetting(options.cwd) &&
        !customTools.some((tool) => tool.name === "see_image")
    ) {
        const fallback = await resolveVisionFallbackModel(registry, SYSTEM_MODEL_DISCOVERY_NETWORK, options.cwd);
        if (fallback) {
            customTools.push(createSeeImageTool({
                cwd: options.cwd,
                remoteModel: fallback.model,
                completeSimpleFn: (model, context, streamOptions) =>
                    runtime.streamSimple(model, context, streamOptions).result(),
            }));
        }
    }
    const systemPrompt = await assembleFinalSystemPrompt(
        { ...agentDef, systemPrompt: agentDef.systemPrompt.replace("{{MEMORIES}}", "") },
        customTools.map((tool) => tool.name),
        customTools,
        options.cwd,
        "",
        { homeDir: personalGlobalRoot() },
    );
    const settingsManager = getSettingsManager(options.cwd);
    const packagePrompts = await resolveInstalledPackagePromptResources({ cwd: options.cwd });
    const promptPaths = [...getPromptTemplatePaths(options.cwd), ...getPackagePromptTemplatePaths(packagePrompts)];
    // Pi reads symlink targets directly. Check every personal template before passing paths to its loader.
    for (const path of promptPaths) {
        await assertPersonalResourcePath(path, "prompt template path");
        const stat = await Deno.stat(path).catch((error) => {
            if (error instanceof Deno.errors.NotFound) return undefined;
            throw error;
        });
        if (!stat?.isDirectory) continue;
        for await (const entry of Deno.readDir(path)) {
            if ((entry.isFile || entry.isSymlink) && entry.name.endsWith(".md")) {
                await assertPersonalResourcePath(join(path, entry.name), "prompt template");
            }
        }
    }
    const loader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: personalGlobalRoot(),
        settingsManager: mappedRemotePackageSettings(settingsManager),
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        additionalPromptTemplatePaths: promptPaths,
        noSkills: true,
        noThemes: true,
        systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();
    const { session } = await createAgentSession({
        cwd: options.cwd,
        agentDir: personalGlobalRoot(),
        modelRuntime: runtime,
        model,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(options.cwd),
        tools: customTools.map((tool) => tool.name),
        customTools,
        ...(customTools.length ? {} : { noTools: "all" }),
    });
    applySessionTemperature(
        session,
        getConfiguredAgentTemperature(agentName, options.cwd) ?? agentDef.temperature,
    );
    return { session, registry };
}
