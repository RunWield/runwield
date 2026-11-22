import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
export interface SavedSessionRow {
    id: string;
    title: string;
    archived: boolean;
    pending?: boolean;
    error?: string;
    href?: string;
    state?: string;
}
interface SavedSessionRowsProps {
    rows: SavedSessionRow[];
    selectedId?: string;
    onOpen?: (id: string) => void;
    onArchive: (id: string, button?: HTMLButtonElement) => void;
}
/** Shared list presentation. The browser and native host retain their own mutation adapters. */
export function SavedSessionRows({ rows, selectedId, onOpen, onArchive }: SavedSessionRowsProps) {
    return (
        <div className="session-card-list">
            {rows.map((row) => (
                <div className="session-list-row" key={row.id} aria-busy={row.pending}>
                    {row.href ? (
                        <a
                            className="session-list-item"
                            href={row.href}
                            aria-current={selectedId === row.id ? "page" : undefined}
                        >
                            <span className="session-list-name" title={row.title}>
                                {row.title}
                            </span>
                            <span className="session-list-status">{row.archived ? "Archived" : row.state || ""}</span>
                        </a>
                    ) : (
                        <button
                            type="button"
                            className="session-list-item"
                            aria-label={row.title}
                            onClick={() => onOpen?.(row.id)}
                            aria-current={selectedId === row.id ? "page" : undefined}
                        >
                            <span className="session-list-name" title={row.title}>
                                {row.title}
                            </span>
                            {row.archived && <span className="session-list-status">Archived</span>}
                        </button>
                    )}
                    <RunWieldButton
                        disabled={row.pending}
                        aria-label={`${row.archived ? "Unarchive" : "Archive"} ${row.title}`}
                        onClick={(event) => onArchive(row.id, event?.currentTarget)}
                    >
                        {row.pending
                            ? row.archived
                                ? "Unarchiving…"
                                : "Archiving…"
                            : row.archived
                              ? "Unarchive"
                              : "Archive"}
                    </RunWieldButton>
                    {row.error && (
                        <p className="notice warning session-archive-error" role="alert">
                            {row.error}
                        </p>
                    )}
                </div>
            ))}
        </div>
    );
}
