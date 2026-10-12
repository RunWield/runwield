// @ts-nocheck: Workspace React islands compile TSX, but this module uses JSDoc-style JavaScript only.

import { RunWieldSegmentedControl } from "../../design-system/components/react/RunWieldSegmentedControl.tsx";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyboardShortcuts } from "@plannotator/ui/components/KeyboardShortcuts.tsx";
import { OverlayScrollArea } from "@plannotator/ui/components/OverlayScrollArea.tsx";
import { configStore, useConfigValue } from "@plannotator/ui/config/index.ts";
import { getIdentity, regenerateIdentity, setCustomIdentity } from "@plannotator/ui/utils/identity.ts";
import { altKey, isMac } from "@plannotator/ui/utils/platform.ts";
import {
    DEFAULT_QUICK_LABELS,
    getLabelColors,
    getQuickLabels,
    LABEL_COLOR_MAP,
    resetQuickLabels,
    saveQuickLabels,
} from "@plannotator/ui/utils/quickLabels.ts";
import { AUTO_CLOSE_OPTIONS, getAutoCloseDelay, setAutoCloseDelay } from "@plannotator/ui/utils/storage.ts";
import { getUIPreferences, PLAN_WIDTH_OPTIONS, saveUIPreferences } from "@plannotator/ui/utils/uiPreferences.ts";

const SETTINGS_TABS = [
    { id: "general", label: "General" },
    { id: "display", label: "Display" },
    { id: "labels", label: "Labels" },
    { id: "shortcuts", label: "Shortcuts" },
];

const CODE_DIFF_STYLE_OPTIONS = [
    { value: "split", label: "Split" },
    { value: "unified", label: "Unified" },
];
const CODE_INDICATOR_OPTIONS = [
    { value: "bars", label: "Bars" },
    { value: "classic", label: "Classic" },
    { value: "none", label: "None" },
];
const CODE_LINE_DIFF_OPTIONS = [
    { value: "word-alt", label: "Word-Alt" },
    { value: "word", label: "Word" },
    { value: "char", label: "Char" },
    { value: "none", label: "None" },
];
const DEFAULT_CODE_LABELS = [
    { label: "suggestion", display: "suggestion", blocking: true },
    { label: "nitpick", display: "nit", blocking: false },
    { label: "question", display: "question", blocking: true },
    { label: "issue", display: "issue", blocking: true },
    { label: "praise", display: "praise", blocking: false },
    { label: "thought", display: "thought", blocking: false },
    { label: "note", display: "note", blocking: false },
    { label: "todo", display: "todo", blocking: true },
    { label: "chore", display: "chore", blocking: true },
];

export function PlanReviewSettings(
    { mode = "plan", open, onClose, onUIPreferencesChange, codeDiffStyle, onCodeDiffStyleChange },
) {
    const [activeTab, setActiveTab] = useState("general");
    const [identity, setIdentity] = useState("");
    const [autoCloseDelay, setAutoCloseDelayState] = useState("off");
    const [uiPreferences, setUiPreferences] = useState(() => getUIPreferences());
    const [quickLabels, setQuickLabels] = useState(() => getQuickLabels());
    const [editingTipIndex, setEditingTipIndex] = useState(null);
    const [editingTipValue, setEditingTipValue] = useState("");
    const [codeLabels, setCodeLabels] = useState(() => readCodeLabels(null));
    const gridEnabled = useConfigValue("gridEnabled");
    const conventionalComments = useConfigValue("conventionalComments");
    const conventionalLabelsJson = useConfigValue("conventionalLabels");
    const diffStyle = useConfigValue("diffStyle");
    const diffIndicators = useConfigValue("diffIndicators");
    const diffLineDiffType = useConfigValue("diffLineDiffType");
    const diffShowLineNumbers = useConfigValue("diffShowLineNumbers");
    const diffShowBackground = useConfigValue("diffShowBackground");
    const diffExpandUnchanged = useConfigValue("diffExpandUnchanged");
    const diffFontSize = useConfigValue("diffFontSize");

    useEffect(() => {
        if (!open) return;
        setActiveTab("general");
        setIdentity(getIdentity());
        setAutoCloseDelayState(getAutoCloseDelay());
        setUiPreferences(getUIPreferences());
        setQuickLabels(getQuickLabels());
        setCodeLabels(readCodeLabels(conventionalLabelsJson));
        setEditingTipIndex(null);
    }, [open, conventionalLabelsJson]);

    useEffect(() => {
        if (!open) return;
        function handleKeyDown(event) {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
        }
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [open, onClose]);

    if (!open) return null;

    function saveIdentity(value) {
        const saved = setCustomIdentity(value);
        setIdentity(saved);
    }

    function updateUIPreferences(updates) {
        const next = { ...uiPreferences, ...updates };
        setUiPreferences(next);
        saveUIPreferences(next);
        onUIPreferencesChange?.(next);
    }

    function updateQuickLabels(next) {
        setQuickLabels(next);
        saveQuickLabels(next);
    }

    function updateQuickLabel(index, updates) {
        const next = quickLabels.map((label, labelIndex) => labelIndex === index ? { ...label, ...updates } : label);
        updateQuickLabels(next);
    }

    function saveTip(index) {
        updateQuickLabel(index, { tip: editingTipValue || undefined });
        setEditingTipIndex(null);
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
            onClick={onClose}
        >
            <section
                aria-labelledby="plan-review-settings-title"
                aria-modal="true"
                className="relative flex max-h-[85vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
            >
                <header className="flex items-center justify-between border-b border-border p-4">
                    <h2 className="text-sm font-semibold" id="plan-review-settings-title">Settings</h2>
                    <button
                        aria-label="Close settings"
                        className="rounded-md bg-muted p-1.5 text-foreground transition-colors hover:bg-muted/80"
                        onClick={onClose}
                        type="button"
                    >
                        <CloseIcon />
                    </button>
                </header>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:min-h-[420px] md:flex-row">
                    <nav
                        aria-label="Settings sections"
                        className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5 md:hidden"
                    >
                        {SETTINGS_TABS.map((tab) => (
                            <SettingsTabButton
                                active={activeTab === tab.id}
                                key={tab.id}
                                label={tab.label}
                                onClick={() => setActiveTab(tab.id)}
                            />
                        ))}
                    </nav>

                    <nav
                        aria-label="Settings sections"
                        className="hidden w-40 flex-shrink-0 border-r border-border p-2 md:block"
                    >
                        <div className="space-y-0.5">
                            {SETTINGS_TABS.map((tab) => (
                                <SettingsTabButton
                                    active={activeTab === tab.id}
                                    desktop
                                    key={tab.id}
                                    label={tab.label}
                                    onClick={() => setActiveTab(tab.id)}
                                />
                            ))}
                        </div>
                    </nav>

                    <OverlayScrollArea className="min-h-0 flex-1">
                        <div className="space-y-4 p-4">
                            {activeTab === "general" && (
                                <GeneralSettings
                                    autoCloseDelay={autoCloseDelay}
                                    identity={identity}
                                    onAutoCloseDelayChange={(next) => {
                                        setAutoCloseDelayState(next);
                                        setAutoCloseDelay(next);
                                    }}
                                    onIdentityChange={setIdentity}
                                    onIdentityRegenerate={() => setIdentity(regenerateIdentity())}
                                    onIdentitySave={saveIdentity}
                                />
                            )}

                            {activeTab === "display" && (
                                mode === "code"
                                    ? (
                                        <CodeDisplaySettings
                                            diffExpandUnchanged={diffExpandUnchanged}
                                            diffFontSize={diffFontSize}
                                            diffIndicators={diffIndicators}
                                            diffLineDiffType={diffLineDiffType}
                                            diffShowBackground={diffShowBackground}
                                            diffShowLineNumbers={diffShowLineNumbers}
                                            diffStyle={codeDiffStyle || diffStyle}
                                            onDiffStyleChange={onCodeDiffStyleChange ||
                                                ((value) => configStore.set("diffStyle", value))}
                                        />
                                    )
                                    : (
                                        <DisplaySettings
                                            gridEnabled={gridEnabled}
                                            onGridEnabledChange={(next) => configStore.set("gridEnabled", next)}
                                            onUIPreferencesChange={updateUIPreferences}
                                            uiPreferences={uiPreferences}
                                        />
                                    )
                            )}

                            {activeTab === "labels" && (
                                mode === "code"
                                    ? (
                                        <CodeLabelsSettings
                                            enabled={conventionalComments}
                                            labels={codeLabels}
                                            onEnabledChange={(next) => configStore.set("conventionalComments", next)}
                                            onLabelsChange={(next) => {
                                                setCodeLabels(next);
                                                configStore.set("conventionalLabels", JSON.stringify(next));
                                            }}
                                            onReset={() => {
                                                setCodeLabels(DEFAULT_CODE_LABELS.map((label) => ({ ...label })));
                                                configStore.set("conventionalLabels", null);
                                            }}
                                        />
                                    )
                                    : (
                                        <LabelsSettings
                                            editingTipIndex={editingTipIndex}
                                            editingTipValue={editingTipValue}
                                            labels={quickLabels}
                                            onAdd={() => {
                                                updateQuickLabels([
                                                    ...quickLabels,
                                                    {
                                                        id: `custom-${Date.now()}`,
                                                        emoji: "📌",
                                                        text: "New label",
                                                        color: "blue",
                                                    },
                                                ]);
                                            }}
                                            onDelete={(index) => {
                                                updateQuickLabels(
                                                    quickLabels.filter((_, labelIndex) => labelIndex !== index),
                                                );
                                                if (editingTipIndex === index) setEditingTipIndex(null);
                                            }}
                                            onEditTip={(index) => {
                                                if (editingTipIndex === index) {
                                                    setEditingTipIndex(null);
                                                    return;
                                                }
                                                setEditingTipIndex(index);
                                                setEditingTipValue(quickLabels[index].tip || "");
                                            }}
                                            onReset={() => {
                                                resetQuickLabels();
                                                setQuickLabels(DEFAULT_QUICK_LABELS.map((label) => ({ ...label })));
                                                setEditingTipIndex(null);
                                            }}
                                            onSaveTip={saveTip}
                                            onTipValueChange={setEditingTipValue}
                                            onUpdate={updateQuickLabel}
                                        />
                                    )
                            )}

                            {activeTab === "shortcuts" && (
                                <KeyboardShortcuts mode={mode === "code" ? "review" : "plan"} />
                            )}
                        </div>
                    </OverlayScrollArea>
                </div>
            </section>
        </div>,
        document.body,
    );
}

function SettingsTabButton({ active, desktop = false, label, onClick }) {
    return (
        <button
            aria-current={active ? "page" : undefined}
            className={`${
                desktop ? "w-full text-left" : "whitespace-nowrap"
            } flex items-center rounded px-3 py-1.5 text-sm transition-colors ${
                active
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            }`}
            onClick={onClick}
            type="button"
        >
            {label}
        </button>
    );
}

function GeneralSettings({
    autoCloseDelay,
    identity,
    onAutoCloseDelayChange,
    onIdentityChange,
    onIdentityRegenerate,
    onIdentitySave,
}) {
    return (
        <>
            <div className="space-y-2">
                <div>
                    <div className="text-sm font-medium">Your Identity</div>
                    <div className="text-xs text-muted-foreground">Used when sharing annotations with others</div>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        aria-label="Your identity"
                        className="min-w-0 flex-1 truncate rounded-lg border border-transparent bg-muted px-3 py-2 font-mono text-xs transition-colors focus:border-primary/50 focus:outline-none"
                        onBlur={(event) => onIdentitySave(event.target.value)}
                        onChange={(event) => onIdentityChange(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            onIdentitySave(event.currentTarget.value);
                            event.currentTarget.blur();
                        }}
                        placeholder="Enter your name..."
                        type="text"
                        value={identity}
                    />
                    <button
                        className="rounded-lg bg-muted p-2 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                        onClick={onIdentityRegenerate}
                        title="Regenerate random identity"
                        type="button"
                    >
                        <RegenerateIcon />
                    </button>
                </div>
            </div>

            <div className="border-t border-border" />

            <div className="space-y-2">
                <div className="text-sm font-medium">Auto-close Tab</div>
                <select
                    aria-label="Auto-close tab"
                    className="w-full cursor-pointer rounded-lg bg-muted px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
                    onChange={(event) => onAutoCloseDelayChange(event.target.value)}
                    value={autoCloseDelay}
                >
                    {AUTO_CLOSE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
                <div className="text-[10px] text-muted-foreground/70">
                    {AUTO_CLOSE_OPTIONS.find((option) => option.value === autoCloseDelay)?.description}
                </div>
            </div>
        </>
    );
}

function DisplaySettings({ gridEnabled, onGridEnabledChange, onUIPreferencesChange, uiPreferences }) {
    return (
        <>
            <SettingSwitch
                checked={uiPreferences.tocEnabled}
                description="Open sidebar with Table of Contents on load"
                label="Auto-open Sidebar"
                onChange={(checked) => onUIPreferencesChange({ tocEnabled: checked })}
            />
            <div className="border-t border-border" />
            <SettingSwitch
                checked={uiPreferences.stickyActionsEnabled}
                description="Keep action buttons visible while scrolling"
                label="Sticky Actions"
                onChange={(checked) => onUIPreferencesChange({ stickyActionsEnabled: checked })}
            />
            <div className="border-t border-border" />
            <SettingSwitch
                checked={gridEnabled}
                description="Show the plan as a floating card on a grid"
                label="Grid Background"
                onChange={onGridEnabledChange}
            />
            <div className="border-t border-border" />
            <div className="space-y-3">
                <div>
                    <div className="text-sm font-medium">Plan Width</div>
                    <div className="text-xs text-muted-foreground">Maximum width of the plan card</div>
                </div>
                <RunWieldSegmentedControl className="w-full">
                    {PLAN_WIDTH_OPTIONS.map((option) => (
                        <button
                            aria-pressed={uiPreferences.planWidth === option.id}
                            className={uiPreferences.planWidth === option.id ? "active" : ""}
                            key={option.id}
                            onClick={() => onUIPreferencesChange({ planWidth: option.id })}
                            title={option.label}
                            type="button"
                        >
                            <SettingsToggleIcon name={option.id} />
                            <span>{option.label}</span>
                        </button>
                    ))}
                </RunWieldSegmentedControl>
                <div className="text-[10px] text-muted-foreground/70">
                    {PLAN_WIDTH_OPTIONS.find((option) => option.id === uiPreferences.planWidth)?.hint}
                </div>
            </div>
        </>
    );
}

function CodeDisplaySettings({
    diffExpandUnchanged,
    diffFontSize,
    diffIndicators,
    diffLineDiffType,
    diffShowBackground,
    diffShowLineNumbers,
    diffStyle,
    onDiffStyleChange,
}) {
    return (
        <>
            <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <div className="text-sm font-medium">Code Font Size</div>
                        <div className="text-xs text-muted-foreground">Font size for diff code lines</div>
                    </div>
                    <span className="min-w-[4ch] text-right text-xs tabular-nums text-muted-foreground">
                        {diffFontSize || "Auto"}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        aria-label="Code font size"
                        className="h-1.5 flex-1 cursor-pointer accent-primary"
                        max="24"
                        min="8"
                        onChange={(event) => configStore.set("diffFontSize", `${event.target.value}px`)}
                        step="1"
                        type="range"
                        value={diffFontSize ? Number.parseInt(diffFontSize, 10) : 13}
                    />
                    {diffFontSize && (
                        <button
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                            onClick={() => configStore.set("diffFontSize", "")}
                            type="button"
                        >
                            Reset
                        </button>
                    )}
                </div>
            </div>
            <div className="border-t border-border" />
            <CodeDisplayChoice
                description="Side-by-side or inline diff view"
                label="Diff Style"
                onChange={onDiffStyleChange}
                options={CODE_DIFF_STYLE_OPTIONS}
                value={diffStyle}
            />
            <div className="border-t border-border" />
            <CodeDisplayChoice
                description="Style of change markers in the gutter"
                label="Change Indicators"
                onChange={(value) => configStore.set("diffIndicators", value)}
                options={CODE_INDICATOR_OPTIONS}
                value={diffIndicators}
            />
            <div className="border-t border-border" />
            <CodeDisplayChoice
                description="Highlight granularity for inline changes"
                label="Inline Diff Granularity"
                onChange={(value) => configStore.set("diffLineDiffType", value)}
                options={CODE_LINE_DIFF_OPTIONS}
                value={diffLineDiffType}
            />
            <div className="border-t border-border" />
            <SettingSwitch
                checked={diffShowLineNumbers}
                label="Show Line Numbers"
                onChange={(next) => configStore.set("diffShowLineNumbers", next)}
            />
            <div className="border-t border-border" />
            <SettingSwitch
                checked={diffShowBackground}
                description="Colored backgrounds on added and deleted lines"
                label="Show Diff Background"
                onChange={(next) => configStore.set("diffShowBackground", next)}
            />
            <div className="border-t border-border" />
            <SettingSwitch
                checked={diffExpandUnchanged}
                description="Show full file content around changes"
                label="Expand Unchanged Regions"
                onChange={(next) => configStore.set("diffExpandUnchanged", next)}
            />
        </>
    );
}

function CodeDisplayChoice({ description, label, onChange, options, value }) {
    return (
        <div className="space-y-2">
            <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <RunWieldSegmentedControl className="w-full">
                {options.map((option) => (
                    <button
                        aria-pressed={value === option.value}
                        className={value === option.value ? "active" : ""}
                        key={option.value}
                        onClick={() => onChange(option.value)}
                        title={option.label}
                        type="button"
                    >
                        <SettingsToggleIcon name={option.value} />
                        <span>{option.label}</span>
                    </button>
                ))}
            </RunWieldSegmentedControl>
        </div>
    );
}

function SettingSwitch({ checked, description, label, onChange }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <button
                aria-checked={checked}
                aria-label={label}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    checked ? "bg-primary" : "bg-muted"
                }`}
                onClick={() => onChange(!checked)}
                role="switch"
                type="button"
            >
                <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                        checked ? "translate-x-6" : "translate-x-1"
                    }`}
                />
            </button>
        </div>
    );
}

function CodeLabelsSettings({ enabled, labels, onEnabledChange, onLabelsChange, onReset }) {
    function updateLabel(index, updates) {
        onLabelsChange(labels.map((label, labelIndex) => labelIndex === index ? { ...label, ...updates } : label));
    }

    return (
        <>
            <SettingSwitch
                checked={enabled}
                description="Add structured labels to inline review comments"
                label="Conventional Comments"
                onChange={onEnabledChange}
            />
            <div className="border-t border-border" />
            <div className={`space-y-3 ${enabled ? "" : "pointer-events-none opacity-40"}`}>
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <div className="text-sm font-medium">Labels</div>
                        <div className="text-xs text-muted-foreground">Customize comment intent and severity</div>
                    </div>
                    <button
                        className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                        onClick={onReset}
                        type="button"
                    >
                        Reset to defaults
                    </button>
                </div>
                <div className="space-y-1.5">
                    {labels.map((label, index) => (
                        <div
                            className="flex items-center gap-2 rounded-lg bg-muted/40 p-2"
                            key={`${label.label}-${index}`}
                        >
                            <input
                                aria-label={`Code review label ${index + 1}`}
                                className="min-w-0 flex-1 rounded bg-background/80 px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                                onChange={(event) =>
                                    updateLabel(index, {
                                        display: event.target.value,
                                        label: labelId(event.target.value),
                                    })}
                                type="text"
                                value={label.display}
                            />
                            <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <input
                                    checked={label.blocking}
                                    className="accent-primary"
                                    onChange={(event) => updateLabel(index, { blocking: event.target.checked })}
                                    type="checkbox"
                                />
                                Blocking
                            </label>
                            <button
                                aria-label={`Remove ${label.display}`}
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => onLabelsChange(labels.filter((_, labelIndex) => labelIndex !== index))}
                                type="button"
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    ))}
                </div>
                {labels.length < 12 && (
                    <button
                        className="w-full rounded-lg border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                        onClick={() =>
                            onLabelsChange([
                                ...labels,
                                { label: `custom-${labels.length + 1}`, display: "custom", blocking: false },
                            ])}
                        type="button"
                    >
                        + Add label
                    </button>
                )}
            </div>
        </>
    );
}

function LabelsSettings({
    editingTipIndex,
    editingTipValue,
    labels,
    onAdd,
    onDelete,
    onEditTip,
    onReset,
    onSaveTip,
    onTipValueChange,
    onUpdate,
}) {
    return (
        <>
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="text-sm font-medium">Quick Labels</div>
                    <div className="text-xs text-muted-foreground">Preset annotations for one-click feedback</div>
                </div>
                <button
                    className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={onReset}
                    type="button"
                >
                    Reset to defaults
                </button>
            </div>

            <div className="space-y-1.5">
                {labels.map((label, index) => {
                    const colors = getLabelColors(label.color);
                    const editingTip = editingTipIndex === index;
                    return (
                        <div
                            className="overflow-hidden rounded-lg"
                            key={`${label.id}-${index}`}
                            style={{ backgroundColor: colors.bg }}
                        >
                            <div className="flex items-center gap-2 p-2">
                                <span className="flex-shrink-0 text-sm">{label.emoji}</span>
                                <input
                                    aria-label={`Label ${index + 1} text`}
                                    className="min-w-0 flex-1 rounded bg-background/80 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                                    onChange={(event) =>
                                        onUpdate(index, {
                                            text: event.target.value,
                                            id: labelId(event.target.value),
                                        })}
                                    type="text"
                                    value={label.text}
                                />
                                <button
                                    aria-label={`${label.tip ? "Edit" : "Add"} instruction for ${label.text}`}
                                    className={`flex-shrink-0 rounded border p-1 transition-colors ${
                                        label.tip
                                            ? "border-foreground/15 bg-foreground/10 text-foreground/70"
                                            : "border-dashed border-muted-foreground/20 text-muted-foreground/40"
                                    }`}
                                    onClick={() => onEditTip(index)}
                                    title={label.tip || "Add AI instruction tip"}
                                    type="button"
                                >
                                    <TipIcon />
                                </button>
                                <select
                                    aria-label={`Color for ${label.text}`}
                                    className="rounded bg-background/80 px-1.5 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-primary/50"
                                    onChange={(event) => onUpdate(index, { color: event.target.value })}
                                    value={label.color}
                                >
                                    {Object.keys(LABEL_COLOR_MAP).map((color) => (
                                        <option key={color} value={color}>{color}</option>
                                    ))}
                                </select>
                                <span className="w-8 flex-shrink-0 text-center font-mono text-[10px] text-muted-foreground/50">
                                    {index < 10 ? `${altKey}${isMac ? "" : "+"}${index === 9 ? "0" : index + 1}` : ""}
                                </span>
                                <button
                                    aria-label={`Remove ${label.text}`}
                                    className="flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                    onClick={() => onDelete(index)}
                                    type="button"
                                >
                                    <CloseIcon />
                                </button>
                            </div>

                            {editingTip && (
                                <div className="flex items-center gap-1.5 px-2 pb-2">
                                    <input
                                        aria-label={`Instruction for ${label.text}`}
                                        autoFocus
                                        className="ml-6 min-w-0 flex-1 rounded bg-background/60 px-2 py-1 text-[10px] text-muted-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/50"
                                        onChange={(event) => onTipValueChange(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") onSaveTip(index);
                                            if (event.key === "Escape") onEditTip(index);
                                        }}
                                        placeholder="AI instruction tip..."
                                        type="text"
                                        value={editingTipValue}
                                    />
                                    <button
                                        aria-label={`Save instruction for ${label.text}`}
                                        className="flex-shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:bg-green-500/10 hover:text-green-500"
                                        onClick={() => onSaveTip(index)}
                                        type="button"
                                    >
                                        <CheckIcon />
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {labels.length < 12 && (
                <button
                    className="w-full rounded-lg border border-dashed border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                    onClick={onAdd}
                    type="button"
                >
                    + Add label
                </button>
            )}

            <div className="text-[10px] text-muted-foreground/70">
                Use {altKey}
                {isMac ? "" : "+"}1 through {altKey}
                {isMac ? "" : "+"}0 when the annotation toolbar is visible to apply a label instantly.
            </div>
        </>
    );
}

function readCodeLabels(value) {
    if (!value) return DEFAULT_CODE_LABELS.map((label) => ({ ...label }));
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) return DEFAULT_CODE_LABELS.map((label) => ({ ...label }));
        return parsed.map((label) => ({
            label: typeof label?.label === "string" && label.label ? label.label : "custom",
            display: typeof label?.display === "string" && label.display
                ? label.display
                : typeof label?.label === "string" && label.label
                ? label.label
                : "custom",
            blocking: label?.blocking === true || label?.blocking === "true",
        }));
    } catch {
        return DEFAULT_CODE_LABELS.map((label) => ({ ...label }));
    }
}

function labelId(value) {
    return value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function SettingsToggleIcon({ name }) {
    const paths = {
        compact: "M8 5h8v14H8z",
        default: "M6 5h12v14H6z",
        wide: "M4 5h16v14H4z",
        split: "M4 5h7v14H4z M13 5h7v14h-7z",
        unified: "M5 5h14v14H5z M8 9h8M8 13h8M8 17h5",
        scroll: "M7 4h10v16H7z M10 8h4M10 12h4M10 16h4",
        wrap: "M4 7h10a4 4 0 0 1 0 8H9m0 0 3-3m-3 3 3 3",
        bars: "M6 5v14M10 8h8M10 16h5",
        classic: "M5 6h14M5 12h14M5 18h14",
        none: "M6 6l12 12M18 6 6 18",
        "word-alt": "M4 7h7M13 7h7M4 12h10M16 12h4M4 17h5M11 17h9",
        word: "M4 8h16M4 13h12M4 18h8",
        char: "M7 18 12 6l5 12M9 14h6",
    };
    return (
        <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
        >
            <path d={paths[name] || paths.none} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function RegenerateIcon() {
    return (
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function TipIcon() {
    return (
        <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
