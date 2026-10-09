import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

export interface ArtifactConversationMessage {
    id: string;
    role: "user" | "agent";
    body: string;
    contextLabel?: string;
}

export interface ArtifactConversationSidebarProps {
    agentLabel: string;
    artifactLabel?: string;
    messages: ArtifactConversationMessage[];
    composer: string;
    attachedContextLabel?: string;
    working: boolean;
    disabled?: boolean;
    error?: string;
    onComposerChange: (value: string) => void;
    onSend: () => void;
    onDetachContext?: () => void;
}

export function ArtifactConversationSidebar(props: ArtifactConversationSidebarProps) {
    const transcriptRef = useRef<HTMLDivElement>(null);
    const canSend = Boolean(props.composer.trim() || props.attachedContextLabel) && !props.working && !props.disabled;
    const artifactLabel = props.artifactLabel || "Plan";

    useEffect(() => {
        const transcript = transcriptRef.current;
        if (transcript) transcript.scrollTop = transcript.scrollHeight;
    }, [props.messages, props.working]);

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || !canSend) return;
        event.preventDefault();
        props.onSend();
    }

    return (
        <section className="rw-artifact-conversation" aria-label={`${props.agentLabel} conversation`}>
            <div className="rw-artifact-conversation-transcript" ref={transcriptRef} aria-live="polite">
                {props.messages.length === 0 && (
                    <div className="rw-artifact-conversation-empty">
                        <span className="rw-artifact-conversation-avatar" aria-hidden="true">
                            {props.agentLabel.slice(0, 1).toUpperCase()}
                        </span>
                        <h3>Talk through the {artifactLabel}</h3>
                        <p>
                            Ask {props.agentLabel} to clarify or revise something. The updated {artifactLabel}{" "}
                            will appear here with its changes highlighted.
                        </p>
                    </div>
                )}
                {props.messages.map((message) => (
                    <article
                        className={`rw-artifact-conversation-message rw-artifact-conversation-message-${message.role}`}
                        key={message.id}
                    >
                        <span>{message.role === "agent" ? props.agentLabel : "You"}</span>
                        <p>{message.body}</p>
                        {message.contextLabel && <small>{message.contextLabel}</small>}
                    </article>
                ))}
                {props.working && (
                    <div className="rw-artifact-conversation-working">
                        <RunWieldThinkingDots
                            label={`${props.agentLabel} is reviewing the ${artifactLabel}…`}
                        />
                    </div>
                )}
            </div>
            <div className="rw-artifact-conversation-composer">
                {props.attachedContextLabel && (
                    <div className="rw-artifact-conversation-context">
                        <span>{props.attachedContextLabel}</span>
                        <button type="button" onClick={props.onDetachContext} aria-label="Remove attached annotations">
                            ×
                        </button>
                    </div>
                )}
                <textarea
                    className="rw-modal-textarea"
                    value={props.composer}
                    onChange={(event) => props.onComposerChange(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`Message ${props.agentLabel}…`}
                    rows={4}
                    disabled={props.working || props.disabled}
                />
                {props.error && <p className="rw-artifact-conversation-error" role="alert">{props.error}</p>}
                <div className="rw-artifact-conversation-submit">
                    <span>⌘↵</span>
                    <button
                        className="rw-review-action-button"
                        type="button"
                        disabled={!canSend}
                        onClick={props.onSend}
                    >
                        Send to {props.agentLabel}
                    </button>
                </div>
            </div>
        </section>
    );
}
