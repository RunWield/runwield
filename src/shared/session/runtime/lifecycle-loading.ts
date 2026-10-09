import { resolveResumeAgentName } from ".././active-agent-session.js";
import { resolveActiveWorkflowRuntimeAgent } from "../../workflow/execution-agent.ts";
import {
    classifyRootSessionLocator,
    getRootSessionBranchEntries,
    isPathInside,
    listPersistedRootSessions,
    openPersistedRootSession,
} from ".././root-session.js";
import { createSessionRuntimeEvent, RuntimeEventTypes } from ".././session-runtime-events.js";
import { createReplayEvents as createProjectedReplayEvents } from ".././session-transcript-projection.js";
import { requestHostedSessionInteraction } from ".././session-runtime-interactions.js";
import { sessionDirForRoot } from ".././file-session-storage.ts";
import { recordSegmentLineageEvidence } from ".././workflow-context-session.js";
import { isAbsolute } from "node:path";

import { enterGitProjectRuntime, isRuntimeRootSessionManager } from "./support.ts";
import type { LoadSessionOptions } from "./types.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";
import type { RuntimeReads } from "./reads.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";
import type { RuntimeAgentSettings } from "./agent-settings.ts";
import type { RuntimeManagedSync } from "./managed-sync.ts";
import type { RuntimeWorkflows } from "./workflows.ts";
import type { RuntimeTurns } from "./turns.ts";

type RuntimeEventsDependency = Pick<
    RuntimeEvents,
    "attachRuntimeEventSink" | "consumePendingReplayEvents" | "emitSessionEvent" | "replacePendingReplayEvents"
>;
type RuntimeManagedOperationsDependency = Pick<
    RuntimeManagedOperations,
    "currentCapability" | "runManagedStandaloneMutation" | "setPendingCreationProof"
>;
type RuntimeReadsDependency = Pick<RuntimeReads, "getRuntimeActiveAgentName">;
type RuntimeLifecycleDependency = Pick<RuntimeLifecycle, "adoptManagedSession" | "closeSession" | "hasPendingProject">;
type RuntimeAgentSettingsDependency = Pick<
    RuntimeAgentSettings,
    "activateSessionAgent" | "ensureSessionProjectForCwd" | "refreshMcpTools" | "renameSession" | "switchAgent"
>;
type RuntimeManagedSyncDependency = Pick<
    RuntimeManagedSync,
    "ensureInitialSessionGeneration" | "synchronizeManagedSession"
>;
type RuntimeWorkflowsDependency = Pick<RuntimeWorkflows, "recordPlanAssociation">;
type RuntimeTurnsDependency = Pick<RuntimeTurns, "rollManagedSessionSegment">;

export class RuntimeLifecycleLoading {
    private events!: RuntimeEventsDependency;
    private managedOperations!: RuntimeManagedOperationsDependency;
    private reads!: RuntimeReadsDependency;
    private lifecycle!: RuntimeLifecycleDependency;
    private settings!: RuntimeAgentSettingsDependency;
    private sync!: RuntimeManagedSyncDependency;
    private workflows!: RuntimeWorkflowsDependency;
    private turns!: RuntimeTurnsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        managedOperations: RuntimeManagedOperationsDependency,
        reads: RuntimeReadsDependency,
        lifecycle: RuntimeLifecycleDependency,
        settings: RuntimeAgentSettingsDependency,
        sync: RuntimeManagedSyncDependency,
        workflows: RuntimeWorkflowsDependency,
        turns: RuntimeTurnsDependency,
    ) {
        this.events = events;
        this.managedOperations = managedOperations;
        this.reads = reads;
        this.lifecycle = lifecycle;
        this.settings = settings;
        this.sync = sync;
        this.workflows = workflows;
        this.turns = turns;
    }
    async replaceSessionForExecutionFollowUp(
        oldSessionId: string,
        workflow: import("../../types.js").ActiveExecutionWorkflow,
    ) {
        const oldSession = this.services.sessionHost.getSession(oldSessionId);
        if (!oldSession) throw new Error("SessionRuntime.replaceSessionForExecutionFollowUp: old session not found");
        const executionCwd = typeof workflow?.executionCwd === "string" ? workflow.executionCwd : "";
        if (!executionCwd || !isAbsolute(executionCwd)) {
            throw new Error("SessionRuntime.replaceSessionForExecutionFollowUp requires an absolute execution cwd");
        }
        const executionAgent = resolveActiveWorkflowRuntimeAgent(workflow);
        if (!executionAgent) {
            throw new Error("SessionRuntime.replaceSessionForExecutionFollowUp requires an execution Agent");
        }
        const originalCwd = oldSession.cwd;
        const originalAgent = this.reads.getRuntimeActiveAgentName(oldSession.id);
        const originalWorkflow = oldSession.getActiveExecutionWorkflow?.() || null;
        try {
            const switched = await this.settings.switchAgent(oldSession.id, {
                agentName: executionAgent,
                cwd: executionCwd,
                mcpRootTools: oldSession.getMcpRootTools?.() || [],
            });
            if (!switched?.ok) throw new Error(switched?.error || "Execution follow-up Agent switch failed");
            oldSession.setActiveExecutionWorkflow(workflow);
            const managed = oldSession.getManagedMetadata?.();
            if (managed) {
                await this.turns.rollManagedSessionSegment(oldSession.id, {
                    kind: "execution",
                    continuation: JSON.parse(JSON.stringify({
                        kind: "execution",
                        activeWorkflow: workflow,
                        executionOwner: executionAgent,
                    })),
                    expectedGeneration: managed.generation,
                });
            }
            const planId = typeof workflow?.triageMeta?.planId === "string" ? workflow.triageMeta.planId : "";
            const planName = typeof workflow?.planName === "string" ? workflow.planName : "";
            if (planId && planName) {
                const recorded = await this.workflows.recordPlanAssociation(oldSession.id, {
                    planId,
                    planName,
                    purpose: "execution",
                });
                if (recorded?.ok === false) throw new Error(recorded.error || "Execution Plan Association failed");
            }
            if (workflow.planName) await this.settings.renameSession(oldSession.id, workflow.planName);
            this.events.emitSessionEvent(oldSession.id, {
                type: RuntimeEventTypes.SESSION_REPLACED,
                oldSessionId: oldSession.id,
                newSessionId: oldSession.id,
                reason: "execution_follow_up",
                planName: workflow.planName || "Plan follow-up",
            });
            return oldSession.id;
        } catch (error) {
            oldSession.rebindProjectRoot(originalCwd);
            oldSession.setActiveExecutionWorkflow(originalWorkflow);
            if (originalAgent && originalAgent !== this.reads.getRuntimeActiveAgentName(oldSession.id)) {
                let restored;
                try {
                    restored = await this.settings.switchAgent(oldSession.id, {
                        agentName: originalAgent,
                        mcpRootTools: oldSession.getMcpRootTools?.() || [],
                        releaseActiveWorkflow: false,
                    });
                } catch (restoreError) {
                    throw new Error(
                        `Execution follow-up failed and the original Agent could not be restored: ${
                            restoreError instanceof Error ? restoreError.message : String(restoreError)
                        }`,
                        { cause: error },
                    );
                }
                if (!restored?.ok) {
                    throw new Error(
                        `Execution follow-up failed and the original Agent could not be restored: ${
                            restored?.error || "restore_failed"
                        }`,
                        { cause: error },
                    );
                }
            }
            throw error;
        }
    }

    async loadSession(options: LoadSessionOptions) {
        if (!options?.cwd || !isAbsolute(options.cwd)) {
            throw new Error("SessionRuntime.loadSession requires an absolute cwd");
        }
        if (!options.sessionId || typeof options.sessionId !== "string") {
            throw new Error("SessionRuntime.loadSession requires a session id");
        }
        await enterGitProjectRuntime(options.cwd);
        const ownerCoordinationStore = this.services.sessionStore;
        if (!ownerCoordinationStore) {
            throw new Error("Session Manager load is blocked: session_store_unavailable");
        }
        const managedProject = this.settings.ensureSessionProjectForCwd(options.cwd);
        if (!managedProject) throw new Error("Session Manager load is blocked: project_identity_unavailable");
        let sessionPath = options.sessionPath;
        if (!sessionPath) {
            const persisted = await listPersistedRootSessions(options.cwd);
            sessionPath = persisted.find((session) => session.id === options.sessionId)?.path;
        }
        const classified = await classifyRootSessionLocator({
            cwd: options.cwd,
            sessionId: options.sessionId,
            sessionPath,
            ownerCoordinationStore,
        });
        if (classified.kind === "blocked") {
            throw new Error(`Session Manager load is blocked: ${classified.reason}`);
        }
        if (classified.kind === "managed") {
            if (classified.session) {
                const managedSession = classified.session;
                let inspected = ownerCoordinationStore.inspectSessionActivation(
                    managedSession.runwieldSessionId,
                );
                if (
                    ["uncertain", "reconcile_required"].includes(inspected.activation?.state || "") ||
                    (!inspected.generation && inspected.activation?.state === "uninitialized")
                ) {
                    await this.sync.ensureInitialSessionGeneration(managedSession.runwieldSessionId);
                    inspected = ownerCoordinationStore.inspectSessionActivation(managedSession.runwieldSessionId);
                }
                if (inspected.generation) {
                    const adopted = this.lifecycle.adoptManagedSession({
                        session: managedSession,
                        generation: inspected.generation.generation,
                    });
                    const sync = await this.sync.synchronizeManagedSession(adopted.sessionId, { emitEvents: false });
                    const adoptedHostedSession = this.services.sessionHost.getSession(adopted.sessionId);
                    if (!adoptedHostedSession) throw new Error("Session Manager load did not retain adopted Session");
                    const mcpIntegration = await this.settings.refreshMcpTools(
                        adoptedHostedSession,
                        options.mcpServers,
                    );
                    if (mcpIntegration) await adoptedHostedSession.setMcpIntegration(mcpIntegration);
                    const setupEvents = this.events.consumePendingReplayEvents(adopted.sessionId);
                    const replayEvents = sync.ok
                        ? setupEvents.concat(
                            (sync.events || []).map((event) => createSessionRuntimeEvent(adopted.sessionId, event)),
                        )
                        : setupEvents;
                    this.events.replacePendingReplayEvents(adopted.sessionId, replayEvents);
                    return {
                        sessionId: adopted.sessionId,
                        cwd: adopted.cwd,
                        replayEvents,
                        sessionManagerId: managedSession.piSessionId,
                        sessionPath: managedSession.transcriptPath,
                    };
                }
            }
        }
        if (classified.kind !== "managed" || !classified.session) {
            throw new Error("Session Manager load is blocked: session_identity_unavailable");
        }
        const managedSession = classified.session;
        const managedSegment = ownerCoordinationStore.getCurrentSessionSegment(managedSession.runwieldSessionId);
        if (!managedSegment) throw new Error("Session Manager load is blocked: session_segment_unavailable");
        const managedProof = ownerCoordinationStore.acquireSessionActivation({
            runwieldSessionId: managedSession.runwieldSessionId,
            projectId: managedSession.projectId,
            ownerInstanceId: this.services.ownerInstanceId,
            ownerProcessKind: this.services.ownerProcessKind,
            expectedGeneration: null,
            phase: "preparing",
        });
        let opened = null;
        let agentName = "";
        try {
            const transcriptProjectRoot = ownerCoordinationStore.requireSessionProjectRoot(managedSession.projectId);
            const transcriptProjectSessionDir = sessionDirForRoot(ownerCoordinationStore.path, transcriptProjectRoot);
            const managedTranscriptPath = sessionPath || managedSession.transcriptPath;
            const managedProjectSessionDir = isPathInside(managedTranscriptPath, transcriptProjectSessionDir)
                ? transcriptProjectSessionDir
                : undefined;
            opened = await openPersistedRootSession({
                cwd: options.cwd,
                sessionId: options.sessionId,
                sessionPath: managedTranscriptPath,
                sessionDir: managedProjectSessionDir,
                managedProjectRoot: managedProjectSessionDir ? transcriptProjectRoot : undefined,
                managedSegmentCwd: managedProjectSessionDir ? managedSegment.transcriptCwd : undefined,
            });
            const sessionManager = opened.sessionManager;
            recordSegmentLineageEvidence(sessionManager, {
                segmentId: managedSegment.segmentId,
                runwieldSessionId: managedSession.runwieldSessionId,
                parentSegmentId: managedSegment.lineageParentSegmentId,
                parentPiSessionId: managedSegment.lineageParentPiSessionId,
                lineageGroupKey: managedSegment.lineageGroupKey || managedSegment.segmentId,
                kind: managedSegment.kind === "execution" || managedSegment.kind === "semantic_repair"
                    ? managedSegment.kind
                    : "planning",
            });
            agentName = await resolveResumeAgentName(sessionManager);
        } catch (error) {
            if (isRuntimeRootSessionManager(opened?.sessionManager)) opened?.sessionManager.dispose?.();
            ownerCoordinationStore.releaseUnchangedActivation(managedProof);
            throw error;
        }
        if (!opened) throw new Error("Session coordination was interrupted during load");
        const { sessionManager, resolved } = opened;
        const hostedSession = this.services.sessionHost.createSession({
            id: crypto.randomUUID(),
            sessionManager: sessionManager,
            cwd: options.cwd,
            managed: {
                runwieldSessionId: managedSession.runwieldSessionId,
                projectId: managedSession.projectId,
                piSessionId: managedSession.piSessionId,
                transcriptPath: managedSession.transcriptPath,
                currentSegmentId: managedSegment.segmentId,
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
            },
        });
        this.managedOperations.setPendingCreationProof(hostedSession.id, managedProof);
        this.events.attachRuntimeEventSink(hostedSession);
        try {
            await this.settings.activateSessionAgent(hostedSession, {
                agentName,
                model: options.modelOverride,
                mcpServers: options.mcpServers,
            });
            const setupEvents = this.events.consumePendingReplayEvents(hostedSession.id);
            const replayEvents = setupEvents.concat(
                createProjectedReplayEvents(
                    hostedSession.id,
                    getRootSessionBranchEntries(sessionManager),
                )
                    .map((event) => createSessionRuntimeEvent(hostedSession.id, event)),
            );
            this.events.replacePendingReplayEvents(hostedSession.id, replayEvents);
            this.events.emitSessionEvent(hostedSession.id, {
                type: RuntimeEventTypes.SESSION_LOADED,
                cwd: hostedSession.cwd,
                _meta: { sessionManagerId: resolved.sessionId, sessionPath: resolved.sessionPath },
            });
            return {
                sessionId: hostedSession.id,
                cwd: hostedSession.cwd,
                replayEvents,
                sessionManagerId: resolved.sessionId,
                sessionPath: resolved.sessionPath,
            };
        } catch (error) {
            await this.lifecycle.closeSession(hostedSession.id);
            throw error;
        }
    }

    setInteractionAdapter(
        sessionId: string,
        adapter: import(".././session-runtime-interactions.js").RuntimeInteractionAdapter | null,
    ) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, error: "not_found" };
        session.setInteractionAdapter(adapter);
        return { ok: true };
    }

    answerInteraction(
        sessionId: string,
        interactionId: string,
        response: import("../session-runtime-interactions.js").RuntimeInteractionResponse,
    ) {
        const record = this.services.sessionHost.getSession(sessionId)?.getActiveInteractions().get(interactionId);
        if (!record?.answer || record.request?._meta?.source !== "user_interview") return false;
        try {
            record.answer(response, "acp");
            return true;
        } catch {
            return false;
        }
    }

    async requestInteraction(
        sessionId: string,
        request: import(".././session-runtime-interactions.js").RuntimeInteractionRequest,
        signal?: AbortSignal,
    ): Promise<import("./types.ts").RuntimeInteractionResult> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { outcome: "unsupported", message: "Session not found." };
        session.localInputSurface = this.services.ownerProcessKind;
        const capability = this.managedOperations.currentCapability(sessionId);
        if (capability) return await requestHostedSessionInteraction(session, request, signal, capability);
        if (this.lifecycle.hasPendingProject(sessionId) && !session.getManagedMetadata?.()) {
            return await requestHostedSessionInteraction(session, request, signal, null);
        }
        return await this.managedOperations.runManagedStandaloneMutation(
            sessionId,
            "workflow_operation",
            (activeSession, operationCapability) =>
                requestHostedSessionInteraction(activeSession, request, signal, operationCapability),
            { activateAgent: false, hydrate: false },
        );
    }
}
