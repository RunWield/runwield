import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { getOwnerCoordinationDatabasePath } from "@runwield/resources/owner-database";
import { DatabaseSync } from "@runwield/resources/sqlite";
import { isProjectId, type ProjectId, type ProjectLaunchContext } from "./identity.ts";

/** Reuse a legacy registration UUID on deliberate Core entry into its recorded current checkout. */
export function preferredRegisteredProjectId(
    canonicalRoot: string,
    context: ProjectLaunchContext,
): ProjectId | undefined {
    if (context.personalOwner.kind !== "execution-account" || !context.executionAccountHome) return;
    const path = getOwnerCoordinationDatabasePath({ home: context.executionAccountHome });
    let ids: ProjectId[];
    try {
        if (!lstatSync(dirname(path), { throwIfNoEntry: false })?.isDirectory()) return;
        if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return;
        const db = new DatabaseSync(path, { readOnly: true });
        try {
            const hasCanonicalId = db
                .prepare("PRAGMA table_info(projects)")
                .all()
                .some((column) => column.name === "canonical_project_id");
            const unbound = hasCanonicalId ? "AND canonical_project_id IS NULL" : "";
            const rows = db
                .prepare(
                    `SELECT id AS project_id, registered_root
                   FROM projects WHERE current_root = ? AND lifecycle <> 'removed' ${unbound}`,
                )
                .all(canonicalRoot);
            ids = [
                ...new Set(
                    rows.flatMap(({ project_id: id, registered_root: registeredRoot }) => {
                        if (typeof id !== "string" || !isProjectId(id) || typeof registeredRoot !== "string") return [];
                        try {
                            return realpathSync.native(registeredRoot) === canonicalRoot ? [id] : [];
                        } catch {
                            return [];
                        }
                    }),
                ),
            ];
        } finally {
            db.close();
        }
    } catch {
        // The owner database is optional for local Core entry.
        return;
    }
    if (ids.length > 1) throw new Error(`Conflicting Project registrations for ${canonicalRoot}`);
    return ids[0];
}
