import { useEffect, useRef, useState } from "react";
import { RunWieldButton, RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

/** @param {string} projectId @param {string} sessionId */
function sessionHref(projectId, sessionId) {
    return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

/** @param {string} projectId */
function newSessionHref(projectId) {
    return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}

/** @param {unknown} value */
function safeDiagnosticText(value) {
    if (!value || typeof value !== "object") return String(value || "");
    const record = /** @type {Record<string, unknown>} */ (value);
    return [record.code, record.message].filter((part) => typeof part === "string" && part).join(": ");
}

/**
 * @typedef {Object} SessionListRow
 * @property {string} runwieldSessionId
 * @property {string} [displayName]
 * @property {string} [state]
 * @property {string | null} [archivedAt]
 * @typedef {Object} SessionListData
 * @property {SessionListRow[]} sessions
 * @property {number} [page]
 * @property {number} [pageSize]
 * @property {number} [total]
 * @property {boolean} [hasNext]
 * @property {boolean} [hasPrevious]
 * @property {unknown[]} [diagnostics]
 * @typedef {Object} SessionListProps
 * @property {string} projectId
 * @property {SessionListData | null} [data]
 * @property {boolean} [loading]
 * @property {string} [error]
 * @property {boolean} [archived]
 * @property {boolean} [preserveArchived]
 * @property {() => void} [onRetry]
 * @property {(page: number) => void} [onPageChange]
 * @property {(sessionId: string) => void} [onSessionChanged]
 * @param {SessionListProps} props
 */
export function SessionList({
    projectId,
    data,
    loading = false,
    error = "",
    onRetry,
    onPageChange,
    archived = false,
    preserveArchived = false,
    onSessionChanged,
}) {
    const pendingIds = useRef(new Set());
    const [pending, setPending] = useState([]);
    const [removed, setRemoved] = useState([]);
    const [actionErrors, setActionErrors] = useState({});
    const knownBusy = useRef(new Set());
    const [archiveOverrides, setArchiveOverrides] = useState({});
    useEffect(() => {
        setRemoved([]);
        setArchiveOverrides({});
    }, [data]);
    const sessions = (Array.isArray(data?.sessions) ? data.sessions : []).filter((row) =>
        !removed.includes(row.runwieldSessionId)
    ).map((row) =>
        archiveOverrides[row.runwieldSessionId] === undefined
            ? row
            : { ...row, archivedAt: archiveOverrides[row.runwieldSessionId] }
    );
    async function changeArchive(session) {
        const id = session.runwieldSessionId;
        if (pendingIds.current.has(id)) return;
        const isArchived = Boolean(session.archivedAt);
        const busy = session.state === "active" || session.state === "busy" || knownBusy.current.has(id);
        if (
            !isArchived && busy &&
            !globalThis.confirm(
                `Stop current work and archive “${
                    session.displayName || "Untitled Session"
                }”? The transcript and Plan associations will be kept.`,
            )
        ) return;
        pendingIds.current.add(id);
        setPending([...pendingIds.current]);
        setActionErrors((errors) => ({ ...errors, [id]: "" }));
        try {
            const csrf = document.cookie.split("; ").find((value) =>
                value.startsWith("rw_owner_csrf=")
            )?.split("=").slice(1).join("=") || "";
            const response = await fetch(
                `/api/owner/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}/${
                    isArchived ? "unarchive" : "archive"
                }`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-runwield-csrf": decodeURIComponent(csrf) },
                    body: JSON.stringify(isArchived ? {} : { confirmed: busy }),
                },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) {
                if (/busy.*confirm/i.test(payload.error || "")) knownBusy.current.add(id);
                throw new Error(payload.error || `Request failed (${response.status}).`);
            }
            knownBusy.current.delete(id);
            if (preserveArchived) {
                setArchiveOverrides((values) => ({
                    ...values,
                    [id]: isArchived ? null : payload.archivedAt || new Date().toISOString(),
                }));
            } else setRemoved((ids) => [...ids, id]);
            onSessionChanged?.(id);
        } catch (error) {
            setActionErrors((errors) => ({
                ...errors,
                [id]: `${isArchived ? "Unarchive" : "Archive"} failed. ${
                    error instanceof Error ? error.message : String(error)
                } Try again.`,
            }));
        } finally {
            pendingIds.current.delete(id);
            setPending([...pendingIds.current]);
        }
    }
    const page = Number.isInteger(data?.page) ? data.page : 0;
    const pageSize = Number.isInteger(data?.pageSize) ? data.pageSize : 30;
    const total = Number.isInteger(data?.total)
        ? Math.max(
            0,
            data.total - removed.filter((id) => data.sessions?.some((row) => row.runwieldSessionId === id)).length,
        )
        : sessions.length;
    const hasNext = data?.hasNext === true;
    const hasPrevious = page > 0 || data?.hasPrevious === true;
    if (loading && !sessions.length) {
        return (
            <section className="session-list-state" aria-busy="true">
                <p>
                    <RunWieldThinkingDots label="Loading Project Sessions" />
                </p>
            </section>
        );
    }
    if (error && !sessions.length) {
        return (
            <section className="error-panel session-list-state" role="alert">
                <h2>Sessions failed to load</h2>
                <p>{error}</p>
                {onRetry ? <RunWieldButton type="button" onClick={onRetry}>Retry</RunWieldButton> : null}
            </section>
        );
    }
    const diagnostics = Array.isArray(data?.diagnostics) ? /** @type {unknown[]} */ (data.diagnostics) : [];
    const newSessionAction = archived ? null : (
        <section className="session-create-panel" aria-label="Session actions">
            <a className="rw-toolbar-button" href={newSessionHref(projectId)}>
                <span className="rw-toolbar-plus" aria-hidden="true">+</span>
                <span>New Session</span>
            </a>
        </section>
    );
    if (!sessions.length) {
        return (
            <section className="session-list-surface" aria-label="Project Sessions">
                {newSessionAction}
                <section className="empty-state session-list-state session-empty-panel">
                    <h2>{archived ? "No archived Sessions" : "No Sessions cataloged"}</h2>
                    <p>
                        {archived
                            ? "Archived Sessions will appear here. Unarchive them to return them to history."
                            : "Start a new browser Session or run a full Session rescan from the Project card."}
                    </p>
                </section>
                {hasPrevious
                    ? (
                        <nav className="session-pagination" aria-label="Session pages">
                            <RunWieldButton
                                type="button"
                                disabled={loading || pending.length > 0}
                                onClick={() => onPageChange?.(page - 1)}
                            >
                                Previous
                            </RunWieldButton>
                        </nav>
                    )
                    : null}
            </section>
        );
    }
    return (
        <section className="session-list-surface" aria-label="Project Sessions">
            {newSessionAction}
            {error
                ? (
                    <p className="notice warning" role="alert">
                        {error} <RunWieldButton onClick={onRetry}>Retry</RunWieldButton>
                    </p>
                )
                : null}
            {diagnostics.length
                ? (
                    <details className="notice warning session-diagnostics">
                        <summary>Catalog diagnostics ({diagnostics.length})</summary>
                        <ul>{diagnostics.map((item, index) => <li key={index}>{safeDiagnosticText(item)}</li>)}</ul>
                    </details>
                )
                : null}
            <section className="session-catalog" aria-label="Existing Sessions">
                <header className="session-catalog-header">
                    <div>
                        <h2>{archived ? "Archived Sessions" : "Sessions"}</h2>
                    </div>
                    <span>{total} total</span>
                </header>
                <div className="session-card-list">
                    {sessions.map((session) => (
                        <div
                            className="session-list-row"
                            key={session.runwieldSessionId}
                            aria-busy={pending.includes(session.runwieldSessionId)}
                        >
                            <a className="session-list-item" href={sessionHref(projectId, session.runwieldSessionId)}>
                                <span className="session-list-name">{session.displayName || "Untitled Session"}</span>
                                <span className="session-list-status">
                                    {session.archivedAt ? "Archived" : session.state || "unknown"}
                                </span>
                            </a>
                            <RunWieldButton
                                disabled={pending.includes(session.runwieldSessionId)}
                                aria-label={`${session.archivedAt ? "Unarchive" : "Archive"} ${
                                    session.displayName || "Untitled Session"
                                }`}
                                onClick={() => changeArchive(session)}
                            >
                                {pending.includes(session.runwieldSessionId)
                                    ? (session.archivedAt ? "Unarchiving…" : "Archiving…")
                                    : (session.archivedAt ? "Unarchive" : "Archive")}
                            </RunWieldButton>
                            {actionErrors[session.runwieldSessionId]
                                ? (
                                    <p className="notice warning session-archive-error" role="alert">
                                        {actionErrors[session.runwieldSessionId]}
                                    </p>
                                )
                                : null}
                        </div>
                    ))}
                </div>
            </section>
            <nav className="session-pagination" aria-label="Session pages">
                <span>
                    Showing {page * pageSize + 1}–{Math.min(page * pageSize + sessions.length, total)} of {total}
                </span>
                <div className="card-actions">
                    <RunWieldButton
                        type="button"
                        disabled={loading || pending.length > 0 || !hasPrevious}
                        onClick={() => onPageChange?.(page - 1)}
                    >
                        Previous
                    </RunWieldButton>
                    <RunWieldButton
                        type="button"
                        disabled={loading || pending.length > 0 || !hasNext}
                        onClick={() => onPageChange?.(page + 1)}
                    >
                        Next {pageSize}
                    </RunWieldButton>
                </div>
            </nav>
        </section>
    );
}

export default SessionList;
