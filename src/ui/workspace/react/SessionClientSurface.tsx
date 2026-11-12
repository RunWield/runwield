import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import type { SessionBinding, SessionClientView, WorkspaceSessionClient } from "../client/session-client.ts";
import { SessionTimeline } from "../components/SessionTimeline.jsx";
import { SessionQuestionForm } from "../components/SessionQuestionForm.tsx";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import "./session-client-surface.css";

interface SessionClientSurfaceProps {
    client: WorkspaceSessionClient;
}
const PHASE_LABELS: Record<SessionClientView["phase"], string> = {
    empty: "No Session open",
    loading: "Loading Session…",
    idle: "Ready",
    streaming: "Working…",
    awaiting_answer: "Answer needed",
    canceling: "Stopping…",
    interrupted: "Interrupted",
};

/** Shared Session composition; the host supplies operations, not runtime authority. */
export function SessionClientSurface({ client }: SessionClientSurfaceProps) {
    const [view, setView] = useState<SessionClientView | null>(null);
    const [knownId, setKnownId] = useState("");
    const [draft, setDraft] = useState("");
    const [error, setError] = useState("");
    const [changing, setChanging] = useState(false);
    const [sending, setSending] = useState(false);
    const [stopping, setStopping] = useState(false);
    const composer = useRef<HTMLTextAreaElement>(null);
    const question = useRef<HTMLElement>(null);
    const conversation = useRef<HTMLElement>(null);
    const following = useRef(true);
    useLayoutEffect(() => {
        following.current = true;
    }, [view?.sessionId]);
    useLayoutEffect(() => {
        if (following.current && conversation.current)
            conversation.current.scrollTop = conversation.current.scrollHeight;
    }, [view?.sessionId, view?.items, view?.question?.requestId]);
    useEffect(() => client.observe(setView), [client]);
    useEffect(() => {
        if (view?.phase === "awaiting_answer") question.current?.querySelector<HTMLElement>("input, textarea")?.focus();
        else if (view?.phase === "idle") composer.current?.focus();
    }, [view?.phase, view?.question?.requestId]);
    useEffect(() => {
        if (view?.durableSessionId) setKnownId(view.durableSessionId);
    }, [view?.durableSessionId]);
    if (!view)
        return (
            <main className="session-client">
                <p role="status">Connecting to runtime…</p>
            </main>
        );
    const binding: SessionBinding = {
        connectionId: view.connectionId,
        project: view.project,
        sessionId: view.sessionId,
    };
    const connected = view.connection === "ready";
    const available = connected && !changing;
    const active = Boolean(view.sessionId);
    const idle = view.phase === "idle";
    const working = view.phase === "streaming" || view.phase === "awaiting_answer";
    const status =
        view.connection === "ready"
            ? PHASE_LABELS[view.phase]
            : view.connection === "connecting"
              ? "Connecting…"
              : view.connection === "incompatible"
                ? "Protocol not supported"
                : "Disconnected";
    async function change(operation: () => Promise<void>) {
        setChanging(true);
        setError("");
        try {
            await operation();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "The Session operation failed.");
        } finally {
            setChanging(false);
        }
    }
    async function send(event: SubmitEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!draft.trim() || sending || !idle || !available) return;
        setSending(true);
        following.current = true;
        setError("");
        try {
            await client.send(binding, draft);
            setDraft("");
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "The message was not sent.");
        } finally {
            setSending(false);
        }
    }
    async function stop() {
        setStopping(true);
        setError("");
        try {
            await client.cancel(binding);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not stop the Session.");
        } finally {
            setStopping(false);
        }
    }
    const items = view.items.map((item) => ({
        ...item,
        key: item.id,
        agentName: "RunWield",
        kind: item.kind === "user" || item.kind === "assistant" ? "message" : item.kind,
        role: item.kind,
        output: item.text,
        status: item.status === "in_progress" ? "running" : item.status,
        done: !working,
    }));
    return (
        <main className="session-client">
            <header className="session-client-header">
                <h1>RunWield</h1>
                <p className="session-client-project" title={view.project}>
                    <span>Project</span> <code>{view.project}</code>
                </p>
                <p className="session-client-status" role="status">
                    {status}
                </p>
            </header>
            <section className="session-client-controls" aria-label="Session controls">
                <RunWieldButton
                    variant="primary"
                    disabled={!available || active || view.phase === "loading"}
                    onClick={() => void change(() => client.create())}
                >
                    New Session
                </RunWieldButton>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void change(() => client.load(knownId));
                    }}
                >
                    <label htmlFor="saved-session-id">Saved Session ID</label>
                    <input
                        id="saved-session-id"
                        value={knownId}
                        onChange={(event) => setKnownId(event.target.value)}
                        maxLength={512}
                        disabled={!available || active || view.phase === "loading"}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <RunWieldButton
                        type="submit"
                        disabled={!available || active || !knownId.trim() || view.phase === "loading"}
                    >
                        Load
                    </RunWieldButton>
                </form>
                <RunWieldButton
                    disabled={!available || !active || view.phase === "loading" || view.phase === "canceling"}
                    onClick={() => void change(() => client.close(binding))}
                >
                    Close Session
                </RunWieldButton>
            </section>
            {active ? (
                <dl className="session-client-identity">
                    <dt>Session</dt>
                    <dd>
                        <code>{view.sessionId}</code>
                    </dd>
                    {view.durableSessionId !== view.sessionId ? (
                        <>
                            <dt>Saved ID</dt>
                            <dd>
                                <code>{view.durableSessionId}</code>
                            </dd>
                        </>
                    ) : null}
                </dl>
            ) : null}
            {error || view.error ? (
                <p className="session-client-error" role="alert">
                    {view.error || error}
                </p>
            ) : null}
            <section
                className="session-client-conversation"
                ref={conversation}
                onScroll={(event) => {
                    const panel = event.currentTarget;
                    following.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
                }}
                aria-label="Conversation"
                aria-busy={view.phase === "loading"}
            >
                <SessionTimeline
                    items={items}
                    emptyMessage={
                        active
                            ? "Send a message to start the conversation."
                            : "Create a Session or load a saved Session."
                    }
                />
                {view.question ? (
                    <section
                        ref={question}
                        className="session-client-question"
                        aria-label="Pending question"
                        key={view.question.requestId}
                    >
                        <SessionQuestionForm
                            host="embedded"
                            mode={view.question.mode}
                            prompt={view.question.prompt}
                            placeholder={view.question.placeholder}
                            allowEmpty={!view.question.required}
                            allowOther={view.question.allowOther}
                            options={view.question.choices}
                            onRawResponse={(fields) =>
                                client.answer(binding, { ...fields, requestId: view.question!.requestId })
                            }
                        />
                    </section>
                ) : null}
            </section>
            <form className="session-client-composer" onSubmit={send}>
                <label htmlFor="session-message">Message</label>
                <textarea
                    ref={composer}
                    id="session-message"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={65536}
                    rows={3}
                    disabled={!available || !active || !idle || sending}
                />
                <div className="session-client-composer-actions">
                    <RunWieldButton
                        type="submit"
                        variant="primary"
                        disabled={!available || !active || !idle || sending || !draft.trim()}
                    >
                        Send
                    </RunWieldButton>
                    <RunWieldButton disabled={!available || !working || stopping} onClick={() => void stop()}>
                        Stop
                    </RunWieldButton>
                </div>
            </form>
        </main>
    );
}
