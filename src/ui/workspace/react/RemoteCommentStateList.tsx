import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

import type { RemoteCommentRecord } from "./remote-review-payload.js";

export type RemoteCommentStateItem = Omit<RemoteCommentRecord, "anchor">;

export interface RemoteCommentStateListProps {
    comments: RemoteCommentStateItem[];
    selectedId: string | null;
    closed: boolean;
    pendingId: string | null;
    onSelect: (id: string) => void;
    onResolve: (id: string) => void;
    onReopen: (id: string) => void;
}

export function RemoteCommentStateList(
    { comments, selectedId, closed, pendingId, onResolve, onReopen }: RemoteCommentStateListProps,
) {
    const selectedComment = selectedId ? comments.find((comment) => comment.id === selectedId) : null;
    return (
        <>
            {closed && (
                <p className="notice muted" role="status">
                    This Shared Space is closed. Comments remain readable, but updates are disabled.
                </p>
            )}
            {selectedComment
                ? (
                    <section className="rw-remote-comment-state-panel" aria-label="Selected comment state">
                        {selectedComment.unreadable
                            ? (
                                <p className="rw-comment-error">
                                    This comment could not be decrypted. It may use a different key or be tampered with.
                                </p>
                            )
                            : null}
                        {selectedComment.anchorMissing
                            ? <p className="rw-comment-anchor-missing">Anchor not found in this revision.</p>
                            : null}
                        <div className="rw-comment-state-row">
                            <span className={selectedComment.resolved ? "badge success" : "badge"}>
                                {selectedComment.resolved ? "Resolved" : "Open"}
                            </span>
                            {!selectedComment.unreadable
                                ? (
                                    selectedComment.resolved
                                        ? (
                                            <button
                                                type="button"
                                                disabled={closed || pendingId === selectedComment.id}
                                                onClick={() => onReopen(selectedComment.id)}
                                            >
                                                {pendingId === selectedComment.id
                                                    ? <RunWieldThinkingDots label="Reopening" />
                                                    : "Reopen"}
                                            </button>
                                        )
                                        : (
                                            <button
                                                type="button"
                                                disabled={closed || pendingId === selectedComment.id}
                                                onClick={() => onResolve(selectedComment.id)}
                                            >
                                                {pendingId === selectedComment.id
                                                    ? <RunWieldThinkingDots label="Resolving" />
                                                    : "Resolve"}
                                            </button>
                                        )
                                )
                                : null}
                        </div>
                    </section>
                )
                : null}
        </>
    );
}
