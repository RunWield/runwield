import type { ImageAttachment, NotificationSurface, RuntimeQueuedMessage, SessionRuntimeEvent } from "./events.ts";
import type { RuntimeInteractionAdapter, RuntimeInteractionResponse } from "./interactions.ts";

/** Identify the process that owns this runtime's Sessions. */
export interface SessionRuntimeOptions {
    ownerProcessKind?: "workspace" | "tui" | "acp" | "test";
    ownerInstanceId?: string;
}

/** Select a checkout and optionally prepare an initial agent for a new Session. */
export interface CreateSessionOptions {
    cwd: string;
    agentName?: string;
    deferPersistenceUntilFirstMessage?: boolean;
}

/** Select a saved Session and optionally select a model for its next turn. */
export interface ResumeSessionOptions {
    cwd: string;
    /** A local RunWield Session ID or Pi transcript ID. Omit to resume the latest saved Session. */
    sessionId?: string;
    /** Optional local transcript locator for an explicit Session ID. */
    sessionPath?: string;
    modelOverride?: string;
}

/** Runtime and persisted identities for a newly opened Session. */
export interface CreatedSession {
    sessionId: string;
    cwd: string;
    sessionManagerId: string | null;
    startedAt: string;
}

/** Runtime identity and replay data for a saved Session. */
export interface ResumedSession {
    sessionId: string;
    cwd: string;
    sessionManagerId: string;
    sessionPath?: string;
    replayEvents: SessionRuntimeEvent[];
}

/** Identify the accepted turn when its events start. */
export interface PromptTurnContext {
    turnId: string;
}

/** Submit text and attachments with optional agent selection and cancellation. */
export interface UserPromptOptions {
    initialRequest: string;
    initialImages?: ImageAttachment[];
    agentName?: string;
    inputSurface?: NotificationSurface;
    signal?: AbortSignal;
    onTurnStarted?: (context: PromptTurnContext) => void | (() => void);
}

/** Report the turn outcome and the text the adapter should keep in history or restore as a draft. */
export interface UserPromptResult {
    ok: boolean;
    turns: number;
    error?: string;
    replacementSessionId?: string;
    templateNewSession?: boolean;
    managed: boolean;
    submittedRequest: string;
    restoreDraft: boolean;
    historyText?: string;
}

/** Report whether follow-up input entered the active turn's queue. */
export interface SteerSessionResult {
    ok: boolean;
    queued: boolean;
    message?: RuntimeQueuedMessage;
    reason?: string;
    error?: string;
}

/** Report whether cancellation interrupted work. */
export interface CancelSessionResult {
    ok: boolean;
    aborted: boolean;
    error?: string;
}

/** Report whether the open Session accepted an interaction adapter change. */
export type SetInteractionAdapterResult = { ok: true } | { ok: false; error: "not_found" };

/** Report whether the runtime closed the specified Session. */
export interface CloseSessionResult {
    ok: boolean;
    closed: boolean;
}

/** Report how many Sessions the runtime closed. */
export interface CloseAllSessionsResult {
    ok: boolean;
    closed: number;
}

/** Model context capacity and reported usage for the current Session. */
export interface ContextUsageSnapshot {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

/** Persisted Session identity and the generation observed by this runtime. */
export interface ManagedSessionSnapshot {
    runwieldSessionId: string;
    projectId: string;
    generation: number | null;
    dormant: boolean;
}

/** The selected model and provider for the Session. */
export interface SessionModelSnapshot {
    model: string;
    provider: string;
}

/** Adapter-visible Session identity, selection, and turn state. */
export interface SessionSnapshot {
    id: string;
    cwd: string;
    name: string | null;
    sessionManagerId: string | null;
    managed: ManagedSessionSnapshot | null;
    activeAgent: string | null;
    activeModel: SessionModelSnapshot;
    thinkingLevel: string;
    busy: boolean;
    activeTurnId: string | null;
    queuedMessages: RuntimeQueuedMessage[];
    contextUsage: ContextUsageSnapshot | null;
    disposed: boolean;
}

/** Receive semantic events in the order they are published. */
export type SessionRuntimeEventListener = (event: SessionRuntimeEvent) => void | Promise<void>;

/** Operations an adapter uses to own Sessions and their active turns. */
export interface SessionRuntime {
    /** Create a Session with an optional initial agent. */
    createSession(options: CreateSessionOptions): Promise<CreatedSession>;

    /** Reopen the requested saved Session with its replay events. An unavailable ID rejects the request. */
    resumeSession(options: ResumeSessionOptions & { sessionId: string }): Promise<ResumedSession>;
    /** With no ID, reopen the most recent unarchived Session, or return null when none is available. */
    resumeSession(options: ResumeSessionOptions): Promise<ResumedSession | null>;

    /** Submit user input and wait for its outcome, including any replacement Session. */
    promptUserTurn(sessionId: string, options: UserPromptOptions): Promise<UserPromptResult>;

    /** Send follow-up input to a streaming turn and report whether it was queued. */
    steerSession(
        sessionId: string,
        text: string,
        images?: ImageAttachment[],
        inputSurface?: NotificationSurface,
    ): Promise<SteerSessionResult>;

    /** Request cancellation of active work and report whether work was interrupted. */
    cancelSession(sessionId: string): CancelSessionResult;

    /** Subscribe to subsequent events for a Session. Call the returned function to unsubscribe. */
    subscribeSessionEvents(sessionId: string, listener: SessionRuntimeEventListener): () => void;

    /** Read the current Session state, or return null if the Session is no longer open. */
    getSessionSnapshot(sessionId: string): SessionSnapshot | null;

    /** Install the adapter that presents requests from this Session, or pass null to detach it. */
    setInteractionAdapter(sessionId: string, adapter: RuntimeInteractionAdapter | null): SetInteractionAdapterResult;

    /** Answer a pending chat request. An explicit source receives subsequent attention notifications. */
    answerInteraction(
        sessionId: string,
        interactionId: string,
        response: RuntimeInteractionResponse,
        source?: NotificationSurface,
    ): boolean;

    /** Wait for active operations to settle, then dispose the Session and release its resources. */
    closeSession(sessionId: string): Promise<CloseSessionResult>;

    /** Cancel active turns, wait for cleanup, and release Sessions and runtime-owned storage. */
    closeAllSessionsWhenIdle(): Promise<CloseAllSessionsResult>;
}
