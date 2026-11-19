import { Container, fuzzyFilter, getKeybindings, Input, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { Focusable, TUI } from "@earendil-works/pi-tui";
import type { RunWieldModel, RunWieldModelRegistry } from "../../shared/models/model-registry.ts";
import { theme } from "../theme/theme.ts";

interface ModelItem {
    provider: string;
    id: string;
    model: RunWieldModel;
}

export interface RunWieldModelSelectorOptions {
    tui: TUI;
    currentModel?: RunWieldModel;
    modelRegistry: RunWieldModelRegistry;
    onSelect(model: RunWieldModel): Promise<void> | void;
    onCancel(): void;
    initialSearchInput?: string;
}

function modelsAreEqual(left: RunWieldModel | undefined, right: RunWieldModel | undefined): boolean {
    return Boolean(left && right && left.provider === right.provider && left.id === right.id);
}

function modelReference(model: RunWieldModel): string {
    return `${model.provider}/${model.id}`;
}

function backendLabel(model: RunWieldModel): string {
    if (model.executionBackend === "claude-cli" || model.provider === "claude-cli") return "Claude CLI";
    if (model.executionBackend === "agy-cli" || model.provider === "agy-cli") return "Antigravity CLI";
    return model.provider;
}

function modelSearchText(item: ModelItem): string {
    return `${item.provider}/${item.id} ${item.model.name || ""} ${backendLabel(item.model)}`;
}

function sortModels(currentModel: RunWieldModel | undefined, models: ModelItem[]): ModelItem[] {
    return [...models].sort((left, right) => {
        const leftCurrent = modelsAreEqual(currentModel, left.model);
        const rightCurrent = modelsAreEqual(currentModel, right.model);
        if (leftCurrent && !rightCurrent) return -1;
        if (!leftCurrent && rightCurrent) return 1;
        const backendOrder = backendLabel(left.model).localeCompare(backendLabel(right.model));
        if (backendOrder !== 0) return backendOrder;
        return modelReference(left.model).localeCompare(modelReference(right.model));
    });
}

export class RunWieldModelSelectorComponent extends Container implements Focusable {
    private readonly tui: TUI;
    private readonly currentModel?: RunWieldModel;
    private readonly modelRegistry: RunWieldModelRegistry;
    private readonly onSelectCallback: (model: RunWieldModel) => Promise<void> | void;
    private readonly onCancelCallback: () => void;
    private readonly searchInput: Input;
    private readonly listContainer = new Container();
    private allModels: ModelItem[] = [];
    private filteredModels: ModelItem[] = [];
    private selectedIndex = 0;
    private errorMessage = "";
    private refreshStatusMessage = "";
    private refreshStatusSuccess = false;
    private closed = false;
    private refreshController?: AbortController;
    private _focused = false;

    constructor(options: RunWieldModelSelectorOptions) {
        super();
        this.tui = options.tui;
        this.currentModel = options.currentModel;
        this.modelRegistry = options.modelRegistry;
        this.onSelectCallback = options.onSelect;
        this.onCancelCallback = options.onCancel;

        this.addChild(new Text(theme.fg("borderAccent", "────────────────────────────────────────"), 0, 0));
        this.addChild(new Spacer(1));
        this.addChild(
            new Text(
                theme.fg(
                    "warning",
                    "Only showing models from configured providers plus supported external CLI models.",
                ),
                0,
                0,
            ),
        );
        this.addChild(
            new Text(
                theme.fg(
                    "muted",
                    "Use /login for API providers. External CLI choices require their CLI installed and signed in.",
                ),
                0,
                0,
            ),
        );
        this.addChild(new Spacer(1));

        this.searchInput = new Input();
        if (options.initialSearchInput) this.searchInput.setValue(options.initialSearchInput);
        this.searchInput.onSubmit = () => this.selectCurrent();
        this.addChild(this.searchInput);
        this.addChild(new Spacer(1));
        this.addChild(this.listContainer);
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("borderAccent", "────────────────────────────────────────"), 0, 0));

        this.loadModelsFromRegistry();
        this.filterModels(options.initialSearchInput || "");
        this.tui.requestRender();
    }

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.searchInput.focused = value;
    }

    getSearchInput(): Input {
        return this.searchInput;
    }

    private loadModelsFromRegistry(): void {
        this.allModels = sortModels(
            this.currentModel,
            this.modelRegistry.getSelectable().map((model) => ({ provider: model.provider, id: model.id, model })),
        );
        this.filteredModels = this.allModels;
        const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
        this.selectedIndex =
            currentIndex >= 0
                ? currentIndex
                : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    }

    private async refreshModels(force = false): Promise<void> {
        if (this.refreshController) return;
        const controller = new AbortController();
        this.refreshController = controller;
        const timeout = setTimeout(() => controller.abort(), 15_000);
        this.errorMessage = "";
        this.refreshStatusMessage = "Refreshing Pi model catalogs…";
        this.refreshStatusSuccess = false;
        this.updateList();
        this.tui.requestRender();
        try {
            await this.modelRegistry.refresh({
                signal: controller.signal,
                ...(force ? { allowNetwork: true, force: true } : {}),
            });
            if (this.closed) return;
            this.errorMessage = this.modelRegistry.getError() || "";
            this.refreshStatusMessage = this.errorMessage ? "" : "Pi model catalogs refreshed.";
            this.refreshStatusSuccess = !this.errorMessage;
            this.loadModelsFromRegistry();
            this.filterModels(this.searchInput.getValue());
            this.tui.requestRender();
        } catch (error) {
            if (this.closed) return;
            const message = error instanceof Error ? error.message : String(error);
            this.errorMessage = `Could not refresh model catalogs; showing cached models. ${message}`;
            this.refreshStatusMessage = "";
            this.updateList();
            this.tui.requestRender();
        } finally {
            clearTimeout(timeout);
            this.refreshController = undefined;
        }
    }

    private close(): void {
        this.closed = true;
        this.refreshController?.abort();
    }

    private filterModels(query: string): void {
        this.filteredModels = query ? fuzzyFilter(this.allModels, query, modelSearchText) : this.allModels;
        this.selectedIndex = Math.min(this.selectedIndex, this.filteredModels.length - 1);
        this.updateList();
    }

    private updateList(): void {
        this.listContainer.clear();
        const refreshSelected = this.selectedIndex === -1;
        this.listContainer.addChild(
            new Text(
                theme.fg(
                    refreshSelected ? "accent" : "muted",
                    `${refreshSelected ? "→ " : "  "}Refresh catalog (Ctrl+R)`,
                ),
                0,
                0,
            ),
        );
        const maxVisible = 10;
        const startIndex = Math.max(
            0,
            Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
        );
        const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

        for (let index = startIndex; index < endIndex; index += 1) {
            const item = this.filteredModels[index];
            if (!item) continue;
            const selected = index === this.selectedIndex;
            const current = modelsAreEqual(this.currentModel, item.model);
            const prefix = selected ? theme.fg("accent", "→ ") : "  ";
            const reference = selected ? theme.fg("accent", modelReference(item.model)) : modelReference(item.model);
            const label = theme.fg("muted", `[${backendLabel(item.model)}]`);
            const checkmark = current ? theme.fg("success", " ✓ current") : "";
            this.listContainer.addChild(new Text(`${prefix}${reference} ${label}${checkmark}`, 0, 0));
        }

        if (this.selectedIndex >= 0 && (startIndex > 0 || endIndex < this.filteredModels.length)) {
            this.listContainer.addChild(
                new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0),
            );
        }

        if (this.errorMessage) {
            for (const line of this.errorMessage.split("\n")) {
                this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
            }
        } else if (this.filteredModels.length === 0) {
            this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
        } else {
            const selected = this.filteredModels[this.selectedIndex];
            if (selected) {
                this.listContainer.addChild(new Spacer(1));
                this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
                if (selected.model.executionBackend === "claude-cli" || selected.model.provider === "claude-cli") {
                    this.listContainer.addChild(
                        new Text(
                            theme.fg(
                                "muted",
                                "  Claude Code must be installed and signed in; RunWield checks it on first turn.",
                            ),
                            0,
                            0,
                        ),
                    );
                }
                if (selected.model.executionBackend === "agy-cli" || selected.model.provider === "agy-cli") {
                    this.listContainer.addChild(
                        new Text(
                            theme.fg(
                                "muted",
                                "  Agy must be installed and signed in; first use asks before RunWield MCP setup.",
                            ),
                            0,
                            0,
                        ),
                    );
                }
            }
        }

        if (this.refreshStatusMessage) {
            this.listContainer.addChild(new Spacer(1));
            this.listContainer.addChild(
                new Text(
                    theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`),
                    0,
                    0,
                ),
            );
        }
    }

    handleInput(keyData: string): void {
        const keybindings = getKeybindings();
        if (matchesKey(keyData, "ctrl+r")) {
            void this.refreshModels(true);
        } else if (keybindings.matches(keyData, "tui.select.up")) {
            this.selectedIndex = this.selectedIndex === -1 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
            this.updateList();
            this.tui.requestRender();
        } else if (keybindings.matches(keyData, "tui.select.down")) {
            this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? -1 : this.selectedIndex + 1;
            this.updateList();
            this.tui.requestRender();
        } else if (keybindings.matches(keyData, "tui.select.confirm")) {
            this.selectCurrent();
        } else if (keybindings.matches(keyData, "tui.select.cancel")) {
            this.close();
            this.onCancelCallback();
        } else {
            this.searchInput.handleInput(keyData);
            this.filterModels(this.searchInput.getValue());
            this.tui.requestRender();
        }
    }

    private selectCurrent(): void {
        if (this.selectedIndex === -1) {
            void this.refreshModels(true);
            return;
        }
        const selected = this.filteredModels[this.selectedIndex];
        if (!selected) return;
        this.close();
        void this.onSelectCallback(selected.model);
    }
}
