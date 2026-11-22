import type { SessionBinding } from "../workspace/client/session-client.ts";
import type { SessionComposerDraft } from "../workspace/client/session-drafts.ts";
import { validateSessionInput } from "../../shared/session/session-input-contract.ts";

export const DRAFT_CHANNEL = "desktop:draft:";
export interface DesktopDraftRequest extends SessionBinding {
    composer?: SessionComposerDraft;
    requestId?: string;
}
export function validateComposer(composer: SessionComposerDraft): void {
    if (
        !composer ||
        typeof composer !== "object" ||
        Array.isArray(composer) ||
        Object.keys(composer).some((key) => !["text", "images", "requestId"].includes(key)) ||
        typeof composer.requestId !== "string" ||
        !composer.requestId.trim() ||
        composer.requestId.length > 128 ||
        typeof composer.text !== "string" ||
        composer.text.length > 65536 ||
        !Array.isArray(composer.images)
    )
        throw new Error("Invalid desktop draft.");
    validateSessionInput(
        composer.text.trim() ? composer.text : "image",
        composer.images.map((image) => ({ mimeType: image?.mimeType, base64: image?.base64 })),
    );
    for (const image of composer.images) {
        if (
            Object.keys(image).some((key) => !["id", "name", "mimeType", "base64"].includes(key)) ||
            typeof image.id !== "string" ||
            image.id.length > 128 ||
            typeof image.name !== "string" ||
            image.name.length > 4096
        )
            throw new Error("Invalid draft image.");
    }
}
export function validateDraftRequest(
    operation: "read" | "write" | "discard" | "editQueued",
    payload: DesktopDraftRequest,
    binding: SessionBinding,
): void {
    if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Object.keys(payload).some(
            (key) =>
                ![
                    "connectionId",
                    "project",
                    "sessionId",
                    ...(operation === "write" ? ["composer"] : operation === "editQueued" ? ["requestId"] : []),
                ].includes(key),
        ) ||
        payload.connectionId !== binding.connectionId ||
        payload.project !== binding.project ||
        !payload.sessionId ||
        payload.sessionId !== binding.sessionId
    )
        throw new Error("Invalid desktop draft binding.");
    if (operation === "write") validateComposer(payload.composer!);
    if (
        operation === "editQueued" &&
        (typeof payload.requestId !== "string" || !payload.requestId || payload.requestId.length > 128)
    )
        throw new Error("Invalid queued request ID.");
}
