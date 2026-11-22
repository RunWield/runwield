/** Serializable, host-independent Session operations. No transport or storage authority lives here. */
export interface SessionBinding {
    connectionId: string;
    project: string;
    sessionId: string;
}

export interface SessionQuestionChoice {
    value: string;
    label: string;
    description?: string;
}

export interface SessionClientQuestion {
    requestId: string;
    interactionId: string;
    prompt: string;
    mode: "text" | "select" | "approval";
    required: boolean;
    placeholder: string;
    defaultValue?: string;
    choices: SessionQuestionChoice[];
    allowOther: boolean;
    otherOptionValue?: string;
}

export interface SessionQuestionFields {
    action: "accept" | "decline" | "cancel";
    answer?: string;
    otherAnswer?: string;
}

export interface SessionQuestionAnswer extends SessionQuestionFields {
    requestId: string;
}

export interface SessionClientItem {
    id: string;
    kind: "user" | "assistant" | "thinking" | "tool" | "system";
    text: string;
    title?: string;
    images?: import("../../../shared/session/session-input-contract.ts").SessionImageTransfer[];
    status?: "in_progress" | "completed" | "failed";
}

/** Lightweight navigation evidence. Does not contain transcripts or nested views. */
export interface SessionBindingSummary {
    sessionId: string;
    durableSessionId: string;
    projectId: string;
    project: string;
    phase: SessionClientView["phase"];
    hasQuestion: boolean;
}

export interface SessionClientView {
    connectionId: string;
    project: string;
    connection: "connecting" | "ready" | "incompatible" | "disconnected";
    phase: "empty" | "loading" | "idle" | "streaming" | "awaiting_answer" | "canceling" | "interrupted";
    sessionId: string;
    durableSessionId: string;
    items: SessionClientItem[];
    question: SessionClientQuestion | null;
    error: string;
    /** Main recovery evidence remains visible until a deliberate continuation. */
    recoveryNotice?: string;
    generation?: number | null;
    archivedAt?: string | null;
    configuration?: import("../../../acp/workspace-contract.ts").WorkspaceConfiguration;
    queued?: SessionQueuedDraft[];
    operationId?: string;
    bindings?: SessionBindingSummary[];
    /** Canonical live evidence, separate from unsent client drafts. */
    sessionInfo?: import("../../../acp/workspace-contract.ts").WorkspaceJsonRecord | null;
    pendingConfiguration?: import("../../../acp/workspace-contract.ts").WorkspaceJsonRecord | null;
    coreQueuedMessages?: import("../../../acp/workspace-contract.ts").WorkspaceJsonRecord[];
}

export interface WorkspaceSessionClient {
    create(): Promise<void>;
    load(sessionId: string): Promise<void>;
    send(binding: SessionBinding, text: string): Promise<void>;
    answer(binding: SessionBinding, response: SessionQuestionAnswer): Promise<void>;
    cancel(binding: SessionBinding): Promise<void>;
    close(binding: SessionBinding): Promise<void>;
    observe(listener: (view: SessionClientView) => void): () => void;
}

export interface SessionQueuedDraft {
    /** Restored intent must wait for a deliberate Send with its saved request ID. */
    restored?: boolean;
    requestId: string;
    text: string;
    images: import("../../../shared/session/session-input-contract.ts").SessionImageTransfer[];
}
/** Optional full-workbench capability. The queue is unsent client intent, not accepted Core work. */
export interface WorkspaceSavedSessionClient extends WorkspaceSessionClient {
    stageConfiguration(
        binding: SessionBinding,
        selection: import("../../../acp/workspace-contract.ts").WorkspaceConfigurationSelection,
    ): Promise<void>;
    sessionOptions(
        context: import("../../../acp/workspace-contract.ts").WorkspaceProjectContext,
    ): Promise<import("../../../acp/workspace-contract.ts").WorkspaceOptionsResult>;
    readProject(
        request: import("../../../acp/workspace-contract.ts").WorkspaceProjectRequest,
    ): Promise<import("../../../acp/workspace-contract.ts").WorkspaceOpenProjectResult>;
    listSessions(
        request: import("../../../acp/workspace-contract.ts").WorkspaceSessionListRequest,
    ): Promise<import("../../../acp/workspace-contract.ts").WorkspaceSessionListResult>;
    history(
        request: import("../../../acp/workspace-contract.ts").WorkspaceHistoryRequest,
    ): Promise<import("../../../acp/workspace-contract.ts").WorkspaceHistoryResult>;
    snapshot(
        request: import("../../../acp/workspace-contract.ts").WorkspaceSnapshotRequest,
    ): Promise<import("../../../acp/workspace-contract.ts").WorkspaceSnapshotResult>;
    command(
        binding: SessionBinding,
        text: string,
    ): Promise<import("../../../shared/session/session-input-contract.ts").SessionCommandResult>;
    configure(request: import("../../../acp/workspace-contract.ts").WorkspaceConfigureRequest): Promise<void>;
    unarchive(request: import("../../../acp/workspace-contract.ts").WorkspaceUnarchiveRequest): Promise<void>;
    archive(
        request: import("../../../acp/workspace-contract.ts").WorkspaceSessionRequest,
        confirmed?: boolean,
    ): Promise<void>;
    sendImages(
        binding: SessionBinding,
        text: string,
        images: import("../../../shared/session/session-input-contract.ts").SessionImageTransfer[],
        requestId?: string,
        expectedGeneration?: number,
    ): Promise<void>;
    queue(binding: SessionBinding, draft: SessionQueuedDraft): void;
    removeQueued(binding: SessionBinding, requestId: string): void;
}
