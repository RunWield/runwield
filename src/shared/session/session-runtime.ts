export {
    getConfiguredAgentModel,
    getConfiguredAgentThinkingLevel,
    listPromptTemplates,
    listSkills,
} from "./session.js";
export type { DequeueQueuedMessageResult, SteerSessionResult } from "./runtime/types.ts";
import { AGENTS } from "../../constants.js";
import { SessionHost } from "./session-host.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import { RuntimeServices } from "./runtime/base.ts";
import { RuntimeEvents } from "./runtime/events.ts";
import { RuntimeQueues } from "./runtime/queues.ts";
import { RuntimeReads } from "./runtime/reads.ts";
import { RuntimeManagedOperations } from "./runtime/managed-operations.ts";
import { RuntimeLifecycle } from "./runtime/lifecycle.ts";
import { RuntimeLifecycleLoading } from "./runtime/lifecycle-loading.ts";
import { RuntimeImages } from "./runtime/images.ts";
import { RuntimeLocalShell } from "./runtime/local-shell.ts";
import { RuntimeAgentSettings } from "./runtime/agent-settings.ts";
import { RuntimeManagedSync } from "./runtime/managed-sync.ts";
import { RuntimeWorkflows } from "./runtime/workflows.ts";
import { RuntimeTurns } from "./runtime/turns.ts";

import type { CreateSessionRuntimeOptions, SessionRuntimeComposition } from "./runtime/types.ts";
export { SessionTurnInProgressError } from "./runtime/support.ts";
export class SessionRuntime {
    readonly #events: RuntimeEvents;
    readonly #queues: RuntimeQueues;
    readonly #reads: RuntimeReads;
    readonly #managedOperations: RuntimeManagedOperations;
    readonly #lifecycle: RuntimeLifecycle;
    readonly #loading: RuntimeLifecycleLoading;
    readonly #images: RuntimeImages;
    readonly #shell: RuntimeLocalShell;
    readonly #settings: RuntimeAgentSettings;
    readonly #sync: RuntimeManagedSync;
    readonly #workflows: RuntimeWorkflows;
    readonly #turns: RuntimeTurns;

    constructor(composition: SessionRuntimeComposition) {
        const services = new RuntimeServices(composition);
        this.#events = new RuntimeEvents(services);
        this.#queues = new RuntimeQueues(services);
        this.#reads = new RuntimeReads(services);
        this.#managedOperations = new RuntimeManagedOperations(services);
        this.#lifecycle = new RuntimeLifecycle(services);
        this.#loading = new RuntimeLifecycleLoading(services);
        this.#images = new RuntimeImages(services);
        this.#shell = new RuntimeLocalShell(services);
        this.#settings = new RuntimeAgentSettings(services);
        this.#sync = new RuntimeManagedSync(services);
        this.#workflows = new RuntimeWorkflows(services);
        this.#turns = new RuntimeTurns(services);
        this.#queues.connect(this.#events, this.#images, this.#managedOperations, this.#sync, this.#turns);
        this.#reads.connect(this.#events, this.#queues, this.#lifecycle);
        this.#managedOperations.connect(
            this.#events,
            this.#queues,
            this.#reads,
            this.#turns,
            this.#lifecycle,
            this.#settings,
            this.#sync,
            this.#workflows,
        );
        this.#lifecycle.connect(
            this.#events,
            this.#queues,
            this.#managedOperations,
            this.#reads,
            this.#settings,
            this.#sync,
            this.#loading,
            this.#turns,
        );
        this.#loading.connect(
            this.#events,
            this.#managedOperations,
            this.#reads,
            this.#lifecycle,
            this.#settings,
            this.#sync,
            this.#workflows,
            this.#turns,
        );
        this.#images.connect(this.#managedOperations);
        this.#shell.connect(this.#events, this.#lifecycle, this.#managedOperations, this.#settings);
        this.#settings.connect(this.#events, this.#lifecycle, this.#managedOperations);
        this.#sync.connect(this.#events);
        this.#workflows.connect(
            this.#events,
            this.#lifecycle,
            this.#managedOperations,
            this.#queues,
            this.#reads,
            this.#settings,
            this.#sync,
            this.#turns,
        );
        this.#turns.connect(
            this.#events,
            this.#lifecycle,
            this.#managedOperations,
            this.#queues,
            this.#images,
            this.#settings,
            this.#sync,
            this.#workflows,
        );
    }

    retryWorkRecord(...args: Parameters<RuntimeWorkflows["retryWorkRecord"]>) {
        return this.#workflows.retryWorkRecord(...args);
    }
    listSessions(...args: Parameters<RuntimeReads["listSessions"]>) {
        return this.#reads.listSessions(...args);
    }
    getSessionSnapshot(...args: Parameters<RuntimeReads["getSessionSnapshot"]>) {
        return this.#reads.getSessionSnapshot(...args);
    }
    getSessionProjectRoot(...args: Parameters<RuntimeReads["getSessionProjectRoot"]>) {
        return this.#reads.getSessionProjectRoot(...args);
    }
    getRuntimeActiveAgentName(...args: Parameters<RuntimeReads["getRuntimeActiveAgentName"]>) {
        return this.#reads.getRuntimeActiveAgentName(...args);
    }
    getEffectiveAgentName(...args: Parameters<RuntimeReads["getEffectiveAgentName"]>) {
        return this.#reads.getEffectiveAgentName(...args);
    }
    getRuntimeActiveExecutionWorkflow(...args: Parameters<RuntimeReads["getRuntimeActiveExecutionWorkflow"]>) {
        return this.#reads.getRuntimeActiveExecutionWorkflow(...args);
    }
    isManagedSessionDormant(...args: Parameters<RuntimeReads["isManagedSessionDormant"]>) {
        return this.#reads.isManagedSessionDormant(...args);
    }
    getUserTurnSubmissionBlockMessage(...args: Parameters<RuntimeReads["getUserTurnSubmissionBlockMessage"]>) {
        return this.#reads.getUserTurnSubmissionBlockMessage(...args);
    }
    getSessionBackgroundTaskState(sessionId: string) {
        return this.#reads.getSessionBackgroundTaskState(sessionId);
    }
    getQueuedMessages(...args: Parameters<RuntimeQueues["getQueuedMessages"]>) {
        return this.#queues.getQueuedMessages(...args);
    }
    steerSession(...args: Parameters<RuntimeQueues["steerSession"]>) {
        return this.#queues.steerSession(...args);
    }
    queueNextTurnMessage(...args: Parameters<RuntimeQueues["queueNextTurnMessage"]>) {
        return this.#queues.queueNextTurnMessage(...args);
    }
    takeNextTurnMessage(...args: Parameters<RuntimeQueues["takeNextTurnMessage"]>) {
        return this.#queues.takeNextTurnMessage(...args);
    }
    dequeueLastQueuedMessage(...args: Parameters<RuntimeQueues["dequeueLastQueuedMessage"]>) {
        return this.#queues.dequeueLastQueuedMessage(...args);
    }
    clearQueuedMessages(...args: Parameters<RuntimeQueues["clearQueuedMessages"]>) {
        return this.#queues.clearQueuedMessages(...args);
    }
    markPromptReadyAgent(...args: Parameters<RuntimeAgentSettings["markPromptReadyAgent"]>) {
        return this.#settings.markPromptReadyAgent(...args);
    }
    renameSession(...args: Parameters<RuntimeAgentSettings["renameSession"]>) {
        return this.#settings.renameSession(...args);
    }
    setSessionModel(...args: Parameters<RuntimeAgentSettings["setSessionModel"]>) {
        return this.#settings.setSessionModel(...args);
    }
    reconfigureSessionModel(...args: Parameters<RuntimeAgentSettings["reconfigureSessionModel"]>) {
        return this.#settings.reconfigureSessionModel(...args);
    }
    setProjectStateContext(...args: Parameters<RuntimeAgentSettings["setProjectStateContext"]>) {
        return this.#settings.setProjectStateContext(...args);
    }
    updateTutorialContext(...args: Parameters<RuntimeAgentSettings["updateTutorialContext"]>) {
        return this.#settings.updateTutorialContext(...args);
    }
    runIsolatedAgent(...args: Parameters<RuntimeAgentSettings["runIsolatedAgent"]>) {
        return this.#settings.runIsolatedAgent(...args);
    }
    setActiveExecutionWorkflow(...args: Parameters<RuntimeAgentSettings["setActiveExecutionWorkflow"]>) {
        return this.#settings.setActiveExecutionWorkflow(...args);
    }
    clearActiveExecutionWorkflow(...args: Parameters<RuntimeAgentSettings["clearActiveExecutionWorkflow"]>) {
        return this.#settings.clearActiveExecutionWorkflow(...args);
    }
    reopenPlanReview(sessionId: string) {
        return this.#workflows.reopenPlanReview(sessionId, this);
    }
    runPlanAction(...args: Parameters<RuntimeWorkflows["runPlanAction"]>) {
        return this.#workflows.runPlanAction(...args);
    }
    reviewSavedPlan(...args: Parameters<RuntimeWorkflows["reviewSavedPlan"]>) {
        return this.#workflows.reviewSavedPlan(...args);
    }
    executePlan(...args: Parameters<RuntimeWorkflows["executePlan"]>) {
        return this.#workflows.executePlan(...args);
    }
    runPlanningAgent(...args: Parameters<RuntimeWorkflows["runPlanningAgent"]>) {
        return this.#workflows.runPlanningAgent(...args);
    }
    runSlicerAgent(...args: Parameters<RuntimeWorkflows["runSlicerAgent"]>) {
        return this.#workflows.runSlicerAgent(...args);
    }
    runEpicIntegrationGate(...args: Parameters<RuntimeWorkflows["runEpicIntegrationGate"]>) {
        return this.#workflows.runEpicIntegrationGate(...args);
    }
    runValidation(...args: Parameters<RuntimeWorkflows["runValidation"]>) {
        return this.#workflows.runValidation(...args);
    }
    setSessionAutoCompaction(...args: Parameters<RuntimeAgentSettings["setSessionAutoCompaction"]>) {
        return this.#settings.setSessionAutoCompaction(...args);
    }
    replaySession(...args: Parameters<RuntimeReads["replaySession"]>) {
        return this.#reads.replaySession(...args);
    }
    persistSessionImage(...args: Parameters<RuntimeImages["persistSessionImage"]>) {
        return this.#images.persistSessionImage(...args);
    }
    preflightSessionImages(...args: Parameters<RuntimeImages["preflightSessionImages"]>) {
        return this.#images.preflightSessionImages(...args);
    }
    preflightUserTurnImages(...args: Parameters<RuntimeImages["preflightUserTurnImages"]>) {
        return this.#images.preflightUserTurnImages(...args);
    }
    requestSessionHelp(...args: Parameters<RuntimeAgentSettings["requestSessionHelp"]>) {
        return this.#settings.requestSessionHelp(...args);
    }
    cycleSessionThinkingLevel(...args: Parameters<RuntimeAgentSettings["cycleSessionThinkingLevel"]>) {
        return this.#settings.cycleSessionThinkingLevel(...args);
    }
    runLocalShellCommand(...args: Parameters<RuntimeLocalShell["runLocalShellCommand"]>) {
        return this.#shell.runLocalShellCommand(...args);
    }
    compactSession(...args: Parameters<RuntimeAgentSettings["compactSession"]>) {
        return this.#settings.compactSession(...args);
    }
    reloadSession(...args: Parameters<RuntimeAgentSettings["reloadSession"]>) {
        return this.#settings.reloadSession(...args);
    }
    getLastAssistantText(...args: Parameters<RuntimeReads["getLastAssistantText"]>) {
        return this.#reads.getLastAssistantText(...args);
    }
    getSessionInfo(...args: Parameters<RuntimeReads["getSessionInfo"]>) {
        return this.#reads.getSessionInfo(...args);
    }
    getSessionContextReport(...args: Parameters<RuntimeReads["getSessionContextReport"]>) {
        return this.#reads.getSessionContextReport(...args);
    }
    listPlanAssociatedSessions(...args: Parameters<RuntimeReads["listPlanAssociatedSessions"]>) {
        return this.#reads.listPlanAssociatedSessions(...args);
    }
    verifyPlanAssociatedSession(...args: Parameters<RuntimeReads["verifyPlanAssociatedSession"]>) {
        return this.#reads.verifyPlanAssociatedSession(...args);
    }
    recordPlanAssociation(...args: Parameters<RuntimeWorkflows["recordPlanAssociation"]>) {
        return this.#workflows.recordPlanAssociation(...args);
    }
    getSessionMemoryBackupDir(...args: Parameters<RuntimeReads["getSessionMemoryBackupDir"]>) {
        return this.#reads.getSessionMemoryBackupDir(...args);
    }
    listResumableSessions(...args: Parameters<RuntimeReads["listResumableSessions"]>) {
        return this.#reads.listResumableSessions(...args);
    }
    inspectResumableSession(...args: Parameters<RuntimeReads["inspectResumableSession"]>) {
        return this.#reads.inspectResumableSession(...args);
    }
    listSessionPromptTemplates(...args: Parameters<RuntimeReads["listSessionPromptTemplates"]>) {
        return this.#reads.listSessionPromptTemplates(...args);
    }
    listSessionSkills(...args: Parameters<RuntimeReads["listSessionSkills"]>) {
        return this.#reads.listSessionSkills(...args);
    }
    listSessionContextFiles(...args: Parameters<RuntimeReads["listSessionContextFiles"]>) {
        return this.#reads.listSessionContextFiles(...args);
    }
    expandSessionSkillCommand(...args: Parameters<RuntimeReads["expandSessionSkillCommand"]>) {
        return this.#reads.expandSessionSkillCommand(...args);
    }
    expandSessionPromptTemplate(...args: Parameters<RuntimeReads["expandSessionPromptTemplate"]>) {
        return this.#reads.expandSessionPromptTemplate(...args);
    }
    exportSession(...args: Parameters<RuntimeReads["exportSession"]>) {
        return this.#reads.exportSession(...args);
    }
    setSessionThinkingLevel(...args: Parameters<RuntimeAgentSettings["setSessionThinkingLevel"]>) {
        return this.#settings.setSessionThinkingLevel(...args);
    }
    closeSession(...args: Parameters<RuntimeLifecycle["closeSession"]>) {
        return this.#lifecycle.closeSession(...args);
    }
    closeSessionWhenIdle(...args: Parameters<RuntimeLifecycle["closeSessionWhenIdle"]>) {
        return this.#lifecycle.closeSessionWhenIdle(...args);
    }
    closeAllSessions(...args: Parameters<RuntimeLifecycle["closeAllSessions"]>) {
        return this.#lifecycle.closeAllSessions(...args);
    }
    closeAllSessionsWhenIdle(...args: Parameters<RuntimeLifecycle["closeAllSessionsWhenIdle"]>) {
        return this.#lifecycle.closeAllSessionsWhenIdle(...args);
    }
    subscribeSessionEvents(...args: Parameters<RuntimeEvents["subscribeSessionEvents"]>) {
        return this.#events.subscribeSessionEvents(...args);
    }
    synchronizeManagedSession(...args: Parameters<RuntimeManagedSync["synchronizeManagedSession"]>) {
        return this.#sync.synchronizeManagedSession(...args);
    }
    ensureInitialSessionGeneration(...args: Parameters<RuntimeManagedSync["ensureInitialSessionGeneration"]>) {
        return this.#sync.ensureInitialSessionGeneration(...args);
    }
    adoptManagedSession(...args: Parameters<RuntimeLifecycle["adoptManagedSession"]>) {
        return this.#lifecycle.adoptManagedSession(...args);
    }
    promptUserTurn(...args: Parameters<RuntimeTurns["promptUserTurn"]>) {
        return this.#turns.promptUserTurn(...args);
    }
    promptManagedSession(...args: Parameters<RuntimeTurns["promptManagedSession"]>) {
        return this.#turns.promptManagedSession(...args);
    }
    rollManagedSessionSegment(...args: Parameters<RuntimeTurns["rollManagedSessionSegment"]>) {
        return this.#turns.rollManagedSessionSegment(...args);
    }
    createInteractiveSession(...args: Parameters<RuntimeLifecycle["createInteractiveSession"]>) {
        return this.#lifecycle.createInteractiveSession(...args);
    }
    createPromptReadySession(...args: Parameters<RuntimeLifecycle["createPromptReadySession"]>) {
        return this.#lifecycle.createPromptReadySession(...args);
    }
    materializePromptReadySession(...args: Parameters<RuntimeLifecycle["materializePromptReadySession"]>) {
        return this.#lifecycle.materializePromptReadySession(...args);
    }
    loadSession(...args: Parameters<RuntimeLifecycleLoading["loadSession"]>) {
        return this.#loading.loadSession(...args);
    }
    setInteractionAdapter(...args: Parameters<RuntimeLifecycleLoading["setInteractionAdapter"]>) {
        return this.#loading.setInteractionAdapter(...args);
    }
    answerInteraction(...args: Parameters<RuntimeLifecycleLoading["answerInteraction"]>) {
        return this.#loading.answerInteraction(...args);
    }
    requestInteraction(...args: Parameters<RuntimeLifecycleLoading["requestInteraction"]>) {
        return this.#loading.requestInteraction(...args);
    }
    switchAgent(...args: Parameters<RuntimeAgentSettings["switchAgent"]>) {
        return this.#settings.switchAgent(...args);
    }
    runMcpCommand(...args: Parameters<RuntimeAgentSettings["runMcpCommand"]>) {
        return this.#settings.runMcpCommand(...args);
    }
    cancelSession(...args: Parameters<RuntimeTurns["cancelSession"]>) {
        return this.#turns.cancelSession(...args);
    }
    promptSession(...args: Parameters<RuntimeTurns["promptSession"]>) {
        return this.#turns.promptSession(...args);
    }
    replaceSessionForExecutionFollowUp(
        ...args: Parameters<RuntimeLifecycleLoading["replaceSessionForExecutionFollowUp"]>
    ) {
        return this.#loading.replaceSessionForExecutionFollowUp(...args);
    }
}

export function createSessionRuntime(options: CreateSessionRuntimeOptions = {}): SessionRuntime {
    let sessionStore = options.sessionStore ?? null;
    let ownsSessionStore = false;
    if (!Object.hasOwn(options, "sessionStore")) {
        sessionStore = openFileSessionStore();
        ownsSessionStore = true;
    }
    return new SessionRuntime({
        sessionHost: new SessionHost(),
        sessionStore,
        ownsSessionStore,
        ownerProcessKind: options.ownerProcessKind ?? "test",
        ownerInstanceId: options.ownerInstanceId ?? crypto.randomUUID(),
    });
}
interface ManagedContinuationFacts {
    activation?: { state?: string | null } | null;
    generation?: { generation?: number | null } | null;
    projection?: { ok?: boolean; complete?: boolean; snapshot?: ManagedContinuationSnapshot | null } | null;
    expectedGeneration?: number | null;
}
interface ManagedContinuationSnapshot {
    activeAgent?: string | null;
    workflowContext?: RuntimeContinuationValue;
    activeExecutionWorkflow?: RuntimeContinuationValue;
}
type RuntimeContinuationValue =
    | string
    | number
    | boolean
    | null
    | RuntimeContinuationRecord
    | RuntimeContinuationValue[];
interface RuntimeContinuationRecord {
    [key: string]: RuntimeContinuationValue;
}
export function deriveManagedSessionContinuationDecision(facts: ManagedContinuationFacts) {
    if (facts.activation?.state !== "idle") {
        return { ok: false, code: "active_owner", message: "This Session is not idle." };
    }
    const generation = facts.generation?.generation ?? null;
    if (generation === null || generation !== facts.expectedGeneration) {
        return { ok: false, code: "stale_generation", message: "Refresh the Session before continuing." };
    }
    if (!facts.projection?.ok) {
        return { ok: false, code: "incomplete_projection", message: "The committed timeline is not complete." };
    }
    const snapshot = facts.projection.snapshot || {};
    return {
        ok: true,
        code: "continue",
        agentName: typeof snapshot.activeAgent === "string" && snapshot.activeAgent
            ? snapshot.activeAgent
            : AGENTS.ROUTER,
        message: "Ready for your next message.",
    };
}
