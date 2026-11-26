import { syncTranscriptFileAndParent } from "../../../src/shared/session/file-session-storage.ts";
import type { CloseSessionResult, CreatedSession } from "../contract.ts";
import { projects } from "@runwield/projects";
import { stat as fsStat } from "node:fs/promises";
import { AGENTS } from "../../../src/shared/session/agent-registry.ts";
import {
    createRootSessionManager,
    isPathInside,
    resolveCreatedRootSessionPath,
} from "../../../src/shared/session/root-session.ts";
import { RuntimeEventTypes } from "../events.ts";
import { captureTranscriptEvidence } from "../session-transcript-projection.ts";
import { recordSegmentLineageEvidence } from "../../../src/shared/session/workflow-context-session.ts";
import { isAbsolute } from "node:path";
import type { CreateSessionOptions } from "./types.ts";

import { enterGitProjectRuntime, isRuntimeRootSessionManager } from "./support.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeQueues } from "./queues.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";
import type { RuntimeReads } from "./reads.ts";
import type { RuntimeAgentSettings } from "./agent-settings.ts";
import type { RuntimeManagedSync } from "./managed-sync.ts";
import type { RuntimeTurns } from "./turns.ts";

type RuntimeEventsDependency = Pick<
    RuntimeEvents,
    "attachRuntimeEventSink" | "awaitBusyOperationSettlement" | "cleanupSession" | "emitSessionEvent" | "isBusy"
>;
type RuntimeQueuesDependency = Pick<
    RuntimeQueues,
    "cleanupSession" | "clearQueuedMessagesInternal" | "scheduleQueuedMessageDrain"
>;
type RuntimeManagedOperationsDependency = Pick<
    RuntimeManagedOperations,
    | "acquirePendingCreation"
    | "awaitSettlement"
    | "clearPendingCreationProof"
    | "hasOperation"
    | "setPendingCreationProof"
>;
type RuntimeReadsDependency = Pick<RuntimeReads, "getSessionSnapshot" | "listSessions">;
type RuntimeAgentSettingsDependency = Pick<
    RuntimeAgentSettings,
    "ensureSessionProjectForCwd" | "markPromptReadyAgent" | "refreshMcpTools" | "switchAgent"
>;
type RuntimeManagedSyncDependency = Pick<RuntimeManagedSync, "synchronizeManagedSession">;
type RuntimeTurnsDependency = Pick<RuntimeTurns, "awaitSettlement" | "cancelSession">;

export class RuntimeLifecycle {
    private events!: RuntimeEventsDependency;
    private queues!: RuntimeQueuesDependency;
    private managedOperations!: RuntimeManagedOperationsDependency;
    private reads!: RuntimeReadsDependency;
    private settings!: RuntimeAgentSettingsDependency;
    private sync!: RuntimeManagedSyncDependency;
    private turns!: RuntimeTurnsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        queues: RuntimeQueuesDependency,
        managedOperations: RuntimeManagedOperationsDependency,
        reads: RuntimeReadsDependency,
        settings: RuntimeAgentSettingsDependency,
        sync: RuntimeManagedSyncDependency,
        turns: RuntimeTurnsDependency,
    ) {
        this.events = events;
        this.queues = queues;
        this.managedOperations = managedOperations;
        this.reads = reads;
        this.settings = settings;
        this.sync = sync;
        this.turns = turns;
    }
    private pendingManagedCreationProjects = new Map<string, { cwd: string; name?: string }>();

    hasPendingProject(sessionId: string) {
        return this.pendingManagedCreationProjects.has(sessionId);
    }

    getPendingProject(sessionId: string) {
        return this.pendingManagedCreationProjects.get(sessionId) || null;
    }

    setPendingProject(sessionId: string, project: { cwd: string; name?: string }) {
        this.pendingManagedCreationProjects.set(sessionId, project);
    }

    clearPendingProject(sessionId: string) {
        this.pendingManagedCreationProjects.delete(sessionId);
    }

    async closeSession(id: string): Promise<CloseSessionResult> {
        const hostedSession = this.services.sessionHost.getSession(id);
        if (
            hostedSession &&
            (this.managedOperations.hasOperation(hostedSession.id) || this.events.isBusy(hostedSession.id))
        ) {
            return this.closeSessionAfterActiveOperation(hostedSession.id);
        }
        if (hostedSession) this.queues.clearQueuedMessagesInternal(hostedSession, "session_closed");
        await this.services.remotePersistence?.discard(id);
        let closed = false;
        try {
            closed = await this.services.sessionHost.disposeSession(id);
        } catch {
            closed = Boolean(hostedSession?.disposed || !this.services.sessionHost.getSession(id));
        }
        if (closed) {
            this.events.emitSessionEvent(id, { type: RuntimeEventTypes.SESSION_CLOSED });
            this.events.cleanupSession(id);
            this.queues.cleanupSession(id);
            this.managedOperations.clearPendingCreationProof(id);
            this.clearPendingProject(id);
        }
        return { ok: true, closed };
    }

    async closeSessionAfterActiveOperation(sessionId: string): Promise<CloseSessionResult> {
        await this.awaitManagedOperationSettlement(sessionId);
        await this.events.awaitBusyOperationSettlement(sessionId);
        return this.closeSession(sessionId);
    }

    async awaitManagedOperationSettlement(sessionId: string) {
        await this.managedOperations.awaitSettlement(sessionId);
    }

    async closeSessionWhenIdle(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: true, closed: false };
        if (session.isTurnActive()) {
            this.turns.cancelSession(session.id);
            await this.turns.awaitSettlement(session.id);
        }
        await this.awaitManagedOperationSettlement(session.id);
        await this.events.awaitBusyOperationSettlement(session.id);
        return await this.closeSession(session.id);
    }

    async closeAllSessions() {
        const sessions = this.reads.listSessions();
        try {
            for (const session of sessions) {
                try {
                    const hostedSession = this.services.sessionHost.getSession(session.id);
                    if (hostedSession) this.turns.cancelSession(hostedSession.id);
                } catch {
                    // Shutdown cleanup is best effort.
                }
                await this.closeSession(session.id);
            }
            return { ok: true, closed: sessions.length };
        } finally {
            this.services.sessionStoreOwner.closeOwned();
        }
    }

    async closeAllSessionsWhenIdle() {
        const sessions = this.reads.listSessions();
        try {
            await Promise.all(sessions.map((session) => this.closeSessionWhenIdle(session.id)));
            return { ok: true, closed: sessions.length };
        } finally {
            this.services.sessionStoreOwner.closeOwned();
        }
    }

    async prepareDeferredManagedCreation(hostedSession: import("../host.ts").HostedSession) {
        const pendingProject = this.pendingManagedCreationProjects.get(hostedSession.id);
        if (!pendingProject) return null;
        await enterGitProjectRuntime(pendingProject.cwd);
        this.services.sessionStoreOwner.ensure();
        const managedProject = this.settings.ensureSessionProjectForCwd(pendingProject.cwd);
        if (!managedProject) throw new Error("Session Manager create is blocked: project_identity_unavailable");
        const existingSessionManager = hostedSession.getRootSessionManager();
        let sessionManager = existingSessionManager ? existingSessionManager : null;
        let createdSessionManager = false;
        try {
            if (!sessionManager) {
                sessionManager = await createRootSessionManager("new", hostedSession.cwd);
                hostedSession.setRootSessionManager(sessionManager);
                createdSessionManager = true;
            }
            if (!isRuntimeRootSessionManager(sessionManager)) throw new Error("The Session could not be opened");
            if (pendingProject.name && sessionManager.getSessionName?.() !== pendingProject.name) {
                sessionManager.appendSessionInfo?.(pendingProject.name);
            }
            const piSessionId = sessionManager.getSessionId?.();
            if (!piSessionId) throw new Error("The Session could not be persisted");
            const transcriptPath = await this.resolveCreatedSessionPath(hostedSession.cwd, sessionManager);
            const acquired = await this.managedOperations.acquirePendingCreation(
                hostedSession,
                managedProject.projectId,
                sessionManager,
                transcriptPath,
                pendingProject.name,
            );
            return { ...acquired, createdSessionManager };
        } catch (error) {
            if (createdSessionManager) {
                await sessionManager?.dispose?.();
                hostedSession.setRootSessionManager(null);
            }
            throw error;
        }
    }

    async materializeDeferredWorkflowSession(hostedSession: import("../host.ts").HostedSession) {
        if (!this.pendingManagedCreationProjects.has(hostedSession.id)) return;
        await this.materializeDeferredManagedShell(hostedSession);
        hostedSession.dehydrateManagedSession();
    }

    async materializeDeferredManagedShell(hostedSession: import("../host.ts").HostedSession) {
        if (this.services.remotePersistence) {
            const pending = this.pendingManagedCreationProjects.get(hostedSession.id);
            if (!pending) return hostedSession.getManagedMetadata();
            await enterGitProjectRuntime(hostedSession.cwd);
            const managed = await this.services.remotePersistence.create(hostedSession, pending.name);
            this.pendingManagedCreationProjects.delete(hostedSession.id);
            return managed;
        }
        const prepared = await this.prepareDeferredManagedCreation(hostedSession);
        if (!prepared) return hostedSession.getManagedMetadata?.() || null;
        if (!this.services.sessionStore) throw new Error("Session coordination is unavailable");
        try {
            this.services.sessionStore.releaseUnchangedActivation(prepared.proof);
            this.pendingManagedCreationProjects.delete(hostedSession.id);
            if (prepared.managed.syncState) this.events.emitSessionEvent(hostedSession.id, prepared.managed.syncState);
            return prepared.managed;
        } catch (error) {
            try {
                this.services.sessionStore.releaseUnchangedActivation(prepared.proof);
            } catch {
                // Preserve the materialization failure after best-effort lock release.
            }
            hostedSession.setManagedMetadata(null);
            if (prepared.createdSessionManager) {
                hostedSession.getRootSessionManager()?.dispose?.();
                hostedSession.setRootSessionManager(null);
            }
            throw error;
        }
    }

    async ensureCreatedSessionTranscriptFile(
        sessionManager: import("../host.ts").MinimalSessionManagerLike,
        transcriptPath: string,
    ) {
        try {
            const stat = await fsStat(transcriptPath);
            if (stat.isFile()) return;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const rewriteFile = Reflect.get(sessionManager, "_rewriteFile");
        if (typeof rewriteFile !== "function") {
            throw new Error(`Created Session transcript was not persisted: ${transcriptPath}`);
        }
        rewriteFile.call(sessionManager);
        if ("flushed" in sessionManager) Reflect.set(sessionManager, "flushed", true);
        const stat = await fsStat(transcriptPath);
        if (!stat.isFile()) throw new Error(`Created Session transcript was not persisted: ${transcriptPath}`);
    }

    async resolveCreatedSessionPath(cwd: string, sessionManager: import("../host.ts").MinimalSessionManagerLike) {
        return await resolveCreatedRootSessionPath(cwd, sessionManager);
    }

    adoptManagedSession(options: {
        cwd?: string;
        session: import("../../../src/shared/owner-coordination/sessions.ts").CatalogedSession;
        generation?: number | null;
        acknowledgedEventId?: string | null;
        hostedSessionId?: string | null;
        name?: string | null;
        activeAgent?: string | null;
        model?: string | null;
        provider?: string | null;
        thinkingLevel?: string | null;
        workflowContext?: import("../events.ts").WorkflowContext | null;
        tutorialContext?: import("../../../src/shared/session/tutorial-context-session.ts").TutorialContext | null;
    }) {
        const cataloged = options?.session;
        if (!cataloged) throw new Error("SessionRuntime.adoptManagedSession requires a cataloged Session");
        const currentSegment = this.services.sessionStore?.getCurrentSessionSegment(cataloged.runwieldSessionId);
        const transcriptCwd = currentSegment?.transcriptCwd || cataloged.transcriptCwd;
        const project = this.services.sessionStore?.getSessionProjectById(cataloged.projectId);
        const currentRoots = this.services.sessionStore?.listProjectRootEvidence(cataloged.projectId) ?? [];
        const usesProjectRoot =
            transcriptCwd === project?.registeredRoot ||
            transcriptCwd === project?.currentRoot ||
            currentRoots.some(
                (root) =>
                    root.rootState === "current" &&
                    projects.storage
                        .inspect(root.canonicalRoot)
                        .some(
                            (binding) =>
                                (binding.historicalRoots ?? [binding.root]).includes(transcriptCwd) &&
                                isPathInside(
                                    currentSegment?.transcriptPath || cataloged.transcriptPath,
                                    binding.sessionDirectory,
                                ),
                        ),
            );
        const hostedSession = this.services.sessionHost.createSession({
            id:
                typeof options.hostedSessionId === "string" && options.hostedSessionId
                    ? options.hostedSessionId
                    : crypto.randomUUID(),
            cwd:
                currentSegment?.kind === "execution" || currentSegment?.kind === "semantic_repair"
                    ? currentSegment.transcriptCwd
                    : (options.cwd ??
                      (usesProjectRoot
                          ? this.services.sessionStore?.requireSessionProjectRoot(cataloged.projectId)
                          : transcriptCwd) ??
                      transcriptCwd),
            sessionManager: null,
            managed: {
                runwieldSessionId: cataloged.runwieldSessionId,
                projectId: cataloged.projectId,
                piSessionId: cataloged.piSessionId,
                transcriptPath: cataloged.transcriptPath,
                currentSegmentId: currentSegment?.segmentId || "",
                generation: options.generation ?? null,
                acknowledgedGeneration: options.generation ?? null,
                acknowledgedEventId: options.acknowledgedEventId ?? null,
                name: options.name ?? null,
                activeAgent: options.activeAgent ?? null,
                model: options.model ?? null,
                provider: options.provider ?? null,
                thinkingLevel: options.thinkingLevel ?? null,
                workflowContext: options.workflowContext ?? null,
                tutorialContext: options.tutorialContext ?? null,
                syncState: {
                    type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                    status: "current",
                    localGeneration: options.generation ?? null,
                    latestGeneration: options.generation ?? null,
                },
            },
        });
        this.events.attachRuntimeEventSink(hostedSession);
        this.events.emitSessionEvent(hostedSession.id, {
            type: RuntimeEventTypes.SESSION_LOADED,
            cwd: hostedSession.cwd,
            _meta: { managed: true, runwieldSessionId: cataloged.runwieldSessionId },
        });
        queueMicrotask(() => this.queues.scheduleQueuedMessageDrain(hostedSession.id));
        return { sessionId: hostedSession.id, cwd: hostedSession.cwd, runwieldSessionId: cataloged.runwieldSessionId };
    }

    async createSession(options: CreateSessionOptions): Promise<CreatedSession> {
        if (!options?.cwd || !isAbsolute(options.cwd)) {
            throw new Error("SessionRuntime.createSession requires an absolute cwd");
        }
        const deferPersistence =
            options.deferPersistenceUntilFirstMessage === true || Boolean(this.services.remotePersistence);
        const created = await this.createSessionShell(options.cwd, deferPersistence);
        const { agentName: requestedAgentName, mcpServers, selectDefaultAgent } = options;
        const agentName = requestedAgentName ?? (selectDefaultAgent ? AGENTS.ROUTER : undefined);
        if (!agentName && !mcpServers) return created;
        const hostedSession = this.services.sessionHost.requireSession(created.sessionId);
        try {
            if (mcpServers) hostedSession.setMcpRequestServers(mcpServers);
            if (!agentName) return created;
            if (deferPersistence) {
                const mcpIntegration = await this.settings.refreshMcpTools(hostedSession, mcpServers);
                if (mcpIntegration) await hostedSession.setMcpIntegration(mcpIntegration);
            }
            const activated = deferPersistence
                ? this.settings.markPromptReadyAgent(hostedSession.id, { agentName })
                : await this.settings.switchAgent(hostedSession.id, { agentName, mcpServers });
            if (!activated.ok) throw new Error(activated.error || "The Session could not start");
            if (requestedAgentName) hostedSession.mergePendingManagedTurnIntent({ agentName: requestedAgentName });
            return created;
        } catch (error) {
            await this.closeSession(hostedSession.id);
            throw error;
        }
    }

    private async createSessionShell(cwd: string, deferPersistence: boolean): Promise<CreatedSession> {
        const ownerCoordinationStore = this.services.sessionStore;
        if (!deferPersistence) await enterGitProjectRuntime(cwd);
        if (!ownerCoordinationStore && !deferPersistence) {
            throw new Error("Session Manager access is blocked: session_store_unavailable");
        }
        const managedProject = deferPersistence ? null : this.settings.ensureSessionProjectForCwd(cwd);
        if (!deferPersistence && !managedProject) {
            throw new Error("Session Manager create is blocked: project_identity_unavailable");
        }
        const sessionManager = deferPersistence ? null : await createRootSessionManager("new", cwd);
        let managedSession = null;
        let managedCurrentSegmentId = "";
        let managedProof = null;
        if (managedProject && ownerCoordinationStore) {
            try {
                if (!sessionManager) throw new Error("The Session could not be opened");
                const piSessionId = sessionManager.getSessionId?.();
                if (!piSessionId) throw new Error("The Session could not be persisted");
                const transcriptPath = await this.resolveCreatedSessionPath(cwd, sessionManager);
                const acquired = await ownerCoordinationStore.ensureSessionCatalogRecordAndAcquire({
                    locator: {
                        projectId: managedProject.projectId,
                        piSessionId,
                        transcriptPath,
                        transcriptCwd: cwd,
                        source: "created",
                    },
                    activation: {
                        ownerInstanceId: this.services.ownerInstanceId,
                        ownerProcessKind: this.services.ownerProcessKind,
                        phase: "preparing",
                    },
                });
                managedSession = acquired.session;
                const managedSegment = acquired.segment;
                managedProof = acquired.proof;
                recordSegmentLineageEvidence(sessionManager, {
                    segmentId: managedSegment.segmentId,
                    runwieldSessionId: managedSession.runwieldSessionId,
                    parentSegmentId: null,
                    parentPiSessionId: null,
                    lineageGroupKey: managedSegment.segmentId,
                    kind: "planning",
                });
                managedCurrentSegmentId = managedSegment.segmentId;
            } catch (error) {
                if (managedProof) {
                    try {
                        ownerCoordinationStore.releaseUnchangedActivation(managedProof);
                    } catch {
                        // Preserve the creation failure after best-effort lock release.
                    }
                }
                if (isRuntimeRootSessionManager(sessionManager)) sessionManager.dispose?.();
                throw error;
            }
        }
        const hostedSession = this.services.sessionHost.createSession({
            id: crypto.randomUUID(),
            sessionManager: sessionManager,
            cwd,
            managed: managedSession
                ? {
                      runwieldSessionId: managedSession.runwieldSessionId,
                      projectId: managedSession.projectId,
                      piSessionId: managedSession.piSessionId,
                      transcriptPath: managedSession.transcriptPath,
                      currentSegmentId: managedCurrentSegmentId,
                      generation: null,
                      acknowledgedGeneration: null,
                      acknowledgedEventId: null,
                      name: managedSession.displayName,
                      activeAgent: null,
                      workflowContext: null,
                      tutorialContext: null,
                      syncState: {
                          type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                          status: "syncing",
                          localGeneration: null,
                          latestGeneration: null,
                      },
                  }
                : null,
        });
        if (managedProof) this.managedOperations.setPendingCreationProof(hostedSession.id, managedProof);
        if (deferPersistence) {
            this.pendingManagedCreationProjects.set(hostedSession.id, { cwd });
        }
        this.events.attachRuntimeEventSink(hostedSession);
        if (managedProof && managedSession) {
            if (!ownerCoordinationStore) throw new Error("Session coordination is unavailable");
            let activeProof = managedProof;
            try {
                activeProof = ownerCoordinationStore.changeSessionActivationPhase(activeProof, "hydrated");
                activeProof = ownerCoordinationStore.changeSessionActivationPhase(activeProof, "checkpointing");
                await syncTranscriptFileAndParent(managedSession.transcriptPath);
                const evidence = await captureTranscriptEvidence({
                    transcriptPath: managedSession.transcriptPath,
                    transcriptCwd: hostedSession.cwd,
                });
                ownerCoordinationStore.publishGenerationAndRelease(activeProof, {
                    generation: 0,
                    byteLength: evidence.byteLength,
                    terminalEntryId: evidence.terminalEntryId,
                    digestHex: evidence.digestHex,
                    currentSegmentId: managedCurrentSegmentId,
                });
                const createdMetadata = hostedSession.getManagedMetadata();
                if (!createdMetadata) throw new Error("Session coordination was interrupted during creation");
                hostedSession.setManagedMetadata({
                    ...createdMetadata,
                    generation: 0,
                    acknowledgedGeneration: 0,
                });
                this.managedOperations.clearPendingCreationProof(hostedSession.id);
                hostedSession.dehydrateManagedSession();
                await this.sync.synchronizeManagedSession(hostedSession.id, {
                    emitEvents: false,
                    replayFromStart: true,
                });
            } catch (error) {
                this.managedOperations.clearPendingCreationProof(hostedSession.id);
                try {
                    ownerCoordinationStore.markSessionUncertain(activeProof, {
                        reason: error instanceof Error ? error.message : String(error),
                    });
                } catch {
                    // Preserve the creation failure.
                }
                hostedSession.dehydrateManagedSession();
                await this.closeSession(hostedSession.id);
                throw error;
            }
        }
        this.events.emitSessionEvent(hostedSession.id, {
            type: RuntimeEventTypes.SESSION_CREATED,
            cwd: hostedSession.cwd,
        });
        return {
            sessionId: hostedSession.id,
            cwd: hostedSession.cwd,
            sessionManagerId: sessionManager?.getSessionId?.() || null,
            startedAt: sessionManager?.getHeader?.()?.timestamp || new Date().toISOString(),
        };
    }

    async materializePromptReadySession(sessionId: string) {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) {
            throw new Error("SessionRuntime.materializePromptReadySession: session not found");
        }
        if (!this.pendingManagedCreationProjects.has(sessionId)) {
            throw new Error("SessionRuntime.materializePromptReadySession: session is not an unpersisted new shell");
        }
        const managed = await this.materializeDeferredManagedShell(hostedSession);
        const snapshot = this.reads.getSessionSnapshot(sessionId);
        if (!managed || !snapshot?.sessionManagerId) {
            throw new Error("SessionRuntime.materializePromptReadySession: session could not be persisted");
        }
        return snapshot;
    }
}
