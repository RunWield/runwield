import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import {
    createSystemNotificationNotifier,
    type RunWieldEventNotifier,
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

test("notifyRunWieldEvent sends Warp a titled desktop notification", async () => {
    const { notify, terminal } = makeNotificationFixture({
        env: { TERM_PROGRAM: "WarpTerminal", TERM: "xterm-256color" },
    });
    const result = await notify("agentStopped", { sessionName: "Warp session" });

    assertEquals(result.sent, true);
    assertEquals(result.protocol, "osc777");
    assertEquals(terminal.strings[0], "\x07");
    assertEquals(terminal.strings.length, 2);
    assertStringIncludes(terminal.strings[1], "\x1b]777;notify;Agent stopped");
    assertStringIncludes(terminal.strings[1], "Warp session");
});

test("notifyRunWieldEvent tries native notification delivery for an unrecognized terminal", async () => {
    const { notify, terminal } = makeNotificationFixture({
        env: { TERM_PROGRAM: "Apple_Terminal" },
        pid: 0,
    });
    const result = await notify("agentStopped", {
        sessionName: "demo",
    });

    assertEquals(result.sent, true);
    assertEquals(result.reason, "sent");
    assertEquals(result.protocol, "osc777");
    assertEquals(result.terminal.pid, 0);
    assertEquals(result.terminalBellEmitted, true);
    assertEquals(terminal.strings[0], "\x07");
    assertEquals(terminal.strings.length, 2);
    assertStringIncludes(terminal.strings[1], "\x1b]777;notify;Agent stopped");
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
    assertStringIncludes(sent.message, "W. compact session");
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

for (const [termProgram, term, protocol, prefix] of [
    ["iTerm.app", "xterm-256color", "osc9", "\x1b]9;"],
    ["WezTerm", "xterm-256color", "osc777", "\x1b]777;notify;"],
    ["Ghostty", "xterm-256color", "osc777", "\x1b]777;notify;"],
    ["kitty", "xterm-kitty", "osc99", "\x1b]99;"],
]) {
    test(`attention delivery selects ${termProgram}'s protocol and prevents terminal-control injection`, async () => {
        const { notify, terminal } = makeNotificationFixture({
            env: { TERM_PROGRAM: termProgram, TERM: term },
            setting: { terminalBell: false },
        });
        const result = await notify("agentStopped", { sessionName: "demo\x1b]bad\x07;title\n" });
        assertEquals(result.sent, true);
        assertEquals(result.protocol, protocol);
        assertEquals(terminal.strings.length, 1);
        const sequence = terminal.strings[0];
        assertEquals(sequence.startsWith(prefix), true);
        assertEquals(sequence.includes("\x1b]bad"), false);
        if (protocol === "osc99") {
            const parts = [...sequence.matchAll(/p=(title|body);([^\x1b]+)/g)];
            assertEquals(parts.length, 2);
            assertStringIncludes(atob(parts[0][2]), "Agent stopped");
            assertStringIncludes(atob(parts[1][2]), "The agent has stopped");
            assertStringIncludes(sequence, "o=unfocused");
        } else {
            assertStringIncludes(sequence, "Agent stopped");
            assertEquals(sequence.endsWith("\x07"), true);
            assertEquals(sequence.slice(0, -1).includes("\x07"), false);
            assertEquals(sequence.includes(";title"), false);
        }
    });
}
