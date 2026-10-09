import { useEffect, useRef, useState } from "react";
import {
    RunWieldButton,
    RunWieldLink,
    RunWieldThinkingDots,
} from "../../design-system/components/react/RunWieldPrimitives.tsx";
import {
    RunWieldSearchDialog,
    RunWieldSearchFilters,
    RunWieldSearchResults,
} from "../../design-system/components/react/RunWieldSearchPrimitives.tsx";

interface SearchProject {
    projectId: string;
    name: string;
}
interface SearchState {
    projectId: string;
    state: string;
    reader?: string;
    message?: string;
}
interface SearchResult {
    id: string;
    projectId: string;
    projectName: string;
    contentType: string;
    sourceId: string;
    title: string;
    snippet: string;
    destination: string;
    freshness: string;
    summary?: string;
    completionMode?: string;
    sourceLinks?: string[];
    notices?: string[];
}
interface SearchPayload {
    query: string;
    page: number;
    pageSize: number;
    total: number;
    results: SearchResult[];
    projects: SearchProject[];
    contentTypes: string[];
    states: SearchState[];
    error?: string;
}
interface SearchProps {
    fullPage?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
    plan: "Plan",
    "work-record": "Work Record",
    prd: "PRD",
    adr: "ADR",
    "design-system": "Design System",
    "domain-language": "Domain Language",
    session: "Session",
};

function cookieValue(name: string) {
    return document.cookie.split("; ").find((value) => value.startsWith(`${name}=`))?.split("=").slice(1).join("=") ||
        "";
}

export function searchStateFromUrl() {
    const params = new URLSearchParams(globalThis.location.search);
    return {
        query: params.get("q") || "",
        projectId: params.get("project") || "",
        contentType: params.get("type") || "",
        page: Math.max(1, Number(params.get("page")) || 1),
    };
}

export function searchUrl(query: string, projectId: string, contentType: string, page: number, pageSize: number) {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (projectId) params.set("project", projectId);
    if (contentType) params.set("type", contentType);
    if (page > 1) params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    return `/api/owner/search?${params}`;
}

export function fullSearchHref(query: string, projectId: string, contentType: string, page = 1) {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (projectId) params.set("project", projectId);
    if (contentType) params.set("type", contentType);
    if (page > 1) params.set("page", String(page));
    const search = params.toString();
    return `/search${search ? `?${search}` : ""}`;
}

export function resultHref(
    result: SearchResult,
    query: string,
    projectId: string,
    contentType: string,
    page: number,
) {
    const returnTo = fullSearchHref(query, projectId, contentType, page);
    const url = new URL(result.destination, globalThis.location.origin);
    url.searchParams.set("return", returnTo);
    return `${url.pathname}${url.search}`;
}

export function UnifiedWorkspaceSearch({ fullPage = false }: SearchProps) {
    const initial = fullPage ? searchStateFromUrl() : { query: "", projectId: "", contentType: "", page: 1 };
    const [open, setOpen] = useState(fullPage);
    const [query, setQuery] = useState(initial.query);
    const [projectId, setProjectId] = useState(initial.projectId);
    const [contentType, setContentType] = useState(initial.contentType);
    const [page, setPage] = useState(initial.page);
    const [payload, setPayload] = useState<SearchPayload | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const requestRef = useRef(0);

    useEffect(() => {
        if (fullPage) return;
        const onShortcut = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
                event.preventDefault();
                setOpen(true);
            }
        };
        globalThis.addEventListener("keydown", onShortcut);
        return () => globalThis.removeEventListener("keydown", onShortcut);
    }, [fullPage]);

    useEffect(() => {
        if (!fullPage && open) requestAnimationFrame(() => inputRef.current?.focus());
    }, [open, fullPage]);

    useEffect(() => {
        if (!open) return;
        const requestId = ++requestRef.current;
        const controller = new AbortController();
        const timer = globalThis.setTimeout(async () => {
            setLoading(true);
            setError("");
            try {
                const response = await fetch(
                    searchUrl(query, projectId, contentType, fullPage ? page : 1, fullPage ? 20 : 8),
                    {
                        signal: controller.signal,
                        headers: { accept: "application/json" },
                    },
                );
                const next = await response.json() as SearchPayload;
                if (!response.ok || next.error) throw new Error(next.error || `Search failed with ${response.status}`);
                if (requestRef.current !== requestId) return;
                setPayload(next);
                setSelected(0);
            } catch (caught) {
                if (controller.signal.aborted || requestRef.current !== requestId) return;
                setError(caught instanceof Error ? caught.message : "Search failed.");
            } finally {
                if (requestRef.current === requestId) setLoading(false);
            }
        }, query ? 120 : 0);
        return () => {
            globalThis.clearTimeout(timer);
            controller.abort();
        };
    }, [query, projectId, contentType, page, open, fullPage]);

    useEffect(() => {
        if (!fullPage) return;
        const href = fullSearchHref(query, projectId, contentType, page);
        globalThis.history.replaceState(globalThis.history.state, "", href);
    }, [query, projectId, contentType, page, fullPage]);

    async function refresh() {
        const requestId = ++requestRef.current;
        setLoading(true);
        setError("");
        try {
            const response = await fetch("/api/owner/search/refresh", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-csrf": decodeURIComponent(cookieValue("rw_owner_csrf")),
                },
                body: "{}",
            });
            const result = await response.json() as { error?: string };
            if (!response.ok || result.error) throw new Error(result.error || "Refresh failed.");
            const nextResponse = await fetch(
                searchUrl(query, projectId, contentType, fullPage ? page : 1, fullPage ? 20 : 8),
            );
            const next = await nextResponse.json() as SearchPayload;
            if (!nextResponse.ok || next.error) throw new Error(next.error || "Refresh failed.");
            if (requestRef.current !== requestId) return;
            setPayload(next);
            setSelected(0);
        } catch (caught) {
            if (requestRef.current !== requestId) return;
            setError(caught instanceof Error ? caught.message : "Refresh failed.");
        } finally {
            if (requestRef.current === requestId) setLoading(false);
        }
    }

    function onResultKeys(event: React.KeyboardEvent<HTMLInputElement>) {
        const resultCount = payload?.results.length || 0;
        if (event.key === "ArrowDown" && resultCount) {
            event.preventDefault();
            setSelected((value) => (value + 1) % resultCount);
        } else if (event.key === "ArrowUp" && resultCount) {
            event.preventDefault();
            setSelected((value) => (value - 1 + resultCount) % resultCount);
        } else if (event.key === "Enter" && payload?.results[selected]) {
            event.preventDefault();
            globalThis.location.assign(resultHref(payload.results[selected], query, projectId, contentType, page));
        } else if (event.key === "Escape" && !fullPage) {
            event.preventDefault();
            setOpen(false);
        }
    }

    const content = (
        <section
            className={`rw-workspace-search ${fullPage ? "rw-workspace-search-page" : "rw-workspace-search-dialog"}`}
            aria-label="Workspace search"
        >
            <header className="rw-workspace-search-header">
                <div>
                    <h1>{fullPage ? "Search" : "Search Workspace"}</h1>
                    {!fullPage && <p>Plans, project knowledge, and Sessions</p>}
                </div>
                {!fullPage && (
                    <button
                        className="rw-icon-button"
                        type="button"
                        aria-label="Close search"
                        onClick={() => setOpen(false)}
                    >
                        ×
                    </button>
                )}
            </header>
            <div className="rw-workspace-search-query">
                <label
                    className="sr-only"
                    htmlFor={fullPage ? "workspace-search-page-input" : "workspace-search-dialog-input"}
                >
                    Search Workspace
                </label>
                <input
                    ref={inputRef}
                    id={fullPage ? "workspace-search-page-input" : "workspace-search-dialog-input"}
                    type="search"
                    value={query}
                    placeholder="Search Plans, knowledge, and Sessions"
                    onChange={(event) => {
                        setPage(1);
                        setQuery(event.target.value);
                    }}
                    onKeyDown={onResultKeys}
                    autoComplete="off"
                />
                {loading && <RunWieldThinkingDots label="Searching" showLabel={false} />}
            </div>
            <RunWieldSearchFilters>
                <label>
                    Project
                    <select
                        value={projectId}
                        onChange={(event) => {
                            setPage(1);
                            setProjectId(event.target.value);
                        }}
                    >
                        <option value="">All Projects</option>
                        {(payload?.projects || []).map((project) => (
                            <option key={project.projectId} value={project.projectId}>{project.name}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Type
                    <select
                        value={contentType}
                        onChange={(event) => {
                            setPage(1);
                            setContentType(event.target.value);
                        }}
                    >
                        <option value="">All types</option>
                        {(payload?.contentTypes || []).map((type) => (
                            <option key={type} value={type}>{TYPE_LABELS[type] || type}</option>
                        ))}
                    </select>
                </label>
                <RunWieldButton onClick={refresh} disabled={loading}>Refresh</RunWieldButton>
            </RunWieldSearchFilters>
            {error && <p className="rw-workspace-search-error" role="alert">{error}</p>}
            {(payload?.states || []).filter((state) => state.state !== "ready").map((state) => (
                <p className="rw-workspace-search-notice" key={state.projectId}>
                    {payload?.projects.find((project) =>
                        project.projectId === state.projectId
                    )?.name || "Project"}:{" "}
                    {state.state === "indexing" ? "Indexing" : state.message || `${state.reader || "Search"} failed`}
                </p>
            ))}
            {!query.trim()
                ? <p className="rw-workspace-search-empty">Enter a query to find Workspace content.</p>
                : !loading && !payload?.results.length
                ? <p className="rw-workspace-search-empty">No matches found.</p>
                : (
                    <RunWieldSearchResults>
                        {(payload?.results || []).map((result, index) => (
                            <li key={result.id} data-selected={index === selected || undefined}>
                                <a
                                    href={resultHref(result, query, projectId, contentType, page)}
                                    onMouseEnter={() =>
                                        setSelected(index)}
                                >
                                    <strong>{result.title}</strong>
                                    <span className="rw-workspace-search-meta">
                                        <span className="badge">
                                            {TYPE_LABELS[result.contentType] || result.contentType}
                                        </span>
                                        <span>{result.projectName}</span>
                                    </span>
                                    <span className="rw-workspace-search-snippet">
                                        {result.summary || result.snippet}
                                    </span>
                                    {result.completionMode && (
                                        <span className="rw-workspace-search-confidence">
                                            Completion confidence: {result.completionMode.replaceAll("_", " ")}
                                        </span>
                                    )}
                                    {result.notices?.map((notice) => (
                                        <span className="rw-workspace-search-result-notice" key={notice}>{notice}</span>
                                    ))}
                                </a>
                                {result.sourceLinks?.length
                                    ? (
                                        <span className="rw-workspace-search-source-links">
                                            Source Plans:{" "}
                                            {result.sourceLinks.map((sourcePlan, sourceIndex) => (
                                                <span key={sourcePlan}>
                                                    {sourceIndex > 0 && ", "}
                                                    <a
                                                        href={`/projects/${
                                                            encodeURIComponent(result.projectId)
                                                        }/plans/${encodeURIComponent(sourcePlan)}?return=${
                                                            encodeURIComponent(
                                                                fullSearchHref(query, projectId, contentType, page),
                                                            )
                                                        }`}
                                                    >
                                                        {sourcePlan}
                                                    </a>
                                                </span>
                                            ))}
                                        </span>
                                    )
                                    : null}
                            </li>
                        ))}
                    </RunWieldSearchResults>
                )}
            {fullPage && payload && payload.total > payload.pageSize && (
                <nav className="rw-workspace-search-pagination" aria-label="Search result pages">
                    <RunWieldButton
                        disabled={page <= 1 || loading}
                        onClick={() =>
                            setPage((current) =>
                                Math.max(1, current - 1)
                            )}
                    >
                        Previous
                    </RunWieldButton>
                    <span>
                        Page {page} of {Math.ceil(payload.total / payload.pageSize)}
                    </span>
                    <RunWieldButton
                        disabled={page * payload.pageSize >= payload.total || loading}
                        onClick={() => setPage((current) => current + 1)}
                    >
                        Next
                    </RunWieldButton>
                </nav>
            )}
            {!fullPage && (
                <footer className="rw-workspace-search-footer">
                    <span>↑↓ Select · Enter Open · Esc Close</span>
                    <RunWieldLink href={fullSearchHref(query, projectId, contentType)}>
                        View all results
                    </RunWieldLink>
                </footer>
            )}
        </section>
    );

    if (fullPage) return content;
    return (
        <>
            <button
                className="rw-workspace-search-trigger"
                type="button"
                onClick={() => setOpen(true)}
                aria-haspopup="dialog"
            >
                <span aria-hidden="true">⌕</span>
                <span>Search</span>
                <kbd>⌘K</kbd>
            </button>
            <RunWieldSearchDialog open={open} onClose={() => setOpen(false)}>
                {content}
            </RunWieldSearchDialog>
        </>
    );
}
