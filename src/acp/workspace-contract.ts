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
}
export interface WorkspaceListProjectsRequest {}
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
