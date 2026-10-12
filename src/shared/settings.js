import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import lockfile from "proper-lockfile";
import { normalizePlanServerUrl } from "./collaboration/urls.ts";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout.ts";
import { getCwd, getHomeDir } from "../constants.js";
import { getBundledModelPresets } from "./model-presets.ts";
import { remoteSettingsSnapshot, updateRemoteGlobalSetting } from "./remote/settings-bridge.ts";
import {
    assertPersonalResourcePathSync,
    personalGlobalRoot,
    remotePersonalResourcesActive,
} from "./remote/personal-resources.ts";

export const PLAN_SERVER_URL_SETTING_KEY = "planServerUrl";
export const ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY = "onboardingTutorialOfferHandled";

/** @type {Map<string, string>} */
const projectSettingsRootMemo = new Map();

/** @type {Map<string, boolean>} */
const mascotEnabledCache = new Map();

/** Clear cached visibility after settings reloads or writes. */
export function clearMascotEnabledCache() {
    mascotEnabledCache.clear();
}

/**
 * Only a literal false disables the mascot. Reads are cached for animation renders.
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function isMascotEnabled(projectRoot) {
    const cached = mascotEnabledCache.get(projectRoot);
    if (cached !== undefined) return cached;
    const enabled = getMergedCustomSetting("mascot", projectRoot) !== false;
    mascotEnabledCache.set(projectRoot, enabled);
    return enabled;
}

const RUNWIELD_CUSTOM_SETTING_KEYS = [
    "agents",
    "activeModelPreset",
    "modelPresets",
    "visionFallback",
    "imageGeneration",
    "compactOnResumeThresholdPercent",
    "verification_command",
    "codereview",
    "guidedReview",
    "cleanupMergedWorktrees",
    "workflowMetrics",
    "workRecords",
    "plans",
    "notifications",
    "mascot",
    "nonGitExecutionConsent",
    "enableExternalSkills",
    "enableExternalGlobalAgentsMd",
    ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY,
    PLAN_SERVER_URL_SETTING_KEY,
];

/**
 * Get the settings directory path for a given scope.
 *
 * @param {string} scope
 * @param {string} [projectRoot]
 *
 * @returns {string}
 */
export function getSettingsDir(scope, projectRoot = getCwd()) {
    if (scope === "global") return personalGlobalRoot();
    let resolvedRoot = projectSettingsRootMemo.get(projectRoot);
    if (!resolvedRoot) {
        resolvedRoot = resolvePrimaryCheckoutRoot(projectRoot);
        projectSettingsRootMemo.set(projectRoot, resolvedRoot);
    }
    return join(resolvedRoot, ".wld");
}

/**
 * Get the project settings directory exactly under the supplied root.
 * This bypasses primary-checkout resolution for validation worktrees.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function getExactProjectSettingsDir(projectRoot) {
    return join(projectRoot, ".wld");
}

/**
 * @param {string} projectRoot
 * @returns {string}
 */
function getExactProjectSettingsPath(projectRoot) {
    return join(getExactProjectSettingsDir(projectRoot), "settings.json");
}

/**
 * RunWield custom storage for SettingsManager.
 *
 * Implementation Details:
 * - Global Scope:
 *     - Read: uses ~/.wld/settings.json only.
 *     - Migration: if ~/.wld/settings.json is missing, copies once from ~/.pi/agent/settings.json.
 *     - Write: always writes to ~/.wld/settings.json.
 * - Project Scope:
 *     - Read/Write: use <primary checkout>/.wld/settings.json when the project root is a linked worktree.
 *       Other roots use <projectRoot>/.wld/settings.json unchanged.
 */
/**
 * @param {string} path
 * @returns {boolean}
 */
function fileExists(path) {
    try {
        return Deno.statSync(path).isFile;
    } catch {
        return false;
    }
}

/**
 * Acquire a sync lock with retry on ELOCKED, mirroring upstream
 * FileSettingsStorage behavior.
 *
 * @param {string} path
 * @returns {() => void}
 */
function acquireSettingsLockSyncWithRetry(path) {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return lockfile.lockSync(path, { realpath: false });
        } catch (error) {
            const code = (error && typeof error === "object" && "code" in error) ? String(error.code) : undefined;
            if (code !== "ELOCKED" || attempt === maxAttempts) {
                throw error;
            }
            lastError = error;
            const start = Date.now();
            while (Date.now() - start < delayMs) { /* busy-wait */ }
        }
    }

    throw lastError ?? new Error("Failed to acquire settings lock");
}

/**
 * Ensure a settings file exists before acquiring a proper-lockfile lock.
 *
 * @param {string} path
 */
function ensureSettingsFileForLock(path) {
    try {
        Deno.statSync(path);
    } catch (_e) {
        const parentDir = dirname(path);
        try {
            Deno.mkdirSync(parentDir, { recursive: true });
        } catch (_e2) { /* ignore */ }
        Deno.writeTextFileSync(path, "{}");
    }
}

/**
 * @param {string} path
 * @returns {string | undefined}
 */
function readSettingsContent(path) {
    try {
        const raw = Deno.readTextFileSync(path);
        return stripJsoncComments(raw);
    } catch (_e) {
        return undefined;
    }
}

/**
 * @param {string} path
 * @param {string} content
 */
function writeSettingsContent(path, content) {
    const parentDir = dirname(path);
    try {
        Deno.mkdirSync(parentDir, { recursive: true });
    } catch (_e) { /* ignore */ }

    Deno.writeTextFileSync(path, content);
}

/**
 * One-time import of legacy Pi settings into RunWield-owned settings.
 * Existing RunWield settings always win; Pi is never used as a runtime fallback.
 *
 * @param {{ homeDir?: string, runwieldPath?: string, piPath?: string }} [options]
 * @returns {{ copied: boolean, skipped: boolean, error?: string }}
 */
export function migratePiSettingsOnce(options = {}) {
    const homeDir = options.homeDir ?? getHomeDir();
    const runwieldPath = options.runwieldPath ?? join(homeDir, ".wld", "settings.json");
    const piPath = options.piPath ?? join(homeDir, ".pi", "agent", "settings.json");

    if (fileExists(runwieldPath) || !fileExists(piPath)) {
        return { copied: false, skipped: true };
    }

    try {
        Deno.mkdirSync(dirname(runwieldPath), { recursive: true });
        Deno.copyFileSync(piPath, runwieldPath);
        return { copied: true, skipped: false };
    } catch (error) {
        return { copied: false, skipped: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** @typedef {Record<string, unknown>} GlobalSettingsValues */

/** Return the laptop settings without using a mounted remote path. */
export function readLaptopGlobalSettingsSnapshot() {
    const path = join(getHomeDir(), ".wld", "settings.json");
    migratePiSettingsOnce({ runwieldPath: path });
    if (!fileExists(path)) return "{}";
    const release = acquireSettingsLockSyncWithRetry(path);
    try {
        return readSettingsContent(path) ?? "{}";
    } finally {
        release();
    }
}

/**
 * Apply one structured change under the laptop's own settings lock.
 * @param {import('./remote/settings-bridge.ts').SettingsUpdate} update
 * @returns {string} The committed snapshot.
 */
export function applyLaptopGlobalSettingsUpdate(update) {
    if (remotePersonalResourcesActive()) throw new Error("Laptop settings writer cannot use a remote mount");
    const path = join(getHomeDir(), ".wld", "settings.json");
    migratePiSettingsOnce({ runwieldPath: path });
    ensureSettingsFileForLock(path);
    const release = acquireSettingsLockSyncWithRetry(path);
    try {
        const content = readSettingsContent(path);
        /** @type {GlobalSettingsValues} */
        let parsed = {};
        if (content) parsed = /** @type {GlobalSettingsValues} */ (parseJsonc(content));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid laptop settings");
        if (update.kind === "set") parsed[update.key] = update.value;
        else if (update.kind === "model") {
            parsed.defaultModel = update.model;
            parsed.defaultProvider = update.provider;
        } else {
            const prior = parsed.compaction;
            parsed.compaction = {
                ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
                [update.key]: update.value,
            };
        }
        const snapshot = JSON.stringify(parsed, null, 2);
        writeSettingsContent(path, snapshot);
        return snapshot;
    } finally {
        release();
    }
}

class RunWieldSettingsStorage {
    /** @param {string} [projectRoot] */
    constructor(projectRoot = getCwd()) {
        this.projectRoot = projectRoot;
    }

    /**
     * Resolves the path for a given scope.
     * @param {"global" | "project"} scope
     * @returns {string}
     */
    #resolvePath(scope) {
        return getSettingsDir(scope, this.projectRoot) + "/settings.json";
    }

    /**
     * Read settings file content, stripping JSONC comments/trailing commas
     * so callers (Pi's SettingsManager, custom setters) receive valid JSON.
     * @param {"global" | "project"} scope
     * @returns {string | undefined}
     */
    #readSettings(scope) {
        const path = this.#resolvePath(scope);
        if (scope === "global" && !remotePersonalResourcesActive()) {
            migratePiSettingsOnce({ runwieldPath: path });
        }
        if (scope === "global" && remotePersonalResourcesActive()) {
            assertPersonalResourcePathSync(path, "global settings");
        }
        const content = readSettingsContent(path);
        if (scope === "global" && remotePersonalResourcesActive()) {
            // The reader treats a failed file read as absent; detect detach
            // during that read before returning an empty or cached snapshot.
            assertPersonalResourcePathSync(path, "global settings");
            return remoteSettingsSnapshot(content);
        }
        return content;
    }

    /**
     * Logic for writing settings.
     * @param {"global" | "project"} scope
     * @param {string} content
     */
    #writeSettings(scope, content) {
        const path = this.#resolvePath(scope);

        writeSettingsContent(path, content);
    }

    /**
     * Implement the lock interface expected by SettingsManager. Must be
     * synchronous: SettingsManager calls this without awaiting.
     * @param {"global" | "project"} scope
     * @param {(content: string | undefined) => string | undefined} callback
     */
    withLock(scope, callback) {
        const path = this.#resolvePath(scope);

        const content = this.#readSettings(scope);
        let newContent = callback(content);
        if (newContent !== undefined) {
            newContent = preserveRunWieldCustomSettingsForWrite(content, newContent);
        }
        if (newContent !== undefined && newContent !== content) {
            if (scope === "global" && remotePersonalResourcesActive()) {
                throw new Error("Remote global settings writes require the laptop settings service");
            }
            // Ensure the file exists before locking; proper-lockfile requires the
            // target to exist.
            ensureSettingsFileForLock(path);

            const release = acquireSettingsLockSyncWithRetry(path);
            try {
                // The first read can be stale. Recompute under the local lock.
                const current = this.#readSettings(scope);
                const changed = callback(current);
                const next = changed === undefined
                    ? undefined
                    : preserveRunWieldCustomSettingsForWrite(current, changed);
                if (next !== undefined && next !== current) this.#writeSettings(scope, next);
            } finally {
                release();
            }
        }
    }
}

/** @type {RunWieldSettingsStorage | null} */
let storageInstance = null;

/** @type {Map<string, RunWieldSettingsStorage>} */
const projectStorageInstances = new Map();

/** @type {Map<string, SettingsManager>} */
const projectSettingsManagers = new Map();

/** @type {Map<string, SettingsManager>} */
const remoteManagerHandles = new Map();

/** @type {Map<string, string | undefined>} */
const remoteManagerSnapshots = new Map();

/**
 * Pi's reload() awaits its write queue, but its getters are synchronous. Keep
 * the caller's manager reference stable while replacing the loaded manager
 * when the laptop's mounted snapshot or acknowledged receipt changes.
 * @param {string} projectRoot
 */
function refreshRemoteSettingsManager(projectRoot) {
    if (!remotePersonalResourcesActive()) return;
    const snapshot = readRemoteSettingsSnapshot();
    if (remoteManagerSnapshots.get(projectRoot) === snapshot) return;
    const manager = SettingsManager.fromStorage(getSettingsStorage(projectRoot));
    manager.getCacheWarmingMode = () => "off";
    projectSettingsManagers.set(projectRoot, manager);
    remoteManagerSnapshots.set(projectRoot, snapshot);
}

/**
 * Initializes a settings manager for the requested project root.
 *
 * @param {string} [projectRoot]
 */
export function initSettings(projectRoot = getCwd()) {
    if (!projectSettingsManagers.has(projectRoot)) {
        const storage = new RunWieldSettingsStorage(projectRoot);
        const manager = SettingsManager.fromStorage(storage);
        // Pi 0.87 reads cache warming directly from global settings, so its
        // ordinary override API cannot enforce RunWield's no-warming policy.
        // Keep the policy in memory and do not rewrite the user's settings.
        manager.getCacheWarmingMode = () => "off";
        projectStorageInstances.set(projectRoot, storage);
        projectSettingsManagers.set(projectRoot, manager);
        if (remotePersonalResourcesActive()) {
            remoteManagerSnapshots.set(projectRoot, readRemoteSettingsSnapshot());
            // A held Pi manager must see later laptop writes without an async
            // reload or another call to getSettingsManager(). Forward both
            // property reads and method calls to the latest loaded manager.
            remoteManagerHandles.set(
                projectRoot,
                new Proxy(manager, {
                    get(_target, property) {
                        refreshRemoteSettingsManager(projectRoot);
                        const current = /** @type {SettingsManager} */ (projectSettingsManagers.get(projectRoot));
                        const value = Reflect.get(current, property, current);
                        if (typeof value !== "function") return value;
                        /** @param {unknown[]} args */
                        return (...args) => {
                            refreshRemoteSettingsManager(projectRoot);
                            const live = /** @type {SettingsManager} */ (projectSettingsManagers.get(projectRoot));
                            return Reflect.apply(Reflect.get(live, property, live), live, args);
                        };
                    },
                    set(_target, property, value) {
                        refreshRemoteSettingsManager(projectRoot);
                        const current = /** @type {SettingsManager} */ (projectSettingsManagers.get(projectRoot));
                        return Reflect.set(current, property, value, current);
                    },
                }),
            );
        }
    }
    storageInstance = /** @type {RunWieldSettingsStorage} */ (projectStorageInstances.get(projectRoot));
}

/**
 * Provides the SettingsManager singleton.
 * @param {string} [projectRoot]
 * @returns {SettingsManager}
 */
export function getSettingsManager(projectRoot = getCwd()) {
    if (!projectSettingsManagers.has(projectRoot)) initSettings(projectRoot);
    refreshRemoteSettingsManager(projectRoot);
    return /** @type {SettingsManager} */ (
        remoteManagerHandles.get(projectRoot) ?? projectSettingsManagers.get(projectRoot)
    );
}

/** @returns {string | undefined} */
function readRemoteSettingsSnapshot() {
    const path = join(personalGlobalRoot(), "settings.json");
    // A missing file is optional only while the activated root is still mounted.
    assertPersonalResourcePathSync(path, "global settings");
    let content;
    try {
        content = Deno.readTextFileSync(path);
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        // An initialized global profile can have no settings.json yet. Recheck
        // the root after the failed read so detach during the read fails closed.
        assertPersonalResourcePathSync(path, "global settings");
        content = "{}";
    }
    return remoteSettingsSnapshot(stripJsoncComments(content));
}

/**
 * @param {string} projectRoot
 * @returns {RunWieldSettingsStorage}
 */
function getSettingsStorage(projectRoot) {
    if (!projectStorageInstances.has(projectRoot)) initSettings(projectRoot);
    return /** @type {RunWieldSettingsStorage} */ (projectStorageInstances.get(projectRoot));
}

/**
 * Test-only escape hatch for tests that need to change HOME or cwd before
 * exercising settings-backed behavior.
 */
export function __resetSettingsForTests() {
    clearMascotEnabledCache();
    storageInstance = null;
    projectStorageInstances.clear();
    projectSettingsManagers.clear();
    remoteManagerHandles.clear();
    remoteManagerSnapshots.clear();
    projectSettingsRootMemo.clear();
}

/**
 * Strip JSONC comments/trailing commas from a raw string, producing valid JSON.
 * Uses @std/jsonc parse then re-serializes for callers that expect clean JSON.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripJsoncComments(raw) {
    try {
        const parsed = parseJsonc(raw);
        return JSON.stringify(parsed);
    } catch {
        // If JSONC parse fails, return original — let the caller's JSON.parse
        // throw with the real error message.
        return raw;
    }
}

/**
 * Preserve RunWield custom settings when Pi's SettingsManager writes its known
 * schema back to disk. Without this, operations like changing theme/model can
 * silently drop RunWield-only keys such as `modelPresets`.
 *
 * @param {string | undefined} previousContent
 * @param {string} nextContent
 * @returns {string}
 */
export function preserveRunWieldCustomSettingsForWrite(previousContent, nextContent) {
    if (!previousContent) return nextContent;

    try {
        const previous = /** @type {Record<string, any>} */ (parseJsonc(previousContent));
        const next = /** @type {Record<string, any>} */ (parseJsonc(nextContent));
        if (
            !previous || typeof previous !== "object" || Array.isArray(previous) ||
            !next || typeof next !== "object" || Array.isArray(next)
        ) {
            return nextContent;
        }

        let changed = false;
        for (const key of RUNWIELD_CUSTOM_SETTING_KEYS) {
            if (
                Object.prototype.hasOwnProperty.call(previous, key) && !Object.prototype.hasOwnProperty.call(next, key)
            ) {
                next[key] = previous[key];
                changed = true;
            }
        }

        return changed ? JSON.stringify(next, null, 2) : nextContent;
    } catch {
        return nextContent;
    }
}

/**
 * Safely reads a custom key from the underlying JSON file, bypassing SettingsManager types.
 * Content is parsed as JSONC (comments/trailing commas tolerated).
 * @param {string} key
 * @param {"global" | "project"} scope
 * @param {string} [projectRoot]
 * @returns {any}
 */
export function getCustomSetting(key, scope = "project", projectRoot = getCwd()) {
    const storage = getSettingsStorage(projectRoot);
    let result = undefined;

    storage.withLock(scope, (content) => {
        if (content) {
            try {
                const parsed = /** @type {Record<string, any>} */ (parseJsonc(content));
                result = parsed[key];
            } catch (_e) { /* ignore */ }
        }

        return undefined; // Return undefined to signify no file changes
    });

    return result;
}

/**
 * Safely writes a custom key to the underlying JSON file, bypassing SettingsManager types,
 * and forces the SettingsManager to sync its in-memory state.
 *
 * Output is always normalized JSON (no comments).
 *
 * @param {string} key
 * @param {any} value
 * @param {"global" | "project"} scope
 * @param {string} [projectRoot]
 */
export async function setCustomSetting(key, value, scope = "project", projectRoot = getCwd()) {
    clearMascotEnabledCache();
    if (scope === "global" && remotePersonalResourcesActive()) {
        await updateRemoteGlobalSetting({ kind: "set", key, value });
        await getSettingsManager(projectRoot).reload();
        clearMascotEnabledCache();
        return;
    }
    const storage = getSettingsStorage(projectRoot);

    storage.withLock(scope, (content) => {
        let parsed = /** @type {Record<string, any>} */ ({});
        if (content) {
            try {
                parsed = /** @type {Record<string, any>} */ (parseJsonc(content));
            } catch (_e) { /* ignore */ }
        }
        parsed[key] = value;

        return JSON.stringify(parsed, null, 2);
    });

    // Force Pi's manager to reload from disk so it doesn't accidentally
    // overwrite our custom key during its next flush() operation.
    await getSettingsManager(projectRoot).reload();
    clearMascotEnabledCache();
}

/**
 * Safely reads a custom key from exactly `<projectRoot>/.wld/settings.json`.
 * This bypasses primary-checkout resolution and parses the on-disk file each time.
 *
 * @param {string} key
 * @param {string} projectRoot
 * @returns {unknown}
 */
export function getExactProjectCustomSetting(key, projectRoot) {
    const content = readSettingsContent(getExactProjectSettingsPath(projectRoot));
    if (!content) return undefined;

    try {
        const parsed = /** @type {Record<string, unknown>} */ (parseJsonc(content));
        return parsed[key];
    } catch (_e) {
        return undefined;
    }
}

/**
 * Safely writes a custom key to exactly `<projectRoot>/.wld/settings.json`.
 * Output is always normalized JSON (no comments), matching ordinary custom writes.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {string} projectRoot
 */
export function setExactProjectCustomSetting(key, value, projectRoot) {
    clearMascotEnabledCache();
    const path = getExactProjectSettingsPath(projectRoot);
    ensureSettingsFileForLock(path);

    const release = acquireSettingsLockSyncWithRetry(path);
    try {
        const content = readSettingsContent(path);
        let parsed = /** @type {Record<string, unknown>} */ ({});
        if (content) {
            try {
                parsed = /** @type {Record<string, unknown>} */ (parseJsonc(content));
            } catch (_e) { /* ignore */ }
        }
        parsed[key] = value;
        const nextContent = preserveRunWieldCustomSettingsForWrite(content, JSON.stringify(parsed, null, 2));
        writeSettingsContent(path, nextContent);
    } finally {
        release();
    }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function validatePositiveIntegerSetting(value, label) {
    const numberValue = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (!Number.isInteger(numberValue) || /** @type {number} */ (numberValue) < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return /** @type {number} */ (numberValue);
}

/**
 * Persist the two parts of a remote model default in one laptop transaction.
 * @param {string} projectRoot
 * @param {string} model
 * @param {string} provider
 */
export async function setRemoteDefaultModelSelection(projectRoot, model, provider) {
    if (!remotePersonalResourcesActive()) throw new Error("Remote model settings require a remote connection");
    await updateRemoteGlobalSetting({ kind: "model", model, provider });
    await getSettingsManager(projectRoot).reload();
}

/**
 * Safely updates one numeric global compaction setting while preserving siblings.
 * @param {"enabled" | "reserveTokens" | "keepRecentTokens"} key
 * @param {boolean | number} value
 */
export async function setGlobalCompactionSetting(key, value) {
    if (remotePersonalResourcesActive()) {
        await updateRemoteGlobalSetting({ kind: "compaction", key, value });
        await getSettingsManager().reload();
        return;
    }
    if (!storageInstance) initSettings();

    // @ts-ignore storageInstance is definitely assigned here
    storageInstance.withLock("global", (content) => {
        let parsed = /** @type {Record<string, any>} */ ({});
        if (content) {
            try {
                parsed = /** @type {Record<string, any>} */ (parseJsonc(content));
            } catch (_e) { /* ignore */ }
        }

        const existing = parsed.compaction;
        const compaction = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        parsed.compaction = { ...compaction, [key]: value };

        return JSON.stringify(parsed, null, 2);
    });

    await getSettingsManager().reload();
}

/**
 * Set the global compaction reserve token budget.
 * @param {unknown} value
 */
export async function setCompactionReserveTokens(value) {
    await setGlobalCompactionSetting("reserveTokens", validatePositiveIntegerSetting(value, "Reserve tokens"));
}

/**
 * Set the global compaction keep-recent token window.
 * @param {unknown} value
 */
export async function setCompactionKeepRecentTokens(value) {
    await setGlobalCompactionSetting("keepRecentTokens", validatePositiveIntegerSetting(value, "Keep recent tokens"));
}

/**
 * Merged custom key lookup: reads a key from both global and project scopes
 * and returns the value with project scope taking precedence.
 *
 * For object-valued keys (e.g. `agents`, `modelPresets`), project values
 * override global values at the top level. Model presets also include bundled
 * defaults, with a same-name user preset replacing the bundled definition.
 * For scalar keys, project value wins if present.
 *
 * @param {string} key
 * @param {string} [projectRoot]
 * @returns {any} Merged value from global + project scopes, or undefined if neither has it.
 */
export function getMergedCustomSetting(key, projectRoot = getCwd()) {
    const globalVal = getCustomSetting(key, "global", projectRoot);
    const projectVal = getCustomSetting(key, "project", projectRoot);

    if (key === "modelPresets") {
        return { ...getBundledModelPresets(), ...globalVal, ...projectVal };
    }

    if (globalVal === undefined && projectVal === undefined) return undefined;
    if (globalVal === undefined) return projectVal;
    if (projectVal === undefined) return globalVal;

    // Both present: merge if both are plain objects, otherwise project wins.
    if (
        typeof globalVal === "object" && globalVal !== null && !Array.isArray(globalVal) &&
        typeof projectVal === "object" && projectVal !== null && !Array.isArray(projectVal)
    ) {
        return { ...globalVal, ...projectVal };
    }

    return projectVal;
}

/**
 * @returns {string | undefined}
 */
export function getDefaultPlanServerUrl() {
    const value = getMergedCustomSetting(PLAN_SERVER_URL_SETTING_KEY);
    if (value === undefined) return undefined;
    return normalizePlanServerUrl(value);
}

/**
 * @param {unknown} value
 * @param {"global" | "project"} [scope]
 */
export async function setDefaultPlanServerUrl(value, scope = "project") {
    await setCustomSetting(PLAN_SERVER_URL_SETTING_KEY, normalizePlanServerUrl(value), scope);
}

/**
 * Whether merged execution worktrees should be removed after successful merge-back.
 * Defaults to true; set `cleanupMergedWorktrees: false` in global or project
 * settings to keep merged worktree checkouts for inspection.
 *
 * @returns {boolean}
 */
/**
 * Resolve the configured vision fallback model string.
 *
 * Resolution order:
 * 1. Active preset `modelPresets.<activeModelPreset>.visionFallback.model`
 * 2. Top-level `visionFallback.model`
 * 3. Disabled when unset or not a string
 *
 * @param {string} projectRoot
 * @returns {string | undefined}
 */
export function getResolvedVisionFallbackModelSetting(projectRoot) {
    const activeModelPreset =
        /** @type {string | undefined} */ (getMergedCustomSetting("activeModelPreset", projectRoot));
    if (activeModelPreset) {
        const modelPresets = /** @type {Record<string, { visionFallback?: { model?: unknown } }> | undefined} */ (
            getMergedCustomSetting("modelPresets", projectRoot)
        );
        const presetModel = modelPresets?.[activeModelPreset]?.visionFallback?.model;
        if (typeof presetModel === "string" && presetModel.trim()) return presetModel.trim();
    }

    const visionFallback =
        /** @type {{ model?: unknown } | undefined} */ (getMergedCustomSetting("visionFallback", projectRoot));
    const model = visionFallback?.model;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

/**
 * Whether merged execution worktrees should be removed after successful merge-back.
 * Defaults to true; set `cleanupMergedWorktrees: false` in global or project
 * settings to keep merged worktree checkouts for inspection.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function shouldCleanupMergedWorktrees(projectRoot) {
    if (!projectRoot) throw new Error("shouldCleanupMergedWorktrees: projectRoot is required");
    return getMergedCustomSetting("cleanupMergedWorktrees", projectRoot) !== false;
}

/**
 * Whether completed top-level Plans should automatically generate or reconcile Work Records.
 * Defaults to true; only a literal nested `workRecords.autoGenerateOnPlanCompletion: false` disables it.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function shouldAutoGenerateWorkRecordsOnPlanCompletion(projectRoot) {
    if (!projectRoot) throw new Error("shouldAutoGenerateWorkRecordsOnPlanCompletion: projectRoot is required");
    const workRecords = getMergedCustomSetting("workRecords", projectRoot);
    if (!workRecords || typeof workRecords !== "object" || Array.isArray(workRecords)) return true;
    return workRecords.autoGenerateOnPlanCompletion !== false;
}

/**
 * Whether standalone Planned Changes merge into their authored target branch.
 * Defaults to false: deliver to a Plan Branch instead.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function shouldAutoMergePlansIntoTargetBranch(projectRoot) {
    if (!projectRoot) throw new Error("shouldAutoMergePlansIntoTargetBranch: projectRoot is required");
    const plans = getMergedCustomSetting("plans", projectRoot);
    return Boolean(
        plans && typeof plans === "object" && !Array.isArray(plans) &&
            plans.autoMergeIntoTargetBranch === true,
    );
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {number}
 */
function validateNonNegativeIntegerSetting(value, key) {
    const numberValue = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (!Number.isInteger(numberValue) || /** @type {number} */ (numberValue) < 0) {
        throw new Error(`${key} must be an integer of zero or more.`);
    }
    return /** @type {number} */ (numberValue);
}

/**
 * Resolve archived Plan retention policy from project settings only.
 *
 * @param {string} projectRoot
 * @returns {{ retentionDays: number, keepLast: number }}
 */
export function getPlanArchiveRetentionPolicy(projectRoot) {
    if (!projectRoot) throw new Error("getPlanArchiveRetentionPolicy: projectRoot is required");
    const plans = getCustomSetting("plans", "project", projectRoot);
    if (!plans || typeof plans !== "object" || Array.isArray(plans)) {
        return { retentionDays: 14, keepLast: 10 };
    }
    const retentionDays = Object.prototype.hasOwnProperty.call(plans, "archiveRetentionDays")
        ? validateNonNegativeIntegerSetting(plans.archiveRetentionDays, "plans.archiveRetentionDays")
        : 14;
    const keepLast = Object.prototype.hasOwnProperty.call(plans, "archiveKeepLast")
        ? validateNonNegativeIntegerSetting(plans.archiveKeepLast, "plans.archiveKeepLast")
        : 10;
    return { retentionDays, keepLast };
}

/**
 * Resolve the optional human code review gate mode.
 *
 * @param {string} projectRoot
 * @returns {"none" | "ask" | "always"}
 */
export function getCodeReviewMode(projectRoot) {
    if (!projectRoot) throw new Error("getCodeReviewMode: projectRoot is required");
    const mode = getMergedCustomSetting("codereview", projectRoot);
    if (mode === undefined) return "ask";
    if (typeof mode !== "string") return "none";

    const normalized = mode.trim().toLowerCase();
    if (normalized === "ask" || normalized === "always") return normalized;
    return "none";
}

/**
 * Resolve the optional Guided Review generation mode.
 *
 * @param {string} projectRoot
 * @returns {"none" | "ask" | "auto" | "always"}
 */
export function getGuidedReviewMode(projectRoot) {
    if (!projectRoot) throw new Error("getGuidedReviewMode: projectRoot is required");
    const mode = getMergedCustomSetting("guidedReview", projectRoot);
    if (mode === undefined) return "auto";
    if (typeof mode !== "string") return "none";

    const normalized = mode.trim().toLowerCase();
    if (normalized === "none" || normalized === "ask" || normalized === "auto" || normalized === "always") {
        return normalized;
    }
    return "none";
}
