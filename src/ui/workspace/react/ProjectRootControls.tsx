import { useEffect, useRef, useState } from "react";
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { RunWieldConfirmationDialog } from "../../design-system/components/react/RunWieldConfirmationDialog.tsx";
export type ProjectRootSubmission =
    { status: "ok" } | { status: "confirmation_required"; confirmation: string; message: string };
interface Confirmation {
    root: string;
    token: string;
    message: string;
}
export interface ProjectRootControlsProps {
    projectId?: string;
    initialRoot?: string;
    submitRoot(root: string, displayName: string, confirmation?: string): Promise<ProjectRootSubmission>;
    onComplete(): void | Promise<void>;
    pickDirectory?: () => Promise<string | null>;
}
/** Shared presentation. HTTP, native selection, and navigation stay in host adapters. */
export function ProjectRootControls({
    projectId,
    initialRoot = "",
    submitRoot,
    onComplete,
    pickDirectory,
}: ProjectRootControlsProps) {
    const [root, setRoot] = useState(initialRoot);
    const [displayName, setDisplayName] = useState("");
    const [pending, setPending] = useState(false);
    const [status, setStatus] = useState("");
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const inFlight = useRef(false);
    const restoreFocus = useRef(false);
    const submitButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!pending && restoreFocus.current) {
            restoreFocus.current = false;
            submitButton.current?.focus();
        }
    }, [pending]);
    async function submit(acknowledgement?: Confirmation) {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        setStatus("");
        setConfirmation(null);
        try {
            const data = await submitRoot(
                root,
                displayName,
                acknowledgement?.root === root ? acknowledgement.token : undefined,
            );
            if (data.status === "confirmation_required") {
                setConfirmation({ root, token: data.confirmation, message: data.message });
            } else await onComplete();
        } catch (error) {
            restoreFocus.current = Boolean(acknowledgement);
            setStatus(
                error instanceof Error
                    ? error.message
                    : projectId
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
                    void submit();
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
                {pickDirectory && (
                    <button
                        type="button"
                        className="secondary-action"
                        disabled={pending}
                        onClick={() => {
                            if (inFlight.current) return;
                            inFlight.current = true;
                            setPending(true);
                            void pickDirectory()
                                .then((path) => {
                                    if (path !== null) {
                                        setRoot(path);
                                        setConfirmation(null);
                                    }
                                })
                                .catch((error: Error) => setStatus(error.message))
                                .finally(() => {
                                    inFlight.current = false;
                                    setPending(false);
                                });
                        }}
                    >
                        Choose folder
                    </button>
                )}
                <button
                    ref={submitButton}
                    type="submit"
                    className={projectId ? "secondary-action" : "primary-action"}
                    disabled={pending}
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
