import { PLAN_SEARCH_QUERY_PARAM } from "../constants.ts";
import { PlanBoardSearch } from "../islands/PlanBoardSearch.tsx";
import type { PlanSearchScreen } from "../plan-search.ts";
import { buildPlanBoardSearchIndex } from "../plan-search.ts";
import { workspaceUrl } from "./PlanCard.tsx";

export type PlanBoardView = "active" | "closed" | "onHold";

export interface PlanBoardToolbarBoard {
    screens: Record<PlanBoardView, PlanSearchScreen>;
}

export interface PlanBoardToolbarProps {
    board: PlanBoardToolbarBoard;
    view: PlanBoardView;
    url: URL | string;
}
export function PlanBoardToolbar({ board, view, url }: PlanBoardToolbarProps) {
    const currentUrl = workspaceUrl(url);
    const boardId = `status-board-${view}`;
    return (
        <PlanBoardSearch
            boardId={boardId}
            searchIndex={buildPlanBoardSearchIndex(board.screens[view])}
            initialQuery={currentUrl.searchParams.get(PLAN_SEARCH_QUERY_PARAM) || ""}
        />
    );
}
