import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    isNotificationEventName,
    isRuntimeAttentionNotificationEventName,
    normalizeBrowserNotificationPolicy,
    normalizeNotificationPolicy,
} from "./notification-content.ts";

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
