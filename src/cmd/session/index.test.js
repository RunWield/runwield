import { assertEquals } from "@std/assert";
import { runSessionCommand } from "./index.ts";
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

Deno.test("runSessionCommand reports a missing Runtime session", async () => {
    const { uiAPI, messages } = makeUi();
    await runSessionCommand([], { uiAPI });
    assertEquals(messages, ["Error: No active session."]);
});

Deno.test("runSessionCommand reports typed Runtime session-info failures", async () => {
    const { uiAPI, messages } = makeUi();
    await runSessionCommand([], {
        uiAPI,
        sessionId: "runtime-id",
        sessionRuntime: /** @type {any} */ ({
            getSessionInfo: () => ({ ok: false, error: "committed_generation_unavailable" }),
        }),
    });

    assertEquals(messages, ["Error: Session info is unavailable (committed_generation_unavailable)."]);
});

Deno.test("runSessionCommand formats the Runtime session-info projection", async () => {
    const { uiAPI, messages } = makeUi();
    await runSessionCommand([], {
        uiAPI,
        sessionId: "runtime-id",
        sessionRuntime: /** @type {any} */ ({
            getSessionInfo: () => ({
                name: "Deep Work",
                file: "/tmp/session.jsonl",
                persistedId: "session-123",
                compactionCount: 1,
                userMessages: 2,
                assistantMessages: 1,
                toolCalls: 1,
                toolResults: 1,
                inputTokens: 1000,
                outputTokens: 250,
                cacheReadTokens: 500,
                cacheWriteTokens: 25,
                compactionSettings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 22000 },
                contextUsage: { tokens: 96000, contextWindow: 128000, percent: 75 },
            }),
        }),
    });

    const plain = messages.join("\n");
    for (
        const expected of [
            "Session compacted 1 time",
            "Deep Work",
            "/tmp/session.jsonl",
            "session-123",
            "96,000/128,000 (75.0%)",
            "1,775",
        ]
    ) {
        assertEquals(plain.includes(expected), true);
    }
});
