import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { WorkspaceSavedSessionClient, SessionClientView } from "../client/session-client.ts";
import type {
    WorkspaceProjectView,
    WorkspaceProjectContext,
    WorkspaceSavedSession,
} from "../../../acp/workspace-contract.ts";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { RunWieldConfirmationDialog } from "../../design-system/components/react/RunWieldConfirmationDialog.tsx";
import { SavedSessionRows } from "../components/SavedSessionRows.tsx";

export interface ProjectSessionListProps {
    client: WorkspaceSavedSessionClient;
    project: WorkspaceProjectView;
    view: SessionClientView | null;
    archived?: boolean;
    refreshKey: string;
    onOpen: (projectId: string, sessionId: string) => void;
    onChanged: () => void;
    onRefreshProjects?: () => void;
}
/** Each list owns its read context, request lifecycle and cursor. Reading never selects a Project. */
export function ProjectSessionList({
    client,
    project,
    view,
    archived = false,
    refreshKey,
    onOpen,
    onChanged,
    onRefreshProjects,
}: ProjectSessionListProps) {
    const [rows, setRows] = useState<WorkspaceSavedSession[]>([]);
    const [context, setContext] = useState<WorkspaceProjectContext | null>(null);
    const [cursor, setCursor] = useState<string | null>(null);
    const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
    const [page, setPage] = useState(0);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
    const [acting, setActing] = useState<string[]>([]);
    const [confirmArchive, setConfirmArchive] = useState<WorkspaceSavedSession | null>(null);
    const archiveButton = useRef<HTMLButtonElement | null>(null);
    const sequence = useRef(0);
    const busy = useRef(new Set<string>());
    async function load(nextCursor?: string, append = false) {
        const request = ++sequence.current;
        setPending(true);
        setError("");
        try {
            const admitted = await client.readProject({ projectId: project.projectId });
            const result = await client.listSessions({
                context: admitted.context,
                archiveState: archived ? "archived" : "active",
                limit: 5,
                ...(nextCursor ? { cursor: nextCursor } : {}),
            });
            if (request !== sequence.current) return;
            setContext(admitted.context);
            setRows((old) => [
                ...new Map([...(append ? old : []), ...result.sessions].map((row) => [row.sessionId, row])).values(),
            ]);
            setCursor(result.nextCursor);
        } catch (caught) {
            if (request === sequence.current)
                setError(caught instanceof Error ? caught.message : "Sessions failed to load.");
        } finally {
            if (request === sequence.current) setPending(false);
        }
    }
    useEffect(() => {
        setPage(0);
        setPages([undefined]);
        if (project.enabled) void load();
        else {
            setRows([]);
            setError("");
        }
        return () => {
            sequence.current++;
        };
    }, [project.projectId, project.enabled, project.healthStatus, archived, refreshKey]);
    async function changeArchive(row: WorkspaceSavedSession, stopConfirmed = false) {
        if (!context || busy.current.has(row.sessionId)) return;
        busy.current.add(row.sessionId);
        setActing([...busy.current]);
        setActionErrors((old) => ({ ...old, [row.sessionId]: "" }));
        try {
            const request = { context, sessionId: row.sessionId };
            if (row.archivedAt) await client.unarchive(request);
            else {
                if (!stopConfirmed && (await client.snapshot(request)).state === "active") {
                    setConfirmArchive(row);
                    return;
                }
                try {
                    await client.archive(request, stopConfirmed);
                } catch (caught) {
                    if (
                        !(caught instanceof Error) ||
                        !/busy.*confirm|confirm.*stop|stop.*confirm/i.test(caught.message)
                    )
                        throw caught;
                    if (stopConfirmed) throw caught;
                    setConfirmArchive(row);
                    return;
                }
            }
            onChanged();
        } catch (caught) {
            setActionErrors((old) => ({
                ...old,
                [row.sessionId]: `${caught instanceof Error ? caught.message : "Archive action failed."} Try again.`,
            }));
        } finally {
            busy.current.delete(row.sessionId);
            setActing([...busy.current]);
        }
    }
    return (
        <section
            className="project-recent"
            aria-label={`${project.displayName || project.rootLabel} ${archived ? "archived" : "recent"} Sessions`}
            aria-busy={pending}
        >
            {confirmArchive && (
                <RunWieldConfirmationDialog
                    returnFocus={archiveButton}
                    title="Stop work and archive Session?"
                    continueLabel="Stop and archive"
                    quitLabel="Cancel"
                    detail={`Stop current work and archive “${confirmArchive.title}”? The transcript and Plan associations stay intact.`}
                    onQuit={() => setConfirmArchive(null)}
                    onContinue={() => {
                        const row = confirmArchive;
                        setConfirmArchive(null);
                        void changeArchive(row, true);
                    }}
                />
            )}
            {!project.enabled ? (
                <p className="muted">
                    Project unavailable <RunWieldButton onClick={onRefreshProjects || onChanged}>Retry</RunWieldButton>
                </p>
            ) : (
                <>
                    <SavedSessionRows
                        rows={rows.map((row) => ({
                            id: row.sessionId,
                            title: row.title,
                            archived: Boolean(row.archivedAt),
                            pending: acting.includes(row.sessionId),
                            error: actionErrors[row.sessionId] || "",
                        }))}
                        selectedId={view?.project === context?.canonicalRoot ? view?.durableSessionId : ""}
                        onOpen={(id) => onOpen(project.projectId, id)}
                        onArchive={(id, button) => {
                            archiveButton.current = button || null;
                            const row = rows.find((item) => item.sessionId === id);
                            if (row) void changeArchive(row);
                        }}
                    />
                    {error && (
                        <p role="alert">
                            {error}{" "}
                            <RunWieldButton
                                disabled={pending}
                                onClick={() => void load(archived ? pages[page] : undefined)}
                            >
                                Retry
                            </RunWieldButton>
                        </p>
                    )}
                    {!error && pending && <p role="status">Loading Sessions…</p>}
                    {!error && !pending && !rows.length && (
                        <p className="muted">{archived ? "No archived Sessions" : "No saved Sessions"}</p>
                    )}
                    {archived ? (
                        <div className="project-session-pages">
                            <RunWieldButton
                                disabled={pending || page === 0}
                                onClick={() => {
                                    setPage(page - 1);
                                    void load(pages[page - 1]);
                                }}
                            >
                                Previous
                            </RunWieldButton>
                            <RunWieldButton
                                disabled={pending || !cursor}
                                onClick={() => {
                                    setPages((old) => [...old.slice(0, page + 1), cursor!]);
                                    setPage(page + 1);
                                    void load(cursor!);
                                }}
                            >
                                Next 5
                            </RunWieldButton>
                        </div>
                    ) : (
                        cursor && (
                            <RunWieldButton disabled={pending} onClick={() => void load(cursor!, true)}>
                                Show more…
                            </RunWieldButton>
                        )
                    )}
                </>
            )}
        </section>
    );
}
interface ProjectSidebarProps {
    rows: WorkspaceProjectView[];
    client: WorkspaceSavedSessionClient | null;
    view: SessionClientView | null;
    refreshKey: string;
    onChanged: () => void;
    onRefreshProjects?: () => void;
    onOpen: (projectId: string, sessionId: string) => void;
    onSettings: (projectId: string) => void;
    onProjects: () => void;
    onNew: () => void;
    onLogo: () => void;
    expandedProjects?: string[];
    onExpandedProjects?: (projects: string[]) => void;
    collapsed: boolean;
    onCollapse: () => void;
    panelRef: RefObject<HTMLElement | null>;
}
function preference(key: string, fallback: string): string {
    try {
        return localStorage.getItem(key) || fallback;
    } catch {
        return fallback;
    }
}
export function ProjectSidebar({
    rows,
    client,
    view,
    refreshKey,
    onChanged,
    onOpen,
    onSettings,
    onProjects,
    onNew,
    onLogo,
    collapsed,
    expandedProjects,
    onExpandedProjects,
    onCollapse,
    panelRef,
    onRefreshProjects,
}: ProjectSidebarProps) {
    const [localExpanded, setLocalExpanded] = useState<string[]>(() => {
        if (expandedProjects) return expandedProjects;
        try {
            return JSON.parse(preference("runwield:desktop:expanded-projects", "[]")) as string[];
        } catch {
            return [];
        }
    });
    const expanded = expandedProjects || localExpanded;
    function setExpanded(update: (old: string[]) => string[]) {
        const next = update(expanded);
        if (onExpandedProjects) onExpandedProjects(next);
        else setLocalExpanded(next);
    }
    const [width, setWidth] = useState(() =>
        Math.max(220, Math.min(480, Number(preference("runwield:owner:sidebar-width", "280")) || 280)),
    );
    const drag = useRef<{ x: number; width: number } | null>(null);
    const style: CSSProperties = { width };
    useEffect(() => {
        if (onExpandedProjects) return;
        try {
            localStorage.setItem("runwield:desktop:expanded-projects", JSON.stringify(expanded));
        } catch {
            /* Optional preference. */
        }
    }, [expanded]);
    function resize(value: number) {
        const next = Math.max(220, Math.min(480, value));
        setWidth(next);
        try {
            localStorage.setItem("runwield:owner:sidebar-width", String(next));
        } catch {
            /* Optional preference. */
        }
    }
    return (
        <aside
            className="project-sidebar workspace-sidebar"
            hidden={collapsed}
            style={style}
            ref={panelRef}
            aria-label="Workspace navigation"
            tabIndex={-1}
            onKeyDown={(event) => {
                if ((event.target as HTMLElement).closest("dialog")) return;
                if (event.key === "Escape") onCollapse();
                if (event.key === "Tab" && globalThis.matchMedia?.("(max-width: 860px)").matches) {
                    const targets = [
                        ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
                    ].filter((target) => !target.closest("[hidden]"));
                    const first = targets[0],
                        last = targets.at(-1);
                    if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last?.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first?.focus();
                    }
                }
            }}
        >
            <header>
                <button type="button" className="project-brand" onClick={onLogo}>
                    RunWield
                </button>
                <RunWieldButton aria-label="Collapse sidebar" onClick={onCollapse}>
                    ◧
                </RunWieldButton>
            </header>
            <RunWieldButton onClick={onNew}>+ New Session</RunWieldButton>
            <RunWieldButton onClick={onProjects}>Projects</RunWieldButton>
            <div className="project-sidebar-scroll">
                {rows.map((project) => (
                    <section className="project-sidebar-group" key={project.projectId}>
                        <div className="project-sidebar-heading">
                            <button
                                type="button"
                                className="project-expand"
                                aria-expanded={expanded.includes(project.projectId)}
                                title={project.displayName || project.rootLabel}
                                onClick={() =>
                                    setExpanded((old) =>
                                        old.includes(project.projectId)
                                            ? old.filter((id) => id !== project.projectId)
                                            : [...old, project.projectId],
                                    )
                                }
                            >
                                <span aria-hidden="true">{expanded.includes(project.projectId) ? "⌄" : "›"}</span>
                                <span>{project.displayName || project.rootLabel}</span>
                            </button>
                            <RunWieldButton
                                aria-label={`${project.displayName || project.rootLabel} settings`}
                                onClick={() => onSettings(project.projectId)}
                            >
                                ⚙
                            </RunWieldButton>
                        </div>
                        {Boolean(view?.bindings?.some((binding) => binding.projectId === project.projectId)) && (
                            <section
                                className="project-bindings"
                                aria-label={`${project.displayName || project.rootLabel} open Sessions`}
                            >
                                {view?.bindings
                                    ?.filter((binding) => binding.projectId === project.projectId)
                                    .map((binding, index) => (
                                        <RunWieldButton
                                            key={binding.sessionId}
                                            title={binding.sessionId}
                                            className="project-binding"
                                            aria-current={view.sessionId === binding.sessionId ? "page" : undefined}
                                            onClick={() =>
                                                onOpen(project.projectId, binding.durableSessionId || binding.sessionId)
                                            }
                                        >
                                            <span>
                                                {binding.durableSessionId
                                                    ? `Session ${binding.durableSessionId.slice(0, 8)}`
                                                    : `New Session ${index + 1}`}
                                            </span>
                                            <span className={binding.hasQuestion ? "project-binding-waiting" : "muted"}>
                                                {binding.hasQuestion
                                                    ? "Answer needed"
                                                    : binding.phase === "streaming"
                                                      ? "Running"
                                                      : binding.phase === "canceling"
                                                        ? "Stopping…"
                                                        : binding.phase === "idle"
                                                          ? "Idle"
                                                          : binding.phase === "interrupted"
                                                            ? "Interrupted"
                                                            : "Loading…"}
                                            </span>
                                        </RunWieldButton>
                                    ))}
                            </section>
                        )}
                        <div hidden={!expanded.includes(project.projectId)}>
                            {client && (
                                <ProjectSessionList
                                    client={client}
                                    project={project}
                                    view={view}
                                    refreshKey={refreshKey}
                                    onOpen={onOpen}
                                    onChanged={onChanged}
                                    onRefreshProjects={onRefreshProjects}
                                />
                            )}
                        </div>
                    </section>
                ))}
            </div>
            <div
                className="project-sidebar-resizer"
                role="separator"
                aria-label="Sidebar width"
                aria-orientation="vertical"
                aria-valuemin={220}
                aria-valuemax={480}
                aria-valuenow={width}
                tabIndex={0}
                onKeyDown={(event) => {
                    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                        event.preventDefault();
                        resize(width + (event.key === "ArrowLeft" ? -20 : 20));
                    }
                }}
                onPointerDown={(event) => {
                    drag.current = { x: event.clientX, width };
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
                }}
                onPointerUp={() => {
                    drag.current = null;
                }}
                onPointerCancel={() => {
                    drag.current = null;
                }}
            />
        </aside>
    );
}
