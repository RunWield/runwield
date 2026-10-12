import { mkdirSync, writeFileSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
/**
 * @module cmd/init/init-state
 * Global state module for tracking init status per project.
 *
 * State is stored in ~/.wld/init-state.json, keyed by SHA-256(CWD).
 * This allows the init command to warn on re-runs and the TUI to
 * conditionally hide `/init` from autocomplete once done.
 */

import { dirname, join } from "node:path";
import { getCwd, getHomeDir } from "../../constants.js";

interface InitStateEntry {
    path: string;
    initOffered: boolean;
    initDone: boolean;
    offeredAt: string | null;
    doneAt: string | null;
    snipMissingWarningCount?: number;
    snipMissingWarningLastShownAt?: string | null;
}

type InitState = Record<string, InitStateEntry>;

// Set only by _setTestStatePath. The resolved home path is deliberately not
// memoized here: HOME can change after this module loads, and caching it once
// pinned this file to whichever home happened to be current at import time.
let STATE_PATH: string | null = null;

/**
 * Allow tests to override the state file path.
 * @param {string | null} path
 */
export function _setTestStatePath(path: string | null): void {
    STATE_PATH = path;
}

/**
 * Resolve the path to the global init-state file.
 * @returns {string}
 */
function getStatePath(): string {
    if (STATE_PATH) return STATE_PATH;
    return join(getHomeDir(), ".wld", "init-state.json");
}

/**
 * Compute SHA-256 hex digest of a string.
 * @param {string} input
 * @returns {Promise<string>}
 */
async function sha256(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return hex;
}

/**
 * Read the full state file from disk.
 * Returns an empty object if the file does not exist or is invalid.
 */
async function readState(): Promise<InitState> {
    const path = getStatePath();
    try {
        const raw = await fsReadFile(path, "utf8");
        const parsed: InitState = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    } catch (_e) {
        return {};
    }
}

/**
 * Write the full state file to disk (synchronous after init completes).
 * @param {Record<string, InitStateEntry>} state
 */
function writeStateSync(state: InitState): void {
    const path = getStatePath();
    const dir = dirname(path);
    try {
        mkdirSync(dir, { recursive: true });
    } catch (_e) {
        // directory already exists or cannot be created; proceed
    }
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Get the SHA-256 hash of a project directory.
 * @returns {Promise<string>}
 */
export async function getCwdHash(projectRoot = getCwd()): Promise<string> {
    return await sha256(projectRoot);
}

/**
 * Get the full init state object.
 * @returns {Promise<Record<string, InitStateEntry>>}
 */
export async function getInitState(): Promise<InitState> {
    return await readState();
}

/**
 * Get the init state entry for the current CWD.
 * @returns {Promise<InitStateEntry | undefined>}
 */
export async function getCwdInitState(projectRoot = getCwd()): Promise<InitStateEntry | undefined> {
    const cwdHash = await getCwdHash(projectRoot);
    const state = await readState();
    return state[cwdHash];
}

/**
 * Build a fresh entry for a given path.
 * @param {string} path
 * @returns {InitStateEntry}
 */
function newEntry(path: string): InitStateEntry {
    return {
        path,
        initOffered: false,
        initDone: false,
        offeredAt: null,
        doneAt: null,
        snipMissingWarningCount: 0,
        snipMissingWarningLastShownAt: null,
    };
}

/**
 * Read or create the current CWD state entry.
 *
 * @param {Record<string, InitStateEntry>} state
 * @returns {Promise<InitStateEntry>}
 */
async function ensureCwdEntry(state: InitState, projectRoot = getCwd()): Promise<InitStateEntry> {
    const cwdHash = await getCwdHash(projectRoot);
    if (!state[cwdHash]) {
        state[cwdHash] = newEntry(projectRoot);
    } else {
        state[cwdHash].path = projectRoot;
    }
    return state[cwdHash];
}

/**
 * Record that init was offered for the current CWD.
 * @returns {Promise<void>}
 */
export async function recordInitOffered(projectRoot = getCwd()): Promise<void> {
    const state = await readState();
    const entry = await ensureCwdEntry(state, projectRoot);
    entry.initOffered = true;
    entry.offeredAt = new Date().toISOString();
    writeStateSync(state);
}

/**
 * Record that init completed successfully for the current CWD.
 * Implicitly marks init as offered as well.
 * @returns {Promise<void>}
 */
export async function recordInitDone(projectRoot = getCwd()): Promise<void> {
    const state = await readState();
    const entry = await ensureCwdEntry(state, projectRoot);
    const now = new Date().toISOString();
    entry.initOffered = true;
    entry.initDone = true;
    if (!entry.offeredAt) entry.offeredAt = now;
    entry.doneAt = now;
    writeStateSync(state);
}

/**
 * Check whether init has been completed for the current CWD.
 * @returns {Promise<boolean>}
 */
export async function isInitDone(projectRoot = getCwd()): Promise<boolean> {
    const entry = await getCwdInitState(projectRoot);
    return entry?.initDone === true;
}

/**
 * Check whether init was ever offered for the current CWD.
 * @returns {Promise<boolean>}
 */
export async function isInitOffered(): Promise<boolean> {
    const entry = await getCwdInitState();
    return entry?.initOffered === true;
}

/**
 * Check whether RunWield should show the missing-Snip boot warning for this CWD.
 *
 * @param {number} [limit]
 * @returns {Promise<boolean>}
 */
export async function shouldShowSnipMissingWarning(limit = 3): Promise<boolean> {
    const entry = await getCwdInitState();
    return (entry?.snipMissingWarningCount || 0) < limit;
}

/**
 * Record that RunWield showed the missing-Snip boot warning for this CWD.
 *
 * @returns {Promise<void>}
 */
export async function recordSnipMissingWarningShown(): Promise<void> {
    const state = await readState();
    const entry = await ensureCwdEntry(state);
    entry.snipMissingWarningCount = (entry.snipMissingWarningCount || 0) + 1;
    entry.snipMissingWarningLastShownAt = new Date().toISOString();
    writeStateSync(state);
}
