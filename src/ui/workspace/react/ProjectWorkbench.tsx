import { useEffect, useRef, useState } from "react";
import type { DesktopProjectClient } from "../client/project-client.ts";
import type {
    WorkspaceSessionClient,
    WorkspaceSavedSessionClient,
    SessionClientView,
} from "../client/session-client.ts";
import type { WorkspaceProjectView } from "../../../acp/workspace-contract.ts";
import { ProjectSidebar, ProjectSessionList } from "./ProjectSidebar.tsx";
import { RunWieldTabs } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { ProjectRootControls } from "./ProjectRootControls.tsx";
import { SessionClientSurface } from "./SessionClientSurface.tsx";
import { RunWieldConfirmationDialog } from "../../design-system/components/react/RunWieldConfirmationDialog.tsx";
import "./project-workbench.css";
interface ProjectWorkbenchProps {
    projects: DesktopProjectClient;
    sessions: WorkspaceSessionClient;
}
export function ProjectWorkbench({ projects, sessions }: ProjectWorkbenchProps) {
    const saved = "readProject" in sessions ? (sessions as WorkspaceSavedSessionClient) : null;
    const [collapsed, setCollapsed] = useState(() => {
        try {
            return (
                localStorage.getItem("runwield:owner:sidebar-collapsed") === "true" ||
                Boolean(globalThis.matchMedia?.("(max-width: 860px)").matches)
            );
        } catch {
            return false;
        }
    });
    const [tab, setTab] = useState("general");
    const [revision, setRevision] = useState(0);
    const panel = useRef<HTMLElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);
    const lastSession = useRef<{ projectId: string; sessionId: string } | null>(null);
    const selectedProject = useRef("");
    const [narrow, setNarrow] = useState(() => Boolean(globalThis.matchMedia?.("(max-width: 860px)").matches));
    useEffect(() => {
        const media = globalThis.matchMedia?.("(max-width: 860px)");
        if (!media) return;
        const sync = () => {
            setNarrow(media.matches);
            if (media.matches) setCollapsed(true);
            else {
                try {
                    setCollapsed(localStorage.getItem("runwield:owner:sidebar-collapsed") === "true");
                } catch {
                    setCollapsed(false);
                }
            }
        };
        media.addEventListener("change", sync);
        return () => media.removeEventListener("change", sync);
    }, []);
    const [view, setView] = useState<SessionClientView | null>(null);
    const [rows, setRows] = useState<WorkspaceProjectView[]>([]);
    const [settings, setSettings] = useState<string | null>(null);
    const [selected, setSelected] = useState(false);
    const [linking, setLinking] = useState(false);
    const [candidate, setCandidate] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [removing, setRemoving] = useState(false);
    const removeButton = useRef<HTMLButtonElement>(null);
    const busy = useRef(false);
    const loaded = useRef(false);
    useEffect(() => sessions.observe(setView), [sessions]);
    useEffect(() => {
        if (view?.durableSessionId && selectedProject.current)
            lastSession.current = { projectId: selectedProject.current, sessionId: view.durableSessionId };
    }, [view?.durableSessionId]);
    async function refresh() {
        setRows((await projects.listProjects()).projects);
    }
    async function action(work: () => Promise<void>) {
        if (busy.current) return;
        busy.current = true;
        setPending(true);
        setError("");
        setStatus("");
        try {
            await work();
        } catch (error) {
            setError(error instanceof Error ? error.message : "Project operation failed. Try again.");
        } finally {
            busy.current = false;
            setPending(false);
        }
    }
    useEffect(() => {
        if (view?.connection !== "ready" || loaded.current) return;
        loaded.current = true;
        void action(async () => {
            await refresh();
            const path = await projects.candidate();
            if (path) {
                setCandidate(path);
                setLinking(true);
            }
        });
    }, [view?.connection]);
    function changed() {
        void refresh()
            .then(() => setRevision((old) => old + 1))
            .catch((caught: Error) => setError(caught.message));
    }
    async function navigate(projectId?: string, sessionId?: string) {
        await action(async () => {
            if (view?.sessionId && (sessionId !== view.durableSessionId || !sessionId)) {
                setError(
                    "Close the current Session before switching. Your draft and pending answer stay with this Session.",
                );
                setSelected(true);
                setSettings(null);
                return;
            }
            if (projectId && !view?.sessionId) {
                await projects.openProject({ projectId });
                selectedProject.current = projectId;
                if (sessionId) await sessions.load(sessionId);
                else await sessions.create();
            } else if (!projectId && !view?.project) {
                setSelected(false);
                setSettings(null);
                return;
            } else if (!sessionId && !view?.sessionId) await sessions.create();
            setSelected(true);
            setSettings(null);
            if (globalThis.matchMedia?.("(max-width: 860px)").matches) collapse(true);
        });
    }
    function collapse(next: boolean) {
        setCollapsed(next);
        if (!globalThis.matchMedia?.("(max-width: 860px)").matches) {
            try {
                localStorage.setItem("runwield:owner:sidebar-collapsed", String(next));
            } catch {
                /* Optional preference. */
            }
        }
        if (next) requestAnimationFrame(() => toggle.current?.focus());
        else requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button")?.focus());
    }
    const refreshKey = `${revision}:${view?.durableSessionId || ""}:${view?.generation ?? ""}:${view?.archivedAt || ""}`;
    const project = rows.find((row) => row.projectId === settings);
    return (
        <div className="project-workbench">
            <ProjectSidebar
                onRefreshProjects={() => void action(refresh)}
                rows={rows}
                client={saved}
                view={view}
                refreshKey={refreshKey}
                onChanged={changed}
                collapsed={collapsed}
                onCollapse={() => collapse(true)}
                panelRef={panel}
                onOpen={(projectId, sessionId) => void navigate(projectId, sessionId)}
                onSettings={(projectId) => {
                    setSettings(projectId);
                    setTab("general");
                }}
                onNew={() => void navigate()}
                onProjects={() => {
                    setSelected(false);
                    setSettings(null);
                }}
                onLogo={() => {
                    if (view?.sessionId) {
                        setSettings(null);
                        setSelected(true);
                    } else if (lastSession.current)
                        void navigate(lastSession.current.projectId, lastSession.current.sessionId);
                    else {
                        setSettings(null);
                        setSelected(false);
                    }
                }}
            />
            {!collapsed && (
                <button
                    className="project-sidebar-backdrop"
                    aria-label="Close navigation"
                    onClick={() => collapse(true)}
                />
            )}
            <div className="project-workbench-main" inert={narrow && !collapsed}>
                <header className="project-workbench-header">
                    <button
                        type="button"
                        className="secondary-action"
                        ref={toggle}
                        aria-expanded={!collapsed}
                        aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
                        onClick={() => collapse(!collapsed)}
                    >
                        ◧
                    </button>
                    <span>{project ? "Project settings" : selected ? "Session" : "Projects"}</span>
                    {view?.sessionId && (
                        <button
                            className="secondary-action"
                            onClick={() => {
                                setSelected(true);
                                setSettings(null);
                            }}
                        >
                            Session
                        </button>
                    )}
                </header>
                {error && selected && !settings && <p role="alert">{error}</p>}
                <section className="project-entry" hidden={selected && !settings} aria-label="Projects">
                    <header>
                        <h1>{project ? `${project.displayName || project.rootLabel} settings` : "Projects"}</h1>
                        {!project && (
                            <button
                                type="button"
                                className="primary-action"
                                disabled={pending || view?.connection !== "ready"}
                                onClick={() =>
                                    void action(async () => {
                                        const path = await projects.pickDirectory();
                                        if (path !== null) {
                                            setCandidate(path);
                                            setLinking(true);
                                        }
                                    })
                                }
                            >
                                Open Project
                            </button>
                        )}
                    </header>
                    {error && <p role="alert">{error}</p>}
                    <p role="status">
                        {pending
                            ? "Working…"
                            : status || (view?.connection !== "ready" ? view?.error || "Connecting to runtime…" : "")}
                    </p>
                    <button
                        type="button"
                        className="secondary-action"
                        disabled={pending || view?.connection !== "ready"}
                        onClick={() => void action(refresh)}
                    >
                        Refresh Projects
                    </button>
                    {project ? (
                        <>
                            <RunWieldTabs
                                variant="underline"
                                defaultValue="general"
                                value={tab}
                                onValueChange={setTab}
                                label="Project settings"
                                keepMounted
                                tabs={[
                                    {
                                        value: "general",
                                        label: "General",
                                        children: (
                                            <>
                                                <p>
                                                    {project.rootLabel} · {project.lifecycle} · {project.healthStatus}
                                                </p>
                                                {project.healthEvidence.map((text, index) => (
                                                    <p key={index}>{text}</p>
                                                ))}
                                                <div className="project-actions">
                                                    <button
                                                        type="button"
                                                        className="secondary-action"
                                                        disabled={pending}
                                                        onClick={() =>
                                                            void action(async () => {
                                                                await projects.setProjectEnabled({
                                                                    projectId: project.projectId,
                                                                    enabled: project.lifecycle !== "enabled",
                                                                });
                                                                await refresh();
                                                            })
                                                        }
                                                    >
                                                        {project.lifecycle === "enabled" ? "Disable" : "Enable"}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="secondary-action"
                                                        disabled={pending || !project.enabled}
                                                        onClick={() =>
                                                            void action(async () => {
                                                                const result = await projects.rescanProject({
                                                                    projectId: project.projectId,
                                                                });
                                                                setStatus(
                                                                    `${result.cataloged} Sessions cataloged. ${result.diagnostics.join(" ")}`,
                                                                );
                                                            })
                                                        }
                                                    >
                                                        Full Session rescan
                                                    </button>
                                                    <button
                                                        type="button"
                                                        ref={removeButton}
                                                        className="secondary-action"
                                                        disabled={pending}
                                                        onClick={() => setRemoving(true)}
                                                    >
                                                        Remove
                                                    </button>
                                                </div>
                                                <h2>Relink Project</h2>
                                                <ProjectRootControls
                                                    key={project.projectId}
                                                    projectId={project.projectId}
                                                    pickDirectory={() => projects.pickDirectory()}
                                                    submitRoot={(root, _name, confirmation) =>
                                                        projects.relinkProject({
                                                            projectId: project.projectId,
                                                            newRoot: root,
                                                            ...(confirmation
                                                                ? { directoryConfirmation: confirmation }
                                                                : {}),
                                                        })
                                                    }
                                                    onComplete={refresh}
                                                />
                                            </>
                                        ),
                                    },
                                    {
                                        value: "archived",
                                        label: "Archived Sessions",
                                        children: (
                                            <>
                                                {saved && (
                                                    <ProjectSessionList
                                                        key={project.projectId}
                                                        client={saved}
                                                        project={project}
                                                        view={view}
                                                        archived
                                                        refreshKey={refreshKey}
                                                        onOpen={(projectId, sessionId) =>
                                                            void navigate(projectId, sessionId)
                                                        }
                                                        onChanged={changed}
                                                    />
                                                )}
                                            </>
                                        ),
                                    },
                                ]}
                            />
                            {removing && (
                                <RunWieldConfirmationDialog
                                    returnFocus={removeButton}
                                    title="Remove Project?"
                                    detail="Project files and saved Sessions stay intact. Only this registration is removed."
                                    onQuit={() => setRemoving(false)}
                                    onContinue={() => {
                                        setRemoving(false);
                                        void action(async () => {
                                            await projects.removeProject({ projectId: project.projectId });
                                            await refresh();
                                            setSettings(null);
                                        });
                                    }}
                                />
                            )}
                        </>
                    ) : (
                        <>
                            {linking && (
                                <div className="project-link">
                                    <h2>Link Project</h2>
                                    <ProjectRootControls
                                        key={candidate}
                                        initialRoot={candidate}
                                        pickDirectory={() => projects.pickDirectory()}
                                        submitRoot={(root, displayName, confirmation) =>
                                            projects.registerProject({
                                                root,
                                                ...(displayName ? { displayName } : {}),
                                                ...(confirmation ? { directoryConfirmation: confirmation } : {}),
                                            })
                                        }
                                        onComplete={async () => {
                                            await refresh();
                                            setLinking(false);
                                        }}
                                    />
                                </div>
                            )}
                            {!rows.length && <p className="muted">No Projects linked. Open a folder to get started.</p>}
                            <ul className="project-list">
                                {rows.map((row) => (
                                    <li key={row.projectId}>
                                        <div>
                                            <h2>{row.displayName || row.rootLabel}</h2>
                                            <p>
                                                {row.rootLabel} · {row.lifecycle} · {row.healthStatus}
                                            </p>
                                        </div>
                                        <div className="project-actions">
                                            <button
                                                type="button"
                                                className="primary-action"
                                                disabled={pending || !row.enabled}
                                                onClick={() =>
                                                    void action(async () => {
                                                        if (view?.sessionId)
                                                            throw new Error(
                                                                "Close the current Session before switching Projects.",
                                                            );
                                                        await projects.openProject({ projectId: row.projectId });
                                                        setSelected(true);
                                                        selectedProject.current = row.projectId;
                                                    })
                                                }
                                            >
                                                Open
                                            </button>
                                            <button
                                                type="button"
                                                className="secondary-action"
                                                disabled={pending}
                                                onClick={() => setSettings(row.projectId)}
                                            >
                                                Settings
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </section>
                <div className="project-session" hidden={!selected || Boolean(settings)}>
                    <SessionClientSurface client={sessions} projects={projects} />
                </div>
            </div>
        </div>
    );
}
