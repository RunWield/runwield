import { useEffect, useRef, useState } from "react";
import type { DesktopProjectClient } from "../client/project-client.ts";
import type { WorkspaceSessionClient, SessionClientView } from "../client/session-client.ts";
import type { WorkspaceProjectView } from "../../../acp/workspace-contract.ts";
import { ProjectRootControls } from "./ProjectRootControls.tsx";
import { SessionClientSurface } from "./SessionClientSurface.tsx";
import { RunWieldConfirmationDialog } from "../../design-system/components/react/RunWieldConfirmationDialog.tsx";
import "./project-workbench.css";
interface ProjectWorkbenchProps {
    projects: DesktopProjectClient;
    sessions: WorkspaceSessionClient;
}
export function ProjectWorkbench({ projects, sessions }: ProjectWorkbenchProps) {
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
    const project = rows.find((row) => row.projectId === settings);
    return (
        <div className="project-workbench">
            <nav aria-label="Workspace">
                <strong>RunWield</strong>
                <button
                    className="secondary-action"
                    onClick={() => {
                        setSelected(false);
                        setSettings(null);
                    }}
                >
                    Projects
                </button>
                {view?.project && (
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
            </nav>
            <section className="project-entry" hidden={selected && !settings} aria-label="Projects">
                <header>
                    <h1>{project ? `${project.displayName || project.rootLabel} settings` : "Projects"}</h1>
                    {!project && (
                        <button
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
                    className="secondary-action"
                    disabled={pending || view?.connection !== "ready"}
                    onClick={() => void action(refresh)}
                >
                    Refresh Projects
                </button>
                {project ? (
                    <>
                        <p>
                            {project.rootLabel} · {project.lifecycle} · {project.healthStatus}
                        </p>
                        {project.healthEvidence.map((text, index) => (
                            <p key={index}>{text}</p>
                        ))}
                        <div className="project-actions">
                            <button
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
                                className="secondary-action"
                                disabled={pending || !project.enabled}
                                onClick={() =>
                                    void action(async () => {
                                        const result = await projects.rescanProject({ projectId: project.projectId });
                                        setStatus(
                                            `${result.cataloged} Sessions cataloged. ${result.diagnostics.join(" ")}`,
                                        );
                                    })
                                }
                            >
                                Full Session rescan
                            </button>
                            <button
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
                                    ...(confirmation ? { directoryConfirmation: confirmation } : {}),
                                })
                            }
                            onComplete={refresh}
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
                                            className="primary-action"
                                            disabled={pending || !row.enabled}
                                            onClick={() =>
                                                void action(async () => {
                                                    await projects.openProject({ projectId: row.projectId });
                                                    setSelected(true);
                                                })
                                            }
                                        >
                                            Open
                                        </button>
                                        <button
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
                <SessionClientSurface client={sessions} />
            </div>
        </div>
    );
}
