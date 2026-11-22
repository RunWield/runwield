import type { DesktopWorkbenchClient } from "../client/desktop-workbench.ts";
import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type {
    SessionBinding,
    SessionClientView,
    WorkspaceSessionClient,
    WorkspaceSavedSessionClient,
} from "../client/session-client.ts";
import { SessionComposer } from "../components/SessionComposer.tsx";
import { useSessionOptions } from "./SessionConfiguration.tsx";
import {
    validateSessionInput,
    SESSION_IMAGE_BYTE_LIMIT,
    SESSION_IMAGE_MIME_TYPES,
    type SessionImageTransfer,
} from "../../../shared/session/session-input-contract.ts";
import type { WorkspaceHistoryEvent, WorkspaceConfigurationSelection } from "../../../acp/workspace-contract.ts";
import { SessionTimeline, reduceSessionEvents, mergeSessionTimelineItems } from "../components/SessionTimeline.jsx";
import { SessionQuestionForm } from "../components/SessionQuestionForm.tsx";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import "../static/workspace-styles/session-composer.css";
import "./session-client-surface.css";

interface SessionClientSurfaceProps {
    workbench?: DesktopWorkbenchClient;
    client: WorkspaceSessionClient;
    projects?: import("../client/project-client.ts").WorkspaceProjectClient;
}
type DraftImage = import("../client/session-drafts.ts").SessionDraftImage;
type BindingDraft = import("../client/session-drafts.ts").SessionComposerDraft;
type PersistentSessionClient = WorkspaceSessionClient & import("../client/session-drafts.ts").WorkspaceDraftClient;
function viewIdentity(view: SessionClientView | null): string {
    return view ? `${view.connectionId}:${view.project}:${view.sessionId}` : "";
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
export function SessionClientSurface({ client, projects, workbench }: SessionClientSurfaceProps) {
    const [view, setView] = useState<SessionClientView | null>(null);
    const persistent = "readDraft" in client ? (client as PersistentSessionClient) : null;
    const [loadedDrafts, setLoadedDrafts] = useState<Set<string>>(new Set());
    const loadingDrafts = useRef(new Set<string>());
    const submittedDraftIds = useRef(new Set<string>());
    const [draftNotice, setDraftNotice] = useState("");
    const saved = projects && "readProject" in client ? (client as WorkspaceSavedSessionClient) : null;
    const {
        context,
        options,
        error: optionsError,
        retry: retryOptions,
    } = useSessionOptions({ client: saved, view, projects });
    // Unsent intent only. Core and the client remain the transcript and queue owners.
    const [drafts, setDrafts] = useState<Record<string, BindingDraft>>({});
    const identity = viewIdentity(view);
    const intent = drafts[identity];
    const flushDraft = useRef<() => Promise<void>>(async () => {});
    flushDraft.current = async () => {
        if (persistent && view?.sessionId && intent && loadedDrafts.has(identity))
            await persistent.writeDraft(
                { connectionId: view.connectionId, project: view.project, sessionId: view.sessionId },
                intent,
            );
    };
    useEffect(() => workbench?.flushDrafts(() => flushDraft.current()), [workbench]);
    const draft = intent?.text || "";
    const images = intent?.images || [];
    function setDraft(value: SetStateAction<string>) {
        setDrafts((old) => {
            const current = old[identity];
            if (!current) return old;
            return {
                ...old,
                [identity]: {
                    ...current,
                    text: typeof value === "function" ? value(current.text) : value,
                    requestId:
                        submittedDraftIds.current.has(current.requestId) ||
                        pendingSends.current.has(current.requestId) ||
                        pendingQueue.current.get(identity) === current.requestId
                            ? crypto.randomUUID()
                            : current.requestId,
                },
            };
        });
    }
    function setImages(value: SetStateAction<DraftImage[]>) {
        setDrafts((old) => {
            const current = old[identity];
            if (!current) return old;
            return {
                ...old,
                [identity]: {
                    ...current,
                    images: typeof value === "function" ? value(current.images) : value,
                    requestId:
                        submittedDraftIds.current.has(current.requestId) ||
                        pendingSends.current.has(current.requestId) ||
                        pendingQueue.current.get(identity) === current.requestId
                            ? crypto.randomUUID()
                            : current.requestId,
                },
            };
        });
    }
    function setRequestIdentity(requestId: string) {
        setDrafts((old) => (old[identity] ? { ...old, [identity]: { ...old[identity], requestId } } : old));
    }
    const [historyEvents, setHistoryEvents] = useState<WorkspaceHistoryEvent[]>([]);
    const [olderCursor, setOlderCursor] = useState<string | null>(null);
    const [historyPending, setHistoryPending] = useState(false);
    const [contextOpen, setContextOpen] = useState(false);
    const historyEpoch = useRef(0);
    const historyBinding = useRef("");
    const oldestEventId = useRef("");
    const filesBusy = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const previousBinding = useRef("");
    const bindingEpoch = useRef(0);
    const pendingSends = useRef(new Set<string>());
    const pendingQueue = useRef(new Map<string, string>());
    const [knownId, setKnownId] = useState("");
    const [error, setError] = useState("");
    const [changing, setChanging] = useState(false);
    const [sending, setSending] = useState(false);
    const [stopping, setStopping] = useState(false);

    const question = useRef<HTMLElement>(null);
    const conversation = useRef<HTMLElement>(null);
    const following = useRef(true);
    useLayoutEffect(() => {
        following.current = true;
    }, [view?.sessionId]);
    useLayoutEffect(() => {
        if (following.current && conversation.current)
            conversation.current.scrollTop = conversation.current.scrollHeight;
    }, [view?.sessionId, view?.items, view?.question?.requestId, historyEvents]);
    useEffect(
        () =>
            client.observe((next) => {
                const identity = viewIdentity(next);
                setDrafts((old) =>
                    old[identity]
                        ? old
                        : {
                              ...old,
                              [identity]: { text: "", images: [], requestId: crypto.randomUUID() },
                          },
                );
                if (previousBinding.current !== identity) {
                    previousBinding.current = identity;
                    bindingEpoch.current++;
                    setError("");
                }
                setView(next);
            }),
        [client],
    );
    useEffect(() => {
        if (!persistent || !view?.sessionId || loadedDrafts.has(identity) || loadingDrafts.current.has(identity))
            return;
        loadingDrafts.current.add(identity);
        const binding = { connectionId: view.connectionId, project: view.project, sessionId: view.sessionId };
        void persistent
            .readDraft(binding)
            .then((snapshot) => {
                if (!mounted.current) return;
                for (const requestId of snapshot.submittedRequestIds || []) submittedDraftIds.current.add(requestId);
                if (snapshot.composer) setDrafts((old) => ({ ...old, [identity]: snapshot.composer! }));
                setDraftNotice(snapshot.notice);
                setLoadedDrafts((old) => new Set([...old, identity]));
            })
            .catch((caught: Error) => {
                loadingDrafts.current.delete(identity);
                if (mounted.current) setError(caught.message);
            });
    }, [persistent, identity, view?.sessionId, loadedDrafts]);
    useEffect(() => {
        if (!persistent || !view?.sessionId || !intent || !loadedDrafts.has(identity)) return;
        void persistent
            .writeDraft({ connectionId: view.connectionId, project: view.project, sessionId: view.sessionId }, intent)
            .catch((caught: Error) => {
                if (mounted.current) setError(caught.message);
            });
    }, [persistent, identity, intent, loadedDrafts]);
    useEffect(() => {
        if (view?.phase === "awaiting_answer") question.current?.querySelector<HTMLElement>("input, textarea")?.focus();
        else if (view?.phase === "idle") document.getElementById("session-message")?.focus();
    }, [view?.phase, view?.question?.requestId, loadedDrafts, identity]);
    useEffect(() => {
        if (view?.sessionId) setKnownId(view.durableSessionId || "");
    }, [view?.sessionId, view?.durableSessionId]);
    useEffect(() => {
        const epoch = ++historyEpoch.current;
        const identity = `${view?.connectionId}:${view?.project}:${view?.durableSessionId}`;
        if (historyBinding.current !== identity) {
            historyBinding.current = identity;
            setHistoryEvents([]);
            oldestEventId.current = "";
            setOlderCursor(null);
        }
        // Bootstrap can expose its durable identity while the first writer still has no committed history.
        // Keep live output until Core supplies a generation; an identity alone is not saved evidence.
        if (saved && context && view?.durableSessionId && view.generation != null) {
            void saved
                .history({ context, sessionId: view.durableSessionId, limit: 200 })
                .then(async (history) => {
                    const oldest = oldestEventId.current;
                    let events = history.events;
                    let cursor = history.previousCursor;
                    while (oldest && cursor && !events.some((event) => event.eventId === oldest)) {
                        if (historyEpoch.current !== epoch) return;
                        const page = await saved.history({
                            context,
                            sessionId: view.durableSessionId,
                            cursor,
                            limit: 200,
                        });
                        events = [...page.events, ...events];
                        cursor = page.previousCursor;
                    }
                    if (historyEpoch.current !== epoch) return;
                    oldestEventId.current = events[0]?.eventId || "";
                    setHistoryEvents(events);
                    setOlderCursor(cursor);
                })
                .catch((caught: Error) => {
                    if (historyEpoch.current === epoch) setError(caught.message);
                });
        }
        return () => {
            historyEpoch.current++;
        };
    }, [saved, context, view?.durableSessionId, view?.generation]);
    useEffect(() => {
        const requestId = pendingQueue.current.get(identity);
        if (requestId && view?.queued?.some((item) => item.requestId === requestId)) {
            setDrafts((old) =>
                old[identity]?.requestId === requestId
                    ? {
                          ...old,
                          [identity]: { text: "", images: [], requestId: crypto.randomUUID() },
                      }
                    : old,
            );
            pendingQueue.current.delete(identity);
        }
    }, [identity, view?.queued]);
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
    const working = view.phase === "streaming" || view.phase === "awaiting_answer" || Boolean(view.operationId);
    const canCompose = available && active && (!persistent || loadedDrafts.has(identity)) && (idle || Boolean(saved));
    const canSubmit = canCompose && (idle || view.phase === "streaming" || Boolean(view.recoveryNotice));
    const status =
        view.connection === "ready"
            ? view.phase === "idle" && pendingSends.current.has(intent?.requestId || "")
                ? "Saving input…"
                : PHASE_LABELS[view.phase]
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
    async function send() {
        if ((!draft.trim() && !images.length) || pendingSends.current.has(intent?.requestId || "") || !canSubmit)
            return;
        const requestId = intent?.requestId || "";
        pendingSends.current.add(requestId);
        setSending(true);
        following.current = true;
        setError("");
        const sentDraft = draft;
        const sentImages = images;
        try {
            validateSessionInput(
                sentDraft,
                sentImages.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
            );
            if (persistent && intent) await persistent.writeDraft(binding, intent);
            if (saved)
                await saved.sendImages(
                    binding,
                    sentDraft,
                    sentImages.map(({ mimeType, base64 }) => ({ mimeType, base64 })),
                    requestId,
                );
            else await client.send(binding, sentDraft);
            setDraft((current) => (current === sentDraft ? "" : current));
            setImages((current) => current.filter((image) => !sentImages.some((sent) => sent.id === image.id)));
            setRequestIdentity(crypto.randomUUID());
        } catch (caught) {
            if (mounted.current) setError(caught instanceof Error ? caught.message : "The message was not sent.");
        } finally {
            pendingSends.current.delete(requestId);
            if (mounted.current) setSending(pendingSends.current.size > 0);
        }
    }
    async function attach(files: File[]) {
        if (filesBusy.current || !saved) return;
        filesBusy.current = true;
        const epoch = bindingEpoch.current;
        const current = () => mounted.current && bindingEpoch.current === epoch;
        try {
            const transfers: (SessionImageTransfer & { id: string; name: string })[] = [];
            for (const file of files) {
                if (!SESSION_IMAGE_MIME_TYPES.some((mime) => mime === file.type))
                    throw new Error("Use PNG, JPEG, GIF or WebP images.");
                if (file.size > SESSION_IMAGE_BYTE_LIMIT) throw new Error("Image exceeds 7 MiB.");
                const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error("Image could not be read."));
                    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
                    reader.readAsDataURL(file);
                });
                transfers.push({
                    id: crypto.randomUUID(),
                    name: file.name || "Pasted image",
                    mimeType: file.type,
                    base64,
                });
            }
            if (!current()) return;
            validateSessionInput(
                draft || "image",
                [...images, ...transfers].map(({ mimeType, base64 }) => ({ mimeType, base64 })),
            );
            setImages((old) => [...old, ...transfers]);
        } catch (caught) {
            if (current()) setError(caught instanceof Error ? caught.message : "Image could not be attached.");
        } finally {
            filesBusy.current = false;
        }
    }
    async function queue() {
        if (!saved || !canCompose || (!draft.trim() && !images.length)) return;
        try {
            const transfers = images.map(({ mimeType, base64 }) => ({ mimeType, base64 }));
            validateSessionInput(draft, transfers);
            pendingQueue.current.set(identity, intent?.requestId || "");
            if (persistent && intent) await persistent.writeDraft(binding, intent);
            saved.queue(binding, { requestId: intent?.requestId || "", text: draft, images: transfers });
        } catch (caught) {
            pendingQueue.current.delete(identity);
            setError(caught instanceof Error ? caught.message : "Could not queue message.");
        }
    }
    async function configure(selection: WorkspaceConfigurationSelection) {
        if (!saved) return false;
        try {
            await saved.stageConfiguration(binding, selection);
            return true;
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Configuration was not changed.");
            return false;
        }
    }
    async function older() {
        if (!saved || !context || !olderCursor || historyPending) return;
        const epoch = historyEpoch.current;
        const panel = conversation.current;
        const height = panel?.scrollHeight || 0;
        const top = panel?.scrollTop || 0;
        setHistoryPending(true);
        following.current = false;
        try {
            const result = await saved.history({
                context,
                sessionId: view!.durableSessionId,
                cursor: olderCursor,
                limit: 200,
            });
            if (epoch !== historyEpoch.current) return;
            oldestEventId.current = result.events[0]?.eventId || oldestEventId.current;
            setHistoryEvents((old) => [
                ...new Map([...result.events, ...old].map((event) => [event.eventId, event])).values(),
            ]);
            setOlderCursor(result.previousCursor);
            requestAnimationFrame(() => {
                if (panel) panel.scrollTop = top + panel.scrollHeight - height;
            });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Older history failed. Try again.");
        } finally {
            setHistoryPending(false);
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
    const liveItems = view.items.map((item) => ({
        ...item,
        key: item.id,
        ...(item.kind === "tool" ? { toolCallId: item.id.replace(/^tool:/, "") } : {}),
        agentName: "RunWield",
        kind: item.kind === "user" || item.kind === "assistant" ? "message" : item.kind,
        role: item.kind,
        output: item.text,
        status: item.status === "in_progress" ? "running" : item.status,
        done: !working,
    }));
    const committed = reduceSessionEvents(historyEvents);
    const flattened = committed.flatMap((item) => (item.kind === "activity" ? item.items : [item]));
    const matched = new Set<number>();
    const remaining = liveItems.filter((item) => {
        const index = flattened.findIndex(
            (savedItem, index) =>
                !matched.has(index) &&
                ((savedItem.key === item.key && savedItem.status !== "running") ||
                    (savedItem.kind === item.kind && savedItem.role === item.role && savedItem.text === item.text)),
        );
        if (index < 0) return true;
        matched.add(index);
        return false;
    });
    const items = mergeSessionTimelineItems(committed, remaining);
    const configuration = view.configuration || options?.defaults;
    const modelValue = configuration ? `${configuration.provider}\u001f${configuration.model}` : "";
    return (
        <main className="session-client">
            {draftNotice && <p role="alert">{draftNotice}</p>}
            <header className="session-client-header">
                <h1>Session</h1>
                <RunWieldButton onClick={() => setContextOpen(!contextOpen)} aria-expanded={contextOpen}>
                    Session context
                </RunWieldButton>
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
                    disabled={!available || (active && !view.bindings) || view.phase === "loading"}
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
                        disabled={!available || (active && !view.bindings) || view.phase === "loading"}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <RunWieldButton
                        type="submit"
                        disabled={
                            !available || (active && !view.bindings) || !knownId.trim() || view.phase === "loading"
                        }
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
                {persistent && (
                    <RunWieldButton
                        disabled={!canCompose || sending || (!draft && !images.length)}
                        onClick={() =>
                            void change(async () => {
                                await persistent.discardDraft(binding);
                                setDraft("");
                                setImages([]);
                                setRequestIdentity(crypto.randomUUID());
                            })
                        }
                    >
                        Discard draft
                    </RunWieldButton>
                )}
            </section>
            {contextOpen && (
                <aside className="session-client-context" aria-label="Session context">
                    <dl>
                        <dt>Agent</dt>
                        <dd>{view.configuration?.agentName || options?.defaults.agentName || "Not selected"}</dd>
                        <dt>Model</dt>
                        <dd>
                            {view.configuration
                                ? `${view.configuration.provider}/${view.configuration.model}`
                                : "Project default"}
                        </dd>
                        <dt>Thinking</dt>
                        <dd>{view.configuration?.thinkingLevel || "Default"}</dd>
                        <dt>Archive state</dt>
                        <dd>{view.archivedAt ? "Archived" : "Active"}</dd>
                        <dt>Operation</dt>
                        <dd>{view.operationId || "None"}</dd>
                    </dl>
                </aside>
            )}
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
            {optionsError && (
                <p role="alert">
                    {optionsError} <RunWieldButton onClick={retryOptions}>Retry options</RunWieldButton>
                </p>
            )}
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
                {olderCursor && (
                    <RunWieldButton disabled={historyPending} onClick={() => void older()}>
                        Load older history
                    </RunWieldButton>
                )}
                {view.recoveryNotice && (
                    <p role="alert" className="session-client-error">
                        {view.recoveryNotice}
                    </p>
                )}
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
                            value={view.question.defaultValue}
                            sessionId={view.durableSessionId || view.sessionId}
                            questionId={view.question.interactionId}
                            placeholder={view.question.placeholder}
                            allowEmpty={!view.question.required}
                            allowOther={view.question.allowOther}
                            otherOptionValue={view.question.otherOptionValue}
                            options={view.question.choices}
                            onRawResponse={(fields) =>
                                client.answer(binding, { ...fields, requestId: view.question!.requestId })
                            }
                        />
                    </section>
                ) : null}
            </section>
            {Boolean(view.queued?.length) && (
                <ol className="session-client-queue" aria-label="Unsent follow-ups">
                    {view.queued!.map((item) => (
                        <li key={item.requestId}>
                            <span>{item.text || "Image message"}</span>
                            <RunWieldButton
                                onClick={() => {
                                    if (draft || images.length) {
                                        setError("Keep or send your current draft before editing a queued message.");
                                        return;
                                    }
                                    if (persistent) {
                                        const previous = intent!;
                                        setDrafts((old) => ({
                                            ...old,
                                            [identity]: {
                                                text: item.text,
                                                requestId: item.requestId,
                                                images: item.images.map((image) => ({
                                                    ...image,
                                                    id: crypto.randomUUID(),
                                                    name: "Queued image",
                                                })),
                                            },
                                        }));
                                        void persistent
                                            .editQueuedDraft(binding, item.requestId)
                                            .catch((caught: Error) => {
                                                setDrafts((old) =>
                                                    old[identity]?.requestId === item.requestId
                                                        ? { ...old, [identity]: previous }
                                                        : old,
                                                );
                                                setError(caught.message);
                                            });
                                        return;
                                    }
                                    setDraft(item.text);
                                    setImages(
                                        item.images.map((image) => ({
                                            ...image,
                                            id: crypto.randomUUID(),
                                            name: "Queued image",
                                        })),
                                    );
                                    setRequestIdentity(item.requestId);
                                    saved?.removeQueued(binding, item.requestId);
                                }}
                            >
                                Edit
                            </RunWieldButton>
                            {item.restored && (
                                <RunWieldButton
                                    disabled={!canSubmit || sending}
                                    onClick={() =>
                                        void change(async () => {
                                            await saved?.sendImages(binding, item.text, item.images, item.requestId);
                                            saved?.removeQueued(binding, item.requestId);
                                        })
                                    }
                                >
                                    Send queued message
                                </RunWieldButton>
                            )}
                            <RunWieldButton onClick={() => saved?.removeQueued(binding, item.requestId)}>
                                Remove queued message
                            </RunWieldButton>
                        </li>
                    ))}
                </ol>
            )}
            <div className="session-client-composition">
                <SessionComposer
                    allowImages={Boolean(saved)}
                    id="session-message"
                    draft={draft}
                    disabled={!canCompose || (!saved && sending)}
                    controlsDisabled={!available || !active}
                    canSend={
                        canSubmit &&
                        !pendingSends.current.has(intent?.requestId || "") &&
                        Boolean(draft.trim() || images.length)
                    }
                    canQueue={canCompose && Boolean(draft.trim() || images.length)}
                    submitting={sending && !saved}
                    alwaysExpanded
                    maxLength={65536}
                    onDraftChange={(text) => {
                        setDraft(text);
                        setRequestIdentity(crypto.randomUUID());
                    }}
                    onCommand={(text) => {
                        if (
                            !saved ||
                            options?.commands.some(
                                (command) =>
                                    command.kind === "prompt" && text.trim().split(/\s+/)[0] === `/${command.name}`,
                            )
                        )
                            return false;
                        if (images.length) {
                            setError("Remove images before running a command.");
                            return true;
                        }
                        const epoch = bindingEpoch.current;
                        void change(async () => {
                            const result = await saved.command(binding, text);
                            if (bindingEpoch.current !== epoch && result.action !== "new") return;
                            setDraft(
                                result.action === "agent" || result.action === "model" ? `/${result.action} ` : "",
                            );
                            setRequestIdentity(crypto.randomUUID());
                        });
                        return true;
                    }}
                    onSubmit={() => void send()}
                    onFiles={(files) => void attach(files)}
                    onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files);
                        if (files.length) {
                            event.preventDefault();
                            const text = event.clipboardData.getData("text/plain");
                            if (text) setDraft((old) => (old + text).slice(0, 65536));
                            void attach(files);
                        }
                    }}
                    imageAttachments={images}
                    onRemoveImage={(id) => setImages((old) => old.filter((image) => image.id !== id))}
                    agents={options?.agents || []}
                    models={options?.models || []}
                    thinkingLevels={options?.thinkingLevels || []}
                    commands={
                        options?.commands.map((command) => ({
                            ...command,
                            kind: command.kind === "prompt" ? "prompt" : "action",
                        })) || []
                    }
                    agentValue={configuration?.agentName || ""}
                    modelValue={modelValue}
                    thinkingValue={configuration?.thinkingLevel || ""}
                    agentFallback={
                        configuration && !options?.agents.some((agent) => agent.name === configuration.agentName) ? (
                            <option value={configuration.agentName}>{configuration.agentName}</option>
                        ) : null
                    }
                    modelFallback={
                        configuration &&
                        !options?.models.some(
                            (model) => model.provider === configuration.provider && model.id === configuration.model,
                        ) ? (
                            <option value={modelValue}>{`${configuration.provider}/${configuration.model}`}</option>
                        ) : null
                    }
                    thinkingFallback={
                        configuration && !options?.thinkingLevels.includes(configuration.thinkingLevel) ? (
                            <option value={configuration.thinkingLevel}>{configuration.thinkingLevel}</option>
                        ) : null
                    }
                    onAgentChange={(agentName) => configure({ agentName })}
                    onModelChange={(value) => {
                        const [provider, model] = value.split("\u001f");
                        return configure({ provider, model });
                    }}
                    onThinkingChange={(thinkingLevel) => configure({ thinkingLevel })}
                    onQueue={saved && working ? queue : undefined}
                    sendLabel={view.phase === "streaming" && saved ? "Steer" : "Send"}
                />
                <RunWieldButton disabled={!available || !working || stopping} onClick={() => void stop()}>
                    Stop
                </RunWieldButton>
            </div>
        </main>
    );
}
