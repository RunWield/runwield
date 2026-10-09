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
import { CATPPUCCIN_MOCHA_THEME_PATH } from "../../constants.js";
import { getSettingsDir, getSettingsManager } from "../../shared/settings.js";
import { loadExternalThemeJsons } from "./theme-discovery.ts";
import { createThemeFromJson } from "./theme-json.ts";
import { createThemeRegistry } from "./theme-registry.ts";

/** @typedef {import('@earendil-works/pi-coding-agent').Theme} ThemeInstance */
/** @typedef {import('./theme-json.ts').ThemeJson} ThemeJson */

// ─── Global theme singleton key (matches the upstream) ───────────────────────
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

export const DEFAULT_THEME_NAME = "catppuccin-mocha";

/**
 * The theme proxy — reads from globalThis just like the upstream.
 * All modules import `theme` from here and get the same singleton.
 * @type {ThemeInstance}
 */
export const theme = new Proxy(/** @type {any} */ ({}), {
    get(_target, prop) {
        const t = /** @type {any} */ (globalThis)[THEME_KEY];
        if (!t) throw new Error("Theme not initialized. Call initRunWieldTheme() first.");
        return t[prop];
    },
});

/** @type {import('@earendil-works/pi-tui').MarkdownTheme | null} */
let _markdownTheme = null;

/** @type {import('@earendil-works/pi-tui').SelectListTheme | null} */
let _selectListTheme = null;

/** @returns {import('@earendil-works/pi-tui').MarkdownTheme} */
export function getMarkdownTheme() {
    if (!_markdownTheme) _markdownTheme = upstreamGetMarkdownTheme();
    return _markdownTheme;
}

/** @returns {import('@earendil-works/pi-tui').SelectListTheme} */
export function getSelectListTheme() {
    if (!_selectListTheme) _selectListTheme = upstreamGetSelectListTheme();
    return _selectListTheme;
}

/** @returns {import('@earendil-works/pi-tui').EditorTheme} */
export function getEditorTheme() {
    return {
        /** @param {string} s */
        borderColor: (s) => theme.fg("borderAccent", s),
        selectList: getSelectListTheme(),
    };
}

export const imageTheme = {
    /** @param {string} s */
    fallbackColor: (s) => {
        try {
            return theme.fg("dim", s);
        } catch (_e) {
            return s;
        }
    },
};

// ─── Theme JSON → Theme instance ─────────────────────────────────────────────

export const DEFAULT_THEME_JSON = /** @type {ThemeJson} */ (JSON.parse(
    Deno.readTextFileSync(CATPPUCCIN_MOCHA_THEME_PATH),
));

// Construct the embedded theme once at module load. It's both the boot default
// and the merge floor for partial external themes.
const EMBEDDED_THEME = createThemeFromJson(DEFAULT_THEME_JSON);

// ─── Local theme registry + setters (re-implemented; not in Pi's exports) ────

/** @param {ThemeInstance} t */
function installGlobalTheme(t) {
    /** @type {any} */ (globalThis)[THEME_KEY] = t;
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
 * @param {() => void} cb
 * @returns {() => void}
 */
export function onThemeChange(cb) {
    return themeRegistry.onChange(cb);
}

/** @param {ThemeInstance[]} themes */
export function setRegisteredThemes(themes) {
    themeRegistry.setRegisteredThemes(themes);
}

/** @param {ThemeInstance} themeInstance */
export function setThemeInstance(themeInstance) {
    themeRegistry.setThemeInstance(themeInstance);
}

/**
 * Swap to a registered theme by name.
 * Returns success false (and stays on the previous theme) if the name
 * is not registered, instead of silently substituting.
 * @param {string} name
 * @returns {{ success: boolean, error?: string }}
 */
export function setTheme(name) {
    return themeRegistry.setTheme(name);
}

/** @returns {string[]} */
export function getAvailableThemes() {
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
 *
 * @returns {Promise<ThemeJson[]>}
 */
export async function resolveAvailableThemeJsons() {
    const settings = getSettingsManager();
    const packageManager = new DefaultPackageManager({
        cwd: Deno.cwd(),
        agentDir: getSettingsDir("global"),
        settingsManager: settings,
    });

    const externalThemeJsons = await loadExternalThemeJsons({
        packageManager,
        readTextFile: Deno.readTextFileSync,
        defaultThemeName: DEFAULT_THEME_NAME,
        baseThemeJson: DEFAULT_THEME_JSON,
    });

    return [DEFAULT_THEME_JSON, ...externalThemeJsons];
}

/**
 * Resolve the currently selected theme JSON using the same default and external
 * package merge semantics as the TUI theme registry.
 *
 * @returns {Promise<ThemeJson>}
 */
export async function resolveSelectedThemeJson() {
    const settings = getSettingsManager();
    await settings.reload?.();
    const selectedThemeName = settings.getTheme() || DEFAULT_THEME_NAME;

    if (selectedThemeName === DEFAULT_THEME_NAME) {
        return DEFAULT_THEME_JSON;
    }

    const availableThemeJsons = await resolveAvailableThemeJsons();

    return availableThemeJsons.find((themeJson) => themeJson.name === selectedThemeName) || DEFAULT_THEME_JSON;
}
