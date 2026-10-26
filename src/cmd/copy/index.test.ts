import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { runCopyCommand } from "./index.ts";
import type { UiAPI } from "../../ui/tui/types.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";

type AssistantTextReader = (() => null) | SessionRuntime["getLastAssistantText"];

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

test("runCopyCommand obtains assistant text only through SessionRuntime", async () => {
    const { uiAPI, messages } = makeUi();
    await runCopyCommand([], {
        uiAPI,
        sessionId: "copy-test",
        sessionRuntime: {
            getLastAssistantText: (() => null) as AssistantTextReader,
        } as SessionRuntime,
    });
    assertEquals(messages, ["Nothing to copy — no assistant message found."]);
});
