import { readFileSync } from "node:fs";
/**
 * @module ui/theme/theme
 * Theme integration — wraps Pi's Theme class with RunWield-local registration,
 * lookup, and a live-swap setter. We re-implement the registration/swap
 * machinery locally because @earendil-works/pi-coding-agent only exports
 * the Theme constructor and initTheme, not the runtime setters.
 */

import {
    DefaultPackageManager,
    getMarkdownTheme as upstreamGetMarkdownTheme,
    getSelectListTheme as upstreamGetSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import { getCwd } from "../../constants.ts";
import defaultThemeJson from "./catppuccin-mocha.json" with { type: "json" };
import { getSettingsDir, getSettingsManager } from "../../shared/settings.ts";
import { loadExternalThemeJsons } from "./theme-discovery.ts";
import { type ThemeInstance, type ThemeJson, createThemeFromJson } from "./theme-json.ts";
import { type ThemeSelectionResult, createThemeRegistry } from "./theme-registry.ts";

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export type { ThemeInstance, ThemeJson } from "./theme-json.ts";
export type { ThemeSelectionResult } from "./theme-registry.ts";

// ─── Global theme singleton key (matches the upstream) ───────────────────────
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** The upstream JavaScript singleton installs Theme on this shared symbol. */
interface ThemeGlobalSlot {
    [THEME_KEY]?: ThemeInstance;
}

type ThemeGlobal = typeof globalThis & ThemeGlobalSlot;

export const DEFAULT_THEME_NAME = "catppuccin-mocha";

/**
 * The theme proxy — reads from globalThis just like the upstream.
 * All modules import `theme` from here and get the same singleton.
 */
// The empty proxy target and arbitrary property forwarding mirror the upstream JavaScript bridge.
export const theme = new Proxy({} as ThemeInstance, {
    get(_target, prop) {
        const t = (globalThis as ThemeGlobal)[THEME_KEY];
        if (!t) throw new Error("Theme not initialized. Call initRunWieldTheme() first.");
        return t[prop as keyof ThemeInstance];
    },
});

let _markdownTheme: MarkdownTheme | null = null;

let _selectListTheme: SelectListTheme | null = null;

export function getMarkdownTheme(): MarkdownTheme {
    if (!_markdownTheme) _markdownTheme = upstreamGetMarkdownTheme();
    return _markdownTheme;
}

export function getSelectListTheme(): SelectListTheme {
    if (!_selectListTheme) _selectListTheme = upstreamGetSelectListTheme();
    return _selectListTheme;
}

export function getEditorTheme(): EditorTheme {
    return {
        borderColor: (s: string) => theme.fg("borderAccent", s),
        selectList: getSelectListTheme(),
    };
}

export const imageTheme = {
    fallbackColor: (s: string) => {
        try {
            return theme.fg("dim", s);
        } catch (_e) {
            return s;
        }
    },
};

// ─── Theme JSON → Theme instance ─────────────────────────────────────────────

export const DEFAULT_THEME_JSON: ThemeJson = defaultThemeJson;

// Construct the embedded theme once at module load. It's both the boot default
// and the merge floor for partial external themes.
const EMBEDDED_THEME = createThemeFromJson(DEFAULT_THEME_JSON);

// ─── Local theme registry + setters (re-implemented; not in Pi's exports) ────

function installGlobalTheme(t: ThemeInstance) {
    (globalThis as ThemeGlobal)[THEME_KEY] = t;
}

const themeRegistry = createThemeRegistry({
    defaultTheme: EMBEDDED_THEME,
    setGlobalTheme: installGlobalTheme,
    warn: console.warn,
});

/**
 * Subscribe to theme changes. Returns an unsubscribe function.
 * Fires on every successful theme swap (setTheme / setThemeInstance) and
 * on the initial install via initRunWieldTheme.
 */
export function onThemeChange(cb: () => void): () => void {
    return themeRegistry.onChange(cb);
}

export function setRegisteredThemes(themes: ThemeInstance[]) {
    themeRegistry.setRegisteredThemes(themes);
}

export function setThemeInstance(themeInstance: ThemeInstance) {
    themeRegistry.setThemeInstance(themeInstance);
}

/**
 * Swap to a registered theme by name.
 * Returns success false (and stays on the previous theme) if the name
 * is not registered, instead of silently substituting.
 */
export function setTheme(name: string): ThemeSelectionResult {
    return themeRegistry.setTheme(name);
}

export function getAvailableThemes(): string[] {
    return themeRegistry.getAvailableThemes();
}

// ─── Boot + discovery ────────────────────────────────────────────────────────

/**
 * Synchronously install the embedded catppuccin-mocha as the boot default.
 * Safe to call from any sync context — guarantees the theme proxy is usable
 * before first render. External themes are discovered later via
 * applyPersistedTheme().
 */
export function initRunWieldTheme() {
    themeRegistry.setRegisteredThemes([]);
    themeRegistry.setThemeInstance(EMBEDDED_THEME);
}

/**
 * Lazy-discover external themes and apply the persisted theme.
 * Awaited by the boot path before first render so the user never sees
 * a flicker from embedded → persisted.
 *
 * No-op when the persisted theme is the embedded default (95% case) — avoids
 * paying the PackageManager.resolve() cost for users who never customized.
 *
 * Tolerant of discovery failures: a broken settings.packages or a missing
 * persisted theme falls back to embedded with a warning instead of crashing.
 */
export async function applyPersistedTheme() {
    const settings = getSettingsManager();
    const persisted = settings.getTheme();
    if (!persisted || persisted === DEFAULT_THEME_NAME) return;

    try {
        await discoverAndRegisterThemes();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Theme discovery failed: ${msg}. Using embedded theme.`);
        return;
    }

    themeRegistry.applyPersistedThemeName(persisted);
}

/**
 * Discover themes from installed packages and register them alongside the
 * embedded default. Idempotent — safe to call after every install/remove.
 *
 * External themes whose `colors`/`vars` are partial are merged on top of the
 * embedded JSON before instantiation, so missing tokens fall back to
 * catppuccin-mocha values instead of throwing.
 *
 * External themes named "catppuccin-mocha" are dropped (builtin precedence).
 */
export async function discoverAndRegisterThemes() {
    const themeJsons = await resolveAvailableThemeJsons();
    const externalThemes = themeJsons
        .filter((themeJson) => themeJson.name !== DEFAULT_THEME_NAME)
        .map((themeJson) => createThemeFromJson(themeJson));

    setRegisteredThemes(externalThemes);
}

/**
 * Resolve available theme JSON objects using the same package discovery and
 * partial-theme merge policy as the TUI theme registry.
 */
export async function resolveAvailableThemeJsons(): Promise<ThemeJson[]> {
    const settings = getSettingsManager();
    const packageManager = new DefaultPackageManager({
        cwd: getCwd(),
        agentDir: getSettingsDir("global"),
        settingsManager: settings,
    });

    const externalThemeJsons = await loadExternalThemeJsons({
        packageManager,
        readTextFile: (path) => readFileSync(path, "utf8"),
        defaultThemeName: DEFAULT_THEME_NAME,
        baseThemeJson: DEFAULT_THEME_JSON,
    });

    return [DEFAULT_THEME_JSON, ...externalThemeJsons];
}

/**
 * Resolve the currently selected theme JSON using the same default and external
 * package merge semantics as the TUI theme registry.
 */
export async function resolveSelectedThemeJson(): Promise<ThemeJson> {
    const settings = getSettingsManager();
    await settings.reload?.();
    const selectedThemeName = settings.getTheme() || DEFAULT_THEME_NAME;

    if (selectedThemeName === DEFAULT_THEME_NAME) {
        return DEFAULT_THEME_JSON;
    }

    const availableThemeJsons = await resolveAvailableThemeJsons();

    return availableThemeJsons.find((themeJson) => themeJson.name === selectedThemeName) || DEFAULT_THEME_JSON;
}
