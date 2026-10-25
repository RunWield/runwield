import { useEffect, useRef } from "react";

interface SavedReviewPayload {
    savedConversation?: boolean;
    conversationStatusUrl?: string;
    reviewRevision?: number;
}
interface SavedReviewTurn {
    turnId: string;
    message: string;
    reply?: string;
}
interface SavedReviewEvent {
    messageId: string;
    delta: string;
}
interface SavedReviewStatus {
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
}
export interface SavedReviewSnapshot {
    turns: SavedReviewTurn[];
    events: SavedReviewEvent[];
    pending: boolean;
    reviewRevision: number;
    revision: number;
    plan: string;
    rawPatch: string;
    reviewStatus?: SavedReviewStatus;
}
export interface SavedReviewMessage {
    id: string;
    role: string;
    body: string;
}

/** Preserve this page's transient replies when a changed round purges its saved text. */
export function mergeSavedReviewMessages(messages: SavedReviewMessage[], snapshot: SavedReviewSnapshot) {
    const result = new Map(messages.map((message) => [message.id, message]));
    for (const turn of snapshot.turns) {
        result.set(`user-${turn.turnId}`, { id: `user-${turn.turnId}`, role: "user", body: turn.message });
        if (turn.reply !== undefined)
            result.set(`agent-${turn.turnId}`, { id: `agent-${turn.turnId}`, role: "agent", body: turn.reply });
    }
    for (const event of snapshot.events) {
        if (event.delta)
            result.set(`agent-${event.messageId}`, {
                id: `agent-${event.messageId}`,
                role: "agent",
                body: event.delta,
            });
    }
    return [...result.values()];
}

/** Attached hosts restore and poll saved turns. Core keeps its existing live-turn path. */
export function useSavedReviewConversation(
    payload: SavedReviewPayload,
    onSnapshot: (snapshot: SavedReviewSnapshot, artifactAdvanced: boolean) => void,
    onError: (message: string) => void,
) {
    const callbacks = useRef({ onSnapshot, onError });
    callbacks.current = { onSnapshot, onError };
    useEffect(() => {
        if (!payload.savedConversation || !payload.conversationStatusUrl) return;
        const controller = new AbortController();
        let revision = payload.reviewRevision ?? 0;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const response = await fetch(payload.conversationStatusUrl!, { signal: controller.signal });
                if (!response.ok) throw new Error("The review host stopped. Reopen the review in Claude.");
                const snapshot: SavedReviewSnapshot = await response.json();
                if (controller.signal.aborted) return;
                const advanced = snapshot.reviewRevision > revision;
                revision = snapshot.reviewRevision;
                callbacks.current.onSnapshot(snapshot, advanced);
            } catch (caught) {
                if (!controller.signal.aborted)
                    callbacks.current.onError(caught instanceof Error ? caught.message : String(caught));
            }
            if (!controller.signal.aborted) timer = setTimeout(poll, 750);
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [payload.savedConversation, payload.conversationStatusUrl, payload.reviewRevision]);
}
