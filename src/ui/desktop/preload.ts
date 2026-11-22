import type { DesktopWorkbenchClient } from "../workspace/client/desktop-workbench.ts";
import type { WorkspaceDraftClient } from "../workspace/client/session-drafts.ts";
import { DRAFT_CHANNEL } from "./draft-bridge.ts";
import { contextBridge, ipcRenderer } from "electron";
import type {
    SessionBinding,
    SessionClientView,
    SessionQuestionAnswer,
    WorkspaceSavedSessionClient,
} from "../workspace/client/session-client.ts";
import type { DesktopProjectClient } from "../workspace/client/project-client.ts";
import { PROJECT_CHANNEL } from "./bridge.ts";
import { SESSION_CHANNEL } from "./bridge.ts";

import { SAVED_CHANNEL, type SavedOperation, type SavedDesktopRequest } from "./saved-session-bridge.ts";
function saved(operation: SavedOperation, request: Partial<SavedDesktopRequest>) {
    return ipcRenderer.invoke(`${SAVED_CHANNEL}${operation}`, { ...binding(), ...request });
}
function reportQueueError(error: Error) {
    if (current) {
        current = { ...current, error: error.message };
        for (const listener of listeners) listener(structuredClone(current));
    }
}
const listeners = new Set<(view: SessionClientView) => void>();
let current: SessionClientView | null = null;
function binding(): SessionBinding {
    if (!current) throw new Error("Wait for the runtime connection.");
    return { connectionId: current.connectionId, project: current.project, sessionId: current.sessionId };
}
ipcRenderer.on(`${SESSION_CHANNEL}view`, (_event, view: SessionClientView) => {
    current = view;
    for (const listener of listeners) listener(structuredClone(current));
});
const draftAcceptedListeners = new Set<(binding: SessionBinding, requestId: string) => void>();
ipcRenderer.on(`${DRAFT_CHANNEL}accepted`, (_event, context: SessionBinding, requestId: string) => {
    for (const listener of draftAcceptedListeners) listener(context, requestId);
});
const client: WorkspaceSavedSessionClient & WorkspaceDraftClient = {
    editQueuedDraft: (context, requestId) =>
        ipcRenderer.invoke(`${DRAFT_CHANNEL}editQueued`, { ...context, requestId }),
    onDraftAccepted(listener) {
        draftAcceptedListeners.add(listener);
        return () => {
            draftAcceptedListeners.delete(listener);
        };
    },
    readDraft: (context) => ipcRenderer.invoke(`${DRAFT_CHANNEL}read`, context),
    writeDraft: (context, composer) => ipcRenderer.invoke(`${DRAFT_CHANNEL}write`, { ...context, composer }),
    discardDraft: (context) => ipcRenderer.invoke(`${DRAFT_CHANNEL}discard`, context),
    readProject: (request) => saved("readProject", { projectId: request.projectId }),
    listSessions: (request) => saved("listSessions", { request }),
    history: (request) => saved("history", { request }),
    snapshot: (request) => saved("snapshot", { request }),
    sessionOptions: (context) => saved("sessionOptions", { context }),
    command: (context, text) => ipcRenderer.invoke(`${SAVED_CHANNEL}command`, { ...context, text }),
    configure: (request) => saved("configure", { request }),
    archive: (request, confirmed) => saved("archive", { request, ...(confirmed === undefined ? {} : { confirmed }) }),
    unarchive: (request) => saved("unarchive", { request }),
    stageConfiguration: (context, selection) =>
        ipcRenderer.invoke(`${SAVED_CHANNEL}stageConfiguration`, { ...context, selection }),
    sendImages: (context, text, images, requestId, expectedGeneration) =>
        ipcRenderer.invoke(`${SAVED_CHANNEL}sendImages`, {
            ...context,
            text,
            images,
            ...(requestId === undefined ? {} : { requestId }),
            ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
        }),
    queue: (context, draft) => {
        void ipcRenderer.invoke(`${SAVED_CHANNEL}queue`, { ...context, draft }).catch(reportQueueError);
    },
    removeQueued: (context, requestId) => {
        void ipcRenderer.invoke(`${SAVED_CHANNEL}removeQueued`, { ...context, requestId }).catch(reportQueueError);
    },
    create: () => ipcRenderer.invoke(`${SESSION_CHANNEL}create`, binding()),
    load: (knownId: string) => ipcRenderer.invoke(`${SESSION_CHANNEL}load`, { ...binding(), knownId }),
    send: (context: SessionBinding, text: string) => ipcRenderer.invoke(`${SESSION_CHANNEL}send`, { ...context, text }),
    answer: (context: SessionBinding, answer: SessionQuestionAnswer) =>
        ipcRenderer.invoke(`${SESSION_CHANNEL}answer`, { ...context, answer }),
    cancel: (context: SessionBinding) => ipcRenderer.invoke(`${SESSION_CHANNEL}cancel`, context),
    close: (context: SessionBinding) => ipcRenderer.invoke(`${SESSION_CHANNEL}close`, context),
    observe(listener) {
        listeners.add(listener);
        if (current) listener(structuredClone(current));
        void ipcRenderer.invoke(`${SESSION_CHANNEL}observe`).catch((error: Error) => console.error(error.message));
        return () => {
            listeners.delete(listener);
        };
    },
};
const projects: DesktopProjectClient = {
    readProject: (request) => client.readProject(request),
    listProjects: () => ipcRenderer.invoke(`${PROJECT_CHANNEL}list`, { connectionId: binding().connectionId }),
    openProject: (request) =>
        ipcRenderer.invoke(`${PROJECT_CHANNEL}open`, { ...request, connectionId: binding().connectionId }),
    registerProject: (request) =>
        ipcRenderer.invoke(`${PROJECT_CHANNEL}register`, { ...request, connectionId: binding().connectionId }),
    relinkProject: (request) =>
        ipcRenderer.invoke(`${PROJECT_CHANNEL}relink`, { ...request, connectionId: binding().connectionId }),
    setProjectEnabled: (request) =>
        ipcRenderer.invoke(`${PROJECT_CHANNEL}setEnabled`, { ...request, connectionId: binding().connectionId }),
    removeProject: (request) =>
        ipcRenderer.invoke(`${PROJECT_CHANNEL}remove`, { ...request, connectionId: binding().connectionId }),
    rescanProject: (request) =>
        ipcRenderer.invoke(`${PROJECT_CHANNEL}rescan`, { ...request, connectionId: binding().connectionId }),
    pickDirectory: () => ipcRenderer.invoke(`${PROJECT_CHANNEL}pick`, { connectionId: binding().connectionId }),
    candidate: () => ipcRenderer.invoke(`${PROJECT_CHANNEL}candidate`, { connectionId: binding().connectionId }),
};
const newSessionListeners = new Set<() => void>();
let pendingNewSession = false;
const flushListeners = new Set<() => Promise<void>>();
ipcRenderer.on("desktop:new-session", () => {
    if (!newSessionListeners.size) pendingNewSession = true;
    else for (const listener of newSessionListeners) listener();
});
ipcRenderer.on("desktop:flush-drafts", async (_event, requestId: string) => {
    try {
        await Promise.all([...flushListeners].map((listener) => listener()));
        await ipcRenderer.invoke("desktop:flushed-drafts", { requestId });
    } catch (error) {
        await ipcRenderer.invoke("desktop:flushed-drafts", {
            requestId,
            error: error instanceof Error ? error.message : "Draft save failed.",
        });
    }
});
const workbench: DesktopWorkbenchClient = {
    read: () => ipcRenderer.invoke("desktop:preferences:read"),
    write: (navigation) => ipcRenderer.invoke("desktop:preferences:write", navigation),
    restartRuntime: () => ipcRenderer.invoke("desktop:restart-runtime"),
    onNewSession(listener) {
        newSessionListeners.add(listener);
        if (pendingNewSession) {
            pendingNewSession = false;
            queueMicrotask(listener);
        }
        return () => {
            newSessionListeners.delete(listener);
        };
    },
    flushDrafts(listener) {
        flushListeners.add(listener);
        return () => {
            flushListeners.delete(listener);
        };
    },
};
if (process.isMainFrame) {
    contextBridge.exposeInMainWorld("runwieldSession", client);
    contextBridge.exposeInMainWorld("runwieldWorkbench", workbench);
    contextBridge.exposeInMainWorld("runwieldProjects", projects);
    contextBridge.exposeInMainWorld("runwieldLinks", {
        open(href: string): Promise<void> {
            if (!navigator.userActivation.isActive) return Promise.reject(new Error("Activate a link to open it."));
            return ipcRenderer.invoke("desktop:open-link", href);
        },
    });
}
