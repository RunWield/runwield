import { join } from "@std/path";
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
    for (const entry of Deno.readDirSync(MODEL_PRESETS_DIR)) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        presets[entry.name.slice(0, -5)] = JSON.parse(
            Deno.readTextFileSync(join(MODEL_PRESETS_DIR, entry.name)),
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
        Deno.mkdirSync(directory, { recursive: true });
        for (const [name, preset] of Object.entries(presets)) {
            const path = join(directory, `${name}.json`);
            try {
                const stat = Deno.lstatSync(path);
                if (stat.isDirectory) Deno.removeSync(path, { recursive: true });
                else if (stat.isSymlink) Deno.removeSync(path);
            } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            Deno.writeTextFileSync(path, JSON.stringify(preset, null, 4) + "\n");
        }
        for (const entry of Deno.readDirSync(directory)) {
            if (entry.name.endsWith(".json") && !Object.hasOwn(presets, entry.name.slice(0, -5))) {
                Deno.removeSync(join(directory, entry.name), { recursive: true });
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
