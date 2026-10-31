import type { BoardColumnData } from "./BoardColumn.tsx";
import type { PlanCardData } from "./PlanCard.tsx";
import type { PlanBoardView } from "./PlanBoardToolbar.tsx";
import { PlanBoardDragDrop } from "../islands/PlanBoardDragDrop.jsx";
import { BoardColumn } from "./BoardColumn.tsx";
import { PlanCard } from "./PlanCard.tsx";

export { buildPlanBoardSearchIndex } from "../plan-search.ts";

export interface PlanBoardScreen {
    title: string;
    columns: BoardColumnData[];
    orphanChildren?: PlanCardData[];
}

export interface PlanDocumentDiagnostic {
    name: string;
    kind: string;
    message: string;
    planId?: string;
}

export interface PlanBoardData {
    screens: Record<PlanBoardView, PlanBoardScreen>;
    diagnostics?: PlanDocumentDiagnostic[];
}

export interface OrphanRepairSectionProps {
    screen: PlanBoardScreen;
    url: URL | string;
}

export interface PlanBoardProps {
    board: PlanBoardData;
    view: PlanBoardView;
    url: URL | string;
    staticRender?: boolean;
    staticRenderNotice?: string;
    draggableCards?: boolean;
}
function OrphanRepairSection({ screen, url }: OrphanRepairSectionProps) {
    if (!screen.orphanChildren?.length) return null;
    return (
        <section className="repair-lane" data-plan-search-repair>
            <header>
                <p className="eyebrow">Repair</p>
                <h3>Orphaned child Plans ({screen.orphanChildren.length})</h3>
                <p>
                    These child Plans reference a parentPlan value that does not resolve to a loaded Epic and remain
                    visible for repair.
                </p>
            </header>
            <div className="repair-grid">
                {screen.orphanChildren.map((plan) => (
                    <PlanCard key={plan.planId} plan={plan} url={url} roleLabel="Orphan child" />
                ))}
                <p className="empty compact-empty filtered-empty" data-filtered-empty hidden>
                    No orphaned child Plans match this search.
                </p>
            </div>
        </section>
    );
}

export function PlanBoard({
    board,
    view,
    url,
    staticRender = false,
    staticRenderNotice,
    draggableCards = true,
}: PlanBoardProps) {
    const screen = board.screens[view];
    const boardId = `status-board-${view}`;
    return (
        <section className="board-view" data-view={view} data-plan-search-scope={boardId}>
            {board.diagnostics?.length ? (
                <section className="notice rw-document-warnings" aria-label="Plan document warnings">
                    <h2>Plans that could not be read ({board.diagnostics.length})</h2>
                    <ul>
                        {board.diagnostics.map((diagnostic) => (
                            <li key={diagnostic.name}>
                                <strong>{diagnostic.name}</strong>
                                <p>{diagnostic.message}</p>
                            </li>
                        ))}
                    </ul>
                    <p>Healthy Plans remain available. Refresh after correcting or removing these documents.</p>
                </section>
            ) : null}
            <div
                id={boardId}
                className="status-board"
                data-plan-board="true"
                aria-label={`${screen.title} status columns`}
            >
                {screen.columns.map((column) => (
                    <BoardColumn key={column.status} column={column} url={url} draggableCards={draggableCards} />
                ))}
            </div>
            {screen.columns.length && !staticRender ? <PlanBoardDragDrop boardId={boardId} /> : null}
            {screen.columns.length && staticRender && staticRenderNotice ? (
                <p className="notice muted board-dnd-status">{staticRenderNotice}</p>
            ) : null}
            <OrphanRepairSection screen={screen} url={url} />
        </section>
    );
}
