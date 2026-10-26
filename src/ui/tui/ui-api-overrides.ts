/** Chat-session-specific input and model-selection behavior. */

import { type Component, type Container, type Editor, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { AgyCliMcpSetupApprovalError } from "../../shared/session/backends/agy-cli/mcp-setup.ts";
import { RunWieldModelSelectorComponent } from "./model-selector.ts";

interface ActiveModelState {
    model: string;
    provider?: string;
}

interface ModelActivationResult {
    status?: "active" | "deferred";
    message?: string;
}

interface InstallUiApiOverridesOptions {
    uiAPI: import("./types.js").UiAPI;
    tui: TUI;
    editor: Editor;
    container: Container;
    getProjectRoot(): string;
    setActiveModel(
        model: string,
        provider?: string,
    ): Promise<ModelActivationResult | void> | ModelActivationResult | void;
    getActiveModelState?: () => ActiveModelState;
}

export function installUiApiOverrides({
    uiAPI,
    tui,
    editor,
    container,
    getProjectRoot: _getProjectRoot,
    setActiveModel,
    getActiveModelState = () => ({ model: "", provider: "" }),
}: InstallUiApiOverridesOptions): void {
    const hiddenInput: Component = {
        render: () => [],
        invalidate: () => {},
        handleInput(data) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
                void editor.handleInput(data);
            }
        },
    };

    let hiddenInputDepth = 0;
    let editorIndex = -1;
    let wasDisabled = false;

    async function runWithInlinePrompt<Result>(openPrompt: () => Promise<Result>): Promise<Result> {
        if (hiddenInputDepth === 0) {
            wasDisabled = editor.disableSubmit === true;
            editorIndex = container.children.indexOf(editor);
            editor.disableSubmit = true;
            if (editorIndex !== -1) {
                container.children.splice(editorIndex, 1);
                tui.setFocus(hiddenInput);
            }
        }
        hiddenInputDepth++;
        tui.requestRender();
        try {
            return await openPrompt();
        } finally {
            hiddenInputDepth--;
            if (hiddenInputDepth === 0) {
                editor.disableSubmit = wasDisabled;
                if (editorIndex !== -1 && !container.children.includes(editor)) {
                    container.children.splice(Math.min(editorIndex, container.children.length), 0, editor);
                    tui.setFocus(editor);
                }
            } else if (!uiAPI.focusActivePrompt?.()) {
                tui.setFocus(hiddenInput);
            }
            tui.requestRender();
        }
    }

    uiAPI.disableInput = () => {
        editor.disableSubmit = true;
        tui.requestRender();
    };

    uiAPI.enableInput = () => {
        editor.disableSubmit = false;
        tui.requestRender();
    };

    uiAPI.withHiddenInput = runWithInlinePrompt;

    const basePromptSelect = uiAPI.promptSelect.bind(uiAPI);
    uiAPI.promptSelect = (...args) => runWithInlinePrompt(() => basePromptSelect(...args));

    const basePromptText = uiAPI.promptText.bind(uiAPI);
    uiAPI.promptText = (...args) => runWithInlinePrompt(() => basePromptText(...args));

    uiAPI.promptComposerText = (title, promptOptions = {}) => {
        return new Promise((resolve) => {
            const previousSubmit = editor.onSubmit;
            const previousDisabled = editor.disableSubmit === true;
            const previousText = editor.getText?.() || "";
            const allowEmpty = promptOptions.allowEmpty !== false;
            const hint = promptOptions.placeholder ? `${promptOptions.placeholder} ` : "";
            uiAPI.appendSystemMessage(`${hint}Use the message input below. Press Enter to send.`, false, title);
            editor.disableSubmit = false;
            editor.setText(promptOptions.defaultValue || "");
            tui.setFocus(editor);
            tui.requestRender();

            const restore = () => {
                editor.onSubmit = previousSubmit;
                editor.disableSubmit = previousDisabled;
                if (previousText) editor.setText(previousText);
                tui.requestRender();
            };

            editor.onSubmit = (text: string) => {
                const finalValue = text || promptOptions.defaultValue || "";
                if (!allowEmpty && !finalValue.trim()) {
                    editor.setText(text);
                    tui.requestRender();
                    return;
                }
                editor.setText("");
                restore();
                resolve(finalValue);
            };
        });
    };

    uiAPI.showModelSelector = (initialSearchInput?: string) => {
        return new Promise((resolve, reject) => {
            const modelRegistry = getModelRegistry();
            const activeModelState = getActiveModelState();
            const currentModel = modelRegistry.find(activeModelState.provider || "", activeModelState.model || "");
            const editorIndex = container.children.indexOf(editor);
            let selector: RunWieldModelSelectorComponent;
            let settled = false;

            const restoreSelector = (selected: boolean) => {
                if (settled) return;
                settled = true;
                const selectorIndex = container.children.indexOf(selector);
                if (selectorIndex !== -1) container.children.splice(selectorIndex, 1, editor);
                else container.addChild(editor);
                tui.setFocus(editor);
                tui.requestRender();
                resolve({ selected });
            };

            try {
                selector = new RunWieldModelSelectorComponent({
                    tui,
                    currentModel,
                    modelRegistry,
                    onSelect: async (model) => {
                        try {
                            const activation = await setActiveModel(model.id, model.provider);
                            uiAPI.appendSystemMessage(
                                activation?.status === "deferred"
                                    ? activation.message ||
                                          `Saved ${model.provider}/${model.id} for later. The current Session was not switched.`
                                    : `Switched model to ${model.provider}/${model.id}`,
                                false,
                                "RunWield",
                            );
                            restoreSelector(true);
                        } catch (error) {
                            if (error instanceof AgyCliMcpSetupApprovalError) {
                                uiAPI.appendSystemMessage(error.message, true, "RunWield");
                                restoreSelector(false);
                                return;
                            }
                            restoreSelector(false);
                            reject(error);
                        }
                    },
                    onCancel: () => restoreSelector(false),
                    initialSearchInput,
                });

                if (editorIndex !== -1) container.children.splice(editorIndex, 1, selector);
                else container.addChild(selector);
                tui.setFocus(selector);
                tui.requestRender();
            } catch (error) {
                reject(error);
            }
        });
    };
}
