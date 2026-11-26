import { AGENTS } from "../../src/shared/session/agent-registry.ts";
import { SessionHost } from "./host.ts";
import { openFileSessionStore } from "../../src/shared/session/file-session-store.ts";
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

import type {
    CreateSessionOptions,
    CreateSessionRuntimeOptions,
    ResumeSessionOptions,
    SessionRuntimeComposition,
} from "./runtime/types.ts";
import type { CreatedSession, ResumedSession, SessionRuntime as SessionRuntimeContract } from "./contract.ts";

// Runtime ownership is not a test capability. It routes a settled root turn
// back to the Session that owns its managed writer and interaction adapter.
const planReviewRuntimeOwners = new WeakMap<import("./host.ts").HostedSession, SessionRuntime>();

/** Continue a Plan review using the runtime that owns the live Session. */
export async function rearmPlanReviewConversation(
    session: import("./host.ts").HostedSession,
    planName: string,
    planningAgentName: string,
): Promise<import("@runwield/workflow/events").PlanWrittenEventPayload> {
    if (session.planReviewConversations.canceled) return { outcome: "canceled", planName };
    try {
        const runtime = planReviewRuntimeOwners.get(session);
        if (!runtime) throw new Error("The Plan review has no owning Session runtime.");
        return await runtime.continuePlanReviewConversation(session.id, planName, planningAgentName);
    } catch (error) {
        session.planReviewConversations.failActive(error instanceof Error ? error.message : String(error));
        throw error;
    }
}

/** Local interactive Session implementation used by TUI, ACP and Workspace. */
export class SessionRuntime implements SessionRuntimeContract {
    readonly #host: SessionHost;

    #ownPlanReviewRuntime(sessionId: string): void {
        const session = this.#host.getSession(sessionId);
        if (session) planReviewRuntimeOwners.set(session, this);
    }
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

    /** Bind this interactive runtime to its host, owner and storage services. */
    constructor(composition: SessionRuntimeComposition) {
        this.#host = composition.sessionHost;
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

    /** Resume recording delivery evidence for a previous execution. */
    retryWorkRecord(...args: Parameters<RuntimeWorkflows["retryWorkRecord"]>) {
        return this.#workflows.retryWorkRecord(...args);
    }
    /** List the Sessions held by this runtime. */
    listSessions(...args: Parameters<RuntimeReads["listSessions"]>) {
        return this.#reads.listSessions(...args);
    }
    /** Read the current identity, selected agent, queue and turn state of an open Session. */
    getSessionSnapshot(...args: Parameters<RuntimeReads["getSessionSnapshot"]>) {
        return this.#reads.getSessionSnapshot(...args);
    }
    /** Resolve the owning checkout for an open Session. */
    getSessionProjectRoot(...args: Parameters<RuntimeReads["getSessionProjectRoot"]>) {
        return this.#reads.getSessionProjectRoot(...args);
    }
    /** Read the active agent from the live Session. */
    getRuntimeActiveAgentName(...args: Parameters<RuntimeReads["getRuntimeActiveAgentName"]>) {
        return this.#reads.getRuntimeActiveAgentName(...args);
    }
    /** Resolve the agent that will receive input, including pending or dormant selection. */
    getEffectiveAgentName(...args: Parameters<RuntimeReads["getEffectiveAgentName"]>) {
        return this.#reads.getEffectiveAgentName(...args);
    }
    /** Read the execution workflow attached to this Session. */
    getRuntimeActiveExecutionWorkflow(...args: Parameters<RuntimeReads["getRuntimeActiveExecutionWorkflow"]>) {
        return this.#reads.getRuntimeActiveExecutionWorkflow(...args);
    }
    /** Check whether the managed Session is waiting for activation. */
    isManagedSessionDormant(...args: Parameters<RuntimeReads["isManagedSessionDormant"]>) {
        return this.#reads.isManagedSessionDormant(...args);
    }
    /** Return the reason the Session cannot accept a user turn, if any. */
    getUserTurnSubmissionBlockMessage(...args: Parameters<RuntimeReads["getUserTurnSubmissionBlockMessage"]>) {
        return this.#reads.getUserTurnSubmissionBlockMessage(...args);
    }
    /** Read the Session's outstanding background work. */
    getSessionBackgroundTaskState(sessionId: string) {
        return this.#reads.getSessionBackgroundTaskState(sessionId);
    }
    /** List messages waiting for this Session to process. */
    getQueuedMessages(...args: Parameters<RuntimeQueues["getQueuedMessages"]>) {
        return this.#queues.getQueuedMessages(...args);
    }
    /** Deliver steering input to the active turn. */
    steerSession(...args: Parameters<RuntimeQueues["steerSession"]>) {
        return this.#queues.steerSession(...args);
    }
    /** Queue input to start a later turn. */
    queueNextTurnMessage(...args: Parameters<RuntimeQueues["queueNextTurnMessage"]>) {
        return this.#queues.queueNextTurnMessage(...args);
    }
    /** Claim the oldest message intended for the next turn. */
    takeNextTurnMessage(...args: Parameters<RuntimeQueues["takeNextTurnMessage"]>) {
        return this.#queues.takeNextTurnMessage(...args);
    }
    /** Remove the newest queued message so the sender can edit it. */
    dequeueLastQueuedMessage(...args: Parameters<RuntimeQueues["dequeueLastQueuedMessage"]>) {
        return this.#queues.dequeueLastQueuedMessage(...args);
    }
    /** Discard pending input and publish the queue change. */
    clearQueuedMessages(...args: Parameters<RuntimeQueues["clearQueuedMessages"]>) {
        return this.#queues.clearQueuedMessages(...args);
    }
    /** Remember the initial agent before a new Session is persisted. */
    markPromptReadyAgent(...args: Parameters<RuntimeAgentSettings["markPromptReadyAgent"]>) {
        return this.#settings.markPromptReadyAgent(...args);
    }
    /** Update the name shown for the Session. */
    renameSession(...args: Parameters<RuntimeAgentSettings["renameSession"]>) {
        return this.#settings.renameSession(...args);
    }
    /** Select the model used for the Session's subsequent work. */
    setSessionModel(...args: Parameters<RuntimeAgentSettings["setSessionModel"]>) {
        return this.#settings.setSessionModel(...args);
    }
    /** Apply a model configuration change to the Session. */
    reconfigureSessionModel(...args: Parameters<RuntimeAgentSettings["reconfigureSessionModel"]>) {
        return this.#settings.reconfigureSessionModel(...args);
    }
    /** Set the project information available to agents in this Session. */
    setProjectStateContext(...args: Parameters<RuntimeAgentSettings["setProjectStateContext"]>) {
        return this.#settings.setProjectStateContext(...args);
    }
    /** Apply tutorial progress to the current Session context. */
    updateTutorialContext(...args: Parameters<RuntimeAgentSettings["updateTutorialContext"]>) {
        return this.#settings.updateTutorialContext(...args);
    }
    /** Run an agent with its own turn context for this Session. */
    runIsolatedAgent(...args: Parameters<RuntimeAgentSettings["runIsolatedAgent"]>) {
        return this.#settings.runIsolatedAgent(...args);
    }
    /** Attach the current execution workflow to the Session. */
    setActiveExecutionWorkflow(...args: Parameters<RuntimeAgentSettings["setActiveExecutionWorkflow"]>) {
        return this.#settings.setActiveExecutionWorkflow(...args);
    }
    /** Clear the workflow associated with this Session. */
    clearActiveExecutionWorkflow(...args: Parameters<RuntimeAgentSettings["clearActiveExecutionWorkflow"]>) {
        return this.#settings.clearActiveExecutionWorkflow(...args);
    }
    /** Reopen the Session's pending Plan review. */
    reopenPlanReview(sessionId: string) {
        this.#ownPlanReviewRuntime(sessionId);
        return this.#workflows.reopenPlanReview(sessionId, this);
    }
    /** Resume the review conversation with the agent responsible for the Plan. */
    continuePlanReviewConversation(sessionId: string, planName: string, planningAgentName: string) {
        return this.#workflows.continuePlanReviewConversation(sessionId, this, planName, planningAgentName);
    }
    /** Apply a selected lifecycle action to a Plan in the Session. */
    runPlanAction(...args: Parameters<RuntimeWorkflows["runPlanAction"]>) {
        return this.#workflows.runPlanAction(...args);
    }
    /** Open a saved Plan for review in its Session. */
    reviewSavedPlan(...args: Parameters<RuntimeWorkflows["reviewSavedPlan"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#workflows.reviewSavedPlan(...args);
    }
    /** Start execution of a selected Plan through the workflow. */
    executePlan(...args: Parameters<RuntimeWorkflows["executePlan"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#workflows.executePlan(...args);
    }
    /** Run the planning agent with the supplied input. */
    runPlanningAgent(...args: Parameters<RuntimeWorkflows["runPlanningAgent"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#workflows.runPlanningAgent(...args);
    }
    /** Run the slicer to divide an Epic into Plans. */
    runSlicerAgent(...args: Parameters<RuntimeWorkflows["runSlicerAgent"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#workflows.runSlicerAgent(...args);
    }
    /** Evaluate the integration gate for an Epic. */
    runEpicIntegrationGate(...args: Parameters<RuntimeWorkflows["runEpicIntegrationGate"]>) {
        return this.#workflows.runEpicIntegrationGate(...args);
    }
    /** Run the configured validation workflow and collect its result. */
    runValidation(...args: Parameters<RuntimeWorkflows["runValidation"]>) {
        return this.#workflows.runValidation(...args);
    }
    /** Change whether the Session automatically compacts its context. */
    setSessionAutoCompaction(...args: Parameters<RuntimeAgentSettings["setSessionAutoCompaction"]>) {
        return this.#settings.setSessionAutoCompaction(...args);
    }
    /** Project the Session's saved history into ordered runtime events. */
    replaySession(...args: Parameters<RuntimeReads["replaySession"]>) {
        return this.#reads.replaySession(...args);
    }
    /** Store an image and return its Session attachment reference. */
    persistSessionImage(...args: Parameters<RuntimeImages["persistSessionImage"]>) {
        return this.#images.persistSessionImage(...args);
    }
    /** Check whether the selected model and Session can accept the supplied images. */
    preflightSessionImages(...args: Parameters<RuntimeImages["preflightSessionImages"]>) {
        return this.#images.preflightSessionImages(...args);
    }
    /** Check attachments for a user turn before submitting the request. */
    preflightUserTurnImages(...args: Parameters<RuntimeImages["preflightUserTurnImages"]>) {
        return this.#images.preflightUserTurnImages(...args);
    }
    /** Request the Session's interactive help. */
    requestSessionHelp(...args: Parameters<RuntimeAgentSettings["requestSessionHelp"]>) {
        return this.#settings.requestSessionHelp(...args);
    }
    /** Select the next supported thinking level. */
    cycleSessionThinkingLevel(...args: Parameters<RuntimeAgentSettings["cycleSessionThinkingLevel"]>) {
        return this.#settings.cycleSessionThinkingLevel(...args);
    }
    /** Execute a shell command in the Session's working environment. */
    runLocalShellCommand(...args: Parameters<RuntimeLocalShell["runLocalShellCommand"]>) {
        return this.#shell.runLocalShellCommand(...args);
    }
    /** Compact the active agent's conversation history. */
    compactSession(...args: Parameters<RuntimeAgentSettings["compactSession"]>) {
        return this.#settings.compactSession(...args);
    }
    /** Reload the Session's agent resources. */
    reloadSession(...args: Parameters<RuntimeAgentSettings["reloadSession"]>) {
        return this.#settings.reloadSession(...args);
    }
    /** Read the most recent assistant text in the Session. */
    getLastAssistantText(...args: Parameters<RuntimeReads["getLastAssistantText"]>) {
        return this.#reads.getLastAssistantText(...args);
    }
    /** Read Session information for display by a host. */
    getSessionInfo(...args: Parameters<RuntimeReads["getSessionInfo"]>) {
        return this.#reads.getSessionInfo(...args);
    }
    /** Describe current context usage for the Session. */
    getSessionContextReport(...args: Parameters<RuntimeReads["getSessionContextReport"]>) {
        return this.#reads.getSessionContextReport(...args);
    }
    /** List saved Sessions associated with a Plan. */
    listPlanAssociatedSessions(...args: Parameters<RuntimeReads["listPlanAssociatedSessions"]>) {
        return this.#reads.listPlanAssociatedSessions(...args);
    }
    /** Check that a saved Session can be used for the selected Plan. */
    verifyPlanAssociatedSession(...args: Parameters<RuntimeReads["verifyPlanAssociatedSession"]>) {
        return this.#reads.verifyPlanAssociatedSession(...args);
    }
    /** Record the connection between a Plan and a Session. */
    recordPlanAssociation(...args: Parameters<RuntimeWorkflows["recordPlanAssociation"]>) {
        return this.#workflows.recordPlanAssociation(...args);
    }
    /** Resolve the memory backup directory for a persisted Session. */
    getSessionMemoryBackupDir(...args: Parameters<RuntimeReads["getSessionMemoryBackupDir"]>) {
        return this.#reads.getSessionMemoryBackupDir(...args);
    }
    /** List saved Sessions a host can resume in the checkout. */
    listResumableSessions(...args: Parameters<RuntimeReads["listResumableSessions"]>) {
        return this.#reads.listResumableSessions(...args);
    }
    /** Read details of a saved Session before opening it. */
    inspectResumableSession(...args: Parameters<RuntimeReads["inspectResumableSession"]>) {
        return this.#reads.inspectResumableSession(...args);
    }
    /** List the prompt templates available to this Session. */
    listSessionPromptTemplates(...args: Parameters<RuntimeReads["listSessionPromptTemplates"]>) {
        return this.#reads.listSessionPromptTemplates(...args);
    }
    /** List the skills available to this Session. */
    listSessionSkills(...args: Parameters<RuntimeReads["listSessionSkills"]>) {
        return this.#reads.listSessionSkills(...args);
    }
    /** List files supplying the Session's agent context. */
    listSessionContextFiles(...args: Parameters<RuntimeReads["listSessionContextFiles"]>) {
        return this.#reads.listSessionContextFiles(...args);
    }
    /** Resolve a skill command using the current Session's resources. */
    expandSessionSkillCommand(...args: Parameters<RuntimeReads["expandSessionSkillCommand"]>) {
        return this.#reads.expandSessionSkillCommand(...args);
    }
    /** Expand the selected prompt template and its arguments. */
    expandSessionPromptTemplate(...args: Parameters<RuntimeReads["expandSessionPromptTemplate"]>) {
        return this.#reads.expandSessionPromptTemplate(...args);
    }
    /** Read the Session content used by export adapters. */
    readSessionExport(...args: Parameters<RuntimeReads["readSessionExport"]>) {
        return this.#reads.readSessionExport(...args);
    }
    /** Set the model's thinking level for subsequent turns. */
    setSessionThinkingLevel(...args: Parameters<RuntimeAgentSettings["setSessionThinkingLevel"]>) {
        return this.#settings.setSessionThinkingLevel(...args);
    }
    /** Whether this runtime has a store that can archive saved Sessions. */
    canArchiveSavedSessions(): boolean {
        return this.#lifecycle.canArchiveSavedSessions();
    }
    /** Stop the saved Session's active writer and archive it by RunWield or Pi ID. Missing Sessions are already settled. */
    archiveSavedSession(persistedId: string): Promise<void> {
        return this.#lifecycle.archiveSavedSession(persistedId);
    }
    /** Dispose the open Session and release its resources. */
    closeSession(...args: Parameters<RuntimeLifecycle["closeSession"]>) {
        return this.#lifecycle.closeSession(...args);
    }
    /** Wait for turn and operation cleanup before disposing the Session. */
    closeSessionWhenIdle(...args: Parameters<RuntimeLifecycle["closeSessionWhenIdle"]>) {
        return this.#lifecycle.closeSessionWhenIdle(...args);
    }
    /** Close the Sessions owned by this runtime. */
    closeAllSessions(...args: Parameters<RuntimeLifecycle["closeAllSessions"]>) {
        return this.#lifecycle.closeAllSessions(...args);
    }
    /** Settle active work and release all Sessions and runtime-owned storage. */
    closeAllSessionsWhenIdle(...args: Parameters<RuntimeLifecycle["closeAllSessionsWhenIdle"]>) {
        return this.#lifecycle.closeAllSessionsWhenIdle(...args);
    }
    /** Listen for future events until the returned unsubscribe function is called. */
    subscribeSessionEvents(...args: Parameters<RuntimeEvents["subscribeSessionEvents"]>) {
        return this.#events.subscribeSessionEvents(...args);
    }
    /** Refresh the local Session from its managed generation. */
    synchronizeManagedSession(...args: Parameters<RuntimeManagedSync["synchronizeManagedSession"]>) {
        return this.#sync.synchronizeManagedSession(...args);
    }
    /** Establish or recover the first usable generation of a saved Session. */
    ensureInitialSessionGeneration(...args: Parameters<RuntimeManagedSync["ensureInitialSessionGeneration"]>) {
        return this.#sync.ensureInitialSessionGeneration(...args);
    }
    /** Attach a saved managed Session to this runtime. */
    adoptManagedSession(...args: Parameters<RuntimeLifecycle["adoptManagedSession"]>) {
        return this.#lifecycle.adoptManagedSession(...args);
    }
    /** Submit user input and return its outcome and any replacement Session. */
    promptUserTurn(...args: Parameters<RuntimeTurns["promptUserTurn"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#turns.promptUserTurn(...args);
    }
    /** Submit a turn under the managed Session's ownership rules. */
    promptManagedSession(...args: Parameters<RuntimeTurns["promptManagedSession"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#turns.promptManagedSession(...args);
    }
    /** Advance a managed Session to its next transcript segment. */
    rollManagedSessionSegment(...args: Parameters<RuntimeTurns["rollManagedSessionSegment"]>) {
        return this.#turns.rollManagedSessionSegment(...args);
    }
    /** Create a Session with an optional initial agent. */
    createSession(options: CreateSessionOptions): Promise<CreatedSession> {
        return this.#lifecycle.createSession(options);
    }
    /** Persist and activate a Session whose first prompt was deferred. */
    materializePromptReadySession(...args: Parameters<RuntimeLifecycle["materializePromptReadySession"]>) {
        return this.#lifecycle.materializePromptReadySession(...args);
    }
    /** Reopen the requested saved Session with its replay events. An unavailable ID rejects the request. */
    resumeSession(options: ResumeSessionOptions & { sessionId: string }): Promise<ResumedSession>;
    /** With no ID, reopen the most recent unarchived Session, or return null when none is available. */
    resumeSession(options: ResumeSessionOptions): Promise<ResumedSession | null>;
    resumeSession(options: ResumeSessionOptions): Promise<ResumedSession | null> {
        return this.#loading.resumeSession(options);
    }
    /** Install or detach the presenter for this Session's interaction requests. */
    setInteractionAdapter(...args: Parameters<RuntimeLifecycleLoading["setInteractionAdapter"]>) {
        return this.#loading.setInteractionAdapter(...args);
    }
    /** Deliver a response to a pending chat interaction. */
    answerInteraction(...args: Parameters<RuntimeLifecycleLoading["answerInteraction"]>) {
        return this.#loading.answerInteraction(...args);
    }
    /** Present a typed request and wait for an answer or cancellation. */
    requestInteraction(...args: Parameters<RuntimeLifecycleLoading["requestInteraction"]>) {
        return this.#loading.requestInteraction(...args);
    }
    /** Change the agent responsible for the Session's next turn. */
    switchAgent(...args: Parameters<RuntimeAgentSettings["switchAgent"]>) {
        return this.#settings.switchAgent(...args);
    }
    /** Dispatch an MCP command for the Session. */
    runMcpCommand(...args: Parameters<RuntimeAgentSettings["runMcpCommand"]>) {
        return this.#settings.runMcpCommand(...args);
    }
    /** Interrupt the Session's active work. */
    cancelSession(...args: Parameters<RuntimeTurns["cancelSession"]>) {
        return this.#turns.cancelSession(...args);
    }
    /** Run an agent turn with the host's prompt options. */
    promptSession(...args: Parameters<RuntimeTurns["promptSession"]>) {
        this.#ownPlanReviewRuntime(args[0]);
        return this.#turns.promptSession(...args);
    }
    /** Create the replacement Session used to continue execution follow-up work. */
    replaceSessionForExecutionFollowUp(
        ...args: Parameters<RuntimeLifecycleLoading["replaceSessionForExecutionFollowUp"]>
    ) {
        return this.#loading.replaceSessionForExecutionFollowUp(...args);
    }
}

/** Create the interactive runtime and open its local store unless a host supplies storage. */
export function createSessionRuntime(options: CreateSessionRuntimeOptions = {}): SessionRuntime {
    let sessionStore = options.sessionStore ?? null;
    let ownsSessionStore = false;
    if (!options.remoteSessionControl && !Object.hasOwn(options, "sessionStore")) {
        sessionStore = openFileSessionStore();
        ownsSessionStore = true;
    }
    return new SessionRuntime({
        sessionHost: new SessionHost(),
        sessionStore,
        remoteSessionControl: options.remoteSessionControl,
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
}
/** Decide whether an idle Session can resume from the expected generation. */
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
        agentName:
            typeof snapshot.activeAgent === "string" && snapshot.activeAgent ? snapshot.activeAgent : AGENTS.ROUTER,
        message: "Ready for your next message.",
    };
}
