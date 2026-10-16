import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { runCompactCommand } from "./index.ts";
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

function makeNotifier() {
    const notifications = /** @type {Array<{ eventName: string, options: any }>} */ ([]);
    return {
        notifications,
        notifyRunWieldEvent: (/** @type {string} */ eventName, /** @type {any} */ options) => {
            notifications.push({ eventName, options });
        },
    };
}

/** @param {{ compact?: (id: string, instructions?: string) => Promise<any> }} [options] */
function makeRuntimeContext(options = {}) {
    return {
        sessionId: "compact-test",
        sessionRuntime: /** @type {any} */ ({
            compactSession: options.compact || (() => Promise.resolve({ tokensBefore: 1234, summary: "summary" })),
            getSessionSnapshot: () => ({ name: "Compact Session" }),
        }),
    };
}

test("runCompactCommand requires a Runtime session id", async () => {
    const { uiAPI, messages } = makeUi();
    const { notifyRunWieldEvent, notifications } = makeNotifier();
    assertEquals(await runCompactCommand([], { uiAPI, notifyRunWieldEvent }), "failed");
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

    const outcome = await runCompactCommand(["keep", "decisions"], {
        uiAPI,
        ...context,
        notifyRunWieldEvent,
    });

    assertEquals(outcome, "succeeded");
    assertEquals(instructions, "keep decisions");
    assertEquals(messages.some((message) => message.includes("Session compacted.")), true);
    assertEquals(messages.includes("short summary"), true);
    assertEquals(notifications, [{
        eventName: "compactionFinished",
        options: { sessionName: "Compact Session" },
    }]);
});

test("runCompactCommand reports Runtime compaction outcomes and notifies", async () => {
    for (
        const [errorMessage, expected] of [
            ["Compaction cancelled", "Compaction cancelled."],
            ["Nothing to compact yet", "Nothing to compact — the session doesn't have enough messages yet."],
            ["model unavailable", "Compaction failed: model unavailable"],
        ]
    ) {
        const { uiAPI, messages } = makeUi();
        const { notifyRunWieldEvent, notifications } = makeNotifier();
        const outcome = await runCompactCommand([], {
            uiAPI,
            ...makeRuntimeContext({ compact: () => Promise.reject(new Error(errorMessage)) }),
            notifyRunWieldEvent,
        });
        assertEquals(outcome, errorMessage === "Compaction cancelled" ? "canceled" : "failed");
        assertEquals(messages.at(-1), expected);
        assertEquals(notifications, [{
            eventName: "compactionFinished",
            options: { sessionName: "Compact Session" },
        }]);
    }
});

test("runCompactCommand treats an incomplete Runtime compaction result as empty context", async () => {
    const { uiAPI, messages } = makeUi();
    const { notifications, notifyRunWieldEvent } = makeNotifier();

    assertEquals(
        await runCompactCommand([], {
            uiAPI,
            ...makeRuntimeContext({ compact: () => Promise.resolve({}) }),
            notifyRunWieldEvent,
        }),
        "failed",
    );

    assertEquals(messages.length, 2);
    assertEquals(messages[0].includes("Compacting context..."), true);
    assertEquals(messages[1], "Nothing to compact — the session doesn't have enough messages yet.");
    assertEquals(notifications, [{
        eventName: "compactionFinished",
        options: { sessionName: "Compact Session" },
    }]);
});
