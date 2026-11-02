/**
 * @module ui/theme/theme-json
 * Pure helpers for Pi-compatible JSON theme files.
 */

import process from "node:process";
import { foregroundAnsi, parseColor } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";

export type ThemeInstance = Theme;
export type ThemeColorValue = string | number;
export type ThemeColors = Record<string, ThemeColorValue>;
export type ThemeColorMode = ConstructorParameters<typeof Theme>[2];

type PiForegroundColors = ConstructorParameters<typeof Theme>[0];
type PiBackgroundColors = ConstructorParameters<typeof Theme>[1];

export interface ThemeJson {
    name?: string;
    vars?: ThemeColors;
    colors?: ThemeColors;
    export?: ThemeColors;
}

export interface ResolvedThemeJson extends ThemeJson {
    colors: ThemeColors;
}

export interface MergedThemeJson extends ThemeJson {
    vars: ThemeColors;
    colors: ThemeColors;
}

export interface ThemeColorMaps {
    fgColors: ThemeColors;
    bgColors: ThemeColors;
}

export interface CreateThemeOptions {
    colorMode?: ThemeColorMode;
}

export const BG_TOKEN_NAMES = new Set([
    "selectedBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
]);

export function detectColorMode(): ThemeColorMode {
    const colorterm = process.env.COLORTERM;
    if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
    if (process.env.WT_SESSION) return "truecolor";
    const term = process.env.TERM || "";
    if (term === "dumb" || term === "" || term === "linux") return "256color";
    if (process.env.TERM_PROGRAM === "Apple_Terminal") return "256color";
    if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) return "256color";
    return "truecolor";
}

function resolveVarRef(value: ThemeColorValue, vars: ThemeColors, visited: Set<string> = new Set()): ThemeColorValue {
    if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
    if (visited.has(value)) throw new Error(`Circular variable reference: ${value}`);
    if (!(value in vars)) throw new Error(`Variable reference not found: ${value}`);
    visited.add(value);
    return resolveVarRef(vars[value], vars, visited);
}

/**
 * Resolve variable references in a theme JSON object's colors.
 */
export function resolveThemeVars(themeJson: ThemeJson): ResolvedThemeJson {
    const vars = themeJson.vars || {};
    const colors = themeJson.colors || {};
    const resolvedColors: ThemeColors = {};

    for (const [key, value] of Object.entries(colors)) {
        resolvedColors[key] = resolveVarRef(value, vars);
    }

    return {
        ...themeJson,
        vars,
        colors: resolvedColors,
    };
}

/**
 * Merge a partial external theme on top of a complete base theme.
 */
export function mergeThemeJson(baseThemeJson: ThemeJson, overrideThemeJson: ThemeJson): MergedThemeJson {
    return {
        ...baseThemeJson,
        ...overrideThemeJson,
        vars: { ...(baseThemeJson.vars || {}), ...(overrideThemeJson.vars || {}) },
        colors: { ...(baseThemeJson.colors || {}), ...(overrideThemeJson.colors || {}) },
        export: { ...(baseThemeJson.export || {}), ...(overrideThemeJson.export || {}) },
    };
}

/**
 * Split resolved color tokens into Pi Theme foreground/background maps.
 */
export function splitFgBgColors(colors: ThemeColors): ThemeColorMaps {
    const fgColors: ThemeColors = {};
    const bgColors: ThemeColors = {};

    for (const [key, value] of Object.entries(colors)) {
        if (BG_TOKEN_NAMES.has(key)) {
            bgColors[key] = value;
        } else {
            fgColors[key] = value;
        }
    }

    return { fgColors, bgColors };
}

/**
 * Build a Pi Theme instance from a parsed theme JSON object.
 */
export function createThemeFromJson(themeJson: ThemeJson, options: CreateThemeOptions = {}): ThemeInstance {
    const resolvedJson = resolveThemeVars(themeJson);
    const { fgColors, bgColors } = splitFgBgColors(resolvedJson.colors);
    // Pi 1.5 only accepts its own token names; RunWield owns these footer tokens.
    const customAnsi = new Map<string, string>();
    const mode = options.colorMode || detectColorMode();
    for (const name of [
        "routingQuickFix",
        "routingFeature",
        "routingEpic",
        "complexityLow",
        "complexityMedium",
        "complexityHigh",
    ]) {
        if (fgColors[name] === undefined) continue;
        customAnsi.set(name, fgColors[name] === "" ? "\x1b[39m" : foregroundAnsi(parseColor(fgColors[name]), mode));
        delete fgColors[name];
    }
    const theme = new Theme(fgColors as PiForegroundColors, bgColors as PiBackgroundColors, mode, {
        name: themeJson.name,
    });
    const fg = theme.fg.bind(theme);
    const getFgAnsi = theme.getFgAnsi.bind(theme);
    theme.fg = (name, text) => (customAnsi.has(name) ? `${customAnsi.get(name)}${text}\x1b[39m` : fg(name, text));
    theme.getFgAnsi = (name) => customAnsi.get(name) ?? getFgAnsi(name);
    return theme;
}
