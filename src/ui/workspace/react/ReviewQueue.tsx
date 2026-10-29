import { RunWieldIconButton } from "../../design-system/components/react/RunWieldIconButton.tsx";

export interface ReviewQueueItem {
    type: string;
    label: string;
    count: number;
    included: boolean;
}

export interface ReviewQueueProps {
    items: ReviewQueueItem[];
    disabled?: boolean;
    onToggle: (type: string) => void;
}

/** Exclusion affects one send, not the underlying review input. */
export function ReviewQueue({ items, disabled, onToggle }: ReviewQueueProps) {
    const queued = items.filter((item) => item.count > 0);
    if (!queued.length) return null;
    return (
        <div className="rw-review-queue" aria-label="Review Queue">
            {queued.map((item) => (
                <div className="rw-review-queue-item" data-included={item.included} key={item.type}>
                    <span>
                        {item.count} {item.label}
                        {!item.included && " (excluded)"}
                    </span>
                    <RunWieldIconButton
                        disabled={disabled}
                        aria-label={`${item.included ? "Exclude" : "Include"} ${item.label}`}
                        title={`${item.included ? "Exclude from" : "Include in"} next send`}
                        onClick={() => onToggle(item.type)}
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            aria-hidden="true"
                        >
                            {item.included ? <path d="m4 4 8 8M12 4l-8 8" /> : <path d="M3 8h10M8 3v10" />}
                        </svg>
                    </RunWieldIconButton>
                </div>
            ))}
        </div>
    );
}
