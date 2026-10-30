import type { Usage } from "@earendil-works/pi-ai";
import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { buildProjectedSessionInfo, createReplayEvents } from "./session-transcript-projection.js";

type AssistantUsageFixture = Partial<Pick<Usage, "input" | "output">>;

const options = { sessionId: "usage-session", cwd: "/project" };
function assistant(usage: AssistantUsageFixture | undefined) {
    return { type: "message", message: { role: "assistant", content: [], ...(usage ? { usage } : {}) } };
}

test("replay keeps absent assistant usage unavailable", () => {
    const info = buildProjectedSessionInfo([assistant(undefined)], options);
    assertEquals(info.inputTokens, null);
    assertEquals(info.costUsd, null);
    assertEquals(info.usageAvailability.inputTokens, "unavailable");
});

test("replay distinguishes measured zero from missing cache categories", () => {
    const info = buildProjectedSessionInfo([assistant({ input: 12, output: 0 })], options);
    assertEquals(info.inputTokens, 12);
    assertEquals(info.outputTokens, 0);
    assertEquals(info.cacheReadTokens, null);
    assertEquals(info.usageAvailability.outputTokens, "complete");
});

test("replay marks a sum partial when a message lacks the measurement", () => {
    const info = buildProjectedSessionInfo(
        [assistant({ input: 12 }), assistant(undefined), assistant({ input: 0 })],
        options,
    );
    assertEquals(info.inputTokens, 12);
    assertEquals(info.usageAvailability.inputTokens, "partial");
});

test("replay keeps measured compaction usage separate from assistant totals", () => {
    const info = buildProjectedSessionInfo(
        [
            assistant({ input: 12, output: 0 }),
            { type: "compaction", usage: { input: 90, output: 7, cacheRead: 0, cost: { total: 0.25 } } },
        ],
        options,
    );
    assertEquals(info.inputTokens, 12);
    assertEquals(info.compactionCount, 1);
    assertEquals(info.compactionUsage.inputTokens, 90);
    assertEquals(info.compactionUsage.costUsd, 0.25);
    assertEquals(info.compactionUsage.cacheReadTokens, 0);
    assertEquals(info.compactionUsage.cacheWriteTokens, null);
    assertEquals(info.compactionUsage.availability.cacheWriteTokens, "unavailable");
});

test("replay does not turn an unmeasured compaction into zero usage", () => {
    const info = buildProjectedSessionInfo([{ type: "compaction" }], options);
    assertEquals(info.compactionUsage.inputTokens, null);
    assertEquals(info.compactionUsage.availability.inputTokens, "unavailable");
    assertEquals(info.inputTokens, null);
});

test("replay preserves an unavailable usage observation after a measured reply", () => {
    const events = createReplayEvents(options.sessionId, [
        { ...assistant({ input: 12, output: 0 }), id: "measured" },
        { ...assistant(undefined), id: "unmeasured" },
    ]).filter((event) => event.type === "usage");
    assertEquals(events.length, 2);
    assertEquals(events[0].usage.inputTokens, 12);
    assertEquals(events[0].usage.outputTokens, 0);
    assertEquals(events[1].usage, {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
    });
});

test("replay usage event identities stay stable for measured and unavailable replies", () => {
    const entries = [{ ...assistant(undefined), id: "reply" }];
    const first = createReplayEvents(options.sessionId, entries).filter((event) => event.type === "usage");
    const second = createReplayEvents(options.sessionId, entries).filter((event) => event.type === "usage");
    assertEquals(first.length, 1);
    assertEquals(first[0].eventId, second[0].eventId);
    assertEquals(first[0].messageId, second[0].messageId);
});
