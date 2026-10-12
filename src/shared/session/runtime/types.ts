import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContextUsageSnapshot } from "../../types.js";
import type { McpServerDefinition } from "../../mcp/config.ts";
import type { FileSessionStore } from "../file-session-store-types.ts";
import type { MinimalSessionManagerLike } from "../hosted-session.js";
import type { ImageAttachment } from "../types.js";
import type { RuntimeQueuedMessage, SessionRuntimeEvent } from "../session-runtime-events.js";
import type { NamedInvocationPayload } from "../named-invocation.ts";
import type { SessionHost } from "../session-host.ts";

export type OwnerProcessKind = "workspace" | "tui" | "acp" | "test";

export interface SessionRuntimeComposition {
    sessionHost: SessionHost;
    sessionStore: FileSessionStore | null;
    ownsSessionStore?: boolean;
    ownerProcessKind: OwnerProcessKind;
    ownerInstanceId: string;
}

export interface CreateSessionRuntimeOptions {
    sessionStore?: FileSessionStore | null;
    ownerProcessKind?: OwnerProcessKind;
    ownerInstanceId?: string;
}

export interface RuntimeContextModel {
    contextWindow?: number;
}

export interface RuntimeCompactionSettings {
    enabled?: boolean;
}

export interface RuntimeContextSettingsManager {
    getCompactionSettings?(): RuntimeCompactionSettings | null;
}

export interface RuntimeContextAgentSession {
    getContextUsage?(): ContextUsageSnapshot | null;
    model?: RuntimeContextModel;
    settingsManager?: RuntimeContextSettingsManager;
}

export interface RuntimeContextCapacity {
    contextUsage: ContextUsageSnapshot | null;
    autoCompactionEnabled: boolean | null;
}

export interface PromptReadySessionOptions {
    cwd: string;
    agentName?: string;
    deferPersistenceUntilFirstMessage?: boolean;
    mcpServers?: McpServerDefinition[];
}

export interface PromptTurnContext {
    turnId: string;
}

export interface PromptSessionOptions {
    inputSurface?: import("../session-runtime-events.js").NotificationSurface;
    generatedTaskId?: string;
    onGeneratedTurnAccepted?: () => void;
    initialRequest: string;
    initialImages?: ImageAttachment[];
    onTurnStarted?: (context: PromptTurnContext) => void | (() => void);
    agentName?: string;
    toolNames?: string[];
    customTools?: ToolDefinition[];
    includeEditFallback?: boolean;
    turnId?: string;
    emitInitialEvents?: boolean;
    /** Input accepted by promptUserTurn, independent of presentation event suppression. */
    metricsUserInitiated?: boolean;
    suppressEpicContinuation?: boolean;
    modelRequest?: string;
    modelOverride?: string;
    preparedModelOverride?: string;
    namedInvocationPayload?: NamedInvocationPayload;
    promptTemplate?: import("../named-invocation.ts").PromptTemplateInvocation;
    initialTutorialContext?: import("../tutorial-context-session.ts").TutorialContext;
    signal?: AbortSignal;
    planName?: string;
    planContent?: string;
    triageMeta?: Partial<import("../../../plan-store.js").PlanFrontMatter>;
}

export interface LoadSessionOptions {
    cwd: string;
    sessionId: string;
    sessionPath?: string;
    modelOverride?: string;
    mcpServers?: McpServerDefinition[];
}

export type RuntimeRootSessionManager = SessionManager & { dispose?(): void };
export type SessionRuntimeEventListener = (event: SessionRuntimeEvent) => void | Promise<void>;

export interface SteerSessionResult {
    ok: boolean;
    queued: boolean;
    message?: RuntimeQueuedMessage;
    reason?: string;
    error?: string;
}

export interface DequeueQueuedMessageResult {
    ok: boolean;
    message: RuntimeQueuedMessage | null;
    warning?: string;
    error?: string;
}

export interface RuntimeQueuedMessageState {
    inputSurface?: import("../session-runtime-events.js").NotificationSurface;
    id: string;
    text: string;
    images: ImageAttachment[];
    delivery: "steer" | "next_turn";
    queuedAt: string;
    submissionOrder?: number;
    preparing?: boolean;
    sourceSession?: import("./support.ts").RuntimeAgentSession;
}

export interface QueueSourceSubscription {
    sourceSession: import("./support.ts").RuntimeAgentSession;
    unsubscribe(): void;
}

export interface RuntimeInteractionResult {
    outcome?: string;
    message?: string;
    value?: string | boolean;
    valueLabel?: string;
    otherText?: string;
    ok?: boolean;
    error?: string;
}

export interface ManagedSyncOptions {
    emitEvents?: boolean;
    replayFromStart?: boolean;
    limit?: number;
}

export interface ManagedOperationFailure {
    ok: false;
    error: string;
    turns?: 0;
    outcome?: string;
    message?: string;
    value?: string | boolean;
    tokensBefore?: number;
    summary?: string;
    output?: string;
    canceled?: boolean;
    exitCode?: number;
    reason?: string;
    deferred?: boolean;
    thinkingLevel?: import("../hosted-session.js").ThinkingLevel;
}

export interface ManagedOperationRunFailure extends ManagedOperationFailure {
    turns: 0;
}

export function isManagedOperationFailure<T>(
    value: T | ManagedOperationFailure,
): value is ManagedOperationFailure {
    return typeof value === "object" && value !== null && "ok" in value && value.ok === false &&
        "error" in value && typeof value.error === "string";
}

export interface ActiveSessionInfoCacheEntry {
    leafId: string | null;
    info: ReturnType<typeof import("../session-transcript-projection.js").buildProjectedSessionInfo>;
}

export type ActiveSessionInfoCache = WeakMap<MinimalSessionManagerLike, ActiveSessionInfoCacheEntry>;
