import { restoreExecutionWorkflow } from "../execution-workflow-recovery.ts";
import {
    readPersistedActiveAgentName,
    readPersistedManualModelState,
    recordManualModelSelection,
    resolveResumeAgentName,
} from ".././active-agent-session.js";
import { isPathInside, openPersistedRootSession } from ".././root-session.js";
import { RuntimeEventTypes } from ".././session-runtime-events.js";
import { captureTranscriptEvidence, syncTranscriptFileAndParent } from ".././session-transcript-projection.js";
import { openLiveSessionConnection } from ".././live-session-connection.ts";
import { recordSegmentLineageEvidence } from ".././workflow-context-session.js";
import { parseProviderModel } from "../../models/model-validation.ts";
import { sessionDirForRoot } from ".././file-session-storage.ts";
import { AsyncLocalStorage } from "node:async_hooks";

import {
    normalizeManagedActiveModelState,
    normalizeThinkingLevel,
    resolvePersistedExecutionRootConfiguration,
    resolvePersistedResumeModel,
    resolvePersistedRootConfiguration,
    restorePublishedSessionProjectRoot,
} from "./support.ts";
import type { RuntimeRootSessionManager } from "./support.ts";

import type { RuntimeServices } from "./base.ts";
import type { ManagedOperationFailure } from "./types.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeQueues } from "./queues.ts";
import type { RuntimeReads } from "./reads.ts";
import type { RuntimeTurns } from "./turns.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";
import type { RuntimeAgentSettings } from "./agent-settings.ts";
import type { RuntimeManagedSync } from "./managed-sync.ts";
import type { RuntimeWorkflows } from "./workflows.ts";

type RuntimeEventsDependency = Pick<
    RuntimeEvents,
    | "beginBusyOperation"
    | "beginLiveCapture"
    | "clearPendingReplayEvents"
    | "emitSessionEvent"
    | "endBusyOperation"
    | "endLiveCapture"
    | "subscribeSessionEvents"
>;
type RuntimeQueuesDependency = Pick<
    RuntimeQueues,
    "getQueuedMessages" | "removeAllQueueSourceSubscriptions" | "reconcileQueuedMessageSources" | "steerSession"
>;
type RuntimeReadsDependency = Pick<RuntimeReads, "getSessionSnapshot">;
type RuntimeTurnsDependency = Pick<RuntimeTurns, "cancelSession" | "reconcileBackgroundResultConsumption">;
type RuntimeLifecycleDependency = Pick<RuntimeLifecycle, "clearPendingProject" | "hasPendingProject">;
type RuntimeAgentSettingsDependency = Pick<RuntimeAgentSettings, "activateSessionAgent">;
type RuntimeManagedSyncDependency = Pick<
    RuntimeManagedSync,
    "ensureInitialSessionGeneration" | "synchronizeManagedSession"
>;
type RuntimeWorkflowsDependency = Pick<RuntimeWorkflows, "restoreDormantManagedInvariant">;
type ActivationProof = import("../../owner-coordination/session-activations.js").ActivationProof;
type FileSessionStore = import("../file-session-store-types.ts").FileSessionStore;
interface ManagedOperationCapabilityOptions {
    runtimeSessionId: string;
    runwieldSessionId: string;
    operationId: string;
    proof: ActivationProof;
    sessionStore: FileSessionStore;
}

class ManagedOperationCapability {
    readonly runtimeSessionId: string;
    readonly runwieldSessionId: string;
    readonly operationId: string;

    constructor(options: ManagedOperationCapabilityOptions) {
        this.runtimeSessionId = options.runtimeSessionId;
        this.runwieldSessionId = options.runwieldSessionId;
        this.operationId = options.operationId;
        this.#proof = options.proof;
        this.#sessionStore = options.sessionStore;
    }

    #proof: ActivationProof;
    readonly #sessionStore: FileSessionStore;
    #settled = false;
    readonly #abortController = new AbortController();

    get proof() {
        return this.#proof;
    }

    get settled() {
        return this.#settled;
    }

    get signal() {
        return this.#abortController.signal;
    }

    cancel() {
        this.assertLive();
        this.#abortController.abort();
    }

    registerArtifact(options: import(".././file-session-store-types.ts").RegisterSessionArtifactOptions) {
        this.assertLive();
        return this.#sessionStore.registerSessionArtifact(this.#proof, options);
    }

    recordLastPlanReview(
        review: Pick<
            import("../file-session-store-types.ts").LastPlanReviewReference,
            "planId" | "planName" | "planningAgentName"
        >,
    ) {
        this.assertLive();
        return this.#sessionStore.recordLastPlanReview(this.#proof, review);
    }

    stagePlanAssociation(entry: import(".././file-session-store-types.ts").PlanAssociation) {
        this.assertLive();
        return this.#sessionStore.stagePlanAssociation(this.#proof, entry);
    }

    getCurrentSegmentKind() {
        this.assertLive();
        return this.#sessionStore.getCurrentSessionSegment(this.runwieldSessionId)?.kind || "session";
    }

    updateProof(proof: ActivationProof) {
        this.assertLive();
        if (proof.runwieldSessionId !== this.runwieldSessionId || proof.operationId !== this.operationId) {
            throw new Error("Managed operation proof does not match capability");
        }
        this.#proof = proof;
    }

    assertLive() {
        if (this.#settled) throw new Error("Managed operation capability is settled");
    }

    settle() {
        this.#settled = true;
    }
}

export class RuntimeManagedOperations {
    private events!: RuntimeEventsDependency;
    private queues!: RuntimeQueuesDependency;
    private reads!: RuntimeReadsDependency;
    private turns!: RuntimeTurnsDependency;
    private lifecycle!: RuntimeLifecycleDependency;
    private settings!: RuntimeAgentSettingsDependency;
    private sync!: RuntimeManagedSyncDependency;
    private workflows!: RuntimeWorkflowsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        queues: RuntimeQueuesDependency,
        reads: RuntimeReadsDependency,
        turns: RuntimeTurnsDependency,
        lifecycle: RuntimeLifecycleDependency,
        settings: RuntimeAgentSettingsDependency,
        sync: RuntimeManagedSyncDependency,
        workflows: RuntimeWorkflowsDependency,
    ) {
        this.events = events;
        this.queues = queues;
        this.reads = reads;
        this.turns = turns;
        this.lifecycle = lifecycle;
        this.settings = settings;
        this.sync = sync;
        this.workflows = workflows;
    }
    private activeManagedOperation = new AsyncLocalStorage<import("./support.ts").ManagedOperationContext>();
    private pendingManagedCreations = new Map<
        string,
        import("../../owner-coordination/session-activations.js").ActivationProof
    >();
    private currentManagedOperations = new Map<
        string,
        import("../managed-operation.ts").ManagedOperationCapability
    >();
    private currentManagedOperationSettlements = new Map<string, Promise<void>>();

    getSessionSnapshot(sessionId: string) {
        return this.reads.getSessionSnapshot(sessionId);
    }

    getQueuedMessages(sessionId: string) {
        return this.queues.getQueuedMessages(sessionId);
    }

    subscribeSessionEvents(
        sessionId: string,
        listener: import("./types.ts").SessionRuntimeEventListener,
    ) {
        return this.events.subscribeSessionEvents(sessionId, listener);
    }

    steerSession(
        sessionId: string,
        text: string,
        images: import("../types.js").ImageAttachment[],
        inputSurface?: import("../session-runtime-events.js").NotificationSurface,
    ) {
        return this.queues.steerSession(sessionId, text, images, inputSurface);
    }

    cancelSession(sessionId: string) {
        return this.turns.cancelSession(sessionId);
    }

    hasOperation(sessionId: string) {
        return this.currentManagedOperations.has(sessionId);
    }

    currentCapability(sessionId: string) {
        return this.currentManagedOperations.get(sessionId) || null;
    }

    isCurrentContext(sessionId: string, capability: import("../managed-operation.ts").ManagedOperationCapability) {
        const context = this.activeManagedOperation.getStore();
        return context?.runtime === this && context.sessionId === sessionId && context.capability === capability;
    }

    async awaitSettlement(sessionId: string) {
        while (this.currentManagedOperations.has(sessionId)) {
            await this.currentManagedOperationSettlements.get(sessionId)?.catch(() => undefined);
            if (this.currentManagedOperations.has(sessionId)) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
    }

    hasPendingCreationProof(sessionId: string) {
        return this.pendingManagedCreations.has(sessionId);
    }

    getPendingCreationProof(sessionId: string) {
        return this.pendingManagedCreations.get(sessionId) || null;
    }

    setPendingCreationProof(
        sessionId: string,
        proof: import("../../owner-coordination/session-activations.js").ActivationProof,
    ) {
        this.pendingManagedCreations.set(sessionId, proof);
    }

    clearPendingCreationProof(sessionId: string) {
        this.pendingManagedCreations.delete(sessionId);
    }

    async acquirePendingCreation(
        hostedSession: import("../hosted-session.js").HostedSession,
        projectId: string,
        sessionManager: RuntimeRootSessionManager,
        transcriptPath: string,
        name?: string,
    ) {
        const sessionStore = this.services.sessionStoreOwner.ensure();
        let proof: import("../../owner-coordination/session-activations.js").ActivationProof | null = null;
        try {
            const acquired = await sessionStore.ensureSessionCatalogRecordAndAcquire({
                locator: {
                    projectId,
                    piSessionId: sessionManager.getSessionId(),
                    transcriptPath,
                    transcriptCwd: hostedSession.cwd,
                    source: "created",
                },
                activation: {
                    ownerInstanceId: this.services.ownerInstanceId,
                    ownerProcessKind: this.services.ownerProcessKind,
                    phase: "preparing",
                },
            });
            proof = acquired.proof;
            recordSegmentLineageEvidence(sessionManager, {
                segmentId: acquired.segment.segmentId,
                runwieldSessionId: acquired.session.runwieldSessionId,
                parentSegmentId: null,
                parentPiSessionId: null,
                lineageGroupKey: acquired.segment.segmentId,
                kind: "planning",
            });
            const managed: import("../hosted-session.js").ManagedSessionMetadata = {
                runwieldSessionId: acquired.session.runwieldSessionId,
                projectId: acquired.session.projectId,
                piSessionId: acquired.session.piSessionId,
                transcriptPath: acquired.session.transcriptPath,
                currentSegmentId: acquired.segment.segmentId,
                generation: null,
                acknowledgedGeneration: null,
                acknowledgedEventId: null,
                name: name || acquired.session.displayName,
                activeAgent: null,
                workflowContext: null,
                tutorialContext: null,
                syncState: {
                    type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                    status: "syncing",
                    localGeneration: null,
                    latestGeneration: null,
                },
            };
            hostedSession.setManagedMetadata(managed);
            return { managed, proof: acquired.proof };
        } catch (error) {
            if (proof) {
                try {
                    sessionStore.releaseUnchangedActivation(proof);
                } catch {
                    // Preserve the creation failure after best-effort lock release.
                }
            }
            throw error;
        }
    }

    async runPendingCreation<T>(
        hostedSession: import("../hosted-session.js").HostedSession,
        pendingCreation: import("../../owner-coordination/session-activations.js").ActivationProof,
        body: (capability: import("../managed-operation.ts").ManagedOperationCapability) => Promise<T>,
    ): Promise<T> {
        if (!this.services.sessionStore) throw new Error("Session coordination is unavailable");
        const managed = hostedSession.getManagedMetadata?.();
        if (!managed) throw new Error("Session coordination was interrupted during creation");
        let activeProof = pendingCreation;
        const capability = new ManagedOperationCapability({
            runtimeSessionId: hostedSession.id,
            runwieldSessionId: managed.runwieldSessionId,
            operationId: activeProof.operationId,
            proof: activeProof,
            sessionStore: this.services.sessionStore,
        });
        let settleManagedCreation = () => {};
        const managedCreationSettlement = new Promise<void>((resolve) => {
            settleManagedCreation = () => resolve();
        });
        this.currentManagedOperations.set(hostedSession.id, capability);
        this.currentManagedOperationSettlements.set(hostedSession.id, managedCreationSettlement);
        hostedSession.setManagedOperationCapability(capability);
        let hydrated = false;
        try {
            activeProof = this.services.sessionStore.changeSessionActivationPhase(activeProof, "hydrated");
            capability.updateProof(activeProof);
            hydrated = true;
            await restoreExecutionWorkflow(hostedSession);
            const result = await body(capability);
            activeProof = this.services.sessionStore.changeSessionActivationPhase(activeProof, "checkpointing");
            capability.updateProof(activeProof);
            await syncTranscriptFileAndParent(managed.transcriptPath);
            const evidence = await captureTranscriptEvidence({
                transcriptPath: managed.transcriptPath,
                transcriptCwd: hostedSession.cwd,
            });
            this.services.sessionStore.publishGenerationAndRelease(activeProof, {
                generation: 0,
                byteLength: evidence.byteLength,
                terminalEntryId: evidence.terminalEntryId,
                digestHex: evidence.digestHex,
                currentSegmentId: managed.currentSegmentId,
            });
            const managedModelState = normalizeManagedActiveModelState(
                hostedSession.getActiveModelState?.() || {},
                managed,
            );
            hostedSession.setManagedMetadata({
                ...managed,
                generation: 0,
                acknowledgedGeneration: 0,
                activeAgent: hostedSession.getRootAgentName?.() ||
                    readPersistedActiveAgentName(hostedSession.getRootSessionManager?.() || undefined) || null,
                model: managedModelState.model,
                provider: managedModelState.provider,
                thinkingLevel: hostedSession.getThinkingLevel?.() || managed.thinkingLevel || "off",
                workflowContext: hostedSession.getWorkflowContext?.() || managed.workflowContext || null,
                tutorialContext: hostedSession.getTutorialContext?.() || managed.tutorialContext || null,
            });
            this.clearPendingCreationProof(hostedSession.id);
            this.lifecycle.clearPendingProject(hostedSession.id);
            hostedSession.dehydrateManagedSession();
            await this.sync.synchronizeManagedSession(hostedSession.id, { emitEvents: false, replayFromStart: true });
            return result;
        } catch (error) {
            this.clearPendingCreationProof(hostedSession.id);
            this.lifecycle.clearPendingProject(hostedSession.id);
            hostedSession.dehydrateManagedSession();
            this.queues.removeAllQueueSourceSubscriptions(hostedSession.id);
            try {
                if (hydrated) {
                    await syncTranscriptFileAndParent(managed.transcriptPath);
                    this.services.sessionStore.markSessionUncertain(activeProof, {
                        reason: error instanceof Error ? error.message : String(error),
                    });
                    await this.sync.ensureInitialSessionGeneration(managed.runwieldSessionId);
                    await this.sync.synchronizeManagedSession(hostedSession.id, { emitEvents: false });
                } else {
                    this.services.sessionStore.releaseUnchangedActivation(activeProof);
                }
            } catch {
                // Preserve the original creation/setup failure.
            }
            throw error;
        } finally {
            capability.settle();
            this.currentManagedOperations.delete(hostedSession.id);
            this.currentManagedOperationSettlements.delete(hostedSession.id);
            settleManagedCreation();
            hostedSession.setManagedOperationCapability(null);
        }
    }

    rejectManagedPublicMutation(
        hostedSession: import(".././hosted-session.js").HostedSession | null | undefined,
        operation: string,
        capability: import(".././managed-operation.ts").ManagedOperationCapability | null = null,
    ) {
        if (!hostedSession?.getManagedMetadata?.()) return null;
        const currentCapability = this.currentManagedOperations.get(hostedSession.id) || null;
        if (currentCapability && currentCapability !== capability) {
            return { ok: false, error: "managed_operation_in_progress", operation };
        }
        if (capability && currentCapability === capability) return null;
        if (capability && !capability.settled && hostedSession.getManagedOperationCapability?.() === capability) {
            return null;
        }
        return { ok: false, error: "managed_operation_required", operation };
    }

    async runManagedStandaloneMutation<T>(
        sessionId: string,
        name: import(".././managed-operation.ts").ManagedOperationName,
        operation: (
            session: import(".././hosted-session.js").HostedSession,
            capability: import(".././managed-operation.ts").ManagedOperationCapability | null,
        ) => T | Promise<T>,
        options: { activateAgent?: boolean; hydrate?: boolean } = {},
    ): Promise<T | ManagedOperationFailure> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return ({ ok: false, error: "not_found" });
        const managed = session.getManagedMetadata?.();
        const currentCapability = this.currentManagedOperations.get(sessionId) || null;
        if (currentCapability) {
            const context = this.activeManagedOperation.getStore();
            if (
                context?.runtime === this && context.sessionId === sessionId && context.capability === currentCapability
            ) {
                return await operation(session, currentCapability);
            }
            await this.awaitSettlement(sessionId);
            return await this.runManagedStandaloneMutation(sessionId, name, operation, options);
        }
        if (this.pendingManagedCreations.has(sessionId) || this.lifecycle.hasPendingProject(sessionId)) {
            return { ok: false, error: "managed_operation_in_progress" };
        }
        if (!managed) {
            return await operation(session, null);
        }
        await this.workflows.restoreDormantManagedInvariant(session);
        if (session.getRootSessionManager?.()) {
            return { ok: false, error: "managed_operation_in_progress" };
        }
        return await this.runManagedOperation(
            sessionId,
            {
                name,
                options: {
                    expectedGeneration: managed.generation ?? undefined,
                    emitBusyEvents: name !== "switch_agent",
                },
                activateAgent: options.activateAgent === true,
                hydrate: options.hydrate !== false,
            },
            async ({ capability }) => await operation(session, capability),
        );
    }

    async runManagedOperation<T>(
        sessionId: string,
        descriptor: import(".././managed-operation.ts").ManagedOperationDescriptor,
        body: (
            context: {
                acceptedTurnId: string;
                hasPendingImages: boolean;
                capability: import(".././managed-operation.ts").ManagedOperationCapability;
            },
        ) => Promise<T>,
    ): Promise<T | import("./types.ts").ManagedOperationRunFailure> {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) throw new Error("SessionRuntime.runManagedOperation: session not found");
        this.events.clearPendingReplayEvents(sessionId);
        const managed = hostedSession.getManagedMetadata?.();
        if (!managed) throw new Error("SessionRuntime.runManagedOperation: Session is not managed");
        if (this.currentManagedOperations.has(sessionId)) {
            return {
                ok: false,
                turns: 0,
                error: "managed_operation_in_progress",
            };
        }
        if (!this.services.sessionStore) throw new Error("Session coordination is unavailable");
        const state = this.services.sessionStore.inspectSessionActivation(managed.runwieldSessionId);
        const committedPlanAssociations = this.services.sessionStore.listSessionPlanAssociations(
            managed.runwieldSessionId,
            managed.projectId,
        );
        const latestGeneration = state.generation?.generation ?? null;
        const options = descriptor.options || {};
        const expectedGeneration = options.expectedGeneration ?? managed.generation ?? latestGeneration ?? null;
        const nextGeneration = (expectedGeneration ?? -1) + 1;
        const isUnpublishedInitialGeneration = latestGeneration === null && expectedGeneration === 0;
        if (latestGeneration !== expectedGeneration && !isUnpublishedInitialGeneration) {
            return { ok: false, turns: 0, error: "refresh_required" };
        }
        let activeProof;
        try {
            activeProof = this.services.sessionStore.acquireSessionActivation({
                runwieldSessionId: managed.runwieldSessionId,
                projectId: managed.projectId,
                ownerInstanceId: this.services.ownerInstanceId,
                ownerProcessKind: this.services.ownerProcessKind,
                expectedGeneration,
                expectedCurrentSegmentId: managed.currentSegmentId ?? state.activation?.currentSegmentId ?? null,
                phase: "preparing",
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("current segment expectation")) {
                return {
                    ok: false,
                    turns: 0,
                    error: "refresh_required",
                };
            }
            if (
                message.includes("Session activation is not available") ||
                message.includes("activation race lost") ||
                message.includes("another RunWield surface")
            ) {
                return {
                    ok: false,
                    turns: 0,
                    error: "managed_operation_in_progress",
                };
            }
            throw error;
        }
        const capability = new ManagedOperationCapability({
            runtimeSessionId: sessionId,
            runwieldSessionId: managed.runwieldSessionId,
            operationId: activeProof.operationId,
            proof: activeProof,
            sessionStore: this.services.sessionStore,
        });
        this.currentManagedOperations.set(sessionId, capability);
        let settleManagedOperation = () => {};
        this.currentManagedOperationSettlements.set(
            sessionId,
            new Promise((resolve) => {
                settleManagedOperation = () => resolve(undefined);
            }),
        );
        hostedSession.setManagedOperationCapability(capability);
        let hydrated = false;
        let closeLiveConnection = null;
        let cleanupTurnStart = () => {};
        const shouldEmitBusyEvents = options.emitBusyEvents !== false;
        if (shouldEmitBusyEvents) this.events.beginBusyOperation(sessionId);
        try {
            const liveEvents = this.events.beginLiveCapture(sessionId);
            closeLiveConnection = await openLiveSessionConnection(
                this,
                hostedSession,
                activeProof.operationId,
                liveEvents,
            );
            const pendingIntent = hostedSession.getPendingManagedTurnIntent?.() || {};
            let generationSegment = null;
            if (state.generation) {
                generationSegment = this.services.sessionStore.listSessionTranscriptSegments(
                    managed.runwieldSessionId,
                )
                    .find((segment) => segment.segmentId === state.generation?.currentSegmentId) || null;
                if (!generationSegment) throw new Error("Committed generation current segment is absent from manifest");
                const currentEvidence = await captureTranscriptEvidence({
                    transcriptPath: generationSegment.transcriptPath,
                    transcriptCwd: generationSegment.transcriptCwd,
                    byteLength: state.generation.byteLength,
                });
                const stat = await Deno.stat(generationSegment.transcriptPath);
                if (
                    stat.size !== state.generation.byteLength ||
                    currentEvidence.digestHex !== state.generation.digestHex ||
                    currentEvidence.terminalEntryId !== state.generation.terminalEntryId
                ) {
                    this.services.sessionStore.markSessionReconcileRequiredWithProof(activeProof, {
                        reason: "transcript_ahead_or_mismatch",
                    });
                    return {
                        ok: false,
                        turns: 0,
                        error: "reconcile_required",
                    };
                }
            }
            const acceptedTurnId = options.turnId || crypto.randomUUID();
            const turnStartCleanup = options.onTurnStarted?.({ turnId: acceptedTurnId });
            if (typeof turnStartCleanup === "function") cleanupTurnStart = turnStartCleanup;
            const hasPendingImages = (options.initialImages || []).some((image) => !image.path && !image.ref);
            if (descriptor.hydrate === false) {
                const result = await this.activeManagedOperation.run(
                    { runtime: this, sessionId, capability },
                    async () => await body({ acceptedTurnId, hasPendingImages, capability }),
                );
                this.services.sessionStore.releaseUnchangedActivation(activeProof);
                return result;
            }
            const shouldEmitPromptEvents = options.initialRequest !== undefined &&
                descriptor.emitPromptEvents !== false;
            if (shouldEmitPromptEvents && !hasPendingImages) {
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.USER_MESSAGE,
                    turnId: acceptedTurnId,
                    ...(options.generatedTaskId
                        ? { origin: "background_task_result", taskId: options.generatedTaskId }
                        : {}),
                    text: options.initialRequest,
                    images: (options.initialImages || []).map((image) => ({ ...image })),
                });
                this.events.emitSessionEvent(hostedSession.id, {
                    type: RuntimeEventTypes.TURN_START,
                    turnId: acceptedTurnId,
                });
            }
            activeProof = this.services.sessionStore.changeSessionActivationPhase(activeProof, "hydrated");
            capability.updateProof(activeProof);
            hydrated = true;
            const transcriptProjectRoot = managed?.projectId
                ? this.services.sessionStore.requireSessionProjectRoot(managed.projectId)
                : null;
            const transcriptProjectSessionDir = transcriptProjectRoot
                ? sessionDirForRoot(this.services.sessionStore.path, transcriptProjectRoot)
                : "";
            const transcriptPath = generationSegment?.transcriptPath || managed.transcriptPath;
            const managedProjectSessionDir = generationSegment && transcriptProjectSessionDir && isPathInside(
                    transcriptPath,
                    transcriptProjectSessionDir,
                )
                ? transcriptProjectSessionDir
                : undefined;
            const { sessionManager } = await openPersistedRootSession({
                cwd: generationSegment?.transcriptCwd || hostedSession.cwd,
                sessionId: generationSegment?.piSessionId || managed.piSessionId,
                sessionPath: transcriptPath,
                sessionDir: managedProjectSessionDir,
                managedProjectRoot: managedProjectSessionDir && transcriptProjectRoot
                    ? transcriptProjectRoot
                    : undefined,
                managedSegmentCwd: managedProjectSessionDir ? generationSegment?.transcriptCwd : undefined,
            });
            hostedSession.setRootSessionManager(sessionManager, capability);
            await restorePublishedSessionProjectRoot(hostedSession, this.services.sessionStore);
            if (options.initialTutorialContext !== undefined) {
                hostedSession.updateTutorialContext(options.initialTutorialContext, committedPlanAssociations);
            }
            await restoreExecutionWorkflow(hostedSession);
            const executionRootConfiguration = resolvePersistedExecutionRootConfiguration(hostedSession);
            const preparedModelOverride = "preparedModelOverride" in options &&
                    typeof options.preparedModelOverride === "string"
                ? options.preparedModelOverride
                : undefined;
            const pendingModel = preparedModelOverride ||
                (pendingIntent.model || pendingIntent.provider
                    ? pendingIntent.provider && pendingIntent.model
                        ? `${pendingIntent.provider}/${pendingIntent.model}`
                        : pendingIntent.model || undefined
                    : undefined);
            if (pendingIntent.model || pendingIntent.provider) {
                hostedSession.setActiveModelState(pendingIntent.model || "", pendingIntent.provider || "", true);
            }
            if (pendingIntent.manualModel && pendingModel) {
                const parsedPendingModel = parseProviderModel(pendingModel);
                recordManualModelSelection(
                    sessionManager,
                    parsedPendingModel.ok ? parsedPendingModel.provider : "",
                    parsedPendingModel.ok ? parsedPendingModel.id : pendingModel,
                );
            }
            let agentName = executionRootConfiguration?.agentName || options.agentName || pendingIntent.agentName ||
                null;
            if (descriptor.activateAgent !== false) {
                const resumeAgent = await resolveResumeAgentName(sessionManager);
                agentName ||= resumeAgent;
                const persistedManualModel = readPersistedManualModelState(sessionManager, agentName);
                const persistedModel = agentName === resumeAgent
                    ? resolvePersistedResumeModel(sessionManager)
                    : undefined;
                const persistedRootConfiguration = await resolvePersistedRootConfiguration(
                    agentName,
                    sessionManager,
                    hostedSession.cwd,
                );
                await this.settings.activateSessionAgent(hostedSession, {
                    ...persistedRootConfiguration,
                    agentName,
                    thinkingLevelOverride: pendingIntent.thinkingLevel || managed.thinkingLevel
                        ? normalizeThinkingLevel(pendingIntent.thinkingLevel || managed.thinkingLevel)
                        : undefined,
                    model: pendingModel ||
                        (persistedManualModel
                            ? persistedManualModel.provider
                                ? `${persistedManualModel.provider}/${persistedManualModel.model}`
                                : persistedManualModel.model
                            : persistedModel),
                    toolNames: options.toolNames,
                    customTools: options.customTools || executionRootConfiguration?.customTools ||
                        persistedRootConfiguration.customTools,
                    includeEditFallback: options.includeEditFallback,
                    ...(executionRootConfiguration?.cwd ? { cwd: executionRootConfiguration.cwd } : {}),
                    ...(executionRootConfiguration?.projectStateContext
                        ? { projectStateContext: executionRootConfiguration.projectStateContext }
                        : {}),
                    managedOperationCapability: capability,
                });
                if (pendingIntent.model || pendingIntent.provider) {
                    hostedSession.getRootSessionManager?.()?.appendModelChange?.(
                        pendingIntent.provider || "",
                        pendingIntent.model || "",
                    );
                }
            }
            // Agent activation restores its saved defaults. Apply the user's
            // pending choice afterwards so the first turn uses that choice.
            if (pendingIntent.thinkingLevel || managed.thinkingLevel) {
                const thinkingLevel = normalizeThinkingLevel(pendingIntent.thinkingLevel || managed.thinkingLevel);
                hostedSession.setThinkingLevel(thinkingLevel);
                if (pendingIntent.thinkingLevel) sessionManager.appendThinkingLevelChange(thinkingLevel);
            }
            hostedSession.consumePendingManagedTurnIntent?.();
            activeProof = this.services.sessionStore.changeSessionActivationPhase(activeProof, "turning");
            capability.updateProof(activeProof);
            const result = await this.activeManagedOperation.run(
                { runtime: this, sessionId, capability },
                async () => await body({ acceptedTurnId, hasPendingImages, capability }),
            );
            activeProof = this.services.sessionStore.changeSessionActivationPhase(activeProof, "checkpointing");
            capability.updateProof(activeProof);
            const managedModelState = normalizeManagedActiveModelState(
                hostedSession.getActiveModelState?.() || {},
                managed,
            );
            const nextManaged = {
                ...managed,
                generation: nextGeneration,
                acknowledgedGeneration: nextGeneration,
                name: hostedSession.getRootSessionManager?.()?.getSessionName?.() || managed.name || null,
                activeAgent: hostedSession.getRootAgentName?.() ||
                    readPersistedActiveAgentName(hostedSession.getRootSessionManager?.() || undefined) || null,
                model: managedModelState.model,
                provider: managedModelState.provider,
                thinkingLevel: hostedSession.getThinkingLevel?.() || managed.thinkingLevel || "off",
                workflowContext: hostedSession.getWorkflowContext?.() || managed.workflowContext || null,
                tutorialContext: hostedSession.getTutorialContext?.() || managed.tutorialContext || null,
            };
            this.queues.reconcileQueuedMessageSources(hostedSession);
            this.turns.reconcileBackgroundResultConsumption(hostedSession);
            hostedSession.dehydrateManagedSession();
            this.queues.removeAllQueueSourceSubscriptions(sessionId);
            await syncTranscriptFileAndParent(managed.transcriptPath);
            const evidence = await captureTranscriptEvidence({
                transcriptPath: managed.transcriptPath,
                transcriptCwd: hostedSession.cwd,
            });
            this.services.sessionStore.publishGenerationAndRelease(activeProof, {
                generation: nextGeneration,
                byteLength: evidence.byteLength,
                terminalEntryId: evidence.terminalEntryId,
                digestHex: evidence.digestHex,
                currentSegmentId: managed.currentSegmentId,
            });
            hostedSession.setManagedMetadata(nextManaged);
            await this.sync.synchronizeManagedSession(sessionId, { emitEvents: false });
            return result;
        } catch (error) {
            hostedSession.dehydrateManagedSession();
            this.queues.removeAllQueueSourceSubscriptions(sessionId);
            if (!hydrated) {
                try {
                    this.services.sessionStore.releaseUnchangedActivation(activeProof);
                } catch {
                    this.services.sessionStore.markSessionUncertain(activeProof, {
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
            } else {
                let uncertaintyRecorded = false;
                try {
                    await syncTranscriptFileAndParent(managed.transcriptPath);
                    this.services.sessionStore.markSessionUncertain(activeProof, {
                        reason: error instanceof Error ? error.message : String(error),
                    });
                    uncertaintyRecorded = true;
                    await this.sync.ensureInitialSessionGeneration(managed.runwieldSessionId);
                    await this.sync.synchronizeManagedSession(sessionId, { emitEvents: false });
                } catch (recoveryError) {
                    if (!uncertaintyRecorded) {
                        try {
                            this.services.sessionStore.markSessionUncertain(activeProof, {
                                reason: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                            });
                        } catch {
                            // Preserve the original turn failure when recovery cannot record its own failure.
                        }
                    }
                }
            }
            throw error;
        } finally {
            this.events.endLiveCapture(sessionId);
            await closeLiveConnection?.();
            cleanupTurnStart();
            capability.settle();
            this.currentManagedOperations.delete(sessionId);
            this.currentManagedOperationSettlements.delete(sessionId);
            settleManagedOperation();
            hostedSession.setManagedOperationCapability(null);
            if (shouldEmitBusyEvents) this.events.endBusyOperation(sessionId);
        }
    }
}
