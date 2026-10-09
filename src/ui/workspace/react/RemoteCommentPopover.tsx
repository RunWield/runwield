// @ts-nocheck: Workspace React UI is the scoped TypeScript/TSX exception zone.
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

export function RemoteCommentPopover(
    { mode, selection, displayName, body, disabled, onDisplayNameChange, onBodyChange, onCancel, onSubmit },
) {
    const title = mode === "inline" ? "Comment on selected text" : "Add global revision comment";
    return (
        <form className="rw-remote-comment-popover" onSubmit={onSubmit} aria-label={title}>
            <div className="rw-popover-heading">
                <h3>{title}</h3>
                <button type="button" aria-label="Close comment form" onClick={onCancel}>×</button>
            </div>
            {selection?.originalText ? <blockquote>{selection.originalText}</blockquote> : null}
            <label>
                Display name
                <input
                    value={displayName}
                    onChange={(event) => onDisplayNameChange(event.currentTarget.value)}
                    autoComplete="name"
                    maxLength={80}
                    required
                    placeholder="Your name"
                />
            </label>
            <p className="help-text">
                Your display name is encrypted with this comment and stored locally in this browser.
            </p>
            <label>
                Comment
                <textarea
                    value={body}
                    onChange={(event) => onBodyChange(event.currentTarget.value)}
                    rows={5}
                    required
                    placeholder="Leave feedback for this revision…"
                />
            </label>
            <div className="rw-popover-actions">
                <button type="button" onClick={onCancel}>Cancel</button>
                <button type="submit" disabled={disabled}>
                    {disabled ? <RunWieldThinkingDots label="Saving" /> : "Save encrypted comment"}
                </button>
            </div>
        </form>
    );
}
