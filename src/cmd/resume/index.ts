import process from "node:process";
/**
 * @module cmd/resume
 * Browse and resume a persisted conversation through SessionRuntime.
 */

import type { SelectListLayoutOptions } from "@earendil-works/pi-tui";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { buildConversationRestoredMessage } from "../../shared/session/session-user-messages.ts";
import { getMergedCustomSetting, getSettingsManager } from "../../shared/settings.js";
import { setTerminalTitleForName } from "../../ui/tui/terminal-title.ts";

const DEFAULT_COMPACT_ON_RESUME_PCT = 50;
const DEFAULT_CONTEXT_WINDOW = 128000;
const FALLBACK_TERMINAL_COLUMNS = 80;
const MIN_PRIMARY_COLUMN_WIDTH = 32;
// Padded block (2 cells each side) + selection prefix (2) + column gap (2) + render safety margin (2).
const SELECT_CHROME_WIDTH = 8;

interface PersistedModelSelection {
    provider: string;
    modelId: string;
}

interface ResumeModelSelection {
    modelOverride: string | undefined;
    contextWindow: number;
}

interface ResumeSelectItem {
    value: string;
    label: string;
    description?: string;
}

interface ResumeCommandUi {
    appendSystemMessage(message: string): void;
    promptSelect(
        title: string,
        options: ResumeSelectItem[],
        hooks?: { layout?: SelectListLayoutOptions },
    ): Promise<string | null>;
    clearMessages?(): void;
}

interface ResumeCommandEditor {
    disableSubmit: boolean;
    setText(text: string): void;
}

interface ResumeCommandOptions {
    uiAPI?: ResumeCommandUi;
    editor?: ResumeCommandEditor;
    sessionRuntime?: SessionRuntime;
    sessionId?: string;
    replaceRuntimeSession?(sessionId: string): void;
}

function getCurrentModelContextWindow(): number {
    try {
        const settingsManager = getSettingsManager();
        const provider = settingsManager.getDefaultProvider();
        const modelId = settingsManager.getDefaultModel();
        if (provider && modelId) {
            const model = getModelRegistry().find(provider, modelId);
            if (model && typeof model.contextWindow === "number") return model.contextWindow;
        }
    } catch {
        // Configuration errors are represented by the engine's default context size.
    }
    return DEFAULT_CONTEXT_WINDOW;
}

export function getResumeModelSelection(sessionModel: PersistedModelSelection | null): ResumeModelSelection {
    if (sessionModel?.provider && sessionModel.modelId) {
        try {
            const registry = getModelRegistry();
            const model = registry.find(sessionModel.provider, sessionModel.modelId);
            if (model && registry.isSelectable(model)) {
                return {
                    modelOverride: `${model.provider}/${model.id}`,
                    contextWindow: typeof model.contextWindow === "number"
                        ? model.contextWindow
                        : DEFAULT_CONTEXT_WINDOW,
                };
            }
        } catch {
            // An unavailable historical model is intentionally replaced by the current configured model.
        }
    }
    return { modelOverride: undefined, contextWindow: getCurrentModelContextWindow() };
}

export function getCompactThresholdPercent(): number {
    try {
        const value = getMergedCustomSetting("compactOnResumeThresholdPercent");
        if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100) return value;
    } catch {
        // Invalid settings use the documented default threshold.
    }
    return DEFAULT_COMPACT_ON_RESUME_PCT;
}

function getTerminalColumns(): number {
    try {
        const columns = process.stdout.columns;
        if (columns > 0) return columns;
    } catch {
        // Non-TTY output (tests, pipes) uses the fallback width.
    }
    return FALLBACK_TERMINAL_COLUMNS;
}

export async function runResumeCommand(argv: string[], options: ResumeCommandOptions = {}): Promise<void> {
    const { uiAPI, editor, sessionRuntime, sessionId, replaceRuntimeSession } = options;
    if (!uiAPI || !editor) {
        const requestedSessionId = argv[0]?.trim() || "";
        if (!requestedSessionId) {
            console.error("Usage: wld resume <session-id>");
            return;
        }
        const { SYSTEM_INTERACTIVE_SESSION_PORT } = await import("../../ui/tui/interactive-session-port.ts");
        await SYSTEM_INTERACTIVE_SESSION_PORT.startInteractiveSession(null, {
            sessionStartMode: "continue",
            resumeSessionId: requestedSessionId,
        });
        return;
    }
    if (!sessionRuntime || !sessionId || !replaceRuntimeSession) {
        throw new Error("Resume requires an active runtime session and replacement surface.");
    }

    const current = sessionRuntime.getSessionSnapshot(sessionId);
    if (!current) throw new Error("The active runtime session is missing.");
    const sessions = await sessionRuntime.listResumableSessions(current.cwd);
    if (sessions.length === 0) {
        uiAPI.appendSystemMessage("No recent sessions found to resume.");
        return;
    }

    const items = sessions.map((session) => {
        const display = (session.firstMessage || session.id).trim().replace(/\n/g, " ");
        return {
            value: session.path,
            label: session.name ? `${session.name} (${display})` : display,
            description: `${new Date(session.modified || 0).toLocaleString()} | Messages: ${session.messageCount}`,
        };
    });
    // Give the name column every column the widest description does not need, so
    // names stretch across the terminal while the full date stays visible.
    const widestDescription = Math.max(...items.map((item) => item.description.length));
    const maxPrimaryColumnWidth = Math.max(
        MIN_PRIMARY_COLUMN_WIDTH,
        getTerminalColumns() - SELECT_CHROME_WIDTH - widestDescription,
    );

    const selectedPath = await uiAPI.promptSelect("Select a session to resume:", items, {
        layout: {
            maxPrimaryColumnWidth,
            truncatePrimary: ({ text, maxWidth }) =>
                text.length > maxWidth ? `${text.slice(0, Math.max(0, maxWidth - 1))}…` : text,
        },
    });
    if (!selectedPath) {
        editor.setText("");
        editor.disableSubmit = false;
        return;
    }

    const selected = sessions.find((session) => session.path === selectedPath);
    if (!selected) throw new Error("Selected persisted session is no longer available.");
    const inspection = await sessionRuntime.inspectResumableSession({
        cwd: current.cwd,
        sessionId: selected.id,
        sessionPath: selected.path,
    });
    const { modelOverride, contextWindow } = getResumeModelSelection(inspection.model);
    const thresholdTokens = contextWindow * (getCompactThresholdPercent() / 100);
    let compact = false;

    if (inspection.estimatedTokens > thresholdTokens) {
        const pctUsed = ((inspection.estimatedTokens / contextWindow) * 100).toFixed(1);
        const choice = await uiAPI.promptSelect("Session is large — how would you like to resume?", [
            {
                value: "compact",
                label: `Compact now (estimated ~${pctUsed}% of ${contextWindow.toLocaleString()} tokens)`,
            },
            { value: "resume", label: "Resume as-is" },
            { value: "cancel", label: "Cancel" },
        ]);
        if (!choice || choice === "cancel") {
            editor.setText("");
            editor.disableSubmit = false;
            return;
        }
        compact = choice === "compact";
    }

    const loaded = await sessionRuntime.loadSession({
        cwd: current.cwd,
        sessionId: selected.id,
        sessionPath: selected.path,
        modelOverride,
    });
    replaceRuntimeSession(loaded.sessionId);
    let notice = buildConversationRestoredMessage();

    if (compact) {
        uiAPI.appendSystemMessage("Compacting session before resume... (Esc to cancel)");
        try {
            const result = await sessionRuntime.compactSession(loaded.sessionId);
            if ("ok" in result && result.ok === false) throw new Error(result.error);
            notice = `Conversation compacted and restored. Previous size: ${
                (result.tokensBefore ?? 0).toLocaleString()
            } tokens.`;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const canceled = message === "Compaction cancelled" || message.includes("cancelled");
            if (!canceled) console.error("[RunWield] resume_compaction_failed", error);
            notice = canceled
                ? `Compaction cancelled, resuming as-is...\n${notice}`
                : `Compaction could not finish. Resuming without it.\n${notice}`;
        }
    }

    uiAPI.clearMessages?.();
    await sessionRuntime.replaySession(loaded.sessionId);
    const resumed = sessionRuntime.getSessionSnapshot(loaded.sessionId);
    if (resumed?.managed?.syncState?.status === "active_elsewhere") {
        notice = buildConversationRestoredMessage(resumed.managed.syncState.owningSurfaceKind);
    }
    uiAPI.appendSystemMessage(notice);
    setTerminalTitleForName(resumed?.name);
}
