import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { parse as parseJsonc, type JsonRecord, type JsonValue } from "./jsonc.ts";
import lockfile from "proper-lockfile";
import { normalizePlanServerUrl } from "./collaboration/urls.ts";
import { resolvePrimaryCheckoutRoot } from "./project-checkout.ts";
import { getCwd, getHomeDir } from "../constants.ts";
import { getBundledModelPresets, type ModelPresetsMap, type ModelPresetVisionFallback } from "./model-presets.ts";
import { remoteSettingsSnapshot, updateRemoteGlobalSetting, type SettingsUpdate } from "./remote/settings-bridge.ts";
import {
    assertPersonalResourcePathSync,
    personalGlobalRoot,
    remotePersonalResourcesActive,
} from "./remote/personal-resources.ts";

interface MigratePiSettingsOnceOptions {
    homeDir?: string;
    runwieldPath?: string;
    piPath?: string;
}

interface MigratePiSettingsOnceResult {
    copied: boolean;
    skipped: boolean;
    error?: string;
}

export interface ArchiveRetentionPolicy {
    retentionDays: number;
    keepLast: number;
}

export const PLAN_SERVER_URL_SETTING_KEY = "planServerUrl";
export const ONBOARDING_TUTORIAL_OFFER_HANDLED_SETTING_KEY = "onboardingTutorialOfferHandled";

export interface CustomSettingReadOptions {
    /** Report unreadable or malformed settings instead of treating them as absent. */
    strict?: boolean;
}

const projectSettingsRootMemo: Map<string, string> = new Map();

const mascotEnabledCache: Map<string, boolean> = new Map();

/** Clear cached visibility after settings reloads or writes. */
export function clearMascotEnabledCache() {
    mascotEnabledCache.clear();
}

/** Only a literal false disables the mascot. Reads are cached for animation renders. */
export function isMascotEnabled(projectRoot: string): boolean {
    const cached = mascotEnabledCache.get(projectRoot);
    if (cached !== undefined) return cached;
    const enabled = getMergedCustomSetting("mascot", projectRoot) !== false;
    mascotEnabledCache.set(projectRoot, enabled);
    return enabled;
}

const RUNWIELD_CUSTOM_SETTING_KEYS = [
    "agents",
    "connect",
    "activeModelPreset",
    "modelPresets",
    "visionFallback",
    "imageGeneration",
    "compactOnResumeThresholdPercent",
    "verification_command",
    "worktree_setup_command",
    "codereview",
    "guidedReview",
    "cleanupMergedWorktrees",
    "workflowMetrics",
    "metricsExport",
    "metricsExporterApprovals",
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

/** Get the settings directory path for a given scope. */
export function getSettingsDir(scope: string, projectRoot: string = getCwd()): string {
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
 */
function getExactProjectSettingsDir(projectRoot: string): string {
    return join(projectRoot, ".wld");
}

function getExactProjectSettingsPath(projectRoot: string): string {
    return join(getExactProjectSettingsDir(projectRoot), "settings.json");
}

function fileExists(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * Acquire a sync lock with retry on ELOCKED, mirroring upstream
 * FileSettingsStorage behavior.
 */
function acquireSettingsLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return lockfile.lockSync(path, { realpath: false });
        } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
            if (code !== "ELOCKED" || attempt === maxAttempts) {
                throw error;
            }
            lastError = error;
            const start = Date.now();
            while (Date.now() - start < delayMs) {
                /* busy-wait */
            }
        }
    }

    throw lastError ?? new Error("Failed to acquire settings lock");
}

/** Ensure a settings file exists before acquiring a proper-lockfile lock. */
function ensureSettingsFileForLock(path: string) {
    try {
        statSync(path);
    } catch (_e) {
        const parentDir = dirname(path);
        try {
            mkdirSync(parentDir, { recursive: true });
        } catch (_e2) {
            /* ignore */
        }
        writeFileSync(path, "{}");
    }
}

function readSettingsContent(path: string, strict: boolean = false): string | undefined {
    try {
        const raw = readFileSync(path, "utf8");
        return stripJsoncComments(raw);
    } catch (error) {
        if (strict && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        return undefined;
    }
}

function writeSettingsContent(path: string, content: string) {
    const parentDir = dirname(path);
    try {
        mkdirSync(parentDir, { recursive: true });
    } catch (_e) {
        /* ignore */
    }

    writeFileSync(path, content);
}

/**
 * One-time import of legacy Pi settings into RunWield-owned settings.
 * Existing RunWield settings always win; Pi is never used as a runtime fallback.
 */
export function migratePiSettingsOnce(options: MigratePiSettingsOnceOptions = {}): MigratePiSettingsOnceResult {
    const homeDir = options.homeDir ?? getHomeDir();
    const runwieldPath = options.runwieldPath ?? join(homeDir, ".wld", "settings.json");
    const piPath = options.piPath ?? join(homeDir, ".pi", "agent", "settings.json");

    if (fileExists(runwieldPath) || !fileExists(piPath)) {
        return { copied: false, skipped: true };
    }

    try {
        mkdirSync(dirname(runwieldPath), { recursive: true });
        copyFileSync(piPath, runwieldPath);
        return { copied: true, skipped: false };
    } catch (error) {
        return { copied: false, skipped: false, error: error instanceof Error ? error.message : String(error) };
    }
}

type SettingsScope = "global" | "project";

interface CustomSettingsValues {
    [key: string]: JsonValue | undefined;
}

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
 * The committed snapshot.
 */
export function applyLaptopGlobalSettingsUpdate(update: SettingsUpdate): string {
    if (remotePersonalResourcesActive()) throw new Error("Laptop settings writer cannot use a remote mount");
    const path = join(getHomeDir(), ".wld", "settings.json");
    migratePiSettingsOnce({ runwieldPath: path });
    ensureSettingsFileForLock(path);
    const release = acquireSettingsLockSyncWithRetry(path);
    try {
        const content = readSettingsContent(path);
        let parsed: JsonValue = {};
        if (content) parsed = parseJsonc(content);
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

type SettingsContentUpdate = (content: string | undefined) => string | undefined;

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
class RunWieldSettingsStorage {
    declare projectRoot: string;

    constructor(projectRoot: string = getCwd()) {
        this.projectRoot = projectRoot;
    }

    /** Resolves the path for a given scope. */
    #resolvePath(scope: SettingsScope): string {
        return getSettingsDir(scope, this.projectRoot) + "/settings.json";
    }

    /**
     * Read settings file content, stripping JSONC comments/trailing commas
     * so callers (Pi's SettingsManager, custom setters) receive valid JSON.
     */
    #readSettings(scope: SettingsScope, strict: boolean = false): string | undefined {
        const path = this.#resolvePath(scope);
        if (scope === "global" && !remotePersonalResourcesActive()) {
            migratePiSettingsOnce({ runwieldPath: path });
        }
        if (scope === "global" && remotePersonalResourcesActive()) {
            assertPersonalResourcePathSync(path, "global settings");
        }
        const content = readSettingsContent(path, strict);
        if (scope === "global" && remotePersonalResourcesActive()) {
            // The reader treats a failed file read as absent; detect detach
            // during that read before returning an empty or cached snapshot.
            assertPersonalResourcePathSync(path, "global settings");
            return remoteSettingsSnapshot(content);
        }
        return content;
    }

    /** Logic for writing settings. */
    #writeSettings(scope: SettingsScope, content: string) {
        const path = this.#resolvePath(scope);

        writeSettingsContent(path, content);
    }

    /**
     * Implement the lock interface expected by SettingsManager. Must be
     * synchronous: SettingsManager calls this without awaiting.
     */
    withLock(scope: SettingsScope, callback: SettingsContentUpdate, options: CustomSettingReadOptions = {}) {
        const path = this.#resolvePath(scope);

        const content = this.#readSettings(scope, options.strict);
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
                const next =
                    changed === undefined ? undefined : preserveRunWieldCustomSettingsForWrite(current, changed);
                if (next !== undefined && next !== current) this.#writeSettings(scope, next);
            } finally {
                release();
            }
        }
    }
}

let storageInstance: RunWieldSettingsStorage | null = null;

const projectStorageInstances: Map<string, RunWieldSettingsStorage> = new Map();

const projectSettingsManagers: Map<string, SettingsManager> = new Map();

const remoteManagerHandles: Map<string, SettingsManager> = new Map();

const remoteManagerSnapshots: Map<string, string | undefined> = new Map();

/**
 * Pi's reload() awaits its write queue, but its getters are synchronous. Keep
 * the caller's manager reference stable while replacing the loaded manager
 * when the laptop's mounted snapshot or acknowledged receipt changes.
 */
function refreshRemoteSettingsManager(projectRoot: string) {
    if (!remotePersonalResourcesActive()) return;
    const snapshot = readRemoteSettingsSnapshot();
    if (remoteManagerSnapshots.get(projectRoot) === snapshot) return;
    const manager = SettingsManager.fromStorage(getSettingsStorage(projectRoot));
    manager.getCacheWarmingMode = () => "off";
    projectSettingsManagers.set(projectRoot, manager);
    remoteManagerSnapshots.set(projectRoot, snapshot);
}

/** Initializes a settings manager for the requested project root. */
export function initSettings(projectRoot: string = getCwd()) {
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
                        const current = projectSettingsManagers.get(projectRoot)!;
                        // Inspect the loaded shape without reading the mount. A held
                        // method must refresh at invocation, not at capture as well.
                        if (typeof Reflect.get(current, property, current) === "function") {
                            return <Argument>(...args: Argument[]) => {
                                refreshRemoteSettingsManager(projectRoot);
                                const live = projectSettingsManagers.get(projectRoot)!;
                                return Reflect.apply(Reflect.get(live, property, live), live, args);
                            };
                        }
                        refreshRemoteSettingsManager(projectRoot);
                        const live = projectSettingsManagers.get(projectRoot)!;
                        return Reflect.get(live, property, live);
                    },
                    set(_target, property, value) {
                        refreshRemoteSettingsManager(projectRoot);
                        const current = projectSettingsManagers.get(projectRoot)!;
                        return Reflect.set(current, property, value, current);
                    },
                }),
            );
        }
    }
    storageInstance = projectStorageInstances.get(projectRoot)!;
}

/** Provides the SettingsManager singleton. */
export function getSettingsManager(projectRoot: string = getCwd()): SettingsManager {
    if (!projectSettingsManagers.has(projectRoot)) initSettings(projectRoot);
    // The proxy refreshes each value read, write, or method invocation itself.
    if (remoteManagerHandles.has(projectRoot)) {
        return remoteManagerHandles.get(projectRoot)!;
    }
    refreshRemoteSettingsManager(projectRoot);
    return projectSettingsManagers.get(projectRoot)!;
}

function readRemoteSettingsSnapshot(): string | undefined {
    const path = join(personalGlobalRoot(), "settings.json");
    // A missing file is optional only while the activated root is still mounted.
    assertPersonalResourcePathSync(path, "global settings");
    let content;
    try {
        content = readFileSync(path, "utf8");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        // An initialized global profile can have no settings.json yet. Recheck
        // the root after the failed read so detach during the read fails closed.
        assertPersonalResourcePathSync(path, "global settings");
        content = "{}";
    }
    return remoteSettingsSnapshot(stripJsoncComments(content));
}

function getSettingsStorage(projectRoot: string): RunWieldSettingsStorage {
    if (!projectStorageInstances.has(projectRoot)) initSettings(projectRoot);
    return projectStorageInstances.get(projectRoot)!;
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
 * Uses the shared JSONC parser then re-serializes for callers that expect clean JSON.
 */
function stripJsoncComments(raw: string): string {
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
 */
export function preserveRunWieldCustomSettingsForWrite(
    previousContent: string | undefined,
    nextContent: string,
): string {
    if (!previousContent) return nextContent;

    try {
        const previous = parseJsonc(previousContent);
        const next = parseJsonc(nextContent);
        if (
            !previous ||
            typeof previous !== "object" ||
            Array.isArray(previous) ||
            !next ||
            typeof next !== "object" ||
            Array.isArray(next)
        ) {
            return nextContent;
        }

        let changed = false;
        for (const key of RUNWIELD_CUSTOM_SETTING_KEYS) {
            if (
                Object.prototype.hasOwnProperty.call(previous, key) &&
                !Object.prototype.hasOwnProperty.call(next, key)
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
 */
export function getCustomSetting(
    key: string,
    scope: SettingsScope = "project",
    projectRoot: string = getCwd(),
    options: CustomSettingReadOptions = {},
): JsonValue | undefined {
    const storage = getSettingsStorage(projectRoot);
    let result: JsonValue | undefined = undefined;

    storage.withLock(
        scope,
        (content) => {
            if (content !== undefined) {
                try {
                    const parsed = parseJsonc(content) as JsonRecord;
                    if (options.strict && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
                        throw new SyntaxError("Settings must be a JSONC object.");
                    }
                    result = parsed[key];
                } catch (error) {
                    if (options.strict) throw error;
                }
            }

            return undefined; // Return undefined to signify no file changes
        },
        options,
    );

    return result;
}

/**
 * Safely writes a custom key to the underlying JSON file, bypassing SettingsManager types,
 * and forces the SettingsManager to sync its in-memory state.
 *
 * Output is always normalized JSON (no comments).
 */
export async function setCustomSetting(
    key: string,
    value: JsonValue | undefined,
    scope: SettingsScope = "project",
    projectRoot: string = getCwd(),
) {
    clearMascotEnabledCache();
    if (scope === "global" && remotePersonalResourcesActive()) {
        // The remote protocol requires a value. Keep its existing rejection of an omitted value.
        await updateRemoteGlobalSetting({ kind: "set", key, value: value! });
        await getSettingsManager(projectRoot).reload();
        clearMascotEnabledCache();
        return;
    }
    const storage = getSettingsStorage(projectRoot);

    storage.withLock(scope, (content) => {
        let parsed: CustomSettingsValues = {};
        if (content) {
            try {
                parsed = parseJsonc(content) as JsonRecord;
            } catch (_e) {
                /* ignore */
            }
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
 */
export function getExactProjectCustomSetting(key: string, projectRoot: string): JsonValue | undefined {
    const content = readSettingsContent(getExactProjectSettingsPath(projectRoot));
    if (!content) return undefined;

    try {
        const parsed = parseJsonc(content) as JsonRecord;
        return parsed[key];
    } catch (_e) {
        return undefined;
    }
}

/**
 * Safely writes a custom key to exactly `<projectRoot>/.wld/settings.json`.
 * Output is always normalized JSON (no comments), matching ordinary custom writes.
 */
export function setExactProjectCustomSetting(key: string, value: JsonValue | undefined, projectRoot: string) {
    clearMascotEnabledCache();
    const path = getExactProjectSettingsPath(projectRoot);
    ensureSettingsFileForLock(path);

    const release = acquireSettingsLockSyncWithRetry(path);
    try {
        const content = readSettingsContent(path);
        let parsed: CustomSettingsValues = {};
        if (content) {
            try {
                parsed = parseJsonc(content) as JsonRecord;
            } catch (_e) {
                /* ignore */
            }
        }
        parsed[key] = value;
        const nextContent = preserveRunWieldCustomSettingsForWrite(content, JSON.stringify(parsed, null, 2));
        writeSettingsContent(path, nextContent);
    } finally {
        release();
    }
}

function validatePositiveIntegerSetting(value: string | number, label: string): number {
    const numberValue = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof numberValue !== "number" || !Number.isInteger(numberValue) || numberValue < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return numberValue;
}

/** Persist the two parts of a remote model default in one laptop transaction. */
export async function setRemoteDefaultModelSelection(projectRoot: string, model: string, provider: string) {
    if (!remotePersonalResourcesActive()) throw new Error("Remote model settings require a remote connection");
    await updateRemoteGlobalSetting({ kind: "model", model, provider });
    await getSettingsManager(projectRoot).reload();
}

type CompactionSettingKey = Extract<SettingsUpdate, { kind: "compaction" }>["key"];

/** Safely updates one numeric global compaction setting while preserving siblings. */
export async function setGlobalCompactionSetting(key: CompactionSettingKey, value: boolean | number) {
    if (remotePersonalResourcesActive()) {
        await updateRemoteGlobalSetting({ kind: "compaction", key, value });
        await getSettingsManager().reload();
        return;
    }
    if (!storageInstance) initSettings();

    storageInstance!.withLock("global", (content) => {
        let parsed: CustomSettingsValues = {};
        if (content) {
            try {
                parsed = parseJsonc(content) as JsonRecord;
            } catch (_e) {
                /* ignore */
            }
        }

        const existing = parsed.compaction;
        const compaction = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
        parsed.compaction = { ...compaction, [key]: value };

        return JSON.stringify(parsed, null, 2);
    });

    await getSettingsManager().reload();
}

/** Set the global compaction reserve token budget. */
export async function setCompactionReserveTokens(value: string | number) {
    await setGlobalCompactionSetting("reserveTokens", validatePositiveIntegerSetting(value, "Reserve tokens"));
}

/** Set the global compaction keep-recent token window. */
export async function setCompactionKeepRecentTokens(value: string | number) {
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
 * Merged value from global + project scopes, or undefined if neither has it.
 */
export function getMergedCustomSetting(key: string, projectRoot: string = getCwd()): JsonValue | undefined {
    const globalVal = getCustomSetting(key, "global", projectRoot);
    const projectVal = getCustomSetting(key, "project", projectRoot);

    if (key === "modelPresets") {
        return {
            ...getBundledModelPresets(),
            ...(globalVal as JsonRecord),
            ...(projectVal as JsonRecord),
        } as JsonRecord;
    }

    if (globalVal === undefined && projectVal === undefined) return undefined;
    if (globalVal === undefined) return projectVal;
    if (projectVal === undefined) return globalVal;

    // Both present: merge if both are plain objects, otherwise project wins.
    if (
        typeof globalVal === "object" &&
        globalVal !== null &&
        !Array.isArray(globalVal) &&
        typeof projectVal === "object" &&
        projectVal !== null &&
        !Array.isArray(projectVal)
    ) {
        return { ...globalVal, ...projectVal };
    }

    return projectVal;
}

export function getDefaultPlanServerUrl(): string | undefined {
    const value = getMergedCustomSetting(PLAN_SERVER_URL_SETTING_KEY);
    if (value === undefined) return undefined;
    return normalizePlanServerUrl(value);
}

export async function setDefaultPlanServerUrl(value: string, scope: SettingsScope = "project") {
    await setCustomSetting(PLAN_SERVER_URL_SETTING_KEY, normalizePlanServerUrl(value), scope);
}

/**
 * Resolve the configured vision fallback model string.
 *
 * Resolution order:
 * 1. Active preset `modelPresets.<activeModelPreset>.visionFallback.model`
 * 2. Top-level `visionFallback.model`
 * 3. Disabled when unset or not a string
 */
export function getResolvedVisionFallbackModelSetting(projectRoot: string): string | undefined {
    const activeModelPreset = getMergedCustomSetting("activeModelPreset", projectRoot) as string | undefined;
    if (activeModelPreset) {
        const modelPresets = getMergedCustomSetting("modelPresets", projectRoot) as ModelPresetsMap | undefined;
        const presetModel = modelPresets?.[activeModelPreset]?.visionFallback?.model;
        if (typeof presetModel === "string" && presetModel.trim()) return presetModel.trim();
    }

    const visionFallback = getMergedCustomSetting("visionFallback", projectRoot) as
        ModelPresetVisionFallback | undefined;
    const model = visionFallback?.model;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

/**
 * Whether merged execution worktrees should be removed after successful merge-back.
 * Defaults to true; set `cleanupMergedWorktrees: false` in global or project
 * settings to keep merged worktree checkouts for inspection.
 */
export function shouldCleanupMergedWorktrees(projectRoot: string): boolean {
    if (!projectRoot) throw new Error("shouldCleanupMergedWorktrees: projectRoot is required");
    return getMergedCustomSetting("cleanupMergedWorktrees", projectRoot) !== false;
}

/**
 * Whether completed top-level Plans should automatically generate or reconcile Work Records.
 * Defaults to true; only a literal nested `workRecords.autoGenerateOnPlanCompletion: false` disables it.
 */
export function shouldAutoGenerateWorkRecordsOnPlanCompletion(projectRoot: string): boolean {
    if (!projectRoot) throw new Error("shouldAutoGenerateWorkRecordsOnPlanCompletion: projectRoot is required");
    const workRecords = getMergedCustomSetting("workRecords", projectRoot);
    if (!workRecords || typeof workRecords !== "object" || Array.isArray(workRecords)) return true;
    return workRecords.autoGenerateOnPlanCompletion !== false;
}

/**
 * Whether standalone Planned Changes merge into their authored target branch.
 * Defaults to false: deliver to a Plan Branch instead.
 */
export function shouldAutoMergePlansIntoTargetBranch(projectRoot: string): boolean {
    if (!projectRoot) throw new Error("shouldAutoMergePlansIntoTargetBranch: projectRoot is required");
    const plans = getMergedCustomSetting("plans", projectRoot);
    return Boolean(
        plans && typeof plans === "object" && !Array.isArray(plans) && plans.autoMergeIntoTargetBranch === true,
    );
}

function validateNonNegativeIntegerSetting(value: JsonValue | undefined, key: string): number {
    const numberValue = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof numberValue !== "number" || !Number.isInteger(numberValue) || numberValue < 0) {
        throw new Error(`${key} must be an integer of zero or more.`);
    }
    return numberValue;
}

/** Resolve archived Plan retention policy from project settings only. */
export function getPlanArchiveRetentionPolicy(projectRoot: string): ArchiveRetentionPolicy {
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

/** Resolve the optional human code review gate mode. */
export function getCodeReviewMode(projectRoot: string): "none" | "ask" | "always" {
    if (!projectRoot) throw new Error("getCodeReviewMode: projectRoot is required");
    const mode = getMergedCustomSetting("codereview", projectRoot);
    if (mode === undefined) return "ask";
    if (typeof mode !== "string") return "none";

    const normalized = mode.trim().toLowerCase();
    if (normalized === "ask" || normalized === "always") return normalized;
    return "none";
}

/** Resolve the optional Guided Review generation mode. */
export function getGuidedReviewMode(projectRoot: string): "none" | "ask" | "auto" | "always" {
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
