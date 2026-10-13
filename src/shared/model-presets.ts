import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir, MODEL_PRESETS_DIR } from "../constants.js";
import type { ImageGenerationSettings } from "./image-generation-settings.ts";

export interface ModelPresetAgentOverride {
    model?: string;
    thinkingLevel?: string;
    temperature?: number;
}

export interface ModelPresetVisionFallback {
    model?: string;
}

export interface ModelPreset {
    description?: string;
    agents?: Record<string, ModelPresetAgentOverride>;
    visionFallback?: ModelPresetVisionFallback;
    imageGeneration?: ImageGenerationSettings;
}

export type ModelPresetsMap = Record<string, ModelPreset>;

let bundledPresets: ModelPresetsMap | undefined;
const extractedDirectories = new Set<string>();

function readBundledPresets(): ModelPresetsMap {
    if (bundledPresets) return bundledPresets;
    const presets: ModelPresetsMap = {};
    for (const entry of readdirSync(MODEL_PRESETS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        presets[entry.name.slice(0, -5)] = JSON.parse(
            readFileSync(join(MODEL_PRESETS_DIR, entry.name), "utf8"),
        ) as ModelPreset;
    }
    bundledPresets = presets;
    return presets;
}

/** Refresh disposable copies without writing personal settings or preset overrides. */
export function extractBundledModelPresets(): string | null {
    const homeDir = getHomeDir();
    if (!homeDir) return null;
    const directory = join(homeDir, ".wld", "bundled-model-presets");
    if (extractedDirectories.has(directory)) return directory;
    const presets = readBundledPresets();
    try {
        mkdirSync(directory, { recursive: true });
        for (const [name, preset] of Object.entries(presets)) {
            const path = join(directory, `${name}.json`);
            try {
                const stat = lstatSync(path);
                if (stat.isDirectory()) rmSync(path, { recursive: true });
                else if (stat.isSymbolicLink()) rmSync(path);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
            writeFileSync(path, JSON.stringify(preset, null, 4) + "\n");
        }
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.endsWith(".json") && !Object.hasOwn(presets, entry.name.slice(0, -5))) {
                rmSync(join(directory, entry.name), { recursive: true });
            }
        }
        extractedDirectories.add(directory);
        return directory;
    } catch {
        // Embedded definitions remain usable when the home cache is unwritable.
        return null;
    }
}

/** Bundled defaults are authoritative; unpacked files are a readable cache. */
export function getBundledModelPresets(): ModelPresetsMap {
    const presets = readBundledPresets();
    extractBundledModelPresets();
    return structuredClone(presets);
}
