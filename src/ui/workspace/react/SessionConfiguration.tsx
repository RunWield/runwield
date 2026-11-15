import { useEffect, useState } from "react";
import type { WorkspaceSavedSessionClient, SessionClientView } from "../client/session-client.ts";
import type { WorkspaceProjectContext, WorkspaceOptionsResult } from "../../../acp/workspace-contract.ts";
interface SessionConfigurationProps {
    client: WorkspaceSavedSessionClient | null;
    view: SessionClientView | null;
    projects?: import("../client/project-client.ts").WorkspaceProjectClient;
}
/** Options are a provider-independent read. This never changes the selected Project. */
export function useSessionOptions({ client, view, projects: projectClient }: SessionConfigurationProps) {
    const [context, setContext] = useState<WorkspaceProjectContext | null>(null);
    const [options, setOptions] = useState<WorkspaceOptionsResult | null>(null);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let current = true;
        setContext(null);
        setOptions(null);
        setError("");
        if (client && projectClient && view?.connection === "ready" && view.project)
            void (async () => {
                const projects = await projectClient.listProjects();
                const candidates = projects.projects.filter((project) => project.enabled);
                for (const project of candidates) {
                    try {
                        const admitted = await client.readProject({ projectId: project.projectId });
                        if (admitted.context.canonicalRoot !== view.project) continue;
                        if (current) setContext(admitted.context);
                        const result = await client.sessionOptions(admitted.context);
                        if (current) {
                            setOptions(result);
                            setError("");
                        }
                        return;
                    } catch (caught) {
                        if (current) setError(caught instanceof Error ? caught.message : "Options unavailable.");
                    }
                }
            })().catch((caught: Error) => {
                if (current) setError(caught.message);
            });
        return () => {
            current = false;
        };
    }, [client, view?.project, view?.connection, retry, projectClient]);
    return { context, options, error, retry: () => setRetry((old) => old + 1) };
}
