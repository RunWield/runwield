import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    buildSharedNotificationTitle,
    getNotificationBaseMessage,
    getNotificationEventLabel,
    isNotificationEventName,
    isRuntimeAttentionNotificationEventName,
    normalizeBrowserNotificationPolicy,
    normalizeNotificationPolicy,
} from "./notification-content.ts";

test("notification content owns all event labels and base messages", () => {
    assertEquals(getNotificationEventLabel("agentStopped"), "Agent stopped");
    assertEquals(getNotificationEventLabel("planWritten"), "Plan ready");
    assertEquals(getNotificationEventLabel("userInterview"), "Input requested");
    assertEquals(getNotificationEventLabel("compactionFinished"), "Compaction finished");
    assertEquals(getNotificationBaseMessage("agentStopped"), "The agent has stopped and is waiting for you.");
    assertEquals(getNotificationBaseMessage("planWritten"), "A plan is ready for review or approval.");
    assertEquals(getNotificationBaseMessage("userInterview"), "The agent is asking you a question.");
    assertEquals(
        getNotificationBaseMessage("compactionFinished"),
        "The /compact command finished. Return to view the result.",
    );
});

test("notification policy defaults on and only literal false disables", () => {
    const malformed = JSON.parse('{"enabled":"no","events":{"planWritten":false}}');
    assertEquals(normalizeNotificationPolicy(malformed), {
        enabled: true,
        events: {
            agentStopped: true,
            planWritten: false,
            userInterview: true,
            compactionFinished: true,
        },
        suppressWhenFocused: true,
    });
    assertEquals(normalizeNotificationPolicy({ enabled: false, suppressWhenFocused: false }).enabled, false);
    assertEquals(normalizeNotificationPolicy({ suppressWhenFocused: false }).suppressWhenFocused, false);
});

test("browser notification policy exposes only browser-applicable settings", () => {
    assertEquals(
        normalizeBrowserNotificationPolicy({
            enabled: false,
            events: { agentStopped: false, userInterview: false, compactionFinished: false },
            suppressWhenFocused: false,
        }),
        { enabled: false, events: { agentStopped: false }, suppressWhenFocused: false },
    );
});

test("runtime attention vocabulary excludes TUI-only compaction events", () => {
    assertEquals(isNotificationEventName("compactionFinished"), true);
    assertEquals(isRuntimeAttentionNotificationEventName("agentStopped"), true);
    assertEquals(isRuntimeAttentionNotificationEventName("compactionFinished"), false);
});

test("shared title composes agent, label, and Session name", () => {
    assertEquals(
        buildSharedNotificationTitle("agentStopped", "Demo Session", "Guide"),
        "Guide: Agent stopped — Demo Session",
    );
});
