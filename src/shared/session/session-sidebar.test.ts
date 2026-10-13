import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { buildSessionSidebarProjection, sessionSidebarFields } from "./session-sidebar.ts";

test("Session tab fields share counts and context percentages across surfaces", () => {
    const projection = buildSessionSidebarProjection({
        sessionName: "Saved Session",
        userMessages: 3,
        assistantMessages: 7,
        toolCalls: 12,
        compactionCount: 1,
        queuedMessages: 2,
        contextUsedTokens: 30000,
        contextWindowTokens: 200000,
        contextPercent: 15,
        systemContextTokens: 10000,
    });
    assertEquals(sessionSidebarFields(projection.session), [
        { label: "Session", value: "Saved Session" },
        { label: "Messages", value: "10 · 3 user / 7 assistant" },
        { label: "Tool calls", value: "12" },
        { label: "Compactions", value: "1" },
        { label: "Queued prompts", value: "2" },
        { label: "Context", value: "30,000 / 200,000 · 15.0%" },
        { label: "System & setup", value: "~10,000 · 33.3% of used" },
        { label: "Conversation", value: "~20,000 · 66.7% of used" },
    ]);
});

test("Session tab fields preserve the TUI's unavailable and empty states", () => {
    const projection = buildSessionSidebarProjection({ userMessages: 0, contextWindowTokens: 200000 });
    assertEquals(sessionSidebarFields(projection.session), [
        { label: "Session", value: "Untitled Session" },
        { label: "Messages", value: "0 · 0 user / 0 assistant" },
        { label: "Tool calls", value: "0" },
        { label: "Compactions", value: "None" },
        { label: "Context", value: "Unknown / 200,000" },
        { label: "System & setup", value: "Unknown" },
        { label: "Conversation", value: "Unknown" },
    ]);
});
