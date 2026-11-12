import type { SessionBinding, SessionQuestionAnswer } from "../workspace/client/session-client.ts";

export const DESKTOP_URL = "runwield://app/";
export const SESSION_CHANNEL = "desktop:session:";
export type DesktopOperation = "create" | "load" | "send" | "answer" | "cancel" | "close" | "observe";
export interface DesktopRequest extends SessionBinding {
    knownId?: string;
    text?: string;
    answer?: SessionQuestionAnswer;
}

/** Validate the untrusted wire shape before invoking any semantic operation. */
export function validateDesktopRequest(
    operation: DesktopOperation,
    payload: DesktopRequest,
    binding: SessionBinding,
): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Session request.");
    const extra =
        operation === "load" ? "knownId" : operation === "send" ? "text" : operation === "answer" ? "answer" : "";
    if (Object.keys(payload).some((key) => !["connectionId", "project", "sessionId", extra].includes(key)))
        throw new Error("Unexpected Session request field.");
    if (
        payload.connectionId !== binding.connectionId ||
        payload.project !== binding.project ||
        payload.sessionId !== binding.sessionId
    )
        throw new Error("This request does not belong to the active Project and Session.");
    if (
        operation === "load" &&
        (typeof payload.knownId !== "string" || !payload.knownId.trim() || payload.knownId.length > 512)
    )
        throw new Error("Enter a saved Session ID.");
    if (
        operation === "send" &&
        (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 65536)
    )
        throw new Error("Enter a message of at most 65,536 characters.");
    if (operation === "answer") {
        const answer = payload.answer;
        if (
            !answer ||
            typeof answer !== "object" ||
            Array.isArray(answer) ||
            Object.keys(answer).some((key) => !["requestId", "action", "answer", "otherAnswer"].includes(key)) ||
            typeof answer.requestId !== "string" ||
            !answer.requestId ||
            answer.requestId.length > 1024 ||
            !["accept", "decline", "cancel"].includes(answer.action) ||
            (answer.answer !== undefined && (typeof answer.answer !== "string" || answer.answer.length > 65536)) ||
            (answer.otherAnswer !== undefined &&
                (typeof answer.otherAnswer !== "string" || answer.otherAnswer.length > 65536))
        )
            throw new Error("Invalid question answer.");
    }
}

export const PROJECT_CHANNEL = "desktop:project:";
export type DesktopProjectOperation =
    "list" | "open" | "register" | "relink" | "setEnabled" | "remove" | "rescan" | "pick" | "candidate";
export interface DesktopProjectRequest {
    connectionId: string;
    projectId?: string;
    root?: string;
    newRoot?: string;
    displayName?: string;
    directoryConfirmation?: string;
    enabled?: boolean;
}
export function validateProjectRequest(
    operation: DesktopProjectOperation,
    payload: DesktopProjectRequest,
    connectionId: string,
): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.connectionId !== connectionId)
        throw new Error("Invalid Project connection.");
    const keys: Record<DesktopProjectOperation, string[]> = {
        list: [],
        open: ["projectId"],
        register: ["root", "displayName", "directoryConfirmation"],
        relink: ["projectId", "newRoot", "displayName", "directoryConfirmation"],
        setEnabled: ["projectId", "enabled"],
        remove: ["projectId"],
        rescan: ["projectId"],
        pick: [],
        candidate: [],
    };
    if (Object.keys(payload).some((key) => key !== "connectionId" && !keys[operation].includes(key)))
        throw new Error("Unexpected Project field.");
    for (const key of ["projectId", "root", "newRoot", "displayName", "directoryConfirmation"] as const) {
        const value = payload[key];
        const limit = key === "root" || key === "newRoot" ? 4096 : key === "displayName" ? 200 : 128;
        if (
            value !== undefined &&
            (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
        )
            throw new Error("Invalid Project field.");
    }
    if (["open", "relink", "setEnabled", "remove", "rescan"].includes(operation) && !payload.projectId)
        throw new Error("Project identity is required.");
    if ((operation === "register" && !payload.root) || (operation === "relink" && !payload.newRoot))
        throw new Error("Project directory is required.");
    if (operation === "setEnabled" && typeof payload.enabled !== "boolean") throw new Error("Enabled must be boolean.");
}
