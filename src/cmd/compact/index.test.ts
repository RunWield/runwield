import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import type { CommandContext } from "../registry.js";
import { runCompactCommand } from "./index.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";

type CompactRuntime = NonNullable<CommandContext["sessionRuntime"]>;
type FixtureCompactResult = Partial<Awaited<ReturnType<CompactRuntime["compactSession"]>>>;
type NotifyRunWieldEvent = NonNullable<CommandContext["notifyRunWieldEvent"]>;
type NotificationEventName = Parameters<NotifyRunWieldEvent>[0];
type NotificationOptions = Parameters<NotifyRunWieldEvent>[1];

interface FixtureNotification {
    eventName: NotificationEventName;
    options: NotificationOptions;
}

interface FixtureCompactOptions {
    compact?: (id: string, instructions?: string) => Promise<FixtureCompactResult>;
}

interface FixtureCommandContext extends Omit<CommandContext, "uiAPI" | "sessionRuntime"> {
    uiAPI?: Pick<NonNullable<CommandContext["uiAPI"]>, "appendSystemMessage">;
    sessionRuntime?: ReturnType<typeof makeRuntimeContext>["sessionRuntime"];
}

type FixtureCompactCommand = (
    argv: string[],
    options: CommandContext | FixtureCommandContext,
) => ReturnType<typeof runCompactCommand>;

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

function makeNotifier() {
    const notifications: FixtureNotification[] = [];
    return {
        notifications,
        notifyRunWieldEvent: (eventName: NotificationEventName, options: NotificationOptions) => {
            notifications.push({ eventName, options });
        },
    };
}

function makeRuntimeContext(options: FixtureCompactOptions = {}) {
    return {
        sessionId: "compact-test",
        sessionRuntime: {
            compactSession: options.compact || (() => Promise.resolve({ tokensBefore: 1234, summary: "summary" })),
            getSessionSnapshot: () => ({ name: "Compact Session" }),
        },
    };
}

test("runCompactCommand requires a Runtime session id", async () => {
    const { uiAPI, messages } = makeUi();
    const { notifyRunWieldEvent, notifications } = makeNotifier();
    assertEquals(await (runCompactCommand as FixtureCompactCommand)([], { uiAPI, notifyRunWieldEvent }), "failed");
    assertEquals(messages, ["Error: No active agent session."]);
    assertEquals(notifications, []);
});

test("runCompactCommand delegates compaction to SessionRuntime and notifies on success", async () => {
    const { uiAPI, messages } = makeUi();
    const { notifyRunWieldEvent, notifications } = makeNotifier();
    let instructions = "";
    const context = makeRuntimeContext({
        compact: (_id, value) => {
            instructions = value || "";
            return Promise.resolve({ tokensBefore: 1234, summary: "short summary" });
        },
    });

    const outcome = await (runCompactCommand as FixtureCompactCommand)(["keep", "decisions"], {
        uiAPI,
        ...context,
        notifyRunWieldEvent,
    });

    assertEquals(outcome, "succeeded");
    assertEquals(instructions, "keep decisions");
    assertEquals(
        messages.some((message) => message.includes("Session compacted.")),
        true,
    );
    assertEquals(messages.includes("short summary"), true);
    assertEquals(notifications, [
        {
            eventName: "compactionFinished",
            options: { sessionName: "Compact Session" },
        },
    ]);
});

test("runCompactCommand reports Runtime compaction outcomes and notifies", async () => {
    for (const [errorMessage, expected] of [
        ["Compaction cancelled", "Compaction cancelled."],
        ["Nothing to compact yet", "Nothing to compact — the session doesn't have enough messages yet."],
        ["model unavailable", "Compaction failed: model unavailable"],
    ]) {
        const { uiAPI, messages } = makeUi();
        const { notifyRunWieldEvent, notifications } = makeNotifier();
        const outcome = await (runCompactCommand as FixtureCompactCommand)([], {
            uiAPI,
            ...makeRuntimeContext({ compact: () => Promise.reject(new Error(errorMessage)) }),
            notifyRunWieldEvent,
        });
        assertEquals(outcome, errorMessage === "Compaction cancelled" ? "canceled" : "failed");
        assertEquals(messages.at(-1), expected);
        assertEquals(notifications, [
            {
                eventName: "compactionFinished",
                options: { sessionName: "Compact Session" },
            },
        ]);
    }
});

test("runCompactCommand treats an incomplete Runtime compaction result as empty context", async () => {
    const { uiAPI, messages } = makeUi();
    const { notifications, notifyRunWieldEvent } = makeNotifier();

    assertEquals(
        await (runCompactCommand as FixtureCompactCommand)([], {
            uiAPI,
            ...makeRuntimeContext({ compact: () => Promise.resolve({}) }),
            notifyRunWieldEvent,
        }),
        "failed",
    );

    assertEquals(messages.length, 2);
    assertEquals(messages[0].includes("Compacting context..."), true);
    assertEquals(messages[1], "Nothing to compact — the session doesn't have enough messages yet.");
    assertEquals(notifications, [
        {
            eventName: "compactionFinished",
            options: { sessionName: "Compact Session" },
        },
    ]);
});
