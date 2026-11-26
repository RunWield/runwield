import type { AgentSession, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerDefinition } from "../../../src/shared/mcp/config.ts";
import type { FileSessionStore } from "../../../src/shared/session/file-session-store-types.ts";
import type { MinimalSessionManagerLike } from "../host.ts";
import type { ImageAttachment, RuntimeQueuedMessage } from "../events.ts";
import type {
    ContextUsageSnapshot,
    CreatePromptReadySessionOptions,
    LoadSessionOptions as PublicLoadSessionOptions,
    SessionRuntimeOptions,
    UserPromptOptions,
    UserPromptResult as PublicUserPromptResult,
} from "../contract.ts";
export type {
    ContextUsageSnapshot,
    PromptTurnContext,
    SessionRuntimeEventListener,
    SteerSessionResult,
} from "../contract.ts";
import type { NamedInvocationPayload } from "../../../src/shared/session/named-invocation.ts";
import type { SessionHost } from "../host.ts";

export type OwnerProcessKind = NonNullable<SessionRuntimeOptions["ownerProcessKind"]>;

export interface RuntimeSteeringResult {
    taskId: string;
    text: string;
    target: AgentSession;
    queueIndex: number | null;
    queueLength: number;
    unsubscribe: () => void;
}

export interface SessionRuntimeComposition {
    sessionHost: SessionHost;
    sessionStore: FileSessionStore | null;
    remoteSessionControl?: import("../../../src/shared/remote/session-control-client.ts").RemoteSessionControl;
    ownsSessionStore?: boolean;
    ownerProcessKind: OwnerProcessKind;
    ownerInstanceId: string;
}

export interface CreateSessionRuntimeOptions extends SessionRuntimeOptions {
    sessionStore?: FileSessionStore | null;
    remoteSessionControl?: import("../../../src/shared/remote/session-control-client.ts").RemoteSessionControl;
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

export interface PromptReadySessionOptions extends CreatePromptReadySessionOptions {
    mcpServers?: McpServerDefinition[];
}

export interface PromptSessionOptions extends UserPromptOptions {
    generatedTaskId?: string;
    onGeneratedTurnAccepted?: () => void;
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
    promptTemplate?: import("../../../src/shared/session/named-invocation.ts").PromptTemplateInvocation;
    initialTutorialContext?: import("../../../src/shared/session/tutorial-context-session.ts").TutorialContext;
    planName?: string;
    planContent?: string;
    triageMeta?: Partial<import("@runwield/plans").PlanFrontMatter>;
}

export interface PromptSessionResult {
    ok: boolean;
    turns: number;
    error?: string;
    replacementSessionId?: string;
    templateNewSession?: boolean;
    _validationResult?: import("./workflow-options.ts").RuntimeValidationResult | null;
    _executionToStart?: import("./workflow-options.ts").RuntimeExecutePlanOptions;
    namedInvocation?: {
        kind: string;
        name: string;
        expansionDigest: string;
        profile: import("../../../src/shared/session/named-invocation.ts").NamedInvocationPayload["profile"];
        messageCount: number;
    };
}

export interface UserPromptResult extends PromptSessionResult, PublicUserPromptResult {}

export interface LoadSessionOptions extends PublicLoadSessionOptions {
    mcpServers?: McpServerDefinition[];
}

export type RuntimeRootSessionManager = SessionManager & { dispose?(): void };

export interface DequeueQueuedMessageResult {
    ok: boolean;
    message: RuntimeQueuedMessage | null;
    warning?: string;
    error?: string;
}

export interface RuntimeQueuedMessageState {
    inputSurface?: import("../events.ts").NotificationSurface;
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
    thinkingLevel?: import("../host.ts").ThinkingLevel;
}

export interface ManagedOperationRunFailure extends ManagedOperationFailure {
    turns: 0;
}

export function isManagedOperationFailure<T>(value: T | ManagedOperationFailure): value is ManagedOperationFailure {
    return (
        typeof value === "object" &&
        value !== null &&
        "ok" in value &&
        value.ok === false &&
        "error" in value &&
        typeof value.error === "string"
    );
}

export interface ActiveSessionInfoCacheEntry {
    leafId: string | null;
    info: ReturnType<typeof import("../session-transcript-projection.ts").buildProjectedSessionInfo>;
}

export type ActiveSessionInfoCache = WeakMap<MinimalSessionManagerLike, ActiveSessionInfoCacheEntry>;

export interface TaskTranscriptEntry {
    type?: string;
    message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
}
