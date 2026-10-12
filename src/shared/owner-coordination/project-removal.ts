import type { DatabaseSync } from "../sqlite.ts";

/**
 * Remove a Workspace registration and its dependent database records.
 * Call inside a transaction. File-authoritative Sessions remain on disk.
 */
export function deleteProjectRegistration(db: DatabaseSync, projectId: string): void {
    // Retired SQLite Session evidence may be deleted only with its registration.
    db.prepare("UPDATE projects SET lifecycle = 'removed' WHERE id = ?").run(projectId);
    for (
        const table of [
            "owner_session_operations",
            "session_transcript_segment_state",
            "session_activation_state",
            "session_committed_generations",
            "session_transcript_segments",
            "session_transcript_locators",
            "runwield_sessions",
            "project_session_catalog_scans",
            "project_roots",
        ]
    ) {
        db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
    db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
}
