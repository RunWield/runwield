import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { initRunWieldTheme } from "../theme/theme.js";
import { RunWieldTui } from "./tui.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { remoteHistoryFooter, showRemoteHistory } from "./remote-history.ts";
import { type SavedRemoteSession } from "../../shared/remote/laptop-session-control.ts";

function savedSession(): SavedRemoteSession {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const contents =
        [
            { type: "session", version: 3, id: "saved", cwd: "/remote-only/project", timestamp },
            {
                type: "message",
                id: "user",
                parentId: null,
                timestamp,
                message: { role: "user", content: [{ type: "text", text: "Saved remote question" }], timestamp: 1 },
            },
            {
                type: "message",
                id: "answer",
                parentId: "user",
                timestamp,
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Saved remote answer" }],
                    api: "openai-completions",
                    provider: "fixture",
                    model: "fixture",
                    stopReason: "stop",
                    timestamp: 2,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
                },
            },
        ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
    return {
        summary: {
            id: "saved",
            name: "Remote title",
            firstMessage: "Saved remote question",
            messageCount: 2,
            modified: timestamp,
        },
        targetLabel: "offline-host:/remote-only/project",
        contents,
    };
}

async function waitFor(terminal: VirtualTerminal, text: string): Promise<void> {
    for (let count = 0; count < 100; count++) {
        await terminal.flush();
        if (terminal.getScreenText().includes(text)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Missing ${text}: ${terminal.getScreenText()}`);
}

test("offline history selects a target and replays ordinary messages without a composer", async () => {
    await withProcessGlobalTestLock(async () => {
        initRunWieldTheme();
        const terminal = new VirtualTerminal({ columns: 180, rows: 30 });
        const tui = new RunWieldTui(terminal);
        tui.start();
        const viewing = showRemoteHistory(tui, [savedSession()]);
        try {
            await waitFor(terminal, "Remote title");
            assertStringIncludes(terminal.getScreenText(), "offline-host:/remote-only/project");
            assertStringIncludes(terminal.getScreenText(), "2026-01-01");
            terminal.pressEnter();
            await waitFor(terminal, "Saved remote answer");
            assertStringIncludes(terminal.getScreenText(), "Saved remote question");
            assertStringIncludes(
                terminal.getScreenText(),
                "Connect with wld remote offline-host:/remote-only/project, then /resume.",
            );
            terminal.input("COMPOSER-MUST-NOT-EXIST");
            terminal.pressEnter();
            await new Promise((resolve) => setTimeout(resolve, 30));
            await terminal.flush();
            assertEquals(terminal.getScreenText().includes("COMPOSER-MUST-NOT-EXIST"), false);
            terminal.input("q");
            await viewing;
        } finally {
            terminal.input("q");
            tui.stop();
        }
    });
});

test("offline history allows scrolling and keeps reconnect instructions pinned", async () => {
    await withProcessGlobalTestLock(async () => {
        initRunWieldTheme();
        const session = savedSession();
        session.contents = session.contents.replace(
            "Saved remote answer",
            Array.from({ length: 100 }, (_, i) => `saved-line-${i}`).join("\\n"),
        );
        const terminal = new VirtualTerminal({ columns: 180, rows: 15 });
        const tui = new RunWieldTui(terminal);
        tui.start();
        const viewing = showRemoteHistory(tui, [session]);
        try {
            await waitFor(terminal, "Remote title");
            terminal.pressEnter();
            await waitFor(terminal, "saved-line-");
            const before = terminal.getScreenText();
            terminal.input("\x1b[6~");
            await terminal.flush();
            await new Promise((resolve) => setTimeout(resolve, 30));
            await terminal.flush();
            assertEquals(terminal.getScreenText() === before, false);
            assertStringIncludes(terminal.getScreenText(), "then /resume.");
            terminal.pressCtrlC();
            await viewing;
        } finally {
            terminal.input("q");
            tui.stop();
        }
    });
});

test("offline history footer strips terminal controls from target labels", () => {
    assertEquals(
        remoteHistoryFooter("host:\u001b[31m/project\n"),
        "Saved on host: [31m/project. Connect with wld remote host: [31m/project, then /resume. · q exit",
    );
});
