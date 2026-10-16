/** @module shared/workspace-search-refresh */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "../constants.js";

function refreshDirectory() {
    return join(getHomeDir(), ".runwield-workspace-search-refresh");
}

/**
 * Marker path for one Project root. Writers and the owner service can hold
 * different spellings of the same root (symlinks, `/var` versus
 * `/private/var`), so the key is derived from the canonical real path.
 * @param {string} root
 */
export async function getWorkspaceSearchRefreshMarker(root: string) {
    let canonical = root;
    try {
        canonical = await realpath(root);
    } catch {
        // An unresolvable root still gets a stable marker key.
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const key = [...new Uint8Array(digest)].slice(0, 16)
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return join(refreshDirectory(), key);
}

/**
 * Request an early rebuild of derived Workspace search data. Canonical writes
 * stay successful when Workspace is not running or the marker cannot be written.
 * @param {string} root
 */
export async function requestWorkspaceSearchRefresh(root: string) {
    try {
        const path = await getWorkspaceSearchRefreshMarker(root);
        await mkdir(refreshDirectory(), { recursive: true });
        await writeFile(path, `${Date.now()}\n`);
    } catch {
        // Search is derived data. The bounded background scan remains the fallback.
    }
}
