import Fuse from "fuse.js";
import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import { PLAN_SEARCH_QUERY_PARAM } from "../constants.ts";
import type { PlanSearchEntry } from "../plan-search.ts";

export interface PlanBoardSearchProps {
    boardId: string;
    searchIndex: PlanSearchEntry[];
    initialQuery?: string;
}

export { PLAN_SEARCH_QUERY_PARAM };

export const PLAN_SEARCH_OPTIONS = Object.freeze({
    keys: [
        { name: "title", weight: 0.45 },
        { name: "planName", weight: 0.4 },
        { name: "summary", weight: 0.15 },
    ],
    threshold: 0.36,
    ignoreLocation: true,
    includeScore: true,
});

export function normalizePlanSearchQuery<T>(value: T): string {
    return String(value || "").trim().replace(/\s+/g, " ");
}

export function matchingPlanIds(searchIndex: PlanSearchEntry[], query: string): Set<string> {
    const normalizedQuery = normalizePlanSearchQuery(query);
    if (!normalizedQuery) return new Set(searchIndex.map((entry) => entry.planId));
    const fuse = new Fuse(searchIndex, PLAN_SEARCH_OPTIONS);
    return new Set(fuse.search(normalizedQuery).map((result) => result.item.planId));
}

export function planMatchesSearch(plan: PlanSearchEntry, query: string): boolean {
    return matchingPlanIds([plan], query).has(plan.planId);
}

function replaceQueryInUrl(query: string) {
    const url = new URL(globalThis.location.href);
    if (query) url.searchParams.set(PLAN_SEARCH_QUERY_PARAM, query);
    else url.searchParams.delete(PLAN_SEARCH_QUERY_PARAM);
    globalThis.history.replaceState(globalThis.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function syncQueryInWorkspaceLinks(query: string) {
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const anchor = link;
        const href = anchor.getAttribute("href") || "";
        if (!href || href.startsWith("#")) continue;
        const url = new URL(href, globalThis.location.href);
        if (url.origin !== globalThis.location.origin) continue;
        if (query) url.searchParams.set(PLAN_SEARCH_QUERY_PARAM, query);
        else url.searchParams.delete(PLAN_SEARCH_QUERY_PARAM);
        anchor.setAttribute("href", `${url.pathname}${url.search}${url.hash}`);
    }
}

export function applyPlanSearchDomState(scope: Element, visiblePlanIds: Set<string>, hasQuery: boolean) {
    const cards = [...scope.querySelectorAll<HTMLElement>("[data-plan-search-card]")];
    for (const card of cards) {
        const planId = card.dataset.planSearchCard || "";
        const visible = !hasQuery || visiblePlanIds.has(planId);
        card.hidden = !visible;
    }

    for (const column of scope.querySelectorAll<HTMLElement>("[data-plan-search-column]")) {
        const columnElement = column;
        const columnCards = [...columnElement.querySelectorAll<HTMLElement>("[data-plan-search-card]")];
        const columnVisibleCount = columnCards.filter((card) => !card.hidden).length;
        const count = columnElement.querySelector("[data-column-count]");
        if (count) {
            count.textContent = hasQuery
                ? String(columnVisibleCount)
                : columnElement.dataset.columnOriginalCount || String(columnVisibleCount);
        }
        const filteredEmpty = columnElement.querySelector<HTMLElement>("[data-filtered-empty]");
        if (filteredEmpty) filteredEmpty.hidden = !hasQuery || columnVisibleCount > 0;
        const originalEmpty = columnElement.querySelector<HTMLElement>("[data-original-empty]");
        if (originalEmpty) originalEmpty.hidden = hasQuery;
    }

    for (const repairLane of scope.querySelectorAll<HTMLElement>("[data-plan-search-repair]")) {
        const laneElement = repairLane;
        const laneCards = [...laneElement.querySelectorAll<HTMLElement>("[data-plan-search-card]")];
        const laneVisibleCount = laneCards.filter((card) => !card.hidden).length;
        const filteredEmpty = laneElement.querySelector<HTMLElement>("[data-filtered-empty]");
        if (filteredEmpty) filteredEmpty.hidden = !hasQuery || laneVisibleCount > 0;
    }
}

export function PlanBoardSearch({ boardId, searchIndex, initialQuery = "" }: PlanBoardSearchProps) {
    const [query, setQuery] = useState(normalizePlanSearchQuery(initialQuery));
    const resultIds = useMemo(() => matchingPlanIds(searchIndex, query), [searchIndex, query]);

    useEffect(() => {
        const scope = document.querySelector(`[data-plan-search-scope="${boardId}"]`);
        if (!scope) return;
        const normalizedQuery = normalizePlanSearchQuery(query);
        applyPlanSearchDomState(scope, resultIds, Boolean(normalizedQuery));
        replaceQueryInUrl(normalizedQuery);
        syncQueryInWorkspaceLinks(normalizedQuery);
    }, [boardId, query, resultIds]);

    function handleInput(event: SyntheticEvent<HTMLInputElement>) {
        setQuery(event.currentTarget.value);
    }

    function handleClear() {
        setQuery("");
    }

    const hasQuery = Boolean(normalizePlanSearchQuery(query));

    return (
        <div className="plan-search" role="search" aria-label="Filter board Plans">
            <div className="plan-search-field">
                <div className="plan-search-input-row">
                    <input
                        id={`${boardId}-plan-search`}
                        type="search"
                        value={query}
                        placeholder="Filter by title, name, or summary"
                        autoComplete="off"
                        aria-label="Search Plans"
                        onInput={handleInput}
                    />
                    {hasQuery
                        ? <button type="button" className="plan-search-clear" onClick={handleClear}>Clear</button>
                        : null}
                </div>
            </div>
        </div>
    );
}

export default PlanBoardSearch;
