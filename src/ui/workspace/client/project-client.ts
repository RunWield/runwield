import type {
    WorkspaceListProjectsResult,
    WorkspaceOpenProjectResult,
    WorkspaceProjectRequest,
    WorkspaceRegisterProjectRequest,
    WorkspaceRelinkProjectRequest,
    WorkspaceSetProjectEnabledRequest,
    WorkspaceProjectWriteResult,
    WorkspaceProjectResult,
    WorkspaceRemoveProjectResult,
    WorkspaceRescanProjectResult,
} from "../../../acp/workspace-contract.ts";

/** Semantic Project operations. Hosts own picking; Core owns admission and registration. */
export interface WorkspaceProjectClient {
    listProjects(): Promise<WorkspaceListProjectsResult>;
    openProject(request: WorkspaceProjectRequest): Promise<WorkspaceOpenProjectResult>;
    registerProject(request: WorkspaceRegisterProjectRequest): Promise<WorkspaceProjectWriteResult>;
    relinkProject(request: WorkspaceRelinkProjectRequest): Promise<WorkspaceProjectWriteResult>;
    setProjectEnabled(request: WorkspaceSetProjectEnabledRequest): Promise<WorkspaceProjectResult>;
    removeProject(request: WorkspaceProjectRequest): Promise<WorkspaceRemoveProjectResult>;
    rescanProject(request: WorkspaceProjectRequest): Promise<WorkspaceRescanProjectResult>;
}
export interface DesktopProjectClient extends WorkspaceProjectClient {
    pickDirectory(): Promise<string | null>;
    candidate(): Promise<string>;
}
