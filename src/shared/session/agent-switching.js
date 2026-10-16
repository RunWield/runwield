/**
 * @module shared/session/agent-switching
 * Adapter-neutral active Agent switch transaction.
 */

import { createAgentHandler } from "./agent-handler.js";
import { readPersistedActiveAgentName, readPersistedManualModelState } from "./active-agent-session.js";
import { getAgentBusyLines, normalizeAgentInternalName } from "./agents.js";
import {
    appendDebugLog,
    clearAgentSessionQueueForTransition,
    ensureRootAgentSession,
    getConfiguredAgentModel,
    getRootSessionSwitchState,
    markRootAgentSwitch,
    runRootTurn,
    shouldReuseExistingRootSession,
} from "./session.js";
import { emitHostedSessionRuntimeEvent, RuntimeEventTypes } from "./session-runtime-events.js";
import {
    claimWorkflowToolEvent,
    listPendingWorkflowToolEvents,
    settleWorkflowToolEvent,
    waitForWorkflowToolEvent,
    WorkflowStepCompleted,
} from "../workflow/workflow-tool-events.ts";

/** @type {WeakMap<import('./hosted-session.js').HostedSession, { agentName: string, model?: string, cwd?: string }>} */
const switchMetadata = new WeakMap();

/** @type {WeakMap<Function, { agentName: string }>} */
const handlerMetadata = new WeakMap();

/**
 * @typedef {Object} AgentSwitchOptions
 * @property {string} agentName
 * @property {string} [model]
 * @property {import('./hosted-session.js').ThinkingLevel} [thinkingLevelOverride]
 * @property {string} [cwd]
 * @property {Array<{base64: string, mimeType: string}>} [images]
 * @property {boolean} [forceRebuild]
 * @property {boolean} [reloadMcpTools]
 * @property {import('@earendil-works/pi-coding-agent').SessionManager} [sessionManager]
 * @property {import('../../tools/plan-written.ts').TriageMeta} [triageMeta]
 * @property {{ id: import('./subagent-definitions.ts').SubAgentDefinitionId, options?: import('./subagent-definitions.ts').LoadSubAgentDefinitionOptions }} [subAgentDefinition]
 * @property {import('@earendil-works/pi-coding-agent').ToolDefinition[]} [customTools]
 * @property {import('@earendil-works/pi-coding-agent').ToolDefinition[]} [mcpRootTools]
 * @property {import('../mcp/integration.ts').McpIntegration} [mcpIntegration]
 * @property {string[]} [toolNames]
 * @property {string} [projectStateContext]
 * @property {boolean} [includeEditFallback]
 * @property {string} [debugLogPath]
 * @property {boolean} [releaseActiveWorkflow]
 * @property {import('./managed-operation.ts').ManagedOperationCapability} [managedOperationCapability]
 * @property {import('../mcp/config.ts').McpServerDefinition[]} [mcpServers]
 */

/**
 * @param {import('./hosted-session.js').HostedSession} hostedSession
 * @param {string} agentName
 */
function releaseActiveWorkflowAfterUserSwitch(hostedSession, agentName) {
    const workflow = hostedSession.getActiveExecutionWorkflow?.() || null;
    if (!workflow) return;
    const planName = typeof workflow.planName === "string" && workflow.planName ? workflow.planName : "quick-fix";
    hostedSession.clearActiveExecutionWorkflow();
    const target = agentName || hostedSession.getRootAgentName() || "the selected Agent";
    const message = planName === "quick-fix"
        ? `User switched to ${target}; QUICK_FIX workflow ownership was released. There is no resumable Plan, and working-tree edits remain in place.`
        : `User switched to ${target}; planned workflow ownership for ${planName} was released. Plan and worktree recovery evidence remain available through /load-plan.`;
    emitHostedSessionRuntimeEvent(hostedSession, {
        type: RuntimeEventTypes.SYSTEM_STATUS,
        level: "info",
        message,
    });
}

/**
 * Switch a HostedSession's root Agent as one completed transaction.
 * The target root Agent Session is built before the active handler is replaced,
 * so construction failures leave the previous root/handler pair intact.
 *
 * @param {import('./hosted-session.js').HostedSession} hostedSession
 * @param {AgentSwitchOptions} options
 * @returns {Promise<{ ok: true, agentName: string, model?: string, changed: boolean }>}
 */
export async function switchActiveAgent(hostedSession, options) {
    if (!hostedSession) throw new Error("switchActiveAgent requires a HostedSession");
    hostedSession.assertActive();
    const managedOperationCapability = options.managedOperationCapability ||
        hostedSession.getManagedOperationCapability?.() || undefined;
    const agentName = String(options?.agentName || "").trim();
    if (!agentName) throw new Error("switchActiveAgent requires an agentName");
    const activeTransitionId = hostedSession.getAgentTransitionId?.() || null;
    const ownsTransition = !activeTransitionId;
    const transitionId = activeTransitionId || hostedSession.beginAgentTransition();
    const completeOwnedTransition = () => {
        if (ownsTransition) hostedSession.completeAgentTransition(transitionId);
    };

    const previousAgentName = hostedSession.getRootAgentName();
    const previousHandler = hostedSession.getActiveOnMessage();
    const previousRootSession = hostedSession.getRootAgentSession();
    const activeModelState = hostedSession.getActiveModelState?.() || { model: "" };
    const rootSwitchState = getRootSessionSwitchState(hostedSession);
    const previousSwitch = switchMetadata.get(hostedSession);
    const effectiveModel = rootSwitchState?.model ?? previousSwitch?.model ?? activeModelState.model;
    const sessionManager = options.sessionManager || hostedSession.getRootSessionManager?.() || undefined;
    const persistedAgentName = readPersistedActiveAgentName(sessionManager);
    const selectionAgent = previousAgentName || persistedAgentName || hostedSession.getActiveAgentInfo?.()?.agentName;
    const changesAgent = !!selectionAgent &&
        normalizeAgentInternalName(selectionAgent) !== normalizeAgentInternalName(agentName);
    const inheritedManualModel = (() => {
        if (!changesAgent && hostedSession.isUserModelOverride?.()) {
            return activeModelState.provider && !activeModelState.model.startsWith(`${activeModelState.provider}/`)
                ? `${activeModelState.provider}/${activeModelState.model}`
                : activeModelState.model;
        }
        const persisted = readPersistedManualModelState(sessionManager, agentName);
        if (!persisted) return undefined;
        return persisted.provider ? `${persisted.provider}/${persisted.model}` : persisted.model;
    })();
    const modelOverride = options.model ?? inheritedManualModel;
    const cwdProvided = Object.hasOwn(options, "cwd") && typeof options.cwd === "string" && options.cwd.length > 0;
    const requestedCwd = cwdProvided ? String(options.cwd) : "";
    const configuredModel = modelOverride === undefined
        ? getConfiguredAgentModel(agentName, requestedCwd || hostedSession.cwd)
        : undefined;
    const requestedModel = modelOverride ?? configuredModel;
    const modelChanged = requestedModel !== undefined && requestedModel !== effectiveModel;
    const effectiveCwd = rootSwitchState?.cwd ?? previousSwitch?.cwd ?? hostedSession.cwd;
    const cwdChanged = cwdProvided && options.cwd !== effectiveCwd;
    const customRootConfigurationProvided = Boolean(
        options.subAgentDefinition || options.customTools || options.mcpRootTools || options.toolNames ||
            options.triageMeta ||
            options.projectStateContext !== undefined || options.includeEditFallback !== undefined ||
            options.debugLogPath,
    );
    const rootOptions = {
        agentName,
        modelOverride,
        thinkingLevelOverride: options.thinkingLevelOverride,
        cwd: requestedCwd || effectiveCwd,
        sessionManager: options.sessionManager,
        images: options.images,
        triageMeta: options.triageMeta,
        subAgentDefinition: options.subAgentDefinition,
        customTools: options.customTools,
        mcpRootTools: options.mcpRootTools,
        mcpIntegration: options.mcpIntegration,
        toolNames: options.toolNames,
        projectStateContext: options.projectStateContext,
        includeEditFallback: options.includeEditFallback,
        debugLogPath: options.debugLogPath,
        managedOperationCapability,
    };
    const canReuseRoot = previousRootSession && !options.forceRebuild && !modelChanged &&
        !cwdChanged && !customRootConfigurationProvided &&
        shouldReuseExistingRootSession({ agentName }, previousAgentName);
    const shouldRebuildRoot = !canReuseRoot;
    const nextMetadata = {
        agentName,
        model: requestedModel ?? effectiveModel,
        cwd: requestedCwd || effectiveCwd,
    };
    const previousHandlerMetadata = typeof previousHandler === "function" ? handlerMetadata.get(previousHandler) : null;
    const canReuseHandler = Boolean(
        previousHandler && previousHandlerMetadata &&
            previousHandlerMetadata.agentName === agentName &&
            !customRootConfigurationProvided,
    );

    if (!shouldRebuildRoot && canReuseHandler) {
        completeOwnedTransition();
        if (options.releaseActiveWorkflow) releaseActiveWorkflowAfterUserSwitch(hostedSession, agentName);
        return { ok: true, agentName, model: options.model, changed: false };
    }

    // Stage the matching handler before the root builder can commit a
    // replacement. A handler-factory failure therefore leaves the previous
    // root/handler pair untouched.
    let handler;
    try {
        handler = createAgentHandler(agentName, {
            hostedSession,
            customTools: options.customTools,
        });
    } catch (error) {
        completeOwnedTransition();
        throw error;
    }
    handlerMetadata.set(handler, {
        agentName,
    });

    if (shouldRebuildRoot) {
        try {
            await ensureRootAgentSession({
                hostedSession,
                ...rootOptions,
                activeHandler: handler,
            });
        } catch (error) {
            completeOwnedTransition();
            throw error;
        }
        if (hostedSession.getActiveOnMessage() !== handler) {
            completeOwnedTransition();
            throw new Error("switchActiveAgent: root builder did not atomically commit the staged Agent handler");
        }
    } else {
        hostedSession.setActiveOnMessage(handler);
    }
    completeOwnedTransition();
    hostedSession.assertActive();
    if (requestedCwd) hostedSession.rebindProjectRoot(requestedCwd);
    // Clear only after a successful switch; a failed build must preserve the
    // previous Agent and its manual model selection.
    if (changesAgent) {
        hostedSession.clearUserModelOverride();
        if (hostedSession.getPendingManagedTurnIntent().manualModel) {
            hostedSession.mergePendingManagedTurnIntent({ model: "", provider: "", manualModel: false });
        }
    }
    switchMetadata.set(hostedSession, nextMetadata);
    const changed = shouldRebuildRoot || previousAgentName !== agentName || !canReuseHandler;
    if (changed) {
        appendDebugLog(
            options.debugLogPath,
            [
                "",
                "========================================",
                "Event: AGENT SWITCH",
                `Timestamp: ${new Date().toISOString()}`,
                `From Agent: ${previousAgentName || "(none)"}`,
                `To Agent: ${agentName}`,
                `Root Session: ${shouldRebuildRoot ? "REBUILT" : "REUSED"}`,
                `Handler: ${canReuseHandler ? "REUSED" : "REPLACED"}`,
                "The next user turn is the first turn after this switch.",
                "========================================",
                "",
            ].join("\n"),
        );
        markRootAgentSwitch(hostedSession, {
            agentName,
            debugLogPath: options.debugLogPath,
        });
        const committedAgentName = hostedSession.getRootAgentName() || agentName;
        const committedDisplayName = hostedSession.getActiveAgentInfo?.()?.displayName || committedAgentName;
        // An explicit /agent request can switch away from a prompt-ready shell
        // before it has a durable root. Ordinary first activation stays silent
        // because there is no selected Agent identity yet.
        const previousRootIdentity = previousAgentName || persistedAgentName || selectionAgent || "";
        const rootHandoff = Boolean(previousRootIdentity) &&
            normalizeAgentInternalName(previousRootIdentity) !== normalizeAgentInternalName(committedAgentName);
        const committedBusyLines = getAgentBusyLines(committedAgentName, hostedSession.cwd);
        emitHostedSessionRuntimeEvent(hostedSession, {
            type: RuntimeEventTypes.AGENT_CHANGED,
            agentName: committedAgentName,
            displayName: committedDisplayName,
            model: options.model,
            ...(rootHandoff ? { rootHandoff: true } : {}),
            ...(committedBusyLines ? { busyLines: committedBusyLines } : {}),
        });
    }
    if (options.releaseActiveWorkflow) releaseActiveWorkflowAfterUserSwitch(hostedSession, agentName);
    return { ok: true, agentName, model: options.model, changed };
}

/**
 * @typedef {Object} ActiveAgentTurnOptions
 * @property {import('./hosted-session.js').HostedSession} hostedSession
 * @property {string} agentName
 * @property {string} userRequest
 * @property {Array<{base64: string, mimeType: string}>} [images]
 * @property {import('@earendil-works/pi-coding-agent').SessionManager} [sessionManager]
 * @property {import('../../tools/plan-written.ts').TriageMeta} [triageMeta]
 * @property {string} [model]
 * @property {string} [cwd]
 * @property {boolean} [forceRebuild]
 * @property {{ id: import('./subagent-definitions.ts').SubAgentDefinitionId, options?: import('./subagent-definitions.ts').LoadSubAgentDefinitionOptions }} [subAgentDefinition]
 * @property {import('@earendil-works/pi-coding-agent').ToolDefinition[]} [customTools]
 * @property {string[]} [toolNames]
 * @property {string} [projectStateContext]
 * @property {boolean} [includeEditFallback]
 * @property {string} [debugLogPath]
 * @property {import('./request-dispatch.ts').RequestDispatchKind} [dispatchKind]
 * @property {boolean} [resumePreviousRequest] True when continuing the preceding failed or interrupted request.
 * @property {string} [taskId] Stable identity for the controller-owned task being continued.
 * @property {AbortSignal} [signal]
 */

/**
 * Activate an Agent and run its root turn without exposing a state where the
 * root session and interactive handler belong to different Agents.
 *
 * @param {ActiveAgentTurnOptions} options
 * @returns {Promise<import('@earendil-works/pi-agent-core').AgentMessage[]>}
 */
export async function runActiveAgentTurn(options) {
    const {
        hostedSession,
        agentName,
        userRequest,
        images,
        sessionManager,
        triageMeta,
        model,
        cwd,
        forceRebuild,
        subAgentDefinition,
        customTools,
        toolNames,
        projectStateContext,
        includeEditFallback,
        debugLogPath,
        dispatchKind,
        resumePreviousRequest,
        taskId,
        signal,
    } = options;

    const switchOptions = {
        agentName,
        ...(model !== undefined ? { model } : {}),
        ...(cwd ? { cwd } : {}),
        ...(forceRebuild ? { forceRebuild } : {}),
        ...(sessionManager ? { sessionManager } : {}),
        ...(images ? { images } : {}),
        ...(triageMeta ? { triageMeta } : {}),
        ...(subAgentDefinition ? { subAgentDefinition } : {}),
        ...(customTools ? { customTools } : {}),
        ...(toolNames ? { toolNames } : {}),
        ...(projectStateContext !== undefined ? { projectStateContext } : {}),
        ...(includeEditFallback !== undefined ? { includeEditFallback } : {}),
        ...(debugLogPath ? { debugLogPath } : {}),
    };
    signal?.throwIfAborted();
    await switchActiveAgent(hostedSession, switchOptions);
    signal?.throwIfAborted();
    return await runRootTurn({
        hostedSession,
        agentName,
        userRequest,
        images,
        dispatchKind,
        resumePreviousRequest,
        taskId,
        signal,
    });
}

/**
 * @typedef {{ dispose?: () => void | Promise<void>, agent?: { state?: { messages?: import('@earendil-works/pi-agent-core').AgentMessage[] } } }} RootAgentSessionState
 */

/**
 * @typedef {Object} RootWorkflowTurnOptions
 * @property {import('./hosted-session.js').HostedSession} hostedSession
 * @property {string} agentName
 * @property {string} userRequest
 * @property {import('./types.js').ImageAttachment[]} [images]
 * @property {import('@earendil-works/pi-coding-agent').ToolDefinition[]} [customTools]
 * @property {RootAgentSessionState | null} rootAgentSession
 * @property {AbortSignal} [signal]
 */

/**
 * @param {RootWorkflowTurnOptions} args
 * @returns {Promise<{ messages: import('@earendil-works/pi-agent-core').AgentMessage[], event: import('../workflow/workflow-tool-events.ts').WorkflowToolEvent | null }>}
 */
export async function runRootTurnUntilRootWorkflowEvent(args) {
    const waitController = new AbortController();
    const turnController = new AbortController();
    const abortBoth = () => {
        const reason = args.signal?.reason || new DOMException("Root workflow turn canceled.", "AbortError");
        waitController.abort(reason);
        turnController.abort(reason);
    };
    if (args.signal?.aborted) abortBoth();
    args.signal?.addEventListener("abort", abortBoth, { once: true });

    /** @type {{ kinds: import("../workflow/workflow-tool-events.ts").WorkflowToolEventKind[], owningSession: RootAgentSessionState | null, excludeEventIds: string[] }} */
    const claimOptions = {
        kinds: ["triage_report", "plan_written"],
        owningSession: args.rootAgentSession,
        excludeEventIds: listPendingWorkflowToolEvents(args.hostedSession).map((event) => event.eventId),
    };
    const eventPromise = waitForWorkflowToolEvent(args.hostedSession, {
        ...claimOptions,
        signal: waitController.signal,
    });
    const turnPromise = runRootTurn({
        hostedSession: args.hostedSession,
        agentName: args.agentName,
        userRequest: args.userRequest,
        images: args.images,
        customTools: args.customTools,
        signal: turnController.signal,
    });

    try {
        const first = await Promise.race([
            eventPromise.then((event) => ({ kind: /** @type {const} */ ("event"), event })),
            turnPromise.then((messages) => ({ kind: /** @type {const} */ ("turn"), messages })),
        ]);
        /** @param {import('../workflow/workflow-tool-events.ts').WorkflowToolEvent} event */
        const stopForTerminalEvent = async (event) => {
            if (!args.hostedSession.isAgentTransitioning()) args.hostedSession.beginAgentTransition();
            try {
                clearAgentSessionQueueForTransition(args.rootAgentSession);
            } catch (error) {
                turnController.abort(new WorkflowStepCompleted());
                await turnPromise.catch(() => undefined);
                const transitionId = args.hostedSession.getAgentTransitionId();
                if (transitionId) args.hostedSession.completeAgentTransition(transitionId);
                throw error;
            }
            turnController.abort(new WorkflowStepCompleted());
            await turnPromise.catch(() => undefined);
            return { messages: [], event };
        };
        if (first.kind === "event") {
            if (
                first.event.kind === "plan_written" &&
                (/** @type {import("../workflow/workflow-tool-events.ts").PlanWrittenEventPayload} */ (first.event
                        .payload)).outcome === "feedback"
            ) {
                let feedbackEvent = first.event;
                const excludedEventIds = [...claimOptions.excludeEventIds, feedbackEvent.eventId];
                while (true) {
                    const feedbackWaitController = new AbortController();
                    const nextEventPromise = waitForWorkflowToolEvent(args.hostedSession, {
                        ...claimOptions,
                        excludeEventIds: excludedEventIds,
                        signal: feedbackWaitController.signal,
                    });
                    try {
                        const next = await Promise.race([
                            nextEventPromise.then((event) => ({ kind: /** @type {const} */ ("event"), event })),
                            turnPromise.then((messages) => ({ kind: /** @type {const} */ ("turn"), messages })),
                        ]);
                        if (next.kind === "turn") return { messages: next.messages, event: feedbackEvent };
                        excludedEventIds.push(next.event.eventId);
                        if (
                            next.event.kind === "plan_written" &&
                            (/** @type {import("../workflow/workflow-tool-events.ts").PlanWrittenEventPayload} */ (next
                                    .event.payload)).outcome === "feedback"
                        ) {
                            settleWorkflowToolEvent(args.hostedSession, feedbackEvent);
                            feedbackEvent = next.event;
                            continue;
                        }
                        settleWorkflowToolEvent(args.hostedSession, feedbackEvent);
                        return await stopForTerminalEvent(next.event);
                    } finally {
                        feedbackWaitController.abort();
                        await nextEventPromise.catch(() => undefined);
                    }
                }
            }
            return await stopForTerminalEvent(first.event);
        }
        waitController.abort(new DOMException("Agent turn finished without root workflow event.", "AbortError"));
        const waitedEvent = await eventPromise.catch(() => null);
        return {
            messages: first.messages,
            event: waitedEvent || claimWorkflowToolEvent(args.hostedSession, claimOptions),
        };
    } finally {
        waitController.abort();
        await eventPromise.catch(() => undefined);
        args.signal?.removeEventListener("abort", abortBoth);
    }
}
