import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { resetTuiState } from "../command-helpers.ts";

test("resetTuiState re-enables input and focus", () => {
    let busy = true;
    let enabled = false;
    let focused = false;

    const editor = /** @type {any} */ ({ disableSubmit: true });
    const uiAPI = /** @type {any} */ ({
        setBusy: (/** @type {boolean} */ v) => {
            busy = v;
        },
        enableInput: () => {
            enabled = true;
        },
    });
    const tui = /** @type {any} */ ({
        setFocus: () => {
            focused = true;
        },
    });

    resetTuiState(editor, uiAPI, tui);

    assertEquals(editor.disableSubmit, false);
    assertEquals(busy, false);
    assertEquals(enabled, true);
    assertEquals(focused, true);
});
