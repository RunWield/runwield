import type { CommandContext } from "../registry.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { runSessionCommand } from "./index.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";

type SessionInfoResult = Awaited<ReturnType<SessionRuntime["getSessionInfo"]>>;
type SessionInfoProjection = Exclude<SessionInfoResult, null | { ok: false }>;
type SessionInfoFailure = Extract<SessionInfoResult, { ok: false }>;
interface SessionProjectionFixture extends Partial<
    Omit<SessionInfoProjection, "compactionSettings" | "usageAvailability">
> {
    compactionSettings?: ReturnType<SettingsManager["getCompactionSettings"]>;
    usageAvailability?: Partial<SessionInfoProjection["usageAvailability"]>;
}

interface SessionRuntimeFixture {
    getSessionInfo: () =>
        | SessionProjectionFixture
        | Pick<SessionInfoFailure, "ok" | "error">
        | ReturnType<SessionRuntime["getSessionInfo"]>;
}

interface SessionCommandFixture extends Pick<CommandContext, "sessionId"> {
    uiAPI: Pick<NonNullable<CommandContext["uiAPI"]>, "appendSystemMessage">;
    sessionRuntime?: SessionRuntimeFixture;
}

// Existing JavaScript fixtures provide only the command-facing methods and synchronous projections.
// Keep their values unchanged while checking that surface against the owning contracts.
type SessionCommandFixtureRunner = (argv: string[], options: SessionCommandFixture) => Promise<void>;

initRunWieldTheme();

function makeUi() {
    const messages: string[] = [];
    return {
        messages,
        uiAPI: {
            appendSystemMessage: (message: string) => messages.push(message),
        },
    };
}

test("runSessionCommand reports a missing Runtime session", async () => {
    const { uiAPI, messages } = makeUi();
    await (runSessionCommand as SessionCommandFixtureRunner)([], { uiAPI });
    assertEquals(messages, ["Error: No active session."]);
});

test("runSessionCommand reports typed Runtime session-info failures", async () => {
    const { uiAPI, messages } = makeUi();
    await (runSessionCommand as SessionCommandFixtureRunner)([], {
        uiAPI,
        sessionId: "runtime-id",
        sessionRuntime: {
            getSessionInfo: () => ({ ok: false, error: "committed_generation_unavailable" }),
        },
    });

    assertEquals(messages, ["Error: Session info is unavailable (committed_generation_unavailable)."]);
});

test("runSessionCommand formats the Runtime session-info projection", async () => {
    const { uiAPI, messages } = makeUi();
    await (runSessionCommand as SessionCommandFixtureRunner)([], {
        uiAPI,
        sessionId: "runtime-id",
        sessionRuntime: {
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
                usageAvailability: {
                    inputTokens: "complete",
                    outputTokens: "complete",
                    cacheReadTokens: "complete",
                    cacheWriteTokens: "complete",
                },
                compactionUsage: {
                    inputTokens: 90,
                    outputTokens: 7,
                    cacheReadTokens: 0,
                    cacheWriteTokens: null,
                    costUsd: null,
                    availability: {
                        inputTokens: "complete",
                        outputTokens: "complete",
                        cacheReadTokens: "complete",
                        cacheWriteTokens: "unavailable",
                        costUsd: "unavailable",
                    },
                },
                compactionSettings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 22000 },
                contextUsage: { tokens: 96000, contextWindow: 128000, percent: 75 },
            }),
        },
    });

    const plain = messages.join("\n");
    for (const expected of [
        "Session compacted 1 time",
        "Deep Work",
        "/tmp/session.jsonl",
        "session-123",
        "96,000/128,000 (75.0%)",
        "1,775",
        "Compaction Usage (separate from assistant tokens)",
        "unavailable",
    ]) {
        assertEquals(plain.includes(expected), true);
    }
});
