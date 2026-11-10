import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { runCopyCommand } from "./index.ts";
import type { UiAPI } from "../../ui/tui/api.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.ts";

initRunWieldTheme();

function makeUi() {
    const messages: string[] = [];
    return {
        messages,
        uiAPI: {
            appendSystemMessage: ((message: string) => messages.push(message)) as UiAPI["appendSystemMessage"],
        } as UiAPI,
    };
}

test("runCopyCommand requires a Runtime session id", async () => {
    const { uiAPI, messages } = makeUi();
    await runCopyCommand([], { uiAPI });
    assertEquals(messages, ["Error: No active agent session."]);
});
