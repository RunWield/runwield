import { useRef, useState } from "react";
import type { ProjectId } from "@runwield/projects";
import type { CloneChoiceRequest } from "../routes/owner-api.ts";
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { RunWieldConfirmationDialog } from "../../design-system/components/react/RunWieldConfirmationDialog.tsx";

export interface ProjectRootFormProps {
    projectId?: string;
}
interface CloneCandidate {
    projectId: ProjectId;
    displayName: string;
}
interface ClonePrompt {
    token: string;
    candidates: CloneCandidate[];
    acknowledgement?: Confirmation;
}
interface Confirmation {
    root: string;
    token: string;
    message: string;
    choice?: CloneChoiceRequest;
}
interface RootProject {
    projectId: ProjectId;
}
interface RootResponse {
    code?: string;
    error?: string;
    confirmation?: string;
    token?: string;
    candidates?: CloneCandidate[];
    project?: RootProject;
}
function navigate(href: string, history: string) {
    const event = new CustomEvent("runwield:workspace-navigate", { cancelable: true, detail: { href, history } });
    if (document.dispatchEvent(event)) location.assign(href);
}
export default function ProjectRootForm({ projectId }: ProjectRootFormProps) {
    const [root, setRoot] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [pending, setPending] = useState(false);
    const [status, setStatus] = useState("");
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [clonePrompt, setClonePrompt] = useState<ClonePrompt | null>(null);
    const inFlight = useRef(false);
    const submitButton = useRef<HTMLButtonElement>(null);
    async function submit(acknowledgement?: Confirmation, choice = acknowledgement?.choice) {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setStatus("");
        setConfirmation(null);
        setClonePrompt(null);
        try {
            const csrf =
                document.cookie
                    .split("; ")
                    .find((cookie) => cookie.startsWith("rw_owner_csrf="))
                    ?.split("=")
                    .slice(1)
                    .join("=") || "";
            const response = await fetch(
                projectId ? `/api/owner/projects/${encodeURIComponent(projectId)}/action` : "/api/owner/projects",
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-runwield-csrf": decodeURIComponent(csrf) },
                    body: JSON.stringify({
                        ...(projectId ? { action: "relink", newRoot: root } : { root, displayName }),
                        ...(acknowledgement?.root === root ? { directoryConfirmation: acknowledgement.token } : {}),
                        cloneChoice: choice,
                    }),
                },
            );
            const data: RootResponse = response.ok ? await response.json() : await response.json().catch(() => ({}));
            if (response.status === 409 && data.code === "directory_confirmation_required" && data.confirmation) {
                setStatus("");
                setConfirmation({
                    root,
                    token: data.confirmation,
                    message: data.error || "System or home folder detected. Continue?",
                    choice,
                });
            } else if (
                response.status === 409 &&
                data.code === "project_clone_choice_required" &&
                data.token &&
                data.candidates?.length
            ) {
                setStatus("This checkout matches an existing Project.");
                setClonePrompt({ token: data.token, candidates: data.candidates, acknowledgement });
            } else if (!response.ok) setStatus(data.error || "Project operation failed.");
            else if (projectId) navigate(location.pathname + location.search, "replace");
            else if (data.project) navigate(`/projects/${encodeURIComponent(data.project.projectId)}/settings`, "push");
        } catch {
            setClonePrompt(clonePrompt);
            setStatus(
                projectId
                    ? "Project relink could not be confirmed. Check your connection and try again."
                    : "Project link could not be confirmed. Check your connection and try again.",
            );
        } finally {
            inFlight.current = false;
            setPending(false);
        }
    }
    return (
        <>
            <form
                className="owner-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!clonePrompt) void submit();
                }}
            >
                <label>
                    {projectId ? "Relink Project root" : "Project root"}
                    <input
                        name={projectId ? "newRoot" : "root"}
                        required
                        disabled={pending}
                        value={root}
                        placeholder={projectId ? "New absolute path" : "Absolute path to a Project"}
                        onInput={(event) => {
                            setRoot(event.currentTarget.value);
                            setConfirmation(null);
                            setClonePrompt(null);
                            setStatus("");
                        }}
                    />
                </label>
                {!projectId && (
                    <label>
                        Display name
                        <input
                            name="displayName"
                            value={displayName}
                            disabled={pending}
                            placeholder="Optional"
                            onChange={(event) => setDisplayName(event.target.value)}
                        />
                    </label>
                )}
                <button
                    ref={submitButton}
                    type="submit"
                    className={projectId ? "secondary-action" : "primary-action"}
                    disabled={pending || Boolean(clonePrompt)}
                >
                    {pending ? (
                        <RunWieldThinkingDots label={projectId ? "Relinking Project" : "Linking Project"} />
                    ) : projectId ? (
                        "Relink"
                    ) : (
                        "Link Project"
                    )}
                </button>
            </form>
            <p className="muted" role="status">
                {status}
            </p>
            {clonePrompt && (
                <fieldset className="workspace-settings-actions">
                    <legend>Choose a Project for this checkout</legend>
                    {clonePrompt.candidates.map((candidate) => (
                        <button
                            key={candidate.projectId}
                            type="button"
                            className="secondary-action"
                            onClick={() =>
                                void submit(clonePrompt.acknowledgement, {
                                    kind: "link",
                                    token: clonePrompt.token,
                                    projectId: candidate.projectId,
                                })
                            }
                        >
                            Link to {candidate.displayName}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="secondary-action"
                        onClick={() =>
                            void submit(clonePrompt.acknowledgement, { kind: "new", token: clonePrompt.token })
                        }
                    >
                        Create a separate Project
                    </button>
                    <button
                        type="button"
                        className="secondary-action"
                        onClick={() => {
                            setClonePrompt(null);
                            setStatus("");
                        }}
                    >
                        Cancel
                    </button>
                </fieldset>
            )}
            {confirmation && (
                <RunWieldConfirmationDialog
                    returnFocus={submitButton}
                    title={confirmation.message}
                    detail={confirmation.root}
                    onQuit={() => setConfirmation(null)}
                    onContinue={() => {
                        void submit(confirmation);
                    }}
                />
            )}
        </>
    );
}
