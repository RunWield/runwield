/**
 * @module shared/command-helpers
 */

import type { Component } from "@earendil-works/pi-tui";
import type { EditorAPI, TuiAPI, UiAPI } from "../ui/tui/types.js";

type FocusableEditor = EditorAPI & Component;

export function resetTuiState(
    editor: EditorAPI | undefined,
    uiAPI: UiAPI | undefined,
    tui: TuiAPI | undefined,
) {
    if (editor) editor.disableSubmit = false;
    if (uiAPI?.setBusy) uiAPI.setBusy(false);
    if (uiAPI?.enableInput) uiAPI.enableInput();
    if (editor && tui) {
        tui.setFocus(editor as FocusableEditor);
    }
}
