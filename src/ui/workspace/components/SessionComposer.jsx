import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { sessionCommandSuggestions, sessionModelLabel } from "./session-commands.ts";

function PaperAirplaneIcon() {
    return (
        <svg className="rw-session-toolbar-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.5 4.5 20.5 12 3.5 19.5 6 12Zm0 0h7" />
        </svg>
    );
}

function resizeComposerTextArea(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * @typedef {Object} SessionComposerProps
 * @property {string} id
 * @property {string} draft
 * @property {boolean} disabled
 * @property {boolean} [controlsDisabled]
 * @property {boolean} [allowImages]
 * @property {boolean} [canQueue]
 * @property {boolean} canSend
 * @property {boolean} submitting
 * @property {(draft: string) => void} onDraftChange
 * @property {() => void} onSubmit
 * @property {number} [maxLength]
 * @property {boolean} [alwaysExpanded]
 * @property {import("react").ReactNode} [mascotSlot]
 * @property {() => void} [onResizeStart]
 * @property {() => void} [onResize]
 * @property {() => void} [onQueue]
 * @property {() => void} [onStop]
 * @property {string} [sendLabel]
 * @property {Array<{id: string, text: string}>} [steeringMessages]
 * @property {import("react").ClipboardEventHandler<HTMLTextAreaElement>} [onPaste]
 * @property {(files: File[]) => void} [onFiles]
 * @property {Array<{id: string, name: string, mimeType: string, base64: string}>} [imageAttachments]
 * @property {(id: string) => void} [onRemoveImage]
 * @property {import("./session-commands.ts").SessionAgentOption[]} [agents]
 * @property {import("./session-commands.ts").SessionModelOption[]} [models]
 * @property {string[]} [thinkingLevels]
 * @property {string} [agentValue]
 * @property {string} [mascotAgent]
 * @property {string} [mascotParentAgent]
 * @property {import("../../mascot/frames.ts").Pose} [mascotActivity]
 * @property {boolean} [mascotVisible]
 * @property {string} [modelValue]
 * @property {string} [thinkingValue]
 * @property {(value: string) => void | boolean | Promise<void | boolean>} [onAgentChange]
 * @property {(value: string) => void | boolean | Promise<void | boolean>} [onModelChange]
 * @property {(value: string) => void | boolean | Promise<void | boolean>} [onThinkingChange]
 * @property {import("react").ReactNode} [agentFallback]
 * @property {import("react").ReactNode} [modelFallback]
 * @property {import("react").ReactNode} [thinkingFallback]
 * @property {Array<{id: string, text: string, images?: import("../../../shared/session/session-input-contract.ts").SessionImageTransfer[]}>} [queuedMessages]
 * @property {import("./session-commands.ts").SessionCommand[]} [commands]
 * @property {(draft: string) => boolean} [onCommand]
 * @property {(command: string) => void} [onCommandPickerOpen]
 * @property {() => void} [onCommandPickerCancel]
 * @param {SessionComposerProps} props
 */
export function SessionComposer({
    id,
    maxLength = undefined,
    alwaysExpanded = false,
    mascotSlot = null,
    draft,
    disabled,
    controlsDisabled = disabled,
    canSend,
    allowImages = true,
    canQueue = canSend,
    submitting,
    onDraftChange,
    onSubmit,
    onResizeStart = undefined,
    onResize = undefined,
    onQueue = undefined,
    onStop = undefined,
    sendLabel = "Send",
    steeringMessages = [],
    onPaste,
    onFiles,
    imageAttachments = [],
    onRemoveImage,
    agents = [],
    models = [],
    thinkingLevels = [],
    agentValue,
    mascotAgent = agentValue || "",
    mascotParentAgent = undefined,
    mascotActivity = "idle",
    mascotVisible = false,
    modelValue,
    thinkingValue,
    onAgentChange,
    onModelChange,
    onThinkingChange,
    agentFallback = null,
    modelFallback = null,
    thinkingFallback = null,
    queuedMessages = [],
    commands = [],
    onCommand = undefined,
    onCommandPickerOpen = undefined,
    onCommandPickerCancel = undefined,
}) {
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const composerRef = useRef(null);
    const composerAnimation = useRef(null);
    const previousComposerHeight = useRef(null);
    const focusInputOnExpand = useRef(false);
    const [expanded, setExpanded] = useState(alwaysExpanded);
    const hasDraft = Boolean(draft.trim() || imageAttachments.length);
    const canReopenReview = draft.trim() === "/plan-review";
    const showStop = Boolean(onStop) && !hasDraft;
    const primaryLabel = showStop ? "Stop" : sendLabel;
    const selectionSummary = [
        agents.find((agent) => agent.name === agentValue)?.displayName || agentValue || "Agent",
        modelValue?.replace("\u001f", "/") || "Project default",
        thinkingValue || "Default thinking",
    ].join(" · ");
    function setComposerExpanded(nextExpanded) {
        if (alwaysExpanded || nextExpanded === expanded) return;
        onResizeStart?.();
        previousComposerHeight.current = composerRef.current?.getBoundingClientRect().height ?? null;
        composerAnimation.current?.cancel();
        setExpanded(nextExpanded);
    }
    function expandComposer() {
        focusInputOnExpand.current = true;
        setComposerExpanded(true);
    }
    useLayoutEffect(() => {
        if (expanded) resizeComposerTextArea(textareaRef.current);
        const composer = composerRef.current;
        const previousHeight = previousComposerHeight.current;
        previousComposerHeight.current = null;
        if (composer && previousHeight !== null && !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const styles = getComputedStyle(composer);
            composerAnimation.current = composer.animate(
                [
                    { height: `${previousHeight}px`, overflow: "clip" },
                    { height: `${composer.getBoundingClientRect().height}px`, overflow: "clip" },
                ],
                {
                    duration: Number.parseFloat(styles.getPropertyValue("--rw-control-motion-duration")),
                    easing: styles.getPropertyValue("--rw-control-motion-ease").trim(),
                },
            );
        }
        onResize?.();
        if (expanded && focusInputOnExpand.current) {
            focusInputOnExpand.current = false;
            textareaRef.current?.focus({ preventScroll: true });
        }
    }, [expanded]);
    useEffect(() => () => composerAnimation.current?.cancel(), []);
    const [commandIndex, setCommandIndex] = useState(0);
    const [dismissedCommandDraft, setDismissedCommandDraft] = useState(null);
    const commandSuggestions =
        dismissedCommandDraft === draft
            ? []
            : sessionCommandSuggestions(draft, {
                  commands,
                  agents,
                  models,
              });
    const selectedCommandIndex = Math.min(commandIndex, Math.max(0, commandSuggestions.length - 1));
    const commandListId = `${id}-commands`;
    useEffect(() => setCommandIndex(0), [draft]);
    useEffect(() => {
        document.getElementById(`${commandListId}-${selectedCommandIndex}`)?.scrollIntoView({ block: "nearest" });
    }, [commandListId, selectedCommandIndex, draft]);
    async function pickCommand(suggestion) {
        if (suggestion.kind === "command") {
            if (["/agent ", "/model "].includes(suggestion.value)) {
                onCommandPickerOpen?.(suggestion.value.trim().slice(1));
            }
            onDraftChange(suggestion.value);
        } else {
            if (controlsDisabled) return;
            const apply = suggestion.kind === "agent" ? onAgentChange : onModelChange;
            const applied = await apply(suggestion.value);
            if (applied !== false) onDraftChange("");
        }
        textareaRef.current?.focus();
    }
    function submitComposer() {
        if (draft.startsWith("/") && onCommand?.(draft) === true) return;
        onSubmit();
    }
    useEffect(() => resizeComposerTextArea(textareaRef.current), [draft]);
    return (
        <form
            className="session-composer"
            ref={composerRef}
            data-expanded={expanded}
            onFocusCapture={(event) => {
                if (!event.target.classList.contains("session-composer-summary")) setComposerExpanded(true);
            }}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    setComposerExpanded(false);
                    onCommandPickerCancel?.();
                }
            }}
            onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                if (!disabled) onFiles?.(Array.from(event.dataTransfer.files));
            }}
            onSubmit={(event) => {
                event.preventDefault();
                submitComposer();
            }}
        >
            {commandSuggestions.length > 0 && (
                <div
                    className="rw-command-menu"
                    hidden={!expanded}
                    id={commandListId}
                    role="listbox"
                    aria-label="Commands"
                >
                    {commandSuggestions.map((suggestion, index) => (
                        <button
                            key={suggestion.key}
                            id={`${commandListId}-${index}`}
                            type="button"
                            role="option"
                            aria-selected={index === selectedCommandIndex}
                            disabled={controlsDisabled && suggestion.kind !== "command"}
                            tabIndex={-1}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => pickCommand(suggestion)}
                        >
                            <strong>{suggestion.label}</strong>
                            <span>{suggestion.description}</span>
                        </button>
                    ))}
                </div>
            )}
            {queuedMessages.length ? (
                <ol className="session-composer-queue" hidden={!expanded} aria-label="Queued messages">
                    {queuedMessages.map((item) => (
                        <li key={item.id}>
                            <span>{item.text || "Image message"}</span>
                            {Array.isArray(item.images) && item.images.length ? (
                                <small>
                                    {item.images.length} image{item.images.length === 1 ? "" : "s"}
                                </small>
                            ) : null}
                        </li>
                    ))}
                </ol>
            ) : null}
            {steeringMessages.length ? (
                <ul className="session-composer-queue" hidden={!expanded} aria-label="Pending steering messages">
                    {steeringMessages.map((item) => (
                        <li key={item.id}>
                            <span>Steering · {item.text}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <textarea
                ref={textareaRef}
                hidden={!expanded}
                id={id}
                maxLength={maxLength}
                value={draft}
                rows={2}
                disabled={disabled}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={expanded && commandSuggestions.length > 0}
                aria-controls={commandSuggestions.length ? commandListId : undefined}
                aria-activedescendant={
                    commandSuggestions.length ? `${commandListId}-${selectedCommandIndex}` : undefined
                }
                onPaste={onPaste}
                onChange={(event) => {
                    setDismissedCommandDraft(null);
                    onDraftChange(event.currentTarget.value);
                    resizeComposerTextArea(event.currentTarget);
                }}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (commandSuggestions.length) {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            setDismissedCommandDraft(draft);
                            onCommandPickerCancel?.();
                            return;
                        }
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            setCommandIndex(
                                (selectedCommandIndex +
                                    (event.key === "ArrowDown" ? 1 : -1) +
                                    commandSuggestions.length) %
                                    commandSuggestions.length,
                            );
                            return;
                        }
                        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                            event.preventDefault();
                            void pickCommand(commandSuggestions[selectedCommandIndex]);
                            return;
                        }
                    }
                    if (event.key === "Escape" && onStop) {
                        event.preventDefault();
                        onStop();
                    }
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if ((canSend || canReopenReview) && !submitting) submitComposer();
                    }
                }}
                placeholder="Ask RunWield..."
                aria-label="Message"
            />
            {imageAttachments.length ? (
                <ul
                    className="session-image-attachments rw-image-previews"
                    hidden={!expanded}
                    aria-label="Attached images"
                >
                    {imageAttachments.map((image) => (
                        <li key={image.id}>
                            <img src={`data:${image.mimeType};base64,${image.base64}`} alt={image.name} />
                            <span>
                                {image.name} · {image.mimeType}
                            </span>
                            <button type="button" onClick={() => onRemoveImage?.(image.id)}>
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="session-composer-actions" aria-label="Session settings">
                {mascotSlot}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                        onFiles?.(Array.from(event.currentTarget.files || []));
                        event.currentTarget.value = "";
                    }}
                />
                <button
                    type="button"
                    className="rw-toolbar-button session-composer-icon-button session-attach-button"
                    hidden={!allowImages}
                    aria-label="Attach image"
                    title="Attach image"
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <svg
                        className="rw-session-toolbar-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                    </svg>
                </button>
                <button
                    type="button"
                    className="session-composer-summary"
                    hidden={expanded}
                    aria-label={`${hasDraft ? "Continue draft" : "Write a message"} · ${selectionSummary}`}
                    title={selectionSummary}
                    disabled={disabled}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        expandComposer();
                    }}
                    onFocus={expandComposer}
                    onClick={expandComposer}
                >
                    <span>{selectionSummary}</span>
                </button>
                <select
                    hidden={!expanded}
                    aria-label="Agent"
                    className="rw-toolbar-select"
                    title={`Agent: ${agents.find((agent) => agent.name === agentValue)?.displayName || agentValue}`}
                    value={agentValue}
                    disabled={controlsDisabled || !agents.length}
                    onChange={(event) => onAgentChange(event.currentTarget.value)}
                >
                    {agentFallback}
                    {agents.map((agent) => (
                        <option key={agent.name} value={agent.name}>
                            {agent.displayName || agent.name}
                        </option>
                    ))}
                </select>
                <select
                    hidden={!expanded}
                    aria-label="Model"
                    className="rw-toolbar-select session-model-select"
                    title={`Provider/model: ${modelValue?.replace("\u001f", "/") || "Project default"}`}
                    value={modelValue}
                    disabled={controlsDisabled || !models.length}
                    onChange={(event) => onModelChange(event.currentTarget.value)}
                >
                    {modelFallback}
                    {models.map((model) => (
                        <option key={`${model.provider}/${model.id}`} value={`${model.provider}\u001f${model.id}`}>
                            {sessionModelLabel(model)}
                        </option>
                    ))}
                </select>
                <select
                    hidden={!expanded}
                    aria-label="Thinking"
                    className="rw-toolbar-select"
                    title={`Thinking: ${thinkingValue}`}
                    value={thinkingValue}
                    disabled={controlsDisabled || !thinkingLevels.length}
                    onChange={(event) => onThinkingChange(event.currentTarget.value)}
                >
                    {thinkingFallback}
                    {thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                            {level}
                        </option>
                    ))}
                </select>
                {onQueue ? (
                    <button
                        type="button"
                        className="rw-toolbar-button session-composer-icon-button session-queue-button"
                        hidden={!expanded}
                        aria-label="Queue"
                        title="Queue follow-up"
                        disabled={!canQueue || submitting}
                        onClick={onQueue}
                    >
                        <svg
                            className="rw-session-toolbar-icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                        >
                            <path strokeLinecap="round" d="M4 6h16M4 12h9M4 18h9m5-5v8m-4-4h8" />
                        </svg>
                    </button>
                ) : null}
                <button
                    type={showStop ? "button" : "submit"}
                    className="rw-toolbar-button session-composer-icon-button session-send-button"
                    disabled={!showStop && ((!canSend && !canReopenReview) || submitting)}
                    onClick={showStop ? onStop : undefined}
                    aria-label={primaryLabel}
                    title={primaryLabel}
                >
                    {showStop ? (
                        <svg
                            className="rw-session-toolbar-icon"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden="true"
                        >
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                    ) : submitting ? (
                        <RunWieldThinkingDots label="Sending" showLabel={false} />
                    ) : (
                        <PaperAirplaneIcon />
                    )}
                </button>
            </div>
        </form>
    );
}
