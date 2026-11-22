import type { SessionBinding } from "./session-client.ts";
import type { SessionImageTransfer } from "../../../shared/session/session-input-contract.ts";

export interface SessionDraftImage extends SessionImageTransfer {
    id: string;
    name: string;
}
export interface SessionComposerDraft {
    text: string;
    images: SessionDraftImage[];
    requestId: string;
}
export interface SessionDraftSnapshot {
    composer: SessionComposerDraft | null;
    submittedRequestIds?: string[];
}
/** Optional desktop-only intent storage. Does not grant runtime authority. */
export interface WorkspaceDraftClient {
    onDraftAccepted(listener: (binding: SessionBinding, requestId: string) => void): () => void;
    readDraft(binding: SessionBinding): Promise<SessionDraftSnapshot>;
    writeDraft(binding: SessionBinding, composer: SessionComposerDraft): Promise<void>;
    discardDraft(binding: SessionBinding): Promise<void>;
    editQueuedDraft(binding: SessionBinding, requestId: string): Promise<SessionComposerDraft>;
}
