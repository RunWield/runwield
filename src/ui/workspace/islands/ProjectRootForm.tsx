import { ProjectRootControls } from "../react/ProjectRootControls.tsx";
import type { ProjectRootSubmission } from "../react/ProjectRootControls.tsx";
export interface ProjectRootFormProps {
    projectId?: string;
}
interface RootProject {
    projectId: string;
}
interface RootResponse {
    code?: string;
    error?: string;
    confirmation?: string;
    project?: RootProject;
}
function navigate(href: string, history: string) {
    const event = new CustomEvent("runwield:workspace-navigate", { cancelable: true, detail: { href, history } });
    if (document.dispatchEvent(event)) location.assign(href);
}
export default function ProjectRootForm({ projectId }: ProjectRootFormProps) {
    let linkedId = "";
    async function submitRoot(
        root: string,
        displayName: string,
        directoryConfirmation?: string,
    ): Promise<ProjectRootSubmission> {
        const csrf =
            document.cookie
                .split("; ")
                .find((cookie) => cookie.startsWith("rw_owner_csrf="))
                ?.split("=")
                .slice(1)
                .join("=") || "";
        let response: Response;
        let data: RootResponse;
        try {
            response = await fetch(
                projectId ? `/api/owner/projects/${encodeURIComponent(projectId)}/action` : "/api/owner/projects",
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-runwield-csrf": decodeURIComponent(csrf) },
                    body: JSON.stringify({
                        ...(projectId ? { action: "relink", newRoot: root } : { root, displayName }),
                        ...(directoryConfirmation ? { directoryConfirmation } : {}),
                    }),
                },
            );
            data = response.ok ? await response.json() : await response.json().catch(() => ({}));
        } catch {
            throw new Error(
                projectId
                    ? "Project relink could not be confirmed. Check your connection and try again."
                    : "Project link could not be confirmed. Check your connection and try again.",
            );
        }
        if (response.status === 409 && data.code === "directory_confirmation_required" && data.confirmation)
            return {
                status: "confirmation_required",
                confirmation: data.confirmation,
                message: data.error || "System or home folder detected. Continue?",
            };
        if (!response.ok) throw new Error(data.error || "Project operation failed.");
        linkedId = data.project?.projectId || "";
        return { status: "ok" };
    }
    return (
        <ProjectRootControls
            projectId={projectId}
            submitRoot={submitRoot}
            onComplete={() => {
                if (projectId) navigate(location.pathname + location.search, "replace");
                else if (linkedId) navigate(`/projects/${encodeURIComponent(linkedId)}/settings`, "push");
            }}
        />
    );
}
