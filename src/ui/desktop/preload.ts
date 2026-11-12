import { contextBridge, ipcRenderer } from "electron";
import type {
    SessionBinding,
    SessionClientView,
    SessionQuestionAnswer,
    WorkspaceSessionClient,
} from "../workspace/client/session-client.ts";
import type { DesktopProjectClient } from "../workspace/client/project-client.ts";
import { PROJECT_CHANNEL } from "./bridge.ts";
import { SESSION_CHANNEL } from "./bridge.ts";

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
const client: WorkspaceSessionClient = {
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
if (process.isMainFrame) {
    contextBridge.exposeInMainWorld("runwieldSession", client);
    contextBridge.exposeInMainWorld("runwieldProjects", projects);
    contextBridge.exposeInMainWorld("runwieldLinks", {
        open(href: string): Promise<void> {
            if (!navigator.userActivation.isActive) return Promise.reject(new Error("Activate a link to open it."));
            return ipcRenderer.invoke("desktop:open-link", href);
        },
    });
}
