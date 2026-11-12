import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { openOwnerCoordinationStore, type OwnerCoordinationStore } from "../shared/owner-coordination/index.ts";
import { DirectoryConfirmationRequired } from "../shared/project-directory.ts";
import {
    listOwnerProjects,
    serializeOwnerProject,
    sessionBelongsToOwnerProject,
} from "../shared/owner-coordination/owner-projects.ts";
import {
    WORKSPACE_EXTENSION,
    type WorkspaceCapability,
    type WorkspaceErrorCode,
    type WorkspaceJson,
    type WorkspaceJsonRecord,
    type WorkspaceProjectContext,
    type WorkspaceProjectOperation,
    type WorkspaceProjectResponse,
} from "./workspace-contract.ts";

/** Parse the ACP boundary's JSON value without exporting SDK open metadata types into Core. */
export function parseWorkspaceRequest(json: string): WorkspaceJsonRecord {
    let value: WorkspaceJson;
    try {
        value = JSON.parse(json);
    } catch {
        return refuse("invalid_params", "Expected a JSON object.");
    }
    return record(value);
}

function refuse(code: WorkspaceErrorCode, message: string): never {
    throw new RequestError(code === "invalid_params" ? -32602 : -32002, message, { code });
}
function record(value: WorkspaceJson | undefined): WorkspaceJsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return refuse("invalid_params", "Expected an object.");
    return value;
}
function text(value: WorkspaceJson | undefined, max: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
        return refuse("invalid_params", "Invalid bounded string.");
    return value;
}
function exact(value: WorkspaceJsonRecord, keys: string[]): void {
    if (Object.keys(value).some((key) => !keys.includes(key))) refuse("invalid_params", "Unexpected field.");
}

/** One admission policy and Session binding ledger per ACP transport. */
export class WorkspaceProjectConnection {
    get active(): boolean {
        return this.negotiated;
    }
    private initialized = false;
    private negotiated = false;
    private rejected = false;
    private readonly connectionId = crypto.randomUUID();
    private readonly sessions = new Map<string, WorkspaceProjectContext>();
    initialize(capabilities: WorkspaceJson | undefined): WorkspaceCapability | null {
        const input = capabilities ? record(capabilities) : {};
        const extension = input._meta ? record(input._meta)[WORKSPACE_EXTENSION] : undefined;
        if (this.initialized && (this.negotiated || extension !== undefined))
            refuse("workspace_already_initialized", "Connection is already initialized.");
        this.initialized = true;
        if (extension === undefined) return null;
        // A failed opt-in cannot fall back to ordinary ACP.
        this.negotiated = true;
        this.rejected = true;
        if (record(extension).version !== 1) {
            this.rejected = true;
            refuse("workspace_version_unsupported", "Workspace version 1 is required.");
        }
        this.rejected = false;
        return { version: 1, connectionId: this.connectionId, projects: { version: 1 } };
    }
    private store(): OwnerCoordinationStore {
        return openOwnerCoordinationStore();
    }
    private requireNegotiated(): void {
        if (this.rejected) refuse("workspace_version_unsupported", "Workspace version 1 is required.");
        if (!this.negotiated) refuse("workspace_not_negotiated", "Workspace version 1 must be negotiated.");
    }
    private root(store: OwnerCoordinationStore, projectId: string): string {
        if (!store.getProjectById(projectId)) refuse("project_not_found", "Project registration is unavailable.");
        try {
            return store.requireEnabledProjectRoot(projectId);
        } catch {
            return refuse(
                "project_unavailable",
                "Project is disabled or its root is unavailable. Open Project settings.",
            );
        }
    }
    private binding(request: WorkspaceJsonRecord): WorkspaceProjectContext {
        const meta = request._meta ? record(request._meta) : {};
        const value = meta[WORKSPACE_EXTENSION];
        if (!value) return refuse("workspace_binding_invalid", "Workspace Project context is required.");
        const binding = record(value);
        exact(binding, ["connectionId", "projectId", "canonicalRoot"]);
        const context = {
            connectionId: text(binding.connectionId, 128),
            projectId: text(binding.projectId, 128),
            canonicalRoot: text(binding.canonicalRoot, 4096),
        };
        if (context.connectionId !== this.connectionId)
            refuse("workspace_binding_invalid", "Workspace connection does not match.");
        return context;
    }
    admit(request: WorkspaceJsonRecord): WorkspaceProjectContext | null {
        if (this.rejected) refuse("workspace_version_unsupported", "Workspace version 1 is required.");
        if (!this.negotiated) return null;
        const context = this.binding(request);
        const store = this.store();
        try {
            if (this.root(store, context.projectId) !== context.canonicalRoot || request.cwd !== context.canonicalRoot)
                refuse("workspace_binding_invalid", "Workspace Project root does not match.");
            return context;
        } finally {
            store.close();
        }
    }
    checkLoad(request: WorkspaceJsonRecord, context: WorkspaceProjectContext | null, sessionId: string): void {
        if (!context) return;
        const store = this.store();
        try {
            const session = store.getSessionById(sessionId) || store.findSessionByLocator({ piSessionId: sessionId });
            const meta = request._meta ? record(request._meta) : {};
            if (
                (meta.runwield && record(meta.runwield).sessionPath !== undefined) ||
                !session ||
                !sessionBelongsToOwnerProject(store, session, context.projectId)
            )
                refuse("session_project_mismatch", "Saved Session does not belong to this Project.");
        } finally {
            store.close();
        }
    }
    bind(sessionId: string, context: WorkspaceProjectContext | null): void {
        if (context) this.sessions.set(sessionId, context);
    }
    /** Recheck the retained admission, not client-supplied response metadata. */
    checkInteraction(sessionId: string): void {
        if (!this.negotiated) return;
        const context = this.sessions.get(sessionId);
        if (!context) refuse("workspace_binding_invalid", "Session Project binding is unavailable.");
        this.admit({ cwd: context.canonicalRoot, _meta: { [WORKSPACE_EXTENSION]: { ...context } } });
    }
    checkMutation(request: WorkspaceJsonRecord, settlement = false): void {
        if (!this.negotiated) return;
        const context = this.binding(request);
        const previous = this.sessions.get(text(request.sessionId, 128));
        if (
            !previous ||
            previous.connectionId !== context.connectionId ||
            previous.projectId !== context.projectId ||
            previous.canonicalRoot !== context.canonicalRoot
        )
            refuse("workspace_binding_invalid", "Session Project binding does not match.");
        if (!settlement) this.admit({ ...request, cwd: context.canonicalRoot });
    }
    async project(operation: WorkspaceProjectOperation, payload: WorkspaceJson): Promise<WorkspaceProjectResponse> {
        this.requireNegotiated();
        const input = record(payload);
        const keys = {
            list: [],
            open: ["projectId"],
            register: ["root", "displayName", "directoryConfirmation"],
            relink: ["projectId", "newRoot", "displayName", "directoryConfirmation"],
            setEnabled: ["projectId", "enabled"],
            remove: ["projectId"],
            rescan: ["projectId"],
        };
        exact(input, keys[operation]);
        const projectId = operation !== "list" && operation !== "register" ? text(input.projectId, 128) : "";
        const displayName = input.displayName === undefined ? undefined : text(input.displayName, 200);
        const directoryConfirmation =
            input.directoryConfirmation === undefined ? undefined : text(input.directoryConfirmation, 128);
        const store = this.store();
        try {
            if (operation === "list") return { projects: listOwnerProjects(store) };
            if (projectId && !store.getProjectById(projectId))
                refuse("project_not_found", "Project registration is unavailable.");
            if (operation === "open")
                return {
                    context: { connectionId: this.connectionId, projectId, canonicalRoot: this.root(store, projectId) },
                };
            if (operation === "remove") {
                store.removeProject(projectId);
                return { removed: true };
            }
            if (operation === "rescan") {
                this.root(store, projectId);
                const result = await store.catalogProjectSessions(projectId, { fullRescan: true });
                return {
                    cataloged: result.cataloged.length,
                    diagnostics: result.diagnostics.map(() => "A saved Session could not be cataloged."),
                };
            }
            if (operation === "setEnabled") {
                if (typeof input.enabled !== "boolean") refuse("invalid_params", "enabled must be boolean.");
                const project = store.setProjectEnabled(projectId, input.enabled);
                return { project: serializeOwnerProject(project, store.getProjectHealth(projectId)) };
            }
            const root = text(operation === "register" ? input.root : input.newRoot, 4096);
            if (!isAbsolute(root)) refuse("invalid_params", "Project root must be absolute.");
            const project =
                operation === "register"
                    ? store.registerProject({ root, displayName, directoryConfirmation })
                    : store.relinkProject({ projectId, newRoot: root, displayName, directoryConfirmation });
            return { status: "ok", project: serializeOwnerProject(project, store.getProjectHealth(project.projectId)) };
        } catch (error) {
            if (error instanceof RequestError) throw error;
            if (error instanceof DirectoryConfirmationRequired)
                return { status: "confirmation_required", confirmation: error.confirmation, message: error.message };
            if (error instanceof Error && /conflict|already registered/.test(error.message))
                refuse("project_conflict", "Project root conflicts with an existing registration.");
            return refuse("project_directory_invalid", "Project operation failed. Check the directory and retry.");
        } finally {
            store.close();
        }
    }
}
