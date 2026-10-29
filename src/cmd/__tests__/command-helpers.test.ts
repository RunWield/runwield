import type { EditorAPI, UiAPI, TuiAPI } from "../../ui/tui/types.js";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { resetTuiState } from "../command-helpers.ts";

test("resetTuiState re-enables input and focus", () => {
    let busy = true;
    let enabled = false;
    let focused = false;

    const editor: Partial<EditorAPI> = { disableSubmit: true };
    const uiAPI: Partial<UiAPI> = {
        setBusy: (v: boolean) => {
            busy = v;
        },
        enableInput: () => {
            enabled = true;
        },
    };
    const tui: Partial<TuiAPI> = {
        setFocus: () => {
            focused = true;
        },
    };

    // Preserve the minimal fixtures while checking each provided member against its owning API.
    resetTuiState(editor as EditorAPI, uiAPI as UiAPI, tui as TuiAPI);

    assertEquals(editor.disableSubmit, false);
    assertEquals(busy, false);
    assertEquals(enabled, true);
    assertEquals(focused, true);
});
