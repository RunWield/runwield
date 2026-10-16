import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { runCopyCommand } from "./index.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";

initRunWieldTheme();

function makeUi() {
    const messages = /** @type {string[]} */ ([]);
    return {
        messages,
        uiAPI: /** @type {any} */ ({
            appendSystemMessage: (/** @type {string} */ message) => messages.push(message),
        }),
    };
}

test("runCopyCommand requires a Runtime session id", async () => {
    const { uiAPI, messages } = makeUi();
    await runCopyCommand([], { uiAPI });
    assertEquals(messages, ["Error: No active agent session."]);
});

test("runCopyCommand obtains assistant text only through SessionRuntime", async () => {
    const { uiAPI, messages } = makeUi();
    await runCopyCommand([], {
        uiAPI,
        sessionId: "copy-test",
        sessionRuntime: /** @type {any} */ ({ getLastAssistantText: () => null }),
    });
    assertEquals(messages, ["Nothing to copy — no assistant message found."]);
});
