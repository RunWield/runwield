export const WORKSPACE_EXTENSION = "dev.runwield/workspace";
export const WORKSPACE_PROJECT_PREFIX = "_dev.runwield/workspace/projects/";
export const WORKSPACE_PROJECT_OPERATIONS = [
    "list",
    "open",
    "register",
    "relink",
    "setEnabled",
    "remove",
    "rescan",
] as const;
export type WorkspaceProjectOperation = (typeof WORKSPACE_PROJECT_OPERATIONS)[number];
export interface WorkspaceProjectView {
    projectId: string;
    displayName?: string;
    rootLabel: string;
    lifecycle?: string;
    healthStatus: string;
    healthEvidence: string[];
    enabled: boolean;
}
export interface WorkspaceProjectContext {
    connectionId: string;
    projectId: string;
    canonicalRoot: string;
}
export interface WorkspaceProjectCapability {
    version: 1;
}
export interface WorkspaceCapability {
    version: 1;
    connectionId: string;
    projects: WorkspaceProjectCapability;
    sessions?: WorkspaceSessionCapability;
}
export type WorkspaceListProjectsRequest = Record<string, never>;
export interface WorkspaceProjectRequest {
    projectId: string;
}
export interface WorkspaceOpenProjectRequest extends WorkspaceProjectRequest {}
export interface WorkspaceRemoveProjectRequest extends WorkspaceProjectRequest {}
export interface WorkspaceRescanProjectRequest extends WorkspaceProjectRequest {}
export interface WorkspaceRegisterProjectRequest {
    root: string;
    displayName?: string;
    directoryConfirmation?: string;
}
export interface WorkspaceRelinkProjectRequest extends WorkspaceProjectRequest {
    newRoot: string;
    displayName?: string;
    directoryConfirmation?: string;
}
export interface WorkspaceSetProjectEnabledRequest extends WorkspaceProjectRequest {
    enabled: boolean;
}
export interface WorkspaceListProjectsResult {
    projects: WorkspaceProjectView[];
}
export interface WorkspaceOpenProjectResult {
    context: WorkspaceProjectContext;
}
export interface WorkspaceProjectResult {
    project: WorkspaceProjectView;
}
export interface WorkspaceRemoveProjectResult {
    removed: true;
}
export interface WorkspaceRescanProjectResult {
    cataloged: number;
    diagnostics: string[];
}
export interface WorkspaceProjectWrittenResult extends WorkspaceProjectResult {
    status: "ok";
}
export interface WorkspaceProjectConfirmationResult {
    status: "confirmation_required";
    confirmation: string;
    message: string;
}
export type WorkspaceProjectWriteResult = WorkspaceProjectWrittenResult | WorkspaceProjectConfirmationResult;
export type WorkspaceProjectResponse =
    | WorkspaceListProjectsResult
    | WorkspaceOpenProjectResult
    | WorkspaceProjectResult
    | WorkspaceRemoveProjectResult
    | WorkspaceRescanProjectResult
    | WorkspaceProjectWriteResult;
export type WorkspaceErrorCode =
    | "invalid_params"
    | "workspace_version_unsupported"
    | "workspace_not_negotiated"
    | "workspace_already_initialized"
    | "project_not_found"
    | "project_unavailable"
    | "project_conflict"
    | "project_directory_invalid"
    | "workspace_binding_invalid"
    | "session_project_mismatch";
export interface WorkspaceErrorData {
    code: WorkspaceErrorCode;
}
export type WorkspaceJson = string | number | boolean | null | WorkspaceJson[] | WorkspaceJsonRecord;
export interface WorkspaceJsonRecord {
    [key: string]: WorkspaceJson | undefined;
}

export type WorkspacePrerequisiteErrorCode = "default_model_required" | "provider_prerequisite";
export interface WorkspacePrerequisiteErrorData {
    cwd: string;
    code: WorkspacePrerequisiteErrorCode;
    prerequisite: string;
    guidance: string;
}

export const WORKSPACE_SESSION_PREFIX = "_dev.runwield/workspace/sessions/";
export const WORKSPACE_SESSION_OPERATIONS = [
    "history",
    "snapshot",
    "options",
    "command",
    "configure",
    "answer",
    "unarchive",
    "drain",
    "resolveSubmission",
] as const;
export type WorkspaceSessionOperation = (typeof WORKSPACE_SESSION_OPERATIONS)[number];
export const WORKSPACE_HISTORY_PAGE_LIMIT = 200;
export const WORKSPACE_OBSERVATION_EVENT_LIMIT = 500;
export const WORKSPACE_OBSERVATION_BYTE_LIMIT = 2 * 1024 * 1024;
export interface WorkspaceSessionCapability {
    version: 1;
    historyPageLimit: number;
    observationEventLimit: number;
}
export interface WorkspaceSessionRequest {
    context: WorkspaceProjectContext;
    sessionId: string;
}
export interface WorkspaceMutationIdentity {
    requestId: string;
    expectedGeneration: number;
}
export interface WorkspaceHistoryRequest extends WorkspaceSessionRequest {
    cursor?: string;
    limit?: number;
}
export interface WorkspaceConfiguration {
    agentName: string;
    model: string;
    provider: string;
    thinkingLevel: string;
}
export interface WorkspaceHistoryEvent extends WorkspaceJsonRecord {
    type: string;
    eventId: string;
}
export interface WorkspaceHistoryResult {
    sessionId: string;
    generation: number;
    archivedAt: string | null;
    events: WorkspaceHistoryEvent[];
    configuration: WorkspaceConfiguration;
    previousCursor: string | null;
    complete: boolean;
}
export interface WorkspaceSnapshotRequest extends WorkspaceSessionRequest {
    /** Required only while the new composer has no durable Session ID. */
    wireSessionId?: string;
    cursor?: string;
}
export interface WorkspaceSnapshotResult {
    sessionId: string;
    generation: number | null;
    state: string;
    cursor: string;
    gap: boolean;
    operation: WorkspaceJsonRecord | null;
}
export interface WorkspaceConfigureRequest extends WorkspaceSessionRequest, WorkspaceMutationIdentity {
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
}
export interface WorkspaceAnswerRequest extends WorkspaceSessionRequest {
    operationId: string;
    interactionId: string;
    requestId: string;
    response: WorkspaceAnswerFields;
}
export interface WorkspaceUnarchiveRequest extends WorkspaceSessionRequest {}
export interface WorkspaceSessionListRequest {
    context: WorkspaceProjectContext;
    archiveState?: "active" | "archived" | "all";
    cursor?: string;
    limit?: number;
}
export interface WorkspaceSavedSession {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: string;
    archivedAt: string | null;
    generation: number | null;
}
export interface WorkspaceSessionListResult {
    sessions: WorkspaceSavedSession[];
    nextCursor: string | null;
}

/** Metadata on standard negotiated mutation methods. Correlation IDs are not receipt IDs. */
export interface WorkspaceSessionMutationMetadata extends WorkspaceProjectContext, WorkspaceMutationIdentity {
    confirmed?: boolean;
    configuration?: WorkspaceConfigurationSelection;
}
export interface WorkspaceOptionsRequest {
    context: WorkspaceProjectContext;
}
export interface WorkspaceAgentOption {
    name: string;
    displayName: string;
    description: string;
    defaults: WorkspaceModelConfiguration;
}
export interface WorkspaceModelConfiguration {
    model: string;
    provider: string;
    thinkingLevel: string;
}
export interface WorkspaceModelOption {
    id: string;
    name: string;
    provider: string;
    providerName: string;
    executionBackend: string;
    reasoning: boolean;
    contextWindow: number;
}
export interface WorkspaceCommandOption {
    name: string;
    description: string;
    kind: string;
}
export interface WorkspaceOptionsResult {
    mascot: boolean;
    defaults: WorkspaceConfiguration;
    agents: WorkspaceAgentOption[];
    models: WorkspaceModelOption[];
    commands: WorkspaceCommandOption[];
    thinkingLevels: string[];
}
export interface WorkspaceConfigureResult {
    ok: boolean;
    status: string;
    generation: number;
    operationId?: string;
    pendingConfiguration?: WorkspacePendingConfiguration | null;
}
export interface WorkspaceConfigurationSelection extends WorkspacePendingConfiguration {
    thinkingLevel?: string;
}
export interface WorkspacePendingConfiguration {
    agentName?: string;
    model?: string;
    provider?: string;
}
export interface WorkspaceAnswerFields {
    action: "accept" | "decline" | "cancel";
    answer?: string;
    otherAnswer?: string;
}
export interface WorkspaceAnswerResult {
    status: string;
}
export interface WorkspaceArchiveResult {
    runwieldSessionId: string;
    archivedAt: string | null;
}

export interface WorkspaceSessionListMetadata extends WorkspaceProjectContext {
    archiveState?: "active" | "archived" | "all";
    limit?: number;
}

export interface WorkspaceCommandRequest {
    context: WorkspaceProjectContext;
    wireSessionId: string;
    text: string;
}

/** Evidence about this connection's work, not a cancellation notification acknowledgement. */
export type WorkspaceSettlementResult = import("../shared/session/session-submission-contract.ts").OwnedWorkSettlement;
export type WorkspaceSessionSettlement =
    import("../shared/session/session-submission-contract.ts").OwnedSessionSettlement;
export type WorkspaceSubmissionKind = import("../shared/session/session-submission-contract.ts").SubmissionKind;
export interface WorkspaceSubmissionMetadata {
    context: WorkspaceProjectContext;
    wireSessionId: string;
    sessionId: string;
    requestId: string;
    kind: WorkspaceSubmissionKind;
    expectedGeneration: number;
    text: string;
    images: import("../shared/session/session-input-contract.ts").SessionImageTransfer[];
}
export interface WorkspaceResolveSubmissionRequest {
    context: WorkspaceProjectContext;
    sessionId?: string;
    requestId: string;
    kind: WorkspaceSubmissionKind;
    expectedGeneration: number;
}
export type WorkspaceSubmissionResolution =
    import("../shared/session/session-submission-contract.ts").SubmissionResolution;
