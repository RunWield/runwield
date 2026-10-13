import { mkdirSync } from "node:fs";
import { AGENTS } from "../../../constants.js";
import { recordManualModelSelection } from ".././active-agent-session.js";
import { resolveActiveWorkflowRuntimeAgent } from "../../workflow/execution-agent.ts";
import { getAgentBusyLines, getAgentDisplayName } from ".././agents.js";
import { switchActiveAgent } from ".././agent-switching.js";
import {
    drainSessionCompactionMetrics,
    getConfiguredAgentModel,
    getRootSessionRebuildOptions,
    runIsolatedAgentSession,
} from ".././session.js";
import { emitSystemStatus, RuntimeEventTypes } from ".././session-runtime-events.js";
import { assertModelExecutionBackendSupported } from "../../models/model-execution.ts";
import { getModelRegistry } from "../../models/model-registry.ts";
import { parseProviderModel } from "../../models/model-validation.ts";
import { clearMascotEnabledCache, getSettingsManager, setGlobalCompactionSetting } from "../../settings.js";
import { getSessionKeyboardHelp } from ".././session-help.ts";
import { resolveMcpConfig } from "../../mcp/config.ts";
import { startMcpIntegration } from "../../mcp/integration.ts";
import { ensureAgyCliMcpSetup } from ".././backends/agy-cli/mcp-setup.ts";
import { readCurrentPairCheckpoint, recordPairCheckpointSnapshot } from ".././pair-checkpoint-session.ts";
import { recordExecutionWorkflowSnapshot } from "../execution-workflow-session.ts";
import { resolvePersistedExecutionRootConfiguration } from "./support.ts";

import {
    getRuntimeRootAgentSession,
    isAgyCliMcpSetupApprovalError,
    isRuntimeRootSessionManager,
    SessionTurnInProgressError,
} from "./support.ts";

import type { ManagedOperationFailure } from "./types.ts";
import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";

interface RuntimeMutationResult {
    ok: boolean;
    error?: string;
    deferred?: boolean;
    enabled?: boolean;
    thinkingLevel?: import("../hosted-session.js").ThinkingLevel;
    agentName?: string;
    model?: string;
    provider?: string;
    changed?: boolean;
}
interface TutorialContextMutationResult {
    ok: boolean;
    error?: string;
    tutorialContext?: import("../tutorial-context-session.ts").TutorialContext | null;
}

interface RuntimeThinkingResult {
    ok: boolean;
    error?: string;
    thinkingLevel?: import("../hosted-session.js").ThinkingLevel;
}

type RuntimeCompactionResult =
    & Awaited<
        ReturnType<import("@earendil-works/pi-coding-agent").AgentSession["compact"]>
    >
    & { error?: undefined };

type RuntimeEventsDependency = Pick<
    RuntimeEvents,
    "emitCommandCatalogChanged" | "emitSessionEvent" | "runBusyOperation"
>;
type RuntimeLifecycleDependency = Pick<
    RuntimeLifecycle,
    "clearPendingProject" | "getPendingProject" | "hasPendingProject" | "prepareDeferredManagedCreation"
>;
type RuntimeManagedOperationsDependency = Pick<
    RuntimeManagedOperations,
    | "clearPendingCreationProof"
    | "getPendingCreationProof"
    | "hasOperation"
    | "hasPendingCreationProof"
    | "runManagedStandaloneMutation"
    | "runPendingCreation"
    | "setPendingCreationProof"
>;

export class RuntimeAgentSettings {
    private events!: RuntimeEventsDependency;
    private lifecycle!: RuntimeLifecycleDependency;
    private managedOperations!: RuntimeManagedOperationsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        lifecycle: RuntimeLifecycleDependency,
        managedOperations: RuntimeManagedOperationsDependency,
    ) {
        this.events = events;
        this.lifecycle = lifecycle;
        this.managedOperations = managedOperations;
    }
    markPromptReadyAgent(
        sessionId: string,
        options: { agentName?: string; model?: string } = {},
    ): RuntimeMutationResult {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) return { ok: false, error: "not_found" };
        if (!this.lifecycle.hasPendingProject(sessionId) || hostedSession.getManagedMetadata?.()) {
            return { ok: false, error: "not_unpersisted_new_session" };
        }
        const agentName = options.agentName || AGENTS.ROUTER;
        const displayName = getAgentDisplayName(agentName, hostedSession.cwd);
        const currentModel = hostedSession.getActiveModelState?.() || { model: "", provider: "" };
        const configuredModelRef = options.model ?? getConfiguredAgentModel(agentName, hostedSession.cwd) ?? "";
        const settingsManager = getSettingsManager(hostedSession.cwd);
        let model = currentModel.model || settingsManager.getDefaultModel?.()?.trim() || "";
        let provider = currentModel.provider || settingsManager.getDefaultProvider?.()?.trim() || "";
        if (configuredModelRef) {
            const parsedModel = parseProviderModel(configuredModelRef);
            if (parsedModel.ok) {
                model = parsedModel.id;
                provider = parsedModel.provider;
            } else {
                model = configuredModelRef;
                provider = "";
            }
        }
        hostedSession.resetAgentInfoStack(displayName, model, provider, agentName);
        const busyLines = getAgentBusyLines(agentName, hostedSession.cwd);
        this.events.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.AGENT_CHANGED,
            agentName,
            model: model || undefined,
            ...(busyLines ? { busyLines } : {}),
        });
        return { ok: true, agentName, model };
    }

    async renameSession(sessionId: string, name: string) {
        const normalizedName = String(name || "").trim();
        if (!normalizedName) return { ok: false, error: "invalid_name" };
        const pendingCreation = this.lifecycle.getPendingProject(sessionId);
        const pendingSession = this.services.sessionHost.getSession(sessionId);
        if (pendingCreation && pendingSession && !pendingSession.getManagedMetadata?.()) {
            pendingCreation.name = normalizedName;
            this.events.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.SESSION_RENAMED,
                name: normalizedName,
            });
            return { ok: true, name: normalizedName };
        }
        return await this.managedOperations.runManagedStandaloneMutation(sessionId, "rename", (session) => {
            session.getRootSessionManager()?.appendSessionInfo?.(normalizedName);
            this.events.emitSessionEvent(session.id, { type: RuntimeEventTypes.SESSION_RENAMED, name: normalizedName });
            return { ok: true, name: normalizedName };
        }, { activateAgent: false });
    }

    async setSessionModel(sessionId: string, model: string, provider: string = "", userOverride: boolean = true) {
        return await this.managedOperations.runManagedStandaloneMutation(sessionId, "set_model", (session) => {
            session.setActiveModelState(model, provider, userOverride);
            this.events.emitSessionEvent(session.id, { type: RuntimeEventTypes.MODEL_CHANGED, model, provider });
            return { ok: true, model, provider };
        }, { activateAgent: false });
    }

    async reconfigureSessionModel(
        sessionId: string,
        model: string,
        provider: string = "",
    ): Promise<RuntimeMutationResult> {
        const registry = getModelRegistry();
        const parsedModel = provider ? { ok: true, provider, id: model } : parseProviderModel(model);
        const targetModel = parsedModel.ok ? registry.find(parsedModel.provider, parsedModel.id) : undefined;
        if (parsedModel.ok && parsedModel.provider === "agy-cli" && !targetModel) {
            throw new Error(
                `Unsupported Antigravity CLI model: agy-cli/${parsedModel.id}. Select agy-cli/gemini-3.8-flash or agy-cli/gemini-3.1-pro.`,
            );
        }
        assertModelExecutionBackendSupported(targetModel);

        const promptReadySession = this.services.sessionHost.getSession(sessionId);
        if (
            promptReadySession &&
            this.lifecycle.hasPendingProject(sessionId) &&
            !promptReadySession.getManagedMetadata?.()
        ) {
            promptReadySession.setActiveModelState(model, provider, true);
            if (parsedModel.ok && parsedModel.provider === "agy-cli") {
                await ensureAgyCliMcpSetup({ hostedSession: promptReadySession });
            }
            promptReadySession.mergePendingManagedTurnIntent?.({ model, provider, manualModel: true });
            this.events.emitSessionEvent(sessionId, { type: RuntimeEventTypes.MODEL_CHANGED, model, provider });
            return { ok: true, model, provider };
        }
        return await this.managedOperations.runManagedStandaloneMutation(
            sessionId,
            "set_model",
            async (session, capability) => {
                const previousUserOverride = session.isUserModelOverride?.() === true;
                const previousModelState = session.getActiveModelState();
                session.setActiveModelState(model, provider, true);
                const agentName = session.getRootAgentName();
                try {
                    if (agentName) {
                        await this.activateSessionAgent(session, {
                            agentName,
                            model: provider ? `${provider}/${model}` : model,
                            forceRebuild: true,
                            ...(capability ? { managedOperationCapability: capability } : {}),
                        });
                    }
                    session.getRootSessionManager?.()?.appendModelChange?.(provider, model);
                    const sessionManager = session.getRootSessionManager?.();
                    if (isRuntimeRootSessionManager(sessionManager)) {
                        recordManualModelSelection(sessionManager, provider, model);
                    }
                } catch (error) {
                    if (!(error instanceof Error && isAgyCliMcpSetupApprovalError(error))) {
                        if (previousUserOverride) {
                            session.setActiveModelState(
                                previousModelState.model,
                                previousModelState.provider || "",
                                true,
                            );
                        } else {
                            session.clearUserModelOverride?.();
                        }
                    }
                    throw error;
                }
                this.events.emitSessionEvent(sessionId, { type: RuntimeEventTypes.MODEL_CHANGED, model, provider });
                return { ok: true, model, provider };
            },
            { activateAgent: false },
        );
    }

    async setProjectStateContext(sessionId: string, context: string) {
        return await this.managedOperations.runManagedStandaloneMutation(sessionId, "workflow_operation", (session) => {
            session.setProjectStateContext(context);
            return { ok: true };
        }, { activateAgent: false });
    }

    async updateTutorialContext(
        sessionId: string,
        update: import("../tutorial-context-session.ts").TutorialContextUpdate,
    ): Promise<TutorialContextMutationResult> {
        const session = this.services.sessionHost.getSession(sessionId);
        const managed = session?.getManagedMetadata?.() || null;
        if (!session || !managed) return { ok: false, error: "not_managed" };
        if (!this.services.sessionStore) return { ok: false, error: "session_store_unavailable" };
        const committedPlanAssociations = this.services.sessionStore.listSessionPlanAssociations(
            managed.runwieldSessionId,
            managed.projectId,
        );
        try {
            return await this.managedOperations.runManagedStandaloneMutation(
                sessionId,
                "workflow_operation",
                (activeSession) => ({
                    ok: true,
                    tutorialContext: activeSession.updateTutorialContext(update, committedPlanAssociations),
                }),
                { activateAgent: false },
            );
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async runIsolatedAgent(
        sessionId: string,
        options: {
            agentName: string;
            userRequest: string;
            subAgentDefinition?: {
                id: import(".././subagent-definitions.ts").SubAgentDefinitionId;
                options?: import(".././subagent-definitions.ts").LoadSubAgentDefinitionOptions;
            };
            images?: import(".././types.js").ImageAttachment[];
            toolNames?: string[];
            customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
            modelOverride?: string;
            thinkingLevelOverride?: import("../hosted-session.js").ThinkingLevel;
            temperatureOverride?: number;
        },
    ): Promise<Awaited<ReturnType<typeof runIsolatedAgentSession>> | RuntimeMutationResult | ManagedOperationFailure> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) throw new Error("SessionRuntime.runIsolatedAgent: session not found");
        if (this.managedOperations.hasPendingCreationProof(sessionId) || this.lifecycle.hasPendingProject(sessionId)) {
            const pendingAgent = session.getPendingManagedTurnIntent?.()?.agentName || session.getRootAgentName?.() ||
                AGENTS.ROUTER;
            const activated = await this.activateSessionAgent(session, { agentName: pendingAgent });
            if (!activated?.ok) return activated;
            return await this.runIsolatedAgent(sessionId, options);
        }
        return await this.managedOperations.runManagedStandaloneMutation(
            sessionId,
            "workflow_operation",
            (activeSession, capability) =>
                this.events.runBusyOperation(activeSession.id, () =>
                    runIsolatedAgentSession({
                        hostedSession: activeSession,
                        ...(capability ? { managedOperationCapability: capability } : {}),
                        agentName: options.agentName,
                        userRequest: options.userRequest,
                        images: options.images || [],
                        toolNames: options.toolNames,
                        customTools: options.customTools,
                        modelOverride: options.modelOverride,
                        thinkingLevelOverride: options.thinkingLevelOverride,
                        temperatureOverride: options.temperatureOverride,
                        subAgentDefinition: options.subAgentDefinition,
                    })),
            { activateAgent: false },
        );
    }

    async setActiveExecutionWorkflow(
        sessionId: string,
        workflow: import("../hosted-session.js").ActiveExecutionWorkflow,
    ) {
        return await this.managedOperations.runManagedStandaloneMutation(sessionId, "workflow_operation", (session) => {
            session.setActiveExecutionWorkflow(workflow);
            return { ok: true };
        }, { activateAgent: false });
    }

    async clearActiveExecutionWorkflow(sessionId: string) {
        return await this.managedOperations.runManagedStandaloneMutation(sessionId, "workflow_operation", (session) => {
            session.clearActiveExecutionWorkflow();
            return { ok: true };
        }, { activateAgent: false });
    }

    async setSessionAutoCompaction(sessionId: string, enabled: boolean): Promise<RuntimeMutationResult> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found" };
        await setGlobalCompactionSetting("enabled", enabled);
        const managed = session.getManagedMetadata?.();
        if (managed && !session.getRootSessionManager?.()) {
            return { ok: true, enabled, deferred: true };
        }
        const rootAgentSession = getRuntimeRootAgentSession(session);
        if (!rootAgentSession?.setAutoCompactionEnabled) return { ok: false, error: "unsupported" };
        rootAgentSession.setAutoCompactionEnabled(enabled);
        await rootAgentSession.settingsManager?.flush?.();
        return { ok: true, enabled };
    }

    requestSessionHelp(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found" };
        const help = getSessionKeyboardHelp();
        this.events.emitSessionEvent(sessionId, {
            type: RuntimeEventTypes.KEYBOARD_HELP,
            title: help.title,
            items: help.items,
        });
        return { ok: true };
    }

    cycleSessionThinkingLevel(
        sessionId: string,
    ): RuntimeThinkingResult | Promise<RuntimeThinkingResult | ManagedOperationFailure> {
        /** @param {import('.././hosted-session.js').HostedSession} session */
        const run = (
            session: import(".././hosted-session.js").HostedSession,
        ): RuntimeThinkingResult => {
            const rootAgentSession = getRuntimeRootAgentSession(session);
            const levels: import("../hosted-session.js").ThinkingLevel[] = [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            ];
            const currentLevel = session.getThinkingLevel();
            const next = rootAgentSession?.cycleThinkingLevel?.() ??
                levels[(levels.indexOf(currentLevel) + 1) % levels.length];
            if (next === undefined) {
                this.events.emitSessionEvent(sessionId, {
                    type: RuntimeEventTypes.SYSTEM_STATUS,
                    message: "Current model does not support thinking",
                });
                return { ok: false, error: "unsupported", thinkingLevel: currentLevel };
            }
            session.setThinkingLevel(next);
            session.getRootSessionManager()?.appendThinkingLevelChange?.(next);
            this.events.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.THINKING_LEVEL_CHANGED,
                thinkingLevel: next,
            });
            return { ok: true, thinkingLevel: next };
        };
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found", thinkingLevel: "off" };
        const managed = session.getManagedMetadata?.();
        if (managed && !session.getRootSessionManager?.()) {
            return this.managedOperations.runManagedStandaloneMutation(
                sessionId,
                "set_thinking_level",
                run,
                { activateAgent: true },
            );
        }
        return run(session);
    }

    async compactSession(
        sessionId: string,
        instructions?: string,
        commandInvocationId?: string,
    ): Promise<RuntimeCompactionResult | ManagedOperationFailure> {
        return await this.managedOperations.runManagedStandaloneMutation(
            sessionId,
            "compact",
            async (session) => {
                const rootAgentSession = getRuntimeRootAgentSession(session);
                const compact = rootAgentSession?.compact;
                if (!compact) throw new Error("Runtime session cannot be compacted.");
                const checkpoint = readCurrentPairCheckpoint(session);
                const previousCommandId = session.activeCommandInvocationId;
                if (commandInvocationId) session.activeCommandInvocationId = commandInvocationId;
                try {
                    const compacted = await this.events.runBusyOperation(
                        session.id,
                        () => compact.call(rootAgentSession, instructions),
                    );
                    if (checkpoint) recordPairCheckpointSnapshot(session, checkpoint);
                    recordExecutionWorkflowSnapshot(session);
                    return compacted;
                } finally {
                    await drainSessionCompactionMetrics(rootAgentSession);
                    session.activeCommandInvocationId = previousCommandId;
                }
            },
            { activateAgent: true },
        );
    }

    async reloadSession(sessionId: string): Promise<RuntimeMutationResult> {
        const promptReadySession = this.services.sessionHost.getSession(sessionId);
        if (
            promptReadySession &&
            this.lifecycle.hasPendingProject(sessionId) &&
            !promptReadySession.getManagedMetadata?.()
        ) {
            await getSettingsManager(promptReadySession.cwd).reload();
            promptReadySession.clearUserModelOverride?.();
            promptReadySession.mergePendingManagedTurnIntent?.({ model: "", provider: "" });
            const activeAgentInfo = promptReadySession.getActiveAgentInfo?.() || null;
            const agentName = activeAgentInfo?.agentName || AGENTS.ROUTER;
            promptReadySession.resetAgentInfoStack(
                getAgentDisplayName(agentName, promptReadySession.cwd),
                "",
                "",
                agentName,
            );
            const refreshed = this.markPromptReadyAgent(sessionId, { agentName });
            if (refreshed.ok) clearMascotEnabledCache();
            if (refreshed.ok) await this.events.emitCommandCatalogChanged(sessionId, promptReadySession);
            return refreshed.ok ? { ok: true, deferred: true } : refreshed;
        }
        return await this.managedOperations.runManagedStandaloneMutation(
            sessionId,
            "reload",
            async (session, capability) => {
                const agentName = session.getRootAgentName();
                if (!agentName) return { ok: false };
                const rebuildOptions = getRootSessionRebuildOptions(session);
                await getSettingsManager(session.cwd).reload();
                await this.activateSessionAgent(session, {
                    ...rebuildOptions,
                    agentName,
                    forceRebuild: true,
                    reloadMcpTools: true,
                    ...(capability ? { managedOperationCapability: capability } : {}),
                });
                clearMascotEnabledCache();
                await this.events.emitCommandCatalogChanged(sessionId, session);
                return { ok: true };
            },
            { activateAgent: true },
        );
    }

    setSessionThinkingLevel(
        sessionId: string,
        thinkingLevel: import(".././hosted-session.js").ThinkingLevel,
    ): RuntimeMutationResult | Promise<RuntimeMutationResult> {
        const run = (session: import(".././hosted-session.js").HostedSession) => {
            const root = getRuntimeRootAgentSession(session);
            root?.setThinkingLevel?.(thinkingLevel);
            session.setThinkingLevel(thinkingLevel);
            session.getRootSessionManager()?.appendThinkingLevelChange?.(thinkingLevel);
            this.events.emitSessionEvent(session.id, { type: RuntimeEventTypes.THINKING_LEVEL_CHANGED, thinkingLevel });
            return { ok: true, thinkingLevel };
        };
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found" };
        const managed = session.getManagedMetadata?.();
        if (!managed && this.lifecycle.hasPendingProject(sessionId)) {
            session.mergePendingManagedTurnIntent?.({ thinkingLevel });
        }
        if (managed && !session.getRootSessionManager?.()) {
            return (this.managedOperations.runManagedStandaloneMutation(
                sessionId,
                "set_thinking_level",
                run,
                { activateAgent: false },
            ));
        }
        return run(session);
    }

    async refreshMcpTools(
        hostedSession: import(".././hosted-session.js").HostedSession,
        requestServers?: import("../../mcp/config.ts").McpServerDefinition[],
        forceReload = false,
    ) {
        if (requestServers) hostedSession.setMcpRequestServers(requestServers);
        if (!forceReload && !requestServers && hostedSession.getMcpIntegration?.()) return null;
        const resolved = await resolveMcpConfig({
            cwd: hostedSession.cwd,
            requestServers: hostedSession.getMcpRequestServers?.() || [],
        });
        for (const item of resolved.warnings) {
            emitSystemStatus(
                hostedSession,
                `[RunWield] MCP warning (${item.stage}${
                    item.serverName ? `/${item.serverName}` : ""
                }): ${item.message}`,
                { level: "warning" },
            );
        }
        const started = await startMcpIntegration({ cwd: hostedSession.cwd, servers: resolved.servers });
        for (const item of started.warnings) {
            emitSystemStatus(
                hostedSession,
                `[RunWield] MCP warning (${item.stage}${
                    item.serverName ? `/${item.serverName}` : ""
                }): ${item.message}`,
                { level: "warning" },
            );
        }
        return started.integration;
    }

    async runMcpCommand(sessionId: string, args: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found", notifications: [] };
        if (session.isTurnActive()) throw new SessionTurnInProgressError(session.id);
        const started = await this.refreshMcpTools(session);
        if (started) await session.setMcpIntegration(started);
        const notifications = await session.getMcpIntegration()?.runCommand(args) ?? [];
        return { ok: true, notifications };
    }

    async activateSessionAgent(
        hostedSession: import(".././hosted-session.js").HostedSession,
        options: import(".././agent-switching.js").AgentSwitchOptions,
    ) {
        let pendingCreation = this.managedOperations.getPendingCreationProof(hostedSession.id);
        if (!pendingCreation && this.lifecycle.hasPendingProject(hostedSession.id)) {
            const prepared = await this.lifecycle.prepareDeferredManagedCreation(hostedSession);
            if (!prepared) throw new Error("Session coordination was interrupted during creation");
            pendingCreation = prepared.proof;
            this.lifecycle.clearPendingProject(hostedSession.id);
            this.managedOperations.setPendingCreationProof(hostedSession.id, pendingCreation);
        }
        const mcpIntegration = options.mcpRootTools ? null : await this.refreshMcpTools(
            hostedSession,
            options.mcpServers,
            options.reloadMcpTools === true,
        );
        const activationOptions = mcpIntegration
            ? { ...options, mcpRootTools: mcpIntegration.getTools(), mcpIntegration }
            : options;
        try {
            if (!pendingCreation) {
                const result = await switchActiveAgent(hostedSession, activationOptions);
                if (mcpIntegration) await hostedSession.setMcpIntegration(mcpIntegration);
                return result;
            }
        } catch (error) {
            if (mcpIntegration) await mcpIntegration.close().catch(() => {});
            throw error;
        }
        try {
            return await this.managedOperations.runPendingCreation(
                hostedSession,
                pendingCreation,
                async (capability) => {
                    const executionRootConfiguration = resolvePersistedExecutionRootConfiguration(hostedSession);
                    const result = await switchActiveAgent(hostedSession, {
                        ...activationOptions,
                        ...executionRootConfiguration,
                        managedOperationCapability: capability,
                    });
                    if (mcpIntegration) await hostedSession.setMcpIntegration(mcpIntegration);
                    return result;
                },
            );
        } catch (error) {
            if (mcpIntegration) await mcpIntegration.close().catch(() => {});
            throw error;
        }
    }

    async alignActiveExecutionWorkflowOwner(hostedSession: import(".././hosted-session.js").HostedSession) {
        // A focused semantic repair retains its Agent while the execution owner stays durable.
        if (hostedSession.getRootAgentName?.() === AGENTS.REVIEWER_FEEDBACK_ENGINEER) return;
        const workflow = hostedSession.getActiveExecutionWorkflow?.() || null;
        const executionAgent = resolveActiveWorkflowRuntimeAgent(workflow) || "";
        if (!executionAgent) return;
        const executionCwd = typeof workflow?.executionCwd === "string" ? workflow.executionCwd : "";
        await this.activateSessionAgent(hostedSession, {
            agentName: executionAgent,
            ...(executionCwd ? { cwd: executionCwd } : {}),
        });
    }

    ensureSessionProjectForCwd(cwd: string) {
        if (!this.services.sessionStore) return null;
        try {
            mkdirSync(cwd, { recursive: true });
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        return this.services.sessionStore.ensureRuntimeProject({ root: cwd });
    }

    async switchAgent(
        sessionId: string,
        options: {
            agentName: string;
            model?: string;
            cwd?: string;
            forceRebuild?: boolean;
            releaseActiveWorkflow?: boolean;
            customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
            mcpRootTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
            mcpIntegration?: import("../../mcp/integration.ts").McpIntegration;
            toolNames?: string[];
            reloadMcpTools?: boolean;
            mcpServers?: import("../../mcp/config.ts").McpServerDefinition[];
        },
    ): Promise<RuntimeMutationResult> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found" };
        if (session.isTurnActive()) throw new SessionTurnInProgressError(session.id);
        if (this.managedOperations.hasPendingCreationProof(sessionId) || this.lifecycle.hasPendingProject(sessionId)) {
            if (this.managedOperations.hasOperation(sessionId)) {
                return { ok: false, error: "managed_operation_in_progress" };
            }
            return await this.activateSessionAgent(session, options);
        }
        const result = await this.managedOperations.runManagedStandaloneMutation(
            sessionId,
            "switch_agent",
            async (activeSession, capability) => {
                return await this.activateSessionAgent(activeSession, {
                    ...options,
                    ...(capability ? { managedOperationCapability: capability } : {}),
                });
            },
            { activateAgent: false },
        );
        if (result.ok && options.releaseActiveWorkflow) {
            session.mergePendingManagedTurnIntent({ agentName: options.agentName });
        }
        return result;
    }
}
