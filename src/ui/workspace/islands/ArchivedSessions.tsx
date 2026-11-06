import { useEffect, useRef, useState } from "react";
import { SessionList, type SessionListData } from "../components/SessionList.tsx";

interface ArchivedSessionsProps {
    projectId: string;
}

export default function ArchivedSessions({ projectId }: ArchivedSessionsProps) {
    const [page, setPage] = useState(0);
    const [data, setData] = useState<SessionListData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const generation = useRef(0);
    async function loadPage() {
        const request = ++generation.current;
        setLoading(true);
        setError("");
        try {
            const query = new URLSearchParams({ archiveState: "archived", page: String(page), pageSize: "30" });
            const response = await fetch(`/api/owner/projects/${encodeURIComponent(projectId)}/sessions?${query}`);
            const payload = await response.json();
            if (!response.ok || payload.error) throw new Error(payload.error || `Request failed (${response.status}).`);
            if (request === generation.current) {
                setData(payload);
                if (!payload.sessions?.length && page > 0) setPage(page - 1);
            }
        } catch (error) {
            if (request === generation.current) {
                setError(
                    `${error instanceof Error ? error.message : String(error)} Try loading archived Sessions again.`,
                );
            }
        } finally {
            if (request === generation.current) setLoading(false);
        }
    }
    useEffect(() => {
        void loadPage();
        return () => {
            generation.current++;
        };
    }, [projectId, page]);
    return (
        <SessionList
            projectId={projectId}
            archived
            data={data}
            loading={loading}
            error={error}
            onRetry={loadPage}
            onPageChange={setPage}
            onSessionChanged={() => {
                void loadPage();
            }}
        />
    );
}
