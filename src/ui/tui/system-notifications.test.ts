import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    buildNativeNotificationSequence,
    createSystemNotificationNotifier,
    detectTerminalIdentity,
    resolveNotificationSettings,
    type RunWieldEventNotifier,
    selectNativeNotificationProtocol,
    shouldSuppressAttentionNotification,
    type SystemNotificationPort,
} from "./system-notifications.ts";
import { installTerminalFocusState, type TerminalFocusStateOwner } from "./terminal-focus-state.ts";

type FocusInputHandler = (data: string) => void;

class NotificationFocusTerminal {
    write(_data: string): void {}

    start(_onInput: FocusInputHandler): void {}
}

function installReportedFocusState(report: "\x1b[I" | "\x1b[O"): TerminalFocusStateOwner {
    const owner = installTerminalFocusState(new NotificationFocusTerminal());
    owner.filterInput(report);
    return owner;
}

type TerminalWriteRecorder = {
    writes: number[][];
    strings: string[];
    writeTerminal(bytes: Uint8Array): void;
};

type TerminalWriterOptions = {
    throwOnWrite?: boolean;
};

interface NotificationFixtureOptions extends TerminalWriterOptions {
    env?: Record<string, string | undefined>;
    pid?: number;
    setting?: ReturnType<SystemNotificationPort["readNotificationSetting"]>;
}

interface NotificationFixture {
    notify: RunWieldEventNotifier;
    terminal: TerminalWriteRecorder;
}

function makeTerminalWriter(options: TerminalWriterOptions = {}): TerminalWriteRecorder {
    const decoder = new TextDecoder();
    return {
        writes: [],
        strings: [],
        writeTerminal(bytes: Uint8Array): void {
            this.writes.push([...bytes]);
            this.strings.push(decoder.decode(bytes));
            if (options.throwOnWrite) {
                throw new Error("write failed");
            }
        },
    };
}

function makeNotificationFixture(options: NotificationFixtureOptions = {}): NotificationFixture {
    const terminal = makeTerminalWriter(options);
    const notify = createSystemNotificationNotifier({
        readEnvironment: () => options.env ?? {},
        getProcessId: () => options.pid ?? 1,
        readNotificationSetting: () => options.setting,
        writeTerminal: terminal.writeTerminal.bind(terminal),
    });
    return { notify, terminal };
}

test("resolveNotificationSettings defaults on and normalizes malformed values", () => {
    assertEquals(resolveNotificationSettings(undefined), {
        enabled: true,
        activation: "tab",
        events: {
            agentStopped: true,
            planWritten: true,
            userInterview: true,
            compactionFinished: true,
        },
        terminalBell: true,
        suppressWhenFocused: true,
    });

    assertEquals(
        resolveNotificationSettings({ enabled: false, activation: "invalid", events: { planWritten: false } }),
        {
            enabled: false,
            activation: "tab",
            events: {
                agentStopped: true,
                planWritten: false,
                userInterview: true,
                compactionFinished: true,
            },
            terminalBell: true,
            suppressWhenFocused: true,
        },
    );

    assertEquals(resolveNotificationSettings({ terminalBell: false, suppressWhenFocused: false }).terminalBell, false);
    assertEquals(
        resolveNotificationSettings({ terminalBell: false, suppressWhenFocused: false }).suppressWhenFocused,
        false,
    );
});

test("detectTerminalIdentity captures terminal environment without subprocess tty lookup", () => {
    const identity = detectTerminalIdentity("demo", {
        env: {
            TERM_PROGRAM: "iTerm.app",
            TERM: "xterm-256color",
            ITERM_SESSION_ID: "w0t0p0",
        },
        pid: 42,
    });

    assertEquals(identity.sessionLabel, "demo");
    assertEquals(identity.terminalTitle, "W. - demo");
    assertEquals(identity.termProgram, "iTerm.app");
    assertEquals(identity.itermSessionId, "w0t0p0");
    assertEquals(identity.pid, 42);
});

test("selectNativeNotificationProtocol maps supported terminal families conservatively", () => {
    assertEquals(
        selectNativeNotificationProtocol({ sessionLabel: "s", terminalTitle: "W. - s", term: "xterm-kitty" }),
        "osc99",
    );
    assertEquals(
        selectNativeNotificationProtocol({ sessionLabel: "s", terminalTitle: "W. - s", termProgram: "WezTerm" }),
        "osc777",
    );
    assertEquals(
        selectNativeNotificationProtocol({ sessionLabel: "s", terminalTitle: "W. - s", termProgram: "Ghostty" }),
        "osc777",
    );
    assertEquals(
        selectNativeNotificationProtocol({ sessionLabel: "s", terminalTitle: "W. - s", termProgram: "iTerm.app" }),
        "osc9",
    );
    assertEquals(
        selectNativeNotificationProtocol({
            sessionLabel: "s",
            terminalTitle: "W. - s",
            termProgram: "Apple_Terminal",
        }),
        "unsupported",
    );
    assertEquals(selectNativeNotificationProtocol({ sessionLabel: "s", terminalTitle: "W. - s" }), "unsupported");
});

test("shouldSuppressAttentionNotification suppresses only known focused terminals by default", () => {
    assertEquals(shouldSuppressAttentionNotification({ suppressWhenFocused: true }, "focused"), true);
    assertEquals(shouldSuppressAttentionNotification({ suppressWhenFocused: true }, "unfocused"), false);
    assertEquals(shouldSuppressAttentionNotification({ suppressWhenFocused: true }, "unknown"), false);
    assertEquals(shouldSuppressAttentionNotification({ suppressWhenFocused: false }, "focused"), false);
});

test("buildNativeNotificationSequence emits iTerm2 OSC 9 safely", () => {
    const sequence = buildNativeNotificationSequence("osc9", "Hello\x1b]bad\x07;title", "Line\nmessage");
    assert(sequence);
    assertStringIncludes(sequence, "\x1b]9;");
    assertStringIncludes(sequence, "Hello");
    assertEquals(sequence.includes("\x1b]bad"), false);
    assertEquals(sequence.includes(";title"), false);
});

test("buildNativeNotificationSequence emits WezTerm and Ghostty OSC 777 safely", () => {
    const sequence = buildNativeNotificationSequence("osc777", "Title;part", "Message\x07part");
    assertEquals(sequence, "\x1b]777;notify;Title part;Message part\x07");
});

test("buildNativeNotificationSequence emits Kitty OSC 99 with unfocused option and encoded text", () => {
    const sequence = buildNativeNotificationSequence("osc99", "Title;\x1b", "Message\x07\x1b\\done");
    assertEquals(
        sequence,
        "\x1b]99;i=runwield:d=0:e=1:o=unfocused:p=title;VGl0bGU7Gw==\x1b\\" +
            "\x1b]99;i=runwield:d=1:e=1:o=unfocused:p=body;TWVzc2FnZQcbXGRvbmU=\x1b\\",
    );
});

test("notifyRunWieldEvent never reaches notifications from a Golden TUI run", async () => {
    const { notify, terminal } = makeNotificationFixture({
        env: { WLD_GOLDEN_TUI: "1", TERM_PROGRAM: "iTerm.app" },
    });
    const result = await notify("agentStopped", {
        sessionName: "golden",
    });

    assertEquals(result.sent, false);
    assertEquals(result.reason, "golden_tui");
    assertEquals(result.terminalBellEmitted, false);
    assertEquals(terminal.writes, []);
});

test("notifyRunWieldEvent emits unsupported-terminal BEL fallback when enabled", async () => {
    const { notify, terminal } = makeNotificationFixture({
        env: { TERM_PROGRAM: "Apple_Terminal" },
        pid: 0,
    });
    const result = await notify("agentStopped", {
        sessionName: "demo",
    });

    assertEquals(result.sent, false);
    assertEquals(result.reason, "unsupported");
    assertEquals(result.protocol, "unsupported");
    assertEquals(result.terminal.pid, 0);
    assertEquals(result.terminalBellEmitted, true);
    assertEquals(terminal.writes, [[7]]);
});

test("notifyRunWieldEvent respects terminalBell false while preserving OSC delivery", async () => {
    const { notify, terminal } = makeNotificationFixture({
        env: { TERM_PROGRAM: "iTerm.app" },
        setting: { terminalBell: false },
    });
    const result = await notify("userInterview", {
        sessionName: "silent bell",
    });

    assertEquals(result.sent, true);
    assertEquals(result.reason, "sent");
    assertEquals(result.protocol, "osc9");
    assertEquals(result.terminalBellEmitted, false);
    assertEquals(terminal.writes.length, 1);
    assertStringIncludes(terminal.strings[0], "\x1b]9;");
});

test("notifyRunWieldEvent suppresses focused terminals before BEL or OSC emission", async () => {
    const focusOwner = installReportedFocusState("\x1b[I");
    const { notify, terminal } = makeNotificationFixture({
        env: { TERM_PROGRAM: "WezTerm" },
    });
    try {
        const result = await notify("planWritten", {
            sessionName: "focused",
        });

        assertEquals(result.sent, false);
        assertEquals(result.reason, "focused");
        assertEquals(result.terminalBellEmitted, false);
        assertEquals(result.oscEmitted, false);
        assertEquals(terminal.writes, []);
    } finally {
        focusOwner.dispose();
    }
});

test("notifyRunWieldEvent suppressWhenFocused false restores always-emit behavior", async () => {
    const focusOwner = installReportedFocusState("\x1b[I");
    const { notify, terminal } = makeNotificationFixture({
        env: { TERM_PROGRAM: "WezTerm" },
        setting: { suppressWhenFocused: false },
    });
    try {
        const result = await notify("planWritten", {
            sessionName: "focused",
        });

        assertEquals(result.sent, true);
        assertEquals(result.protocol, "osc777");
        assertEquals(result.terminalBellEmitted, true);
        assertEquals(terminal.writes[0], [7]);
        assertStringIncludes(terminal.strings[1], "\x1b]777;notify;");
    } finally {
        focusOwner.dispose();
    }
});

test("notifyRunWieldEvent preserves per-event settings and compaction finished text", async () => {
    const disabledFixture = makeNotificationFixture({
        env: { TERM_PROGRAM: "Ghostty" },
        setting: { events: { compactionFinished: false } },
    });
    const disabled = await disabledFixture.notify("compactionFinished", {
        sessionName: "disabled compact",
    });

    assertEquals(disabled.reason, "event_disabled");
    assertEquals(disabledFixture.terminal.writes, []);

    const { notify } = makeNotificationFixture({
        env: { TERM_PROGRAM: "Ghostty" },
    });
    const sent = await notify("compactionFinished", {
        sessionName: "compact session",
    });

    assertEquals(sent.sent, true);
    assertStringIncludes(sent.title, "Compaction finished");
    assertStringIncludes(sent.message, "The /compact command finished. Return to view the result.");
    assertStringIncludes(sent.message, "W. - compact session");
});

test("notifyRunWieldEvent skips bell and OSC for disabled or unknown events", async () => {
    const disabledFixture = makeNotificationFixture({
        env: { TERM_PROGRAM: "iTerm.app" },
        setting: { enabled: false },
    });
    const disabled = await disabledFixture.notify("agentStopped", {
        sessionName: "disabled",
    });

    assertEquals(disabled.reason, "disabled");
    assertEquals(disabledFixture.terminal.writes, []);

    const unknownFixture = makeNotificationFixture({
        env: { TERM_PROGRAM: "iTerm.app" },
    });
    const unknown = await unknownFixture.notify("unknownEvent", {
        sessionName: "unknown",
    });

    assertEquals(unknown.reason, "unknown_event");
    assertEquals(unknownFixture.terminal.writes, []);
});

test("notifyRunWieldEvent isolates terminal write failures", async () => {
    const { notify } = makeNotificationFixture({
        env: { TERM_PROGRAM: "iTerm.app" },
        throwOnWrite: true,
    });
    const result = await notify("planWritten", {
        sessionName: "write failure",
    });

    assertEquals(result.sent, false);
    assertEquals(result.reason, "write_failed");
    assertEquals(result.terminalBellEmitted, false);
});

test("command-based notification helpers are removed from active source", async () => {
    const source = await fsReadFile(new URL("./system-notifications.ts", import.meta.url), "utf8");
    const removedTerms = [
        "CommandSpec",
        "run" + "Command",
        "command" + "Exists",
        "build" + "Notification" + "Command",
        "build" + "Osascript" + "Notification" + "Command",
        "build" + "Activation" + "Command",
        "terminal" + "-" + "notifier",
        "display" + " notification",
    ];
    for (const term of removedTerms) {
        assertEquals(source.includes(term), false);
    }
    assertStringIncludes(source, "getNotificationBaseMessage");
    assertStringIncludes(source, "normalizeNotificationPolicy");
    assertEquals(source.includes("const EVENT_LABELS"), false);
    assertEquals(source.includes("const EVENT_MESSAGES"), false);
});
