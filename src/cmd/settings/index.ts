/**
 * @module cmd/settings
 * Settings menu for interactive sessions.
 */

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelPreset, ModelPresetsMap } from "../../shared/model-presets.ts";
import { getCwd } from "../../constants.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    getCustomSetting,
    getMergedCustomSetting,
    getSettingsManager,
    isMascotEnabled,
    setCompactionKeepRecentTokens,
    setCompactionReserveTokens,
    setCustomSetting,
} from "../../shared/settings.js";
import { theme } from "../../ui/theme/theme.js";
import { printCommandHelp } from "../help/index.js";
import { editPolicySetting, getPolicySettings } from "./policies.ts";

interface CompactionSettings {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
}

interface ContextUsage {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
}

interface ContextSession {
    getContextUsage?(): ContextUsage | undefined;
    model?: {
        contextWindow?: number | null;
    };
}

interface SettingsSelectItem {
    value: string;
    label: string;
    description?: string;
}

interface SettingsTextOptions {
    defaultValue: string;
    placeholder: string;
    allowEmpty: boolean;
}

interface SettingsCommandUi {
    appendSystemMessage(message: string): void;
    promptSelect(title: string, options: SettingsSelectItem[]): Promise<string | null>;
    promptText(title: string, options: SettingsTextOptions): Promise<string | null>;
    requestRender?(): void;
}

interface SettingsCommandEditor {
    disableSubmit: boolean;
    setText?(text: string): void;
}

interface SettingsCommandOptions {
    editor?: SettingsCommandEditor;
    sessionId?: string;
    sessionRuntime?: SessionRuntime;
    uiAPI?: SettingsCommandUi;
}

const MODEL_PRESET_PREFIX = "preset:";

function formatMaybeTokens(value: number | null | undefined): string {
    return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown";
}

function parsePositiveInteger(value: string | null | undefined): number | null {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const parsed = Number(text.replaceAll(",", ""));
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function getContextUsage(session: ContextSession): ContextUsage | undefined {
    const usage = session.getContextUsage?.();
    if (usage) return usage;
    const contextWindow = session.model?.contextWindow;
    if (typeof contextWindow === "number" && contextWindow > 0) {
        return { tokens: null, contextWindow, percent: null };
    }
    return undefined;
}

export function formatCompactionBehavior(
    settings: CompactionSettings,
    session: ContextSession,
    settingsManager: SettingsManager,
): string {
    const usage = getContextUsage(session);
    const contextWindow = usage?.contextWindow ?? session.model?.contextWindow;
    const threshold = typeof contextWindow === "number" && contextWindow > 0
        ? Math.max(0, contextWindow - settings.reserveTokens)
        : null;
    const currentContext = usage && typeof usage.tokens === "number"
        ? `${usage.tokens.toLocaleString()}/${formatMaybeTokens(usage.contextWindow)} tokens` +
            (typeof usage.percent === "number" ? ` (${usage.percent.toFixed(1)}%)` : "")
        : "unknown";
    const projectCompaction = settingsManager.getProjectSettings().compaction;
    const overrideNote = projectCompaction
        ? "\nProject settings define compaction overrides; effective values are shown above."
        : "";

    return [
        theme.bold("Compaction behavior"),
        `${theme.fg("dim", "Auto-compact:")} ${settings.enabled ? "enabled" : "disabled"}`,
        `${theme.fg("dim", "Reserve tokens:")} ${settings.reserveTokens.toLocaleString()}`,
        `${theme.fg("dim", "Keep recent tokens:")} ${settings.keepRecentTokens.toLocaleString()}`,
        `${theme.fg("dim", "Auto threshold:")} ${
            threshold === null
                ? "unknown"
                : `${threshold.toLocaleString()} / ${formatMaybeTokens(contextWindow)} tokens`
        }`,
        `${theme.fg("dim", "Current context:")} ${currentContext}`,
        "",
        `Auto-compaction triggers when current context exceeds the threshold. Compaction keeps about ${settings.keepRecentTokens.toLocaleString()} tokens of recent messages.`,
    ].join("\n") + overrideNote;
}

function formatCompactionMenuDescription(
    settings: CompactionSettings,
    session: ContextSession,
    settingsManager: SettingsManager,
): string {
    const usage = getContextUsage(session);
    const contextWindow = usage?.contextWindow ?? session.model?.contextWindow;
    const threshold = typeof contextWindow === "number" && contextWindow > 0
        ? Math.max(0, contextWindow - settings.reserveTokens).toLocaleString()
        : "unknown";
    const overrideSuffix = settingsManager.getProjectSettings().compaction ? " (project override active)" : "";
    return `${
        settings.enabled ? "enabled" : "disabled"
    }; threshold ${threshold}; keep ${settings.keepRecentTokens.toLocaleString()}${overrideSuffix}`;
}

function getCompactionSettings(settingsManager: SettingsManager): CompactionSettings {
    return settingsManager.getCompactionSettings();
}

async function editTokenSetting(
    label: string,
    currentValue: number,
    uiAPI: SettingsCommandUi,
    setter: (value: number) => Promise<void>,
): Promise<void> {
    const value = await uiAPI.promptText(`${label}:`, {
        defaultValue: String(currentValue),
        placeholder: "Positive integer token count",
        allowEmpty: false,
    });
    if (value === null) return;

    const parsed = parsePositiveInteger(value);
    if (parsed === null) {
        uiAPI.appendSystemMessage(`${label} must be a positive integer.`);
        return;
    }

    await setter(parsed);
    uiAPI.appendSystemMessage(`${label} set to ${parsed.toLocaleString()}.`);
}

function getModelPresets(projectRoot: string): ModelPresetsMap {
    return (getMergedCustomSetting("modelPresets", projectRoot) as ModelPresetsMap | undefined) ?? {};
}

function getActiveModelPreset(projectRoot: string): string | null | undefined {
    return getMergedCustomSetting("activeModelPreset", projectRoot) as string | null | undefined;
}

function formatModelPresetsMenuDescription(projectRoot: string): string {
    const names = Object.keys(getModelPresets(projectRoot));
    if (names.length === 0) return "No presets defined";
    const active = getActiveModelPreset(projectRoot);
    if (!active) return `None active (${names.length} defined)`;
    return names.includes(active) ? `Active: ${active}` : `${active} (missing); ${names.length} defined`;
}

/**
 * Rebuild the active Session's agent so a model preset change takes effect
 * immediately, instead of waiting for the next `/reload` or new Session.
 */
async function reloadActiveSessionForPresetChange(
    sessionRuntime: SessionRuntime,
    sessionId: string,
    uiAPI: SettingsCommandUi,
): Promise<void> {
    try {
        const result = await sessionRuntime.reloadSession(sessionId);
        if (!result.ok) {
            console.error(`[RunWield] preset_reload_failed ${result.error || "reload_failed"}`);
            uiAPI.appendSystemMessage("Preset saved, but the current agent could not reload. Run /reload to retry.");
            return;
        }
        uiAPI.appendSystemMessage(
            result.deferred
                ? "The new model preset will be used for your first message."
                : "Agent context reloaded with the new model preset.",
        );
    } catch (error) {
        uiAPI.appendSystemMessage(
            `Preset saved, but the active agent could not be reloaded: ${
                error instanceof Error ? error.message : String(error)
            }. Run /reload to retry.`,
        );
    }
}

function formatModelPresetDescription(preset: ModelPreset): string {
    if (preset.description) return preset.description;
    const parts: string[] = [];
    const agentEntries = Object.entries(preset.agents ?? {});
    if (agentEntries.length > 0) {
        const modelCount = agentEntries.filter(([, cfg]) => typeof cfg.model === "string").length;
        parts.push(
            modelCount > 0
                ? `${modelCount} agent model override${modelCount === 1 ? "" : "s"}`
                : `${agentEntries.length} agent override${agentEntries.length === 1 ? "" : "s"}`,
        );
    }
    if (typeof preset.visionFallback?.model === "string") parts.push("vision fallback");
    if (typeof preset.imageGeneration?.model === "string") parts.push("image generation");
    return parts.length > 0 ? parts.join("; ") : "No overrides";
}

export async function runSettingsCommand(argv: string[], options: SettingsCommandOptions = {}): Promise<void> {
    const firstArg = argv[0]?.trim();
    if (firstArg === "help" || firstArg === "--help" || firstArg === "-h") {
        printCommandHelp("settings");
        return;
    }

    const { uiAPI, editor, sessionRuntime, sessionId } = options;
    if (!uiAPI) {
        console.error("The /settings command is only available inside an interactive session.");
        return;
    }
    if (!sessionRuntime || !sessionId) {
        throw new Error("Settings require an active runtime session.");
    }

    const projectRoot = sessionRuntime.getSessionSnapshot(sessionId)?.cwd || getCwd();
    const settingsManager = getSettingsManager(projectRoot);
    const getActiveSession = (): ContextSession => {
        const usage = sessionRuntime.getSessionSnapshot(sessionId)?.contextUsage || undefined;
        return {
            getContextUsage: () => usage || undefined,
            model: { contextWindow: usage?.contextWindow },
        };
    };

    while (true) {
        const session = getActiveSession();
        const settings = getCompactionSettings(settingsManager);
        const mascotEnabled = isMascotEnabled(projectRoot);
        const policies = getPolicySettings(projectRoot);
        const selection = await uiAPI.promptSelect("Settings", [
            ...policies.map((policy) => ({
                value: policy.key,
                label: `${policy.title}: ${policy.current === "none" ? "never" : policy.current}`,
                description: policy.description,
            })),
            {
                value: "mascot",
                label: `Mascot: ${mascotEnabled ? "on" : "off"}`,
                description: `Agent mascot ${mascotEnabled ? "on" : "off"}${
                    getCustomSetting("mascot", "project", projectRoot) !== undefined ? " (project override active)" : ""
                }`,
            },
            {
                value: "compaction",
                label: "Compaction",
                description: formatCompactionMenuDescription(settings, session, settingsManager),
            },
            {
                value: "model-presets",
                label: "Model presets",
                description: formatModelPresetsMenuDescription(projectRoot),
            },
            { value: "done", label: "Done" },
        ]);

        if (!selection || selection === "done") break;
        const policy = policies.find((entry) => entry.key === selection);
        if (policy) {
            try {
                await editPolicySetting(policy, projectRoot, uiAPI);
            } catch (error) {
                uiAPI.appendSystemMessage(error instanceof Error ? error.message : String(error));
            }
            continue;
        }
        if (selection === "mascot") {
            await setCustomSetting("mascot", !mascotEnabled, "global", projectRoot);
            uiAPI.appendSystemMessage(`Mascot ${!mascotEnabled ? "on" : "off"} (global setting).`);
            uiAPI.requestRender?.();
            continue;
        }
        if (selection === "model-presets") {
            while (true) {
                const presets = getModelPresets(projectRoot);
                const presetNames = Object.keys(presets).sort((a, b) => a.localeCompare(b));
                if (presetNames.length === 0) {
                    uiAPI.appendSystemMessage(
                        "No model presets defined. Add a `modelPresets` entry to your settings " +
                            "(see https://docs.runwield.dev/settings/#modelpresets).",
                    );
                }
                const active = getActiveModelPreset(projectRoot);
                const presetOptions: SettingsSelectItem[] = presetNames.map((name) => {
                    const preset = presets[name];
                    return {
                        value: `${MODEL_PRESET_PREFIX}${name}`,
                        label: name === active ? `${name} (active)` : name,
                        description: preset ? formatModelPresetDescription(preset) : undefined,
                    };
                });
                presetOptions.push(
                    {
                        value: "none",
                        label: !active ? "None (base config) (active)" : "None (base config)",
                        description: "Clear activeModelPreset and use the base agents config",
                    },
                    { value: "back", label: "Back" },
                );

                const presetChoice = await uiAPI.promptSelect("Model Presets", presetOptions);
                if (!presetChoice || presetChoice === "back") break;

                if (presetChoice === "none") {
                    await setCustomSetting("activeModelPreset", null, "global", projectRoot);
                    uiAPI.appendSystemMessage("Active model preset cleared; base agents config is used.");
                    await reloadActiveSessionForPresetChange(sessionRuntime, sessionId, uiAPI);
                    uiAPI.requestRender?.();
                } else if (presetChoice.startsWith(MODEL_PRESET_PREFIX)) {
                    const name = presetChoice.slice(MODEL_PRESET_PREFIX.length);
                    await setCustomSetting("activeModelPreset", name, "global", projectRoot);
                    uiAPI.appendSystemMessage(`Active model preset set to ${name}.`);
                    await reloadActiveSessionForPresetChange(sessionRuntime, sessionId, uiAPI);
                    uiAPI.requestRender?.();
                }
            }
            continue;
        }
        if (selection !== "compaction") continue;

        while (true) {
            const activeSession = getActiveSession();
            const activeSettings = getCompactionSettings(settingsManager);
            const compactionChoice = await uiAPI.promptSelect("Compaction Settings", [
                {
                    value: "toggle",
                    label: `Auto-compact: ${activeSettings.enabled ? "enabled" : "disabled"}`,
                    description: "Automatically compact context when it gets too large",
                },
                {
                    value: "reserve",
                    label: `Reserve tokens: ${activeSettings.reserveTokens.toLocaleString()}`,
                    description: "Space reserved for compaction prompt and summary output",
                },
                {
                    value: "keep-recent",
                    label: `Keep recent tokens: ${activeSettings.keepRecentTokens.toLocaleString()}`,
                    description: "Approximate recent context retained after compaction",
                },
                {
                    value: "summary",
                    label: "Show behavior summary",
                    description: "Print current compaction thresholds and context usage",
                },
                { value: "back", label: "Back" },
            ]);

            if (!compactionChoice || compactionChoice === "back") break;

            try {
                if (compactionChoice === "toggle") {
                    const enabled = !activeSettings.enabled;
                    const result = await sessionRuntime.setSessionAutoCompaction(sessionId, enabled);
                    if (!result.ok) throw new Error("Active runtime session does not support auto-compaction.");
                    await settingsManager.reload();
                    uiAPI.appendSystemMessage(`Auto-compact ${enabled ? "enabled" : "disabled"}.`);
                    uiAPI.requestRender?.();
                } else if (compactionChoice === "reserve") {
                    await editTokenSetting(
                        "Reserve tokens",
                        activeSettings.reserveTokens,
                        uiAPI,
                        setCompactionReserveTokens,
                    );
                    await settingsManager.reload();
                } else if (compactionChoice === "keep-recent") {
                    await editTokenSetting(
                        "Keep recent tokens",
                        activeSettings.keepRecentTokens,
                        uiAPI,
                        setCompactionKeepRecentTokens,
                    );
                    await settingsManager.reload();
                } else if (compactionChoice === "summary") {
                    uiAPI.appendSystemMessage(
                        formatCompactionBehavior(activeSettings, activeSession, settingsManager),
                    );
                }
            } catch (error) {
                uiAPI.appendSystemMessage(error instanceof Error ? error.message : String(error));
            }
        }
    }

    if (editor) {
        editor.setText?.("");
        editor.disableSubmit = false;
    }
}
