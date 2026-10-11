import { getAgentDisplayName } from ".././agents.js";
import {
    expandPromptTemplate,
    expandSkillCommand,
    getRootSessionContextProjection,
    getRootSessionStaticContextTokens,
    listLoadedAgentMdFiles,
    listPromptTemplates,
    listSkills,
} from ".././session.js";
import { buildActiveConversationSubmissionMessage } from ".././session-user-messages.ts";
import {
    classifyRootSessionLocator,
    exportRootSessionToHtml,
    exportRootSessionToJsonl,
    getRootSessionBranchEntries,
    getRunWieldSessionMemoryBackupDir,
    listCatalogSafeRootSessionLocators,
} from ".././root-session.js";
import {
    buildProjectedSessionContextProjection,
    buildProjectedSessionInfo,
    captureTranscriptEvidence,
    createReplayEvents as createProjectedReplayEvents,
    exportProjectedTranscript,
    getProjectedLastAssistantText,
    inspectProjectedTranscript,
    toProjectionFailure,
} from ".././session-transcript-projection.js";
import { projectAggregateTranscript } from ".././session-transcript-manifest.ts";
import { listRecentResumableSessions } from ".././session-resume-list.ts";
import { buildSessionContextReport } from ".././session-context-report.ts";
import { deriveWorkflowContextFromExecutionWorkflow } from ".././workflow-context-session.js";
import { dirname, isAbsolute } from "@std/path";

import {
    getRuntimeContextCapacity,
    getRuntimeRootAgentSession,
    isRuntimeRootSessionManager,
    workflowProgressFactsFromActiveMeta,
} from "./support.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeQueues } from "./queues.ts";
import type { RuntimeLifecycle } from "./lifecycle.ts";

type ManagedProjection = Awaited<ReturnType<typeof projectAggregateTranscript>>;
type ManagedProjectionSuccess = Extract<ManagedProjection, { ok: true }>;
type TranscriptEntries = Awaited<ReturnType<typeof captureTranscriptEvidence>>["entries"];
interface ManagedCommittedProjection {
    ok: true;
    managed: import("../hosted-session.js").ManagedSessionMetadata;
    entries: TranscriptEntries;
    projection: ManagedProjectionSuccess;
}
interface ManagedProjectionFailure {
    ok: false;
    error: string;
    message: string;
    assistantMessages?: number;
    usedTokens?: number;
    agentDisplayName?: string;
    provider?: string;
    model?: string;
    usageState?: string;
    staticTokens?: number;
    activeMessageTokens?: number;
}
interface ReplayOptions {
    signal?: AbortSignal;
}
interface CommittedProjectionOptions extends ReplayOptions {
    completeHistory?: boolean;
}
type ProjectedSessionInfo =
    & Omit<
        ReturnType<typeof buildProjectedSessionInfo>,
        "compactionSettings" | "contextUsage"
    >
    & {
        ok?: true;
        compactionSettings?: import("./types.ts").RuntimeCompactionSettings | null;
        contextUsage?: import("../../types.js").ContextUsageSnapshot | null;
    };
type SessionInfoResult = ProjectedSessionInfo | ManagedProjectionFailure | null;
type SessionContextReportResult =
    | (ReturnType<typeof buildSessionContextReport> & { ok?: true })
    | ManagedProjectionFailure
    | null;

type RuntimeEventsDependency = Pick<RuntimeEvents, "consumePendingReplayEvents" | "emitSessionEvent" | "isBusy">;
type RuntimeQueuesDependency = Pick<RuntimeQueues, "getQueuedMessages">;
type RuntimeLifecycleDependency = Pick<RuntimeLifecycle, "getPendingProject">;

export class RuntimeReads {
    private events!: RuntimeEventsDependency;
    private queues!: RuntimeQueuesDependency;
    private lifecycle!: RuntimeLifecycleDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        queues: RuntimeQueuesDependency,
        lifecycle: RuntimeLifecycleDependency,
    ) {
        this.events = events;
        this.queues = queues;
        this.lifecycle = lifecycle;
    }
    private activeSessionInfoCache = new WeakMap<
        import("../hosted-session.js").MinimalSessionManagerLike,
        { leafId: string | null; info: ReturnType<typeof buildProjectedSessionInfo> }
    >();
    getSessionBackgroundTaskState(sessionId: string) {
        const tasks = this.services.sessionHost.getSession(sessionId)?.backgroundTasks;
        return tasks ? { active: tasks.activeCount, pending: tasks.pendingCompletions().length } : null;
    }
    listSessions() {
        return this.services.sessionHost.listSessions()
            .map((session) => this.getSessionSnapshot(session.id))
            .filter((snapshot) => snapshot !== null);
    }

    getActiveSessionInfo(
        session: import(".././hosted-session.js").HostedSession,
        sessionManager: import(".././hosted-session.js").MinimalSessionManagerLike,
    ) {
        const fallbackEntries = sessionManager.getLeafId ? null : sessionManager.getEntries?.() || [];
        const fallbackLeaf = fallbackEntries?.at(-1);
        const leafId = sessionManager.getLeafId?.() ??
            (fallbackLeaf && typeof fallbackLeaf === "object" && "id" in fallbackLeaf
                ? String(fallbackLeaf.id)
                : `entries:${fallbackEntries?.length || 0}`);
        const cached = this.activeSessionInfoCache.get(sessionManager);
        if (cached?.leafId === leafId) return cached.info;
        const info = buildProjectedSessionInfo(fallbackEntries || sessionManager.getEntries?.() || [], {
            sessionId: sessionManager.getSessionId?.() || session.id,
            cwd: session.cwd,
            transcriptPath: sessionManager.getSessionFile?.() || "In-memory",
        });
        this.activeSessionInfoCache.set(sessionManager, { leafId, info });
        return info;
    }

    getSessionSnapshot(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        const sessionManager = session.getRootSessionManager();
        const activeSessionInfo = sessionManager ? this.getActiveSessionInfo(session, sessionManager) : null;
        const managed = session.getManagedMetadata?.() || null;
        const pendingCreation = this.lifecycle.getPendingProject(sessionId) || null;
        const managedDormant = Boolean(managed && !sessionManager);
        const pendingManagedIntent = session.getPendingManagedTurnIntent?.() || {};
        const pendingAgentName = pendingManagedIntent.agentName || "";
        const rawSessionManagerId = sessionManager?.getSessionId?.();
        const sessionManagerId = managed
            ? managed.piSessionId
            : typeof rawSessionManagerId === "string" && rawSessionManagerId
            ? rawSessionManagerId
            : null;
        const activeExecutionWorkflow = session.getActiveExecutionWorkflow();
        const baseWorkflowContext = session.getWorkflowContext() ||
            (managedDormant ? managed?.workflowContext : null) ||
            deriveWorkflowContextFromExecutionWorkflow(activeExecutionWorkflow) || null;
        const activeInteractions = [...session.getActiveInteractions().values()];
        const liveQuestion = activeInteractions.some((record) =>
            record.request && record.request.type !== "plan_review" && record.request.type !== "code_review"
        );
        const livePlanReview = activeInteractions.some((record) => record.request?.type === "plan_review");
        const liveCodeReview = activeInteractions.some((record) => record.request?.type === "code_review");
        const liveReview = activeInteractions.find((record) =>
            record.request?.type === "plan_review" || record.request?.type === "code_review"
        );
        const workflowProgressFacts = activeExecutionWorkflow
            ? workflowProgressFactsFromActiveMeta(activeExecutionWorkflow.triageMeta || {})
            : Array.isArray(baseWorkflowContext?.progressFacts)
            ? baseWorkflowContext.progressFacts.map((fact) => ({ ...fact }))
            : [];
        const activeWorkflowMeta = activeExecutionWorkflow?.triageMeta || {};
        const hasValidationCheckpoint = workflowProgressFacts.some((fact) => fact.kind === "validation_checkpoint");
        const hasRepairCheckpoint = workflowProgressFacts.some((fact) =>
            fact.kind === "validation_checkpoint" && (fact.state === "awaiting_repair" || Boolean(fact.repairKind))
        );
        const tutorialContext = session.getTutorialContext?.() ||
            (managedDormant ? managed?.tutorialContext || null : null);
        const workflowContext = baseWorkflowContext
            ? {
                ...baseWorkflowContext,
                ...(typeof activeWorkflowMeta.planId === "string" ? { planId: activeWorkflowMeta.planId } : {}),
                ...(typeof activeWorkflowMeta.status === "string" ? { status: activeWorkflowMeta.status } : {}),
                ...(workflowProgressFacts.length ? { progressFacts: workflowProgressFacts } : {}),
                canReopenPlanReview: Boolean(
                    managed && this.services.sessionStore?.getLastPlanReview(
                        managed.runwieldSessionId,
                        managed.projectId,
                    ),
                ),
                liveQuestion,
                livePlanReview,
                liveCodeReview,
                liveReviewUrl: liveReview?.request?.reviewUrl,
                ...(baseWorkflowContext.canRun === true || activeWorkflowMeta.status === "ready_for_work"
                    ? { canRun: true }
                    : {}),
                ...(baseWorkflowContext.canResume === true || hasValidationCheckpoint ? { canResume: true } : {}),
                ...(baseWorkflowContext.canRecover === true || hasRepairCheckpoint ? { canRecover: true } : {}),
            }
            : null;
        const contextCapacity = getRuntimeContextCapacity(session);
        const systemContextTokens = getRootSessionStaticContextTokens(session);
        const activeModelState = session.getActiveModelState();
        const activeAgentInfo = session.getActiveAgentInfo();
        const liveSessionName = sessionManager?.getSessionName?.() || "";
        const managedModel = managedDormant ? managed?.model || "" : "";
        const managedProvider = managedDormant ? managed?.provider || "" : "";
        const managedThinkingLevel = managedDormant ? managed?.thinkingLevel || "" : "";
        const artifacts = managed && this.services.sessionStore
            ? this.services.sessionStore.listSessionArtifacts(managed.runwieldSessionId, managed.projectId)
            : [];
        const planAssociations = activeSessionInfo?.planAssociations ||
            (managed && this.services.sessionStore
                ? this.services.sessionStore.listSessionPlanAssociations(managed.runwieldSessionId, managed.projectId)
                    .filter((association) => Number.isInteger(association.committedGeneration))
                    .map(({ committedGeneration: _committedGeneration, ...association }) => association)
                : []);
        return {
            id: session.id,
            cwd: session.cwd,
            sessionManagerId,
            name: liveSessionName || activeSessionInfo?.name || managed?.name || pendingCreation?.name || null,
            sessionStats: activeSessionInfo
                ? {
                    userMessages: activeSessionInfo.userMessages,
                    assistantMessages: activeSessionInfo.assistantMessages,
                    toolCalls: activeSessionInfo.toolCalls,
                    compactionCount: activeSessionInfo.compactionCount,
                }
                : null,
            disposed: session.disposed,
            managed: managed
                ? {
                    runwieldSessionId: managed.runwieldSessionId,
                    projectId: managed.projectId,
                    currentSegmentId: managed.currentSegmentId,
                    generation: managed.generation,
                    acknowledgedGeneration: managed.acknowledgedGeneration ?? managed.generation ?? null,
                    acknowledgedEventId: managed.acknowledgedEventId ?? null,
                    syncState: managed.syncState
                        ? {
                            status: managed.syncState.status,
                            localGeneration: managed.syncState.localGeneration,
                            latestGeneration: managed.syncState.latestGeneration,
                            ...(managed.syncState.owningSurfaceKind
                                ? { owningSurfaceKind: managed.syncState.owningSurfaceKind }
                                : {}),
                            ...(managed.syncState.message ? { message: managed.syncState.message } : {}),
                        }
                        : null,
                    dormant: managedDormant,
                }
                : null,
            activeAgent: pendingAgentName || session.getRootAgentName() || activeAgentInfo?.agentName ||
                (managedDormant ? managed?.activeAgent || null : null),
            activeAgentInfo: pendingAgentName
                ? { displayName: pendingAgentName, model: "", provider: "", agentName: pendingAgentName }
                : activeAgentInfo,
            activeModel: {
                model: pendingManagedIntent.model || activeModelState.model || managedModel,
                provider: pendingManagedIntent.provider || activeModelState.provider || managedProvider,
            },
            thinkingLevel: pendingManagedIntent.thinkingLevel || managedThinkingLevel || session.getThinkingLevel(),
            busy: session.isTurnActive() || this.events.isBusy(session.id),
            livePlanReview,
            ...(livePlanReview && liveReview?.request?.reviewUrl
                ? { livePlanReviewUrl: liveReview.request.reviewUrl }
                : {}),
            activeTurnId: session.getActiveTurnId(),
            queuedMessages: this.queues.getQueuedMessages(session.id),
            workflowContext: workflowContext ? { ...workflowContext } : null,
            tutorialContext: tutorialContext
                ? { ...tutorialContext, shownExplanationIds: [...tutorialContext.shownExplanationIds] }
                : null,
            planAssociations,
            artifacts,
            activeExecutionWorkflow: activeExecutionWorkflow ? { ...activeExecutionWorkflow } : null,
            systemContextTokens,
            ...contextCapacity,
        };
    }

    getSessionProjectRoot(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        const managed = session.getManagedMetadata?.();
        if (!managed || !this.services.sessionStore) return session.cwd;
        return this.services.sessionStore.requireSessionProjectRoot(managed.projectId);
    }

    getRuntimeActiveAgentName(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        const pendingAgentName = session.getPendingManagedTurnIntent?.()?.agentName || "";
        if (pendingAgentName) return pendingAgentName;
        if (session.getManagedMetadata?.() && !session.getRootSessionManager?.()) return null;
        return session.getRootAgentName() || null;
    }

    getEffectiveAgentName(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        const pendingAgentName = session.getPendingManagedTurnIntent?.()?.agentName || "";
        if (pendingAgentName) return pendingAgentName;
        const managed = session.getManagedMetadata?.() || null;
        if (managed && !session.getRootSessionManager?.()) return managed.activeAgent || null;
        return session.getRootAgentName() || null;
    }

    getRuntimeActiveExecutionWorkflow(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        const workflow = session.getActiveExecutionWorkflow?.() || null;
        return workflow ? { ...workflow } : null;
    }

    isManagedSessionDormant(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        return Boolean(session?.getManagedMetadata?.() && !session.getRootSessionManager?.());
    }

    getUserTurnSubmissionBlockMessage(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        const syncState = session?.getManagedMetadata?.()?.syncState || null;
        if (!syncState) return null;
        if (syncState.status === "active_elsewhere") {
            return buildActiveConversationSubmissionMessage(syncState.owningSurfaceKind);
        }
        if (syncState.status === "blocked" || syncState.status === "degraded") {
            return syncState.message || "This Session needs recovery before accepting new input.";
        }
        return null;
    }

    async readManagedCommittedProjection(
        sessionId: string,
        options: CommittedProjectionOptions = {},
    ): Promise<ManagedCommittedProjection | ManagedProjectionFailure> {
        const session = this.services.sessionHost.getSession(sessionId);
        const managed = session?.getManagedMetadata?.() || null;
        if (!session || !managed) return { ok: false, error: "not_managed", message: "Session is not managed." };
        if (!this.services.sessionStore) {
            return { ok: false, error: "session_store_unavailable", message: "This Session is unavailable." };
        }
        let inspected;
        try {
            inspected = this.services.sessionStore.inspectSessionActivation(managed.runwieldSessionId);
        } catch (_error) {
            return { ok: false, error: "managed_read_blocked", message: "Managed read is unavailable." };
        }
        if (!inspected.generation) {
            return { ok: false, error: "committed_generation_unavailable", message: "Managed read is unavailable." };
        }
        try {
            const segments = this.services.sessionStore.listSessionTranscriptSegments(managed.runwieldSessionId);
            const projectionOptions = {
                cwd: session.cwd,
                sessionDir: dirname(managed.transcriptPath),
                runwieldSessionId: managed.runwieldSessionId,
                runtimeSessionId: sessionId,
                generation: inspected.generation,
                segments,
            };
            let projection = await projectAggregateTranscript(projectionOptions);
            if (!projection.ok) return { ok: false, error: projection.code, message: projection.message };
            // Pin generation and segments for the entire replay. Never mix pages from
            // a newer writer, or emit a partial history if a later page fails validation.
            const events = [...projection.events];
            while (options.completeHistory && !projection.complete) {
                if (
                    options.signal?.aborted || session.disposed ||
                    this.services.sessionHost.getSession(sessionId) !== session
                ) {
                    return { ok: false, error: "replay_canceled", message: "Session replay was canceled." };
                }
                projection = await projectAggregateTranscript({
                    ...projectionOptions,
                    cursorEventId: projection.nextCursor,
                    cursorEventOrdinal: projection.nextCursorOrdinal,
                });
                if (!projection.ok) return { ok: false, error: projection.code, message: projection.message };
                events.push(...projection.events);
            }
            projection = { ...projection, events };
            const evidence = await captureTranscriptEvidence({
                transcriptPath: managed.transcriptPath,
                transcriptCwd: session.cwd,
                byteLength: inspected.generation.byteLength,
            });
            return { ok: true, managed, entries: evidence.entries, projection };
        } catch (error) {
            const failure = toProjectionFailure(error);
            return { ok: false, error: failure.code, message: failure.message };
        }
    }

    async replaySession(sessionId: string, options: ReplayOptions = {}) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, replayed: 0, error: "not_found" };
        const canceled = () =>
            options.signal?.aborted || session.disposed ||
            this.services.sessionHost.getSession(sessionId) !== session;
        if (canceled()) return { ok: false, replayed: 0, error: "replay_canceled" };
        const emit = (events: Parameters<RuntimeEvents["emitSessionEvent"]>[1][]) => {
            let replayed = 0;
            for (const event of events) {
                if (canceled()) return { ok: false, replayed, error: "replay_canceled" };
                this.events.emitSessionEvent(sessionId, event);
                replayed += 1;
            }
            return { ok: true, replayed };
        };
        const pendingEvents = this.events.consumePendingReplayEvents(sessionId);
        if (pendingEvents.length > 0) {
            return emit(pendingEvents);
        }
        const managed = session.getManagedMetadata?.() || null;
        const manager = session.getRootSessionManager();
        if (managed && !manager) {
            const projected = await this.readManagedCommittedProjection(sessionId, {
                ...options,
                completeHistory: true,
            });
            if (!projected.ok) return { ok: false, replayed: 0, error: projected.error };
            return emit(projected.projection.events);
        }
        const events = createProjectedReplayEvents(sessionId, manager ? getRootSessionBranchEntries(manager) : []);
        return emit(events);
    }

    async getLastAssistantText(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        const managed = session?.getManagedMetadata?.() || null;
        if (managed && !session?.getRootSessionManager?.()) {
            const projected = await this.readManagedCommittedProjection(sessionId);
            return projected.ok ? getProjectedLastAssistantText(projected.entries) : {
                ok: false,
                error: projected.error,
                message: projected.message,
            };
        }
        const messages = (session ? getRuntimeRootAgentSession(session) : null)?.agent?.state?.messages || [];
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
            const text = message.content
                .map((block) => block.type === "text" ? block.text : "")
                .filter(Boolean)
                .join("\n")
                .trim();
            if (text) return text;
        }
        return null;
    }

    async getSessionInfo(sessionId: string): Promise<SessionInfoResult> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        const managed = session.getManagedMetadata?.() || null;
        const manager = session.getRootSessionManager();
        if (managed && !manager) {
            const projected = await this.readManagedCommittedProjection(sessionId);
            return projected.ok
                ? buildProjectedSessionInfo(projected.entries, {
                    sessionId: managed.piSessionId,
                    cwd: session.cwd,
                    transcriptPath: managed.transcriptPath,
                })
                : { ok: false, error: projected.error, message: projected.message };
        }
        const info: ProjectedSessionInfo = manager
            ? { ...this.getActiveSessionInfo(session, manager) }
            : buildProjectedSessionInfo([], {
                sessionId: session.id,
                cwd: session.cwd,
                transcriptPath: "In-memory",
            });
        const rootAgentSession = getRuntimeRootAgentSession(session);
        info.compactionSettings = rootAgentSession?.settingsManager?.getCompactionSettings?.() || null;
        info.contextUsage = getRuntimeContextCapacity(session).contextUsage;
        return info;
    }

    async getSessionContextReport(sessionId: string): Promise<SessionContextReportResult> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return null;
        if (session.getManagedMetadata?.() && !session.getRootSessionManager?.()) {
            const managed = session.getManagedMetadata?.();
            const projected = await this.readManagedCommittedProjection(sessionId);
            if (!projected.ok) return { ok: false, error: projected.error, message: projected.message };
            const info = buildProjectedSessionInfo(projected.entries, {
                sessionId,
                cwd: session.cwd,
                transcriptPath: session.getManagedMetadata?.()?.transcriptPath,
            });
            return buildSessionContextReport({
                agentName: managed?.activeAgent || "",
                agentDisplayName: managed?.activeAgent ? getAgentDisplayName(managed.activeAgent, session.cwd) : "",
                model: { provider: managed?.provider || "", model: managed?.model || "" },
                projection: buildProjectedSessionContextProjection(projected.entries),
                contextUsage: null,
                activeMessageTokens: info.inputTokens + info.outputTokens + info.cacheReadTokens +
                    info.cacheWriteTokens,
                contextWindow: null,
            });
        }
        const projection = getRootSessionContextProjection(session);
        if (!projection) return null;
        const rootAgentSession = getRuntimeRootAgentSession(session);
        const snapshot = this.getSessionSnapshot(sessionId);
        return buildSessionContextReport({
            agentName: projection.agentName,
            agentDisplayName: projection.agentDisplayName,
            model: snapshot?.activeModel || undefined,
            projection: projection.projection,
            contextUsage: rootAgentSession?.getContextUsage?.() || null,
            activeMessageTokens: projection.activeMessageTokens,
            contextWindow: rootAgentSession?.model?.contextWindow,
        });
    }

    async listPlanAssociatedSessions(
        cwd: string,
        planId: string,
    ): Promise<import("../plan-session-lookup.ts").PlanAssociatedSession[]> {
        if (!this.services.sessionStore) return [];
        const { findPlanAssociatedSessions } = await import("../plan-session-lookup.ts");
        return await findPlanAssociatedSessions(this.services.sessionStore, { cwd, planId });
    }

    async verifyPlanAssociatedSession(candidate: import(".././plan-session-lookup.ts").PlanAssociatedSession) {
        if (!this.services.sessionStore) return { ok: false, reason: "degraded" };
        const { verifyPlanAssociatedSession } = await import("../plan-session-lookup.ts");
        return await verifyPlanAssociatedSession(this.services.sessionStore, candidate);
    }

    getSessionMemoryBackupDir(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        const managed = session?.getManagedMetadata?.() || null;
        const manager = session?.getRootSessionManager();
        const persistedId = managed?.piSessionId || manager?.getSessionId?.();
        if (!session || !persistedId) throw new Error("Runtime session has no persisted session id.");
        return getRunWieldSessionMemoryBackupDir(session.cwd, persistedId);
    }

    async listResumableSessions(cwd: string) {
        if (!cwd || !isAbsolute(cwd)) {
            throw new Error("SessionRuntime.listResumableSessions requires an absolute cwd");
        }
        const sessionStore = this.services.sessionStoreOwner.ensure();
        return await listRecentResumableSessions(cwd, sessionStore);
    }

    async inspectUnmanagedResumableSession(options: { cwd: string; sessionId: string; sessionPath?: string }) {
        const { locators } = await listCatalogSafeRootSessionLocators(options.cwd);
        const locator = locators.find((candidate) =>
            candidate.piSessionId === options.sessionId &&
            (!options.sessionPath || candidate.sessionPath === options.sessionPath)
        );
        if (!locator) throw new Error("The Session transcript is unavailable");
        const evidence = await captureTranscriptEvidence({
            transcriptPath: locator.sessionPath,
            transcriptCwd: locator.headerCwd,
        });
        return inspectProjectedTranscript(evidence.entries);
    }

    async inspectResumableSession(options: { cwd: string; sessionId: string; sessionPath?: string }) {
        if (!this.services.sessionStore) {
            return {
                estimatedTokens: 0,
                messageCount: 0,
                model: null,
                ok: false,
                error: "session_store_unavailable",
            };
        }
        const classified = await classifyRootSessionLocator({
            cwd: options.cwd,
            sessionId: options.sessionId,
            sessionPath: options.sessionPath,
            ownerCoordinationStore: this.services.sessionStore,
        });
        if (classified.kind === "managed" && classified.session) {
            const inspected = this.services.sessionStore?.inspectSessionActivation(
                classified.session.runwieldSessionId,
            );
            if (!inspected?.generation) {
                return await this.inspectUnmanagedResumableSession(options);
            }
            try {
                const evidence = await captureTranscriptEvidence({
                    transcriptPath: classified.session.transcriptPath,
                    transcriptCwd: classified.session.transcriptCwd,
                    byteLength: inspected.generation.byteLength,
                });
                if (evidence.digestHex !== inspected.generation.digestHex) {
                    return { estimatedTokens: 0, messageCount: 0, model: null, ok: false, error: "evidence_mismatch" };
                }
                if (evidence.terminalEntryId !== inspected.generation.terminalEntryId) {
                    return { estimatedTokens: 0, messageCount: 0, model: null, ok: false, error: "terminal_mismatch" };
                }
                return inspectProjectedTranscript(evidence.entries);
            } catch (error) {
                return {
                    estimatedTokens: 0,
                    messageCount: 0,
                    model: null,
                    ok: false,
                    error: toProjectionFailure(error).code,
                };
            }
        }
        if (classified.kind === "blocked") {
            return {
                estimatedTokens: 0,
                messageCount: 0,
                model: null,
                ok: false,
                error: classified.reason || "managed_read_blocked",
            };
        }
        return await this.inspectUnmanagedResumableSession(options);
    }

    async listSessionPromptTemplates(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) throw new Error("SessionRuntime.listSessionPromptTemplates: session not found");
        return await listPromptTemplates({ cwd: session.cwd });
    }

    async listSessionSkills(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) throw new Error("SessionRuntime.listSessionSkills: session not found");
        return await listSkills({ cwd: session.cwd });
    }

    async listSessionContextFiles(sessionId: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) throw new Error("SessionRuntime.listSessionContextFiles: session not found");
        return await listLoadedAgentMdFiles(session.cwd);
    }

    async expandSessionSkillCommand(sessionId: string, skillName: string, instructions: string = "") {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) throw new Error("SessionRuntime.expandSessionSkillCommand: session not found");
        return await expandSkillCommand(skillName, instructions, session.cwd);
    }

    async expandSessionPromptTemplate(templatePath: string, instructions: string = "") {
        return await expandPromptTemplate(templatePath, instructions);
    }

    async exportSession(sessionId: string, outputPath: string) {
        const session = this.services.sessionHost.getSession(sessionId);
        const managed = session?.getManagedMetadata?.() || null;
        const manager = session?.getRootSessionManager();
        if (managed && !manager) {
            const projected = await this.readManagedCommittedProjection(sessionId);
            if (!projected.ok) throw new Error(projected.message);
            if (!session) throw new Error("Runtime session has no persistence store.");
            return await exportProjectedTranscript(projected.entries, {
                cwd: session.cwd,
                sessionId: managed.piSessionId,
            }, outputPath);
        }
        if (!isRuntimeRootSessionManager(manager)) {
            throw new Error("Runtime session has no persistence store.");
        }
        return outputPath.toLowerCase().endsWith(".jsonl")
            ? exportRootSessionToJsonl(manager, outputPath)
            : await exportRootSessionToHtml(manager, outputPath);
    }
}
