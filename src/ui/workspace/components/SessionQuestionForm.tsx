/** Shared select/text/approval question controls for Workspace-style browser surfaces. */
import { type SubmitEvent, useEffect, useState } from "react";
import { isApprovalAcceptedValue } from "../../../shared/session/interaction-values.ts";
import type { SessionQuestionFields } from "../client/session-client.ts";

type SessionQuestionOption = {
    value: string;
    label: string;
    description?: string;
    _meta?: { accepted?: boolean; approvalOutcome?: string };
};

type SessionQuestionResponse = {
    outcome: string;
    value?: string | boolean;
    valueLabel?: string;
    message?: string;
};

type SessionQuestionFormProps = {
    mode?: "select" | "text" | "approval" | string;
    state?: "pending" | "submitting" | "completed" | string;
    error?: string;
    prompt?: string;
    value?: string;
    placeholder?: string;
    allowEmpty?: boolean;
    action?: string;
    sessionId?: string;
    questionId?: string;
    options?: SessionQuestionOption[];
    onResponse?: (response: SessionQuestionResponse) => Promise<void> | void;
    onRawResponse?: (response: SessionQuestionFields) => Promise<void> | void;
    allowOther?: boolean;
    host?: "browser" | "embedded";
};

function defaultOptions(mode: string): SessionQuestionOption[] {
    if (mode === "approval")
        return [
            { value: "approve", label: "Approve" },
            { value: "decline", label: "Decline" },
        ];
    return [
        { value: "guide", label: "Guide" },
        { value: "planner", label: "Planner" },
        {
            value: "engineer",
            label: "Engineer",
        },
    ];
}

export function SessionQuestionForm({
    mode = "select",
    state = "pending",
    error = "",
    prompt = "",
    value = "",
    placeholder = "",
    allowEmpty = false,
    action = "",
    sessionId = "",
    questionId = "",
    options,
    onResponse,
    onRawResponse,
    allowOther = true,
    host = "browser",
}: SessionQuestionFormProps) {
    const [currentState, setCurrentState] = useState(state);
    const [currentError, setCurrentError] = useState(error);
    useEffect(() => {
        setCurrentState(state);
    }, [state]);
    useEffect(() => {
        setCurrentError(error);
    }, [error]);
    const isText = mode === "text";
    const isApproval = mode === "approval";
    const disabled = currentState === "submitting" || currentState === "completed";
    const title = prompt || (isText ? "Answer question" : isApproval ? "Approve?" : "Choose one");
    const choices = options?.length ? options : defaultOptions(mode);

    async function submitQuestion(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault();
        setCurrentState("submitting");
        setCurrentError("");
        const submitter = event.nativeEvent.submitter;
        const form = new FormData(event.currentTarget);
        if (submitter instanceof HTMLButtonElement && submitter.name) form.set(submitter.name, submitter.value);
        if (onRawResponse) {
            const answer = String(form.get("answer") ?? "");
            const canceled = Boolean(form.get("cancel"));
            if (!canceled && !allowEmpty && !answer.trim()) {
                setCurrentState("pending");
                setCurrentError(isText ? "An answer is required." : "Choose an answer.");
                return;
            }
            try {
                await onRawResponse(
                    canceled
                        ? { action: "cancel" }
                        : {
                              action: "accept",
                              answer,
                              ...(allowOther && !isText ? { otherAnswer: String(form.get("customAnswer") ?? "") } : {}),
                          },
                );
                setCurrentState("completed");
            } catch (caught) {
                setCurrentState("pending");
                setCurrentError(caught instanceof Error ? caught.message : "Could not send answer.");
            }
            return;
        }
        if (onResponse) {
            const selectedValue = String(form.get("answer") ?? "");
            const customValue = String(form.get("customAnswer") ?? "").trim();
            const formValue = !isText && !isApproval && customValue ? customValue : selectedValue;
            const option = choices.find((item) => item.value === selectedValue);
            const accepted = isApprovalAcceptedValue({ options: choices }, selectedValue);
            const response = form.get("cancel")
                ? { outcome: "canceled", value: false }
                : isText
                  ? { outcome: "text", value: formValue }
                  : isApproval && !accepted
                    ? { outcome: "canceled", value: false, valueLabel: option?.label || formValue }
                    : {
                          outcome: isApproval ? "accepted" : "selected",
                          value: isApproval ? true : formValue,
                          valueLabel: customValue && !isApproval ? "Other" : option?.label || formValue,
                      };
            try {
                await onResponse(response);
                setCurrentState("completed");
            } catch (caught) {
                setCurrentState("pending");
                setCurrentError(caught instanceof Error ? caught.message : String(caught || "Could not send answer."));
            }
            return;
        }
        const customValue = String(form.get("customAnswer") ?? "").trim();
        if (!isText && !isApproval && customValue) form.set("answer", customValue);
        if (!action) {
            setCurrentState("pending");
            setCurrentError("This question is missing a submit URL.");
            return;
        }
        try {
            const response = await fetch(action, { method: "POST", body: form });
            const text = await response.text();
            if (!response.ok) {
                setCurrentState("pending");
                setCurrentError(text || "The answer was not accepted.");
                return;
            }
            setCurrentState("completed");
        } catch (caught) {
            setCurrentState("pending");
            setCurrentError(caught instanceof Error ? caught.message : "Could not send answer.");
        }
    }

    const Heading = host === "embedded" ? "h2" : "h1";
    return (
        <form
            className="rw-question-card"
            data-host={host}
            aria-busy={currentState === "submitting" ? "true" : "false"}
            method="post"
            action={action}
            onSubmit={submitQuestion}
        >
            {host === "browser" ? <p className="kicker">RunWield question</p> : null}
            <Heading>{title}</Heading>
            {sessionId || questionId ? (
                <p className="rw-question-meta">
                    Session: {sessionId || "unknown"} · Question: {questionId || "unknown"}
                </p>
            ) : null}
            <p className="rw-question-help">
                {host === "embedded"
                    ? "Answer to continue the Session."
                    : "Answer this browser question to continue the waiting command."}
            </p>
            {currentError ? (
                <p className="rw-question-error" role="alert">
                    {currentError}
                </p>
            ) : null}
            {currentState === "completed" ? (
                <p className="rw-question-complete">
                    {host === "embedded" ? "Answer sent." : "Answer saved. You can close this tab."}
                </p>
            ) : null}
            {isText ? (
                <label className="rw-question-field">
                    <span>Answer</span>
                    <textarea
                        name="answer"
                        required={!allowEmpty}
                        disabled={disabled}
                        placeholder={placeholder}
                        defaultValue={onRawResponse ? "" : value}
                    />
                </label>
            ) : (
                <fieldset className="rw-question-field" disabled={disabled}>
                    <legend>{isApproval ? "Decision" : "Choices"}</legend>
                    {choices.map((option) => (
                        <label className="rw-question-option" key={option.value}>
                            <input
                                type="radio"
                                name="answer"
                                value={option.value}
                                required={isApproval || Boolean(onRawResponse && !allowEmpty)}
                            />
                            <span>
                                <strong>{option.label}</strong>
                                {option.description ? <small>{option.description}</small> : null}
                            </span>
                        </label>
                    ))}
                    {allowOther && (!isApproval || onRawResponse) ? (
                        <label className="rw-question-field">
                            <span>Other answer</span>
                            <input name="customAnswer" disabled={disabled} placeholder="Type a different answer" />
                        </label>
                    ) : null}
                </fieldset>
            )}
            <div className="rw-question-actions">
                <button type="submit" className="rw-toolbar-button rw-toolbar-button-primary" disabled={disabled}>
                    {currentState === "submitting" ? "Submitting…" : "Submit answer"}
                </button>
                <button
                    type="submit"
                    name="cancel"
                    value="1"
                    formNoValidate
                    className="rw-toolbar-button"
                    disabled={disabled}
                >
                    Cancel
                </button>
            </div>
        </form>
    );
}
