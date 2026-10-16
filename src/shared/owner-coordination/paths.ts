/**
 * @module shared/owner-coordination/paths
 * Path helpers for the owner-only coordination database.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHomeDir } from "../../constants.js";

export const OWNER_COORDINATION_DB_FILENAME = "owner-coordination.sqlite3";

export interface OwnerCoordinationPathOptions {
    home?: string;
}

/**
 * Resolve the default owner database path at call time.
 *
 * @param options
 */
export function getOwnerCoordinationDatabasePath(options: OwnerCoordinationPathOptions = {}) {
    const home = options.home || getHomeDir() || "~";
    return join(home, ".wld", OWNER_COORDINATION_DB_FILENAME);
}

/**
 * Ensure the parent directory for an on-disk owner database exists.
 *
 * @param dbPath
 */
export function ensureOwnerDatabaseDirectory(dbPath: string) {
    if (!dbPath || dbPath === ":memory:") return;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    try {
        chmodSync(dirname(dbPath), 0o700);
    } catch {
        // Some filesystems do not support chmod; creation mode remains best effort.
    }
}
