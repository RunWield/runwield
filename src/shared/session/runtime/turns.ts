import { AGENTS } from "../../../constants.js";
import { abortActiveSession as abortActiveSessionFn, steerRootSessionWithTarget } from ".././session.js";
import { formatBackgroundTaskCompletion } from "../background-tasks.ts";
import type { BackgroundTaskStatus } from "../background-tasks.ts";
import { resolveNamedInvocation, withNamedInvocationDisplayMessage } from ".././named-invocation.ts";
import { getRuntimeErrorMessage, RuntimeEventTypes } from ".././session-runtime-events.js";
import { rollSessionTranscriptSegment } from ".././segment-rollover.ts";
import { promptTemplateWorkflowConflict, resolvePromptTemplateSettings } from "../prompt-template-settings.ts";
import { recordManualModelSelection } from "../active-agent-session.js";
import { getAgentDisplayName } from "../agents.js";
import { requestHostedSessionInteraction, RuntimeInteractionTypes } from ".././session-runtime-interactions.js";

import {
    getRuntimeRootAgentSession,
    imageReferencesForNamedInvocation,
    isRuntimeRootSessionManager,
    SessionTurnInProgressError,
} from "./support.ts";
import { isManagedOperationFailure } from "./types.ts";
import type { PromptSessionOptions, PromptTurnContext } from "./types.ts";
import { SlashCommandMetricsTracker } from "../../workflow/command-metrics.ts";

interface TaskTranscriptEntry {
    type?: string;
    message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
}

interface PromptSessionResult {
    ok: boolean;
    turns: number;
    error?: string;
    replacementSessionId?: string;
    templateNewSession?: boolean;
    _validationResult?: import("./workflows.ts").RuntimeValidationResult | null;
    namedInvocation?: {
        kind: string;
        name: string;
        expansionDigest: string;
        profile: import("../named-invocation.ts").NamedInvocationPayload["profile"];
        messageCount: number;
    };
}

interface UserPromptResult extends PromptSessionResult {
    managed: boolean;
    submittedRequest: string;
    restoreDraft: boolean;
    historyText?: string;
}

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";
import type { RuntimeQueues } from "./queues.ts";
import type { RuntimeImages } from "./images.ts";
import type { RuntimeAgentSettings } from "./agent-settings.ts";
import type { RuntimeManagedSync } from "./managed-sync.ts";
import type { RuntimeWorkflows } from "./workflows.ts";

type RuntimeEventsDependency = Pick<RuntimeEvents, "beginBusyOperation" | "emitSessionEvent" | "endBusyOperation">;
type RuntimeLifecycleDependency = Pick<
    RuntimeLifecycle,
    "hasPendingProject" | "materializeDeferredManagedShell" | "createInteractiveSession"
>;
type RuntimeManagedOperationsDependency = Pick<
    RuntimeManagedOperations,
    "currentCapability" | "hasOperation" | "runManagedOperation"
>;
type RuntimeQueuesDependency = Pick<
    RuntimeQueues,
    "clearQueuedMessagesInternal" | "reconcileQueuedMessageSources" | "removeBackgroundSteering"
>;
type RuntimeImagesDependency = Pick<
    RuntimeImages,
    "persistPendingPromptImages" | "preflightSessionImages" | "preflightUserTurnImages"
>;
type RuntimeAgentSettingsDependency = Pick<
    RuntimeAgentSettings,
    "alignActiveExecutionWorkflowOwner" | "activateSessionAgent" | "setSessionThinkingLevel"
>;
type RuntimeManagedSyncDependency = Pick<RuntimeManagedSync, "synchronizeManagedSession">;
type RuntimeWorkflowsDependency = Pick<
    RuntimeWorkflows,
    "continueEpicAfterValidation" | "runSemanticRepairSegmentHandoff"
>;

// Only a runtime that owns a Session can have queued background steering for it.
const backgroundSteeringOwners = new WeakMap<import("../hosted-session.js").HostedSession, RuntimeTurns>();

export async function clearBackgroundSteeringForCompletion(
    session: import("../hosted-session.js").HostedSession,
): Promise<void> {
    await backgroundSteeringOwners.get(session)?.clearBackgroundSteering(session);
}

export class RuntimeTurns {
    private events!: RuntimeEventsDependency;
    private lifecycle!: RuntimeLifecycleDependency;
    private managedOperations!: RuntimeManagedOperationsDependency;
    private queues!: RuntimeQueuesDependency;
    private images!: RuntimeImagesDependency;
    private settings!: RuntimeAgentSettingsDependency;
    private sync!: RuntimeManagedSyncDependency;
    private workflows!: RuntimeWorkflowsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        lifecycle: RuntimeLifecycleDependency,
        managedOperations: RuntimeManagedOperationsDependency,
        queues: RuntimeQueuesDependency,
        images: RuntimeImagesDependency,
        settings: RuntimeAgentSettingsDependency,
        sync: RuntimeManagedSyncDependency,
        workflows: RuntimeWorkflowsDependency,
    ) {
        this.events = events;
        this.lifecycle = lifecycle;
        this.managedOperations = managedOperations;
        this.queues = queues;
        this.images = images;
        this.settings = settings;
        this.sync = sync;
        this.workflows = workflows;
    }
    private turnSettlements = new Map<string, Promise<void>>();
    private resultDrains = new Map<string, Promise<void>>();
    private resultAcquisitions = new Set<string>();
    private steeringResults = new Map<string, {
        taskId: string;
        text: string;
        target: import("@earendil-works/pi-coding-agent").AgentSession;
        queueIndex: number | null;
        queueLength: number;
        unsubscribe: () => void;
    }>();
    private steeringInFlight = new Map<
        string,
        Promise<import("@earendil-works/pi-coding-agent").AgentSession | null>
    >();
    private steeringCleanup = new Map<string, Promise<void>>();

    clearBackgroundSteering(session: import("../hosted-session.js").HostedSession): Promise<void> {
        const existing = this.steeringCleanup.get(session.id);
        if (existing) return existing;
        const cleanup = (async () => {
            await this.steeringInFlight.get(session.id)?.catch(() => null);
            const steering = this.steeringResults.get(session.id);
            if (!steering) return;
            steering.unsubscribe();
            if (steering.queueIndex !== null && steering.queueIndex >= 0) {
                await this.queues.removeBackgroundSteering(session, steering.target, steering.queueIndex);
            }
            this.steeringResults.delete(session.id);
        })();
        this.steeringCleanup.set(session.id, cleanup);
        void cleanup.finally(() => {
            if (this.steeringCleanup.get(session.id) === cleanup) this.steeringCleanup.delete(session.id);
        }).catch(() => {});
        return cleanup;
    }

    /** Register once on the owning HostedSession; it remains registered after root dehydrate. */
    registerBackgroundDelivery(sessionId: string): void {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return;
        backgroundSteeringOwners.set(session, this);
        session.backgroundTasks.setCompletionHandler((status) => {
            this.events.emitSessionEvent(sessionId, {
                type: RuntimeEventTypes.BACKGROUND_TASK_SETTLED,
                taskId: status.task_id,
                state: status.state,
            });
            this.scheduleBackgroundResultDrain(sessionId);
        });
    }

    private scheduleBackgroundResultDrain(sessionId: string): void {
        if (this.resultDrains.has(sessionId)) return;
        const drain = this.drainBackgroundResults(sessionId).finally(() => {
            if (this.resultDrains.get(sessionId) === drain) this.resultDrains.delete(sessionId);
        });
        this.resultDrains.set(sessionId, drain);
    }

    /** A recorded root input is stronger evidence than a lost queue notification. */
    reconcileBackgroundResultConsumption(session: import("../hosted-session.js").HostedSession): void {
        const steering = this.steeringResults.get(session.id);
        if (!steering) return;
        const manager = session.getRootSessionManager();
        const entries = (manager?.getEntries?.() || []) as TaskTranscriptEntry[];
        const recorded = entries.some((entry) =>
            entry.type === "message" && entry.message?.role === "user" &&
            (typeof entry.message.content === "string"
                ? entry.message.content === steering.text
                : Array.isArray(entry.message.content) &&
                    entry.message.content.some((block) => block.type === "text" && block.text === steering.text))
        );
        if (recorded && steering.queueIndex !== null && steering.queueIndex < 0) {
            session.backgroundTasks.acknowledge(steering.taskId);
            steering.unsubscribe();
            this.steeringResults.delete(session.id);
        }
    }

    private async drainBackgroundResults(sessionId: string): Promise<void> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return;
        const tasks = session.backgroundTasks;
        while (!session.disposed && tasks.pendingCompletions().length > 0) {
            const result: BackgroundTaskStatus = tasks.pendingCompletions()[0];
            const id = result.task_id;
            if (this.managedOperations.hasOperation(sessionId) || session.isTurnActive()) {
                const root = getRuntimeRootAgentSession(session);
                if (root?.isStreaming && !this.steeringResults.has(sessionId)) {
                    const text = formatBackgroundTaskCompletion(result);
                    const delivery = steerRootSessionWithTarget(session, text, undefined, (steeringTarget) => {
                        const manager = session.getRootSessionManager();
                        manager?.appendCustomEntry?.("runwield.background_task_steering", { taskId: id, text });
                        const initialLength = steeringTarget.getSteeringMessages().length;
                        const unsubscribe = steeringTarget.subscribe((event) => {
                            if (event.type !== "queue_update") return;
                            const steering = this.steeringResults.get(sessionId);
                            if (!steering || !event.steering) return;
                            if (steering.queueIndex === null && event.steering.length > steering.queueLength) {
                                steering.queueIndex = event.steering.length - 1;
                            } else if (steering.queueIndex !== null && event.steering.length < steering.queueLength) {
                                steering.queueIndex -= steering.queueLength - event.steering.length;
                            }
                            steering.queueLength = event.steering.length;
                            this.reconcileBackgroundResultConsumption(session);
                        });
                        this.steeringResults.set(sessionId, {
                            taskId: id,
                            text,
                            target: steeringTarget,
                            queueIndex: null,
                            queueLength: initialLength,
                            unsubscribe,
                        });
                    }).catch(() => null);
                    this.steeringInFlight.set(sessionId, delivery);
                    const target = await delivery;
                    if (this.steeringInFlight.get(sessionId) === delivery) this.steeringInFlight.delete(sessionId);
                    // Consumption may complete inside steer(), before it returns or emits a queue update.
                    this.reconcileBackgroundResultConsumption(session);
                    if (!target) {
                        this.steeringResults.get(sessionId)?.unsubscribe();
                        this.steeringResults.delete(sessionId);
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
            }
            this.reconcileBackgroundResultConsumption(session);
            await this.clearBackgroundSteering(session);
            if (!tasks.pendingCompletions().some((pending) => pending.task_id === id)) continue;
            const managed = session.getManagedMetadata();
            if (!managed) return;
            try {
                await this.sync.synchronizeManagedSession(sessionId, { emitEvents: false });
                const current = session.getManagedMetadata() || managed;
                const expectedGeneration = current.acknowledgedGeneration ?? current.generation ?? null;
                if (!tasks.pendingCompletions().some((pending) => pending.task_id === id)) continue;
                this.resultAcquisitions.add(sessionId);
                const outcome = await this.promptManagedSession(sessionId, {
                    initialRequest: formatBackgroundTaskCompletion(result),
                    initialImages: [],
                    generatedTaskId: id,
                    expectedGeneration,
                    onGeneratedTurnAccepted: () => tasks.acknowledge(id),
                });
                if (!outcome.ok) await new Promise((resolve) => setTimeout(resolve, 300));
            } catch {
                // An active competing writer or transient activation failure is retried locally.
                await new Promise((resolve) => setTimeout(resolve, 300));
            } finally {
                this.resultAcquisitions.delete(sessionId);
            }
        }
    }

    async awaitSettlement(sessionId: string) {
        await this.turnSettlements.get(sessionId);
    }

    promptUserTurn(sessionId: string, options: PromptSessionOptions): Promise<UserPromptResult> {
        return this.promptUserTurnWithCommand(sessionId, options, null);
    }

    private async promptUserTurnWithCommand(
        sessionId: string,
        options: PromptSessionOptions,
        parentCommandTracker: SlashCommandMetricsTracker | null,
    ): Promise<UserPromptResult> {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) throw new Error("SessionRuntime.promptUserTurn: session not found");
        const namedInvocation = await resolveNamedInvocation({
            cwd: hostedSession.cwd,
            text: options.initialRequest,
            images: options.initialImages || [],
        });
        if (namedInvocation.kind === "prompt_template") {
            const pending = hostedSession.getPendingManagedTurnIntent();
            const selectedAgent = pending.agentName || hostedSession.getActiveAgentInfo()?.agentName ||
                hostedSession.getManagedMetadata()?.activeAgent;
            if (!namedInvocation.agentName || namedInvocation.agentName === selectedAgent) {
                namedInvocation.thinkingLevel ||= pending.thinkingLevel;
            }
            namedInvocation.agentName ||= pending.agentName;
            if (!namedInvocation.model && !namedInvocation.agentName && pending.manualModel && pending.model) {
                namedInvocation.model = pending.provider ? `${pending.provider}/${pending.model}` : pending.model;
            }
            if (!namedInvocation.agentName && options.agentName && options.agentName !== AGENTS.ROUTER) {
                namedInvocation.agentName = options.agentName;
            }
        }
        const submittedRequest = options.initialRequest;
        let displayRequest = submittedRequest;
        if (namedInvocation.kind === "prompt_template") displayRequest = namedInvocation.expandedRequest;
        if (namedInvocation.kind === "skill") displayRequest = namedInvocation.payload.compactInvocation;
        let preparedModelOverride = options.preparedModelOverride;
        if ((options.initialImages || []).length > 0) {
            const imagePreflight = await this.images.preflightUserTurnImages(sessionId, options);
            if (!imagePreflight.ok) throw new Error(imagePreflight.message);
            if ("preparedModelOverride" in imagePreflight) {
                preparedModelOverride ||= imagePreflight.preparedModelOverride;
            }
        }
        let managed = hostedSession.getManagedMetadata?.() || null;
        const isDeferredFirstTurn = !managed && this.lifecycle.hasPendingProject(sessionId);
        const deferredFirstTurnId = isDeferredFirstTurn ? crypto.randomUUID() : "";
        let deferredBusyStarted = false;
        if (isDeferredFirstTurn) {
            const hasInitialImages = (options.initialImages || []).length > 0;
            if (!hasInitialImages && namedInvocation.kind !== "prompt_template") {
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.USER_MESSAGE,
                    turnId: deferredFirstTurnId,
                    text: displayRequest,
                    images: (options.initialImages || []).map((image) => ({ ...image })),
                });
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.TURN_START,
                    turnId: deferredFirstTurnId,
                });
                this.events.beginBusyOperation(sessionId, deferredFirstTurnId);
                deferredBusyStarted = true;
            }
            const activeAgentInfo = hostedSession.getActiveAgentInfo?.() || null;
            const agentName = options.agentName || activeAgentInfo?.agentName || AGENTS.ROUTER;
            if (namedInvocation.kind !== "prompt_template") {
                hostedSession.mergePendingManagedTurnIntent?.({ agentName });
            }
            // Give presentation adapters one event-loop turn to paint the user
            // message and first busy frame before filesystem/session setup begins.
            await new Promise((resolve) => setTimeout(resolve, 0));
            try {
                managed = await this.lifecycle.materializeDeferredManagedShell(hostedSession);
            } catch (error) {
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.TURN_END,
                    turnId: deferredFirstTurnId,
                    ok: false,
                });
                if (deferredBusyStarted) {
                    this.events.endBusyOperation(sessionId, deferredFirstTurnId);
                    deferredBusyStarted = false;
                }
                throw error;
            }
        }
        if (!managed) throw new Error("SessionRuntime.promptUserTurn: segmented Session metadata is unavailable");
        if (!isDeferredFirstTurn && !this.managedOperations.hasOperation(sessionId)) {
            await this.sync.synchronizeManagedSession(sessionId);
            managed = hostedSession.getManagedMetadata() || managed;
        }
        options = {
            ...options,
            metricsUserInitiated: true,
            inputSurface: options.inputSurface || this.services.ownerProcessKind,
        };
        let cleanupTurnStart: (() => void) | undefined;
        // Keep surface subscriptions alive across a user-approved Session change.
        const onTurnStarted = (context: PromptTurnContext) => {
            const cleanup = options.onTurnStarted?.(context);
            if (typeof cleanup === "function") cleanupTurnStart = cleanup;
        };
        const requestOptions = deferredFirstTurnId
            ? {
                ...options,
                onTurnStarted,
                initialRequest: displayRequest,
                preparedModelOverride,
                turnId: deferredFirstTurnId,
                emitInitialEvents: deferredBusyStarted ? false : undefined,
            }
            : { ...options, onTurnStarted, initialRequest: displayRequest, preparedModelOverride };
        const buildResult = (
            result: PromptSessionResult,
        ) => ({
            ...result,
            managed: true,
            submittedRequest,
            restoreDraft: Boolean(result.error),
            ...(result.ok && submittedRequest.trim() ? { historyText: submittedRequest.trim() } : {}),
        });

        const expectedGenerationSource = managed.acknowledgedGeneration ?? managed.generation;
        const expectedGeneration = Number.isSafeInteger(expectedGenerationSource) ? expectedGenerationSource : null;
        let commandTracker: SlashCommandMetricsTracker | null = null;
        if (!parentCommandTracker && (namedInvocation.kind === "prompt_template" || namedInvocation.kind === "skill")) {
            const rawSurface = options.inputSurface || this.services.ownerProcessKind || "cli";
            const surface = rawSurface === "acp" ? "acp" : (rawSurface === "workspace" ? "workspace" : "tui");
            commandTracker = new SlashCommandMetricsTracker({
                command: namedInvocation.name,
                alias: (namedInvocation as { alias?: string }).alias || undefined,
                kind: namedInvocation.kind === "prompt_template" ? "template" : "skill",
                surface,
                projectRoot: hostedSession.cwd,
                sessionId,
            });
            await commandTracker.recordStart();
        }
        const invocationId = (commandTracker || parentCommandTracker)?.invocationId || null;
        if (invocationId) hostedSession.activeCommandInvocationId = invocationId;
        let commandOutcome: "succeeded" | "failed" | "canceled" = "succeeded";
        let commandErrorReason: string | null = null;
        try {
            const result = await this.promptManagedSession(sessionId, {
                ...requestOptions,
                expectedGeneration,
                ...(namedInvocation.kind !== "ordinary"
                    ? {
                        modelRequest: namedInvocation.expandedRequest,
                        namedInvocationPayload: namedInvocation.payload,
                        ...(namedInvocation.kind === "prompt_template" ? { promptTemplate: namedInvocation } : {}),
                    }
                    : {}),
            });
            if (!result.ok) {
                commandOutcome = result.error === "Prompt canceled." ? "canceled" : "failed";
                commandErrorReason = commandOutcome;
            }
            if (result.templateNewSession && namedInvocation.kind === "prompt_template") {
                const created = await this.lifecycle.createInteractiveSession({
                    cwd: hostedSession.cwd,
                    mode: "new",
                    deferManagedActivationUntilAgentReady: true,
                });
                const next = this.services.sessionHost.requireSession(created.sessionId);
                next.setInteractionAdapter(hostedSession.getInteractionAdapter());
                next.notificationSurface = hostedSession.notificationSurface;
                next.localInputSurface = hostedSession.localInputSurface;
                next.setMcpRequestServers(hostedSession.getMcpRequestServers());
                this.events.emitSessionEvent(sessionId, {
                    type: RuntimeEventTypes.SESSION_REPLACED,
                    oldSessionId: sessionId,
                    newSessionId: next.id,
                    reason: "prompt_template",
                    templateName: namedInvocation.name,
                });
                const nextResult = await this.promptUserTurnWithCommand(next.id, {
                    initialRequest: submittedRequest,
                    initialImages: options.initialImages,
                    inputSurface: options.inputSurface,
                }, commandTracker);
                if (!nextResult.ok) {
                    commandOutcome = nextResult.error === "Prompt canceled." ? "canceled" : "failed";
                    commandErrorReason = commandOutcome;
                }
                return { ...nextResult, replacementSessionId: next.id };
            }
            return buildResult(result);
        } catch (error) {
            commandOutcome = "failed";
            commandErrorReason = "failed";
            throw error;
        } finally {
            if (invocationId && hostedSession.activeCommandInvocationId === invocationId) {
                hostedSession.activeCommandInvocationId = null;
            }
            if (commandTracker && !parentCommandTracker) {
                await commandTracker.recordFinish({
                    outcome: commandOutcome,
                    errorReason: commandErrorReason,
                });
            }
            cleanupTurnStart?.();
            if (deferredBusyStarted) this.events.endBusyOperation(sessionId, deferredFirstTurnId);
        }
    }

    async promptManagedSession(
        sessionId: string,
        options: PromptSessionOptions & { expectedGeneration: number | null },
    ): Promise<PromptSessionResult> {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) throw new Error("SessionRuntime.promptManagedSession: session not found");
        const managed = hostedSession.getManagedMetadata?.();
        if (!managed) throw new Error("SessionRuntime.promptManagedSession: segmented Session metadata is unavailable");
        let operationOptions = options;
        if ((options.initialImages || []).length > 0 && !options.preparedModelOverride) {
            const imagePreflight = await this.images.preflightUserTurnImages(sessionId, options);
            if (!imagePreflight.ok) throw new Error(imagePreflight.message);
            operationOptions = {
                ...options,
                preparedModelOverride: "preparedModelOverride" in imagePreflight
                    ? imagePreflight.preparedModelOverride
                    : undefined,
            };
        }
        const result = await this.managedOperations.runManagedOperation(
            sessionId,
            {
                name: "prompt",
                options: operationOptions,
                emitPromptEvents: operationOptions.promptTemplate || operationOptions.emitInitialEvents === false
                    ? false
                    : undefined,
                activateAgent: operationOptions.promptTemplate ? false : undefined,
            },
            async ({ acceptedTurnId, hasPendingImages, capability }) => {
                const template = operationOptions.promptTemplate;
                if (template) {
                    const profile = await resolvePromptTemplateSettings(hostedSession, {
                        ...template,
                        model: operationOptions.preparedModelOverride || template.model,
                    });
                    const conflict = promptTemplateWorkflowConflict(hostedSession, profile.agentName);
                    if (conflict) {
                        const response = await requestHostedSessionInteraction(
                            hostedSession,
                            {
                                type: RuntimeInteractionTypes.SELECT,
                                prompt: `/${template.name} requires ${
                                    getAgentDisplayName(profile.agentName, hostedSession.cwd)
                                }. This session has ${conflict}.`,
                                options: [
                                    { value: "new_session", label: "Open in new session" },
                                    { value: "cancel", label: "Cancel" },
                                ],
                                defaultValue: "cancel",
                            },
                            capability.signal,
                            capability,
                        );
                        if (response.outcome === "selected" && response.value === "new_session") {
                            return { ok: true, turns: 0, templateNewSession: true };
                        }
                        if (response.outcome === "unsupported" || response.outcome === "blocked") {
                            throw new Error(
                                `/${template.name} requires a different Agent during ${conflict}. Open a new session and run /${template.name} there.`,
                            );
                        }
                        return { ok: false, turns: 0, error: "Prompt canceled." };
                    }
                    const previousModel = hostedSession.getActiveModelState();
                    const previousManual = hostedSession.isUserModelOverride();
                    const slash = profile.model.indexOf("/");
                    hostedSession.setActiveModelState(
                        profile.model.slice(slash + 1),
                        profile.model.slice(0, slash),
                        profile.manualModel,
                    );
                    try {
                        await this.settings.activateSessionAgent(hostedSession, {
                            agentName: profile.agentName,
                            model: profile.model,
                            thinkingLevelOverride: profile.thinkingLevel,
                            forceRebuild: true,
                            managedOperationCapability: capability,
                        });
                    } catch (error) {
                        hostedSession.setActiveModelState(previousModel.model, previousModel.provider, previousManual);
                        if (!previousManual) hostedSession.clearUserModelOverride();
                        throw error;
                    }
                    const state = hostedSession.getActiveModelState();
                    this.events.emitSessionEvent(sessionId, {
                        type: RuntimeEventTypes.MODEL_CHANGED,
                        model: state.model,
                        provider: state.provider,
                    });
                    if (profile.manualModel) {
                        hostedSession.setActiveModelState(state.model, state.provider, true);
                        const manager = hostedSession.getRootSessionManager();
                        if (isRuntimeRootSessionManager(manager)) {
                            recordManualModelSelection(manager, state.provider, state.model);
                        }
                    }
                    await this.settings.setSessionThinkingLevel(sessionId, profile.thinkingLevel);
                    template.payload.profile = {
                        agentName: profile.agentName,
                        model: profile.model,
                        thinkingLevel: profile.thinkingLevel,
                    };
                }
                const result = await this.promptSession(sessionId, {
                    ...operationOptions,
                    turnId: acceptedTurnId,
                    onTurnStarted: undefined,
                    emitInitialEvents: template
                        ? true
                        : operationOptions.emitInitialEvents === false
                        ? false
                        : hasPendingImages,
                    suppressEpicContinuation: true,
                    signal: capability.signal,
                }, capability);
                if (template) {
                    result.namedInvocation = {
                        kind: template.kind,
                        name: template.name,
                        expansionDigest: template.payload.expansionDigest,
                        profile: template.payload.profile,
                        messageCount: result.turns,
                    };
                }
                return result;
            },
        );
        if (isManagedOperationFailure(result)) return { ...result, turns: result.turns ?? 0 };
        const validationResult = result._validationResult;
        if (
            result.ok && validationResult?.kind === "semantic_repair_handoff" &&
            validationResult.semanticRepairHandoff
        ) {
            const workflow = hostedSession.getActiveExecutionWorkflow?.() || null;
            result._validationResult = await this.workflows.runSemanticRepairSegmentHandoff(
                hostedSession.id,
                {
                    planName: validationResult.planName || workflow?.planName || options.planName || "",
                    planContent: options.planContent,
                    triageMeta: workflow?.triageMeta || options.triageMeta || {},
                },
                {
                    ...validationResult,
                    kind: "semantic_repair_handoff",
                    semanticRepairHandoff: validationResult.semanticRepairHandoff,
                },
            );
        }
        const settledValidationResult = result._validationResult;
        if (result.ok && settledValidationResult?.epicContinuation) {
            const replacement = await this.workflows.continueEpicAfterValidation(
                hostedSession,
                settledValidationResult,
            );
            if (replacement.sessionId) result.replacementSessionId = replacement.sessionId;
        }
        delete result._validationResult;
        return result;
    }

    async rollManagedSessionSegment(
        sessionId: string,
        options: {
            kind: "execution" | "semantic_repair";
            transcriptCwd?: string;
            continuation: import(".././segment-rollover.ts").SegmentRolloverResult["continuation"];
            expectedGeneration?: number | null;
            lineageGroupKey?: string | null;
        },
    ) {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) throw new Error("SessionRuntime.rollManagedSessionSegment: session not found");
        if (!this.services.sessionStore) throw new Error("Session storage is unavailable");
        return await rollSessionTranscriptSegment({
            hostedSession,
            ownerCoordinationStore: this.services.sessionStore,
            ownerInstanceId: this.services.ownerInstanceId,
            ownerProcessKind: this.services.ownerProcessKind,
            kind: options.kind,
            transcriptCwd: options.transcriptCwd,
            continuation: options.continuation,
            expectedGeneration: options.expectedGeneration,
            lineageGroupKey: options.lineageGroupKey,
        });
    }

    cancelSession(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, aborted: false, error: "not_found" };
        const hasBackgroundWork = session.backgroundTasks.activeCount > 0 ||
            session.backgroundTasks.pendingCompletions().length > 0;
        void session.backgroundTasks.cancelAllAndSuppress();
        session.resetBackgroundCompletionWarning();
        this.steeringResults.get(session.id)?.unsubscribe();
        this.steeringResults.delete(session.id);
        const currentOperation = this.managedOperations.currentCapability(session.id);
        const activeInteractions = session.getActiveInteractions?.() || new Map();
        const onlyPlanReviewInteraction = activeInteractions.size > 0 &&
            [...activeInteractions.values()].every((record) =>
                record.request?.type === RuntimeInteractionTypes.PLAN_REVIEW
            );
        if (currentOperation) {
            let aborted = false;
            let operationCanceled = false;
            let agentCanceled = false;
            const turnActive = session.isTurnActive();
            try {
                if (session.isAgentTransitioning?.() || this.resultAcquisitions.has(session.id)) {
                    currentOperation.cancel?.();
                    operationCanceled = Boolean(currentOperation.cancel);
                }
                operationCanceled = Boolean(session.cancelActiveInteractions?.()) || operationCanceled;
                const rootAgentSession = getRuntimeRootAgentSession(session);
                if (rootAgentSession?.isCompacting && rootAgentSession?.abortCompaction) {
                    rootAgentSession.abortCompaction();
                    operationCanceled = true;
                }
                this.queues.clearQueuedMessagesInternal(session, "session_cancel");
                const transitionId = session.getAgentTransitionId?.();
                if (transitionId) session.completeAgentTransition(transitionId);
                if (!onlyPlanReviewInteraction) {
                    agentCanceled = abortActiveSessionFn(session);
                    if (agentCanceled || turnActive) session.suppressNextAgentStoppedAttention();
                }
                aborted = operationCanceled || agentCanceled || hasBackgroundWork;
            } finally {
                this.events.emitSessionEvent(session.id, {
                    type: RuntimeEventTypes.CANCELLATION,
                    aborted,
                    reason: "session_cancel",
                    ...(aborted
                        ? {
                            scope: operationCanceled ? "operation" : "agent",
                            message: operationCanceled ? "Operation canceled." : "Agent run canceled.",
                        }
                        : {}),
                });
            }
            return { ok: true, aborted };
        }
        if (session.getManagedMetadata?.()) {
            this.events.emitSessionEvent(session.id, {
                type: RuntimeEventTypes.CANCELLATION,
                aborted: hasBackgroundWork,
                reason: "session_cancel",
            });
            return { ok: true, aborted: hasBackgroundWork };
        }
        let aborted = false;
        let operationCanceled = false;
        let agentCanceled = false;
        const turnActive = session.isTurnActive();
        try {
            operationCanceled = Boolean(session.cancelActiveInteractions?.());
            const rootAgentSession = getRuntimeRootAgentSession(session);
            if (rootAgentSession?.isCompacting && rootAgentSession?.abortCompaction) {
                rootAgentSession.abortCompaction();
                operationCanceled = true;
            }
            this.queues.clearQueuedMessagesInternal(session, "session_cancel");
            const transitionId = session.getAgentTransitionId?.();
            if (transitionId) session.completeAgentTransition(transitionId);
            if (!onlyPlanReviewInteraction) {
                agentCanceled = abortActiveSessionFn(session);
                if (agentCanceled || turnActive) session.suppressNextAgentStoppedAttention();
            }
            aborted = operationCanceled || agentCanceled || hasBackgroundWork;
        } finally {
            this.events.emitSessionEvent(session.id, {
                type: RuntimeEventTypes.CANCELLATION,
                aborted,
                reason: "session_cancel",
                ...(aborted
                    ? {
                        scope: operationCanceled ? "operation" : "agent",
                        message: operationCanceled ? "Operation canceled." : "Agent run canceled.",
                    }
                    : {}),
            });
        }
        return { ok: true, aborted };
    }

    async promptSession(
        sessionId: string,
        options: PromptSessionOptions,
        capability: import(".././managed-operation.ts").ManagedOperationCapability | null = null,
    ): Promise<PromptSessionResult> {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) throw new Error("SessionRuntime.promptSession: session not found");
        if (
            (hostedSession.isTurnActive() || this.managedOperations.hasOperation(sessionId)) &&
            capability !== hostedSession.getManagedOperationCapability?.()
        ) {
            throw new SessionTurnInProgressError(hostedSession.id);
        }
        const managed = hostedSession.getManagedMetadata?.() || null;
        if (!managed) throw new Error("SessionRuntime.promptSession: segmented Session metadata is unavailable");
        if (!capability || capability !== hostedSession.getManagedOperationCapability?.()) {
            const expectedGenerationSource = managed.acknowledgedGeneration ?? managed.generation;
            const expectedGeneration = Number.isSafeInteger(expectedGenerationSource) ? expectedGenerationSource : 0;
            return await this.promptManagedSession(sessionId, { ...options, expectedGeneration });
        }
        if (
            options.generatedTaskId &&
            !hostedSession.backgroundTasks.pendingCompletions().some((task) => task.task_id === options.generatedTaskId)
        ) {
            return { ok: false, turns: 0, error: "background_result_cancelled" };
        }
        options.signal?.throwIfAborted();
        const turnId = options.turnId || crypto.randomUUID();
        const emitInitialEvents = options.emitInitialEvents !== false;
        await this.settings.alignActiveExecutionWorkflowOwner(hostedSession);
        if (options.generatedTaskId && !hostedSession.backgroundTasks.isPending(options.generatedTaskId)) {
            return { ok: false, turns: 0, error: "background_result_cancelled" };
        }
        if (!hostedSession.beginTurn(turnId)) throw new SessionTurnInProgressError(hostedSession.id);
        if (!options.generatedTaskId) hostedSession.backgroundTasks.resumeDelivery();
        options.onGeneratedTurnAccepted?.();
        this.registerBackgroundDelivery(sessionId);
        let cleanupTurn = () => {};
        let settleTurn = () => {};
        const turnSettlement = new Promise<void>((resolve) => {
            settleTurn = () => resolve(undefined);
        });
        this.turnSettlements.set(hostedSession.id, turnSettlement);
        const request = options.initialRequest;
        const modelRequest = options.modelRequest || request;
        let images = options.initialImages || [];
        let turns = 0;
        let ok = false;
        let busyStarted = false;
        let validationResult = null;
        const managedCapability = hostedSession.getManagedOperationCapability?.() || null;
        let result: PromptSessionResult | null = null;

        try {
            const imagePreflight = await this.images.preflightSessionImages(sessionId, images);
            if (!imagePreflight.ok) throw new Error(imagePreflight.message);
            if (!options.generatedTaskId) {
                hostedSession.localInputSurface = this.services.ownerProcessKind;
                hostedSession.notificationSurface = options.inputSurface || hostedSession.notificationSurface ||
                    this.services.ownerProcessKind;
            }
            hostedSession.generatedTaskTurnId = options.generatedTaskId || null;
            hostedSession.metricsHumanInputPending = !options.generatedTaskId && options.metricsUserInitiated === true;
            const cleanup = options.onTurnStarted?.({ turnId });
            if (typeof cleanup === "function") cleanupTurn = cleanup;
            images = await this.images.persistPendingPromptImages(hostedSession, images);
            if (options.namedInvocationPayload) {
                options.namedInvocationPayload.imageReferences = imageReferencesForNamedInvocation(images);
            }
            if (emitInitialEvents) {
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.USER_MESSAGE,
                    turnId,
                    ...(options.generatedTaskId
                        ? { origin: "background_task_result", taskId: options.generatedTaskId }
                        : {}),
                    text: request,
                    images: images.map((image) => ({ ...image })),
                });
                this.events.emitSessionEvent(hostedSession.id, { type: RuntimeEventTypes.TURN_START, turnId });
            }
            this.events.beginBusyOperation(hostedSession.id, turnId);
            busyStarted = true;

            if (!hostedSession.getActiveOnMessage() || !hostedSession.getRootSessionManager()) {
                const message = "Error: No active agent handler or session manager.";
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.SYSTEM_STATUS,
                    turnId,
                    level: "error",
                    message,
                });
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.TERMINAL_ERROR,
                    turnId,
                    message,
                    error: "missing_active_handler_or_session_manager",
                });
                result = {
                    ok: false,
                    turns,
                    error: "missing_active_handler_or_session_manager",
                };
                return result;
            }

            const handler = hostedSession.getActiveOnMessage();
            if (!handler) {
                const message = "Error: No active agent handler or session manager.";
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.SYSTEM_STATUS,
                    turnId,
                    level: "error",
                    message,
                });
                result = {
                    ok: false,
                    turns,
                    error: "missing_active_handler_or_session_manager",
                };
                return result;
            }

            const rootSessionManager = hostedSession.getRootSessionManager() || null;
            if (!isRuntimeRootSessionManager(rootSessionManager)) {
                throw new Error("Runtime session manager is unavailable.");
            }
            options.signal?.throwIfAborted();
            if (options.generatedTaskId && !hostedSession.backgroundTasks.canDeliver(options.generatedTaskId)) {
                result = { ok: false, turns, error: "background_result_cancelled" };
                return result;
            }
            const runHandler = async () =>
                await handler(
                    modelRequest,
                    images,
                    rootSessionManager || undefined,
                    options.signal || managedCapability?.signal,
                );
            const turnResult = options.namedInvocationPayload && rootSessionManager
                ? await withNamedInvocationDisplayMessage(
                    rootSessionManager,
                    options.namedInvocationPayload,
                    runHandler,
                )
                : await runHandler();
            turns++;
            validationResult = turnResult?.validationResult || null;
            ok = true;
            result = { ok: true, turns };
            return result;
        } catch (error) {
            if (options.generatedTaskId && error instanceof Error && error.message === "background_result_cancelled") {
                result = { ok: false, turns, error: "background_result_cancelled" };
                return result;
            }
            this.events.emitSessionEvent(hostedSession.id, {
                type: RuntimeEventTypes.TERMINAL_ERROR,
                turnId,
                message: getRuntimeErrorMessage(error),
                error,
            });
            throw error;
        } finally {
            this.queues.reconcileQueuedMessageSources(hostedSession);
            if (
                hostedSession.notificationSurface === "workspace" &&
                hostedSession.agentStoppedAttentionTurnId !== turnId
            ) {
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.ATTENTION_REQUESTED,
                    reason: "agentStopped",
                    agentName: hostedSession.getRootAgentName() || undefined,
                });
            }
            this.events.emitSessionEvent(hostedSession.id, {
                type: RuntimeEventTypes.TURN_END,
                turnId,
                ok,
                result: result || { turns },
            });
            hostedSession.endTurn(turnId);
            hostedSession.generatedTaskTurnId = null;
            hostedSession.metricsHumanInputPending = false;
            if (busyStarted) this.events.endBusyOperation(hostedSession.id, turnId);
            try {
                cleanupTurn();
            } catch {
                // Adapter cleanup must not prevent runtime turn settlement.
            }
            settleTurn();
            if (this.turnSettlements.get(hostedSession.id) === turnSettlement) {
                this.turnSettlements.delete(hostedSession.id);
            }
            if (validationResult && result) {
                result._validationResult = validationResult;
            }
            if (!options.suppressEpicContinuation && ok && validationResult?.epicContinuation && result) {
                const replacement = await this.workflows.continueEpicAfterValidation(hostedSession, validationResult);
                if (replacement.sessionId) result.replacementSessionId = replacement.sessionId;
            }
        }
    }
}
