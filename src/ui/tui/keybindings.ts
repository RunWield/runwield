import process from "node:process";
/**
 * @module ui/tui/keybindings
 *
 * Wraps the editor's input handler with chat-session keybindings.
 */

import { type Container, type Editor, Image, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { stopTUI } from "./tui.ts";
import { cleanupAgentBrowserSessionSync } from "../../shared/agent-browser-session.ts";
import type { ImageAttachment } from "../../shared/session/types.js";
import { imageTheme } from "../theme/theme.js";
import type { GenerationGuard } from "./generation-guard.ts";
import type { UiAPI } from "./types.js";

interface KeyboardHelpResult {
    ok: boolean;
    error?: string;
}

export interface KeybindingsContext {
    editor: Editor;
    tui: TUI;
    uiAPI: UiAPI;
    pastedImages: ImageAttachment[];
    previewImages: Container;
    generationGuard: GenerationGuard;
    dismissActivePrompt(): void;
    dequeueLastSubmission(): boolean | Promise<boolean>;
    recallQueuedSubmissionsToEditor(): void | Promise<void>;
    forceResetUI(): void;
    markCtrlCPendingExit(): void;
    isCtrlCPendingExit(): boolean;
    requestKeyboardHelp?: () => KeyboardHelpResult | void | Promise<KeyboardHelpResult | void>;
    hideKeyboardHelp?: () => void;
    cycleThinkingLevel(): void;
    readClipboardImage(): Promise<{ base64: string; mimeType: string } | null>;
    onClipboardImageMissing?(): void;
    onInput?(): void;
    handleImagePaste?: (image: ImageAttachment) => Promise<ImageAttachment | null>;
    cancelRuntimeSession(): boolean;
}

interface KeybindingsLifecycle {
    disposed: boolean;
}

const keybindingsLifecycles = new WeakMap<Editor, KeybindingsLifecycle>();

export function disposeKeybindings(editor: Editor): void {
    const lifecycle = keybindingsLifecycles.get(editor);
    if (!lifecycle) return;
    lifecycle.disposed = true;
    keybindingsLifecycles.delete(editor);
}

function isEditorEmpty(editor: Editor): boolean {
    return editor.getText() === "";
}

function createPastedImagePreview(image: ImageAttachment): Image {
    return new Image(image.base64, image.mimeType, imageTheme, {
        filename: image.ref || image.path || image.mimeType,
        maxWidthCells: 30,
        maxHeightCells: 10,
    });
}

/**
 * Install custom keybindings on the editor. Returns the unwrapped handler so
 * callers can re-invoke the original behavior.
 */
export function installKeybindings(ctx: KeybindingsContext): (data: string) => void {
    const {
        editor,
        tui,
        uiAPI,
        pastedImages,
        previewImages,
        generationGuard,
        dismissActivePrompt,
        dequeueLastSubmission,
        recallQueuedSubmissionsToEditor,
        forceResetUI,
        markCtrlCPendingExit,
        isCtrlCPendingExit,
        requestKeyboardHelp,
        hideKeyboardHelp,
        cycleThinkingLevel,
        handleImagePaste,
        readClipboardImage,
    } = ctx;
    function cancelEverything(): void {
        generationGuard.invalidateAll();
        dismissActivePrompt();
        ctx.cancelRuntimeSession();
        forceResetUI();
    }

    const lifecycle: KeybindingsLifecycle = { disposed: false };
    keybindingsLifecycles.set(editor, lifecycle);
    const originalHandleInput = editor.handleInput.bind(editor);
    let pendingClipboardRead: Promise<ImageAttachment | null> | null = null;

    editor.handleInput = async (data: string): Promise<void> => {
        if (pendingClipboardRead) {
            try {
                await pendingClipboardRead;
            } catch {
                // The paste handler reports clipboard failures. Keep later input responsive.
            }
        }
        if (lifecycle.disposed) return;
        ctx.onInput?.();
        if (matchesKey(data, Key.escape)) {
            hideKeyboardHelp?.();
            await recallQueuedSubmissionsToEditor();
            cancelEverything();
            tui.requestRender();
            return;
        }

        if (matchesKey(data, Key.ctrl("c"))) {
            if (isCtrlCPendingExit()) {
                stopTUI();
                cleanupAgentBrowserSessionSync();
                setTimeout(() => process.exit(0), 100);
                return;
            }
            editor.setText("");
            if (pastedImages.length > 0) {
                pastedImages.length = 0;
                while (previewImages.children.length > 0) {
                    previewImages.removeChild(previewImages.children[previewImages.children.length - 1]);
                }
            }
            markCtrlCPendingExit();
            return;
        }

        if (matchesKey(data, Key.ctrl("v"))) {
            const imageRead = readClipboardImage();
            pendingClipboardRead = imageRead;
            let img: ImageAttachment | null;
            try {
                img = await imageRead;
            } finally {
                if (pendingClipboardRead === imageRead) pendingClipboardRead = null;
            }
            if (lifecycle.disposed) return;
            if (!img) {
                ctx.onClipboardImageMissing?.();
                return;
            }
            pastedImages.push(img);
            previewImages.addChild(createPastedImagePreview(img));
            tui.requestRender();
            if (handleImagePaste) {
                handleImagePaste(img)
                    .then((attachment) => {
                        if (lifecycle.disposed) return;
                        if (!attachment) {
                            const index = pastedImages.indexOf(img);
                            if (index >= 0) {
                                pastedImages.splice(index, 1);
                                const preview = previewImages.children[index];
                                if (preview) previewImages.removeChild(preview);
                            }
                        } else if (attachment !== img) {
                            Object.assign(img, attachment);
                        }
                        tui.requestRender();
                    })
                    .catch((error) => {
                        if (lifecycle.disposed) return;
                        const index = pastedImages.indexOf(img);
                        if (index >= 0) {
                            pastedImages.splice(index, 1);
                            const preview = previewImages.children[index];
                            if (preview) previewImages.removeChild(preview);
                        }
                        const message = error instanceof Error ? error.message : String(error);
                        uiAPI.appendSystemMessage(`Cannot attach pasted image: ${message}`);
                        tui.requestRender();
                    });
            }
            return;
        }

        if (matchesKey(data, Key.ctrl("o"))) {
            if (uiAPI.toggleToolOutputsExpanded) {
                uiAPI.toggleToolOutputsExpanded();
                tui.requestRender();
                return;
            }
            tui.requestRender();
            return;
        }

        if (data === "?" && isEditorEmpty(editor) && pastedImages.length === 0) {
            await requestKeyboardHelp?.();
            tui.requestRender();
            return;
        }

        if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.alt("enter"))) {
            hideKeyboardHelp?.();
            editor.insertTextAtCursor("\n");
            tui.requestRender();
            return;
        }

        if (matchesKey(data, Key.backspace) && isEditorEmpty(editor) && pastedImages.length > 0) {
            pastedImages.pop();
            const lastChild = previewImages.children[previewImages.children.length - 1];
            if (lastChild) previewImages.removeChild(lastChild);
            tui.requestRender();
            return;
        }

        if (matchesKey(data, Key.shift("tab"))) {
            hideKeyboardHelp?.();
            cycleThinkingLevel();
            tui.requestRender();
            return;
        }

        if (matchesKey(data, Key.up) && isEditorEmpty(editor)) {
            if (await dequeueLastSubmission()) {
                hideKeyboardHelp?.();
                return;
            }
        }

        hideKeyboardHelp?.();
        originalHandleInput(data);
    };

    return originalHandleInput;
}
