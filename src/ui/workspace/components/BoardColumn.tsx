import type { ProjectCardData } from "./EpicCard.tsx";
import type { PlanCardData } from "./PlanCard.tsx";
import { EpicCard } from "./EpicCard.tsx";
import { PlanCard } from "./PlanCard.tsx";

export interface BoardCardData extends PlanCardData, ProjectCardData {
    isEpic?: boolean;
}

export interface BoardColumnData {
    status: string;
    label: string;
    description: string;
    count: number;
    cards: BoardCardData[];
}

export interface BoardColumnProps {
    column: BoardColumnData;
    url: URL | string;
    draggableCards?: boolean;
}
export function BoardColumn({ column, url, draggableCards = true }: BoardColumnProps) {
    return (
        <section
            className="board-column"
            data-status={column.status}
            data-action-target-status={column.status}
            data-column-label={column.label}
            data-plan-search-column={column.status}
            data-column-original-count={column.count}
            aria-label={`${column.label}: ${column.description}`}
        >
            <header className="column-header">
                <div>
                    <h3>{column.label}</h3>
                    <p>{column.description}</p>
                </div>
                <span className="column-count" data-column-count>{column.count}</span>
            </header>
            <div className="column-cards">
                {column.cards.map((plan) => (
                    plan.isEpic
                        ? <EpicCard key={plan.planId} epic={plan} url={url} draggableCard={draggableCards} />
                        : (
                            <PlanCard
                                key={plan.planId}
                                plan={plan}
                                url={url}
                                roleLabel="Planned Change"
                                draggableCard={draggableCards}
                            />
                        )
                ))}
                {column.cards.length === 0
                    ? <p className="empty compact-empty" data-original-empty>No top-level Plans.</p>
                    : null}
                <p className="empty compact-empty filtered-empty" data-filtered-empty hidden>
                    No Plans match this search in {column.label}.
                </p>
            </div>
        </section>
    );
}
