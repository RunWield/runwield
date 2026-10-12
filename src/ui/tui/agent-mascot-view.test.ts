import { setCustomSetting } from "../../shared/settings.js";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { createChatView } from "./chat-view.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { mascotForAgent } from "../mascot/mascot.ts";

Deno.test("live TUI reserves mascot space and pauses for questions without covering input", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 45 });
        const tui = new TuiAltScreen(terminal);
        session.resetAgentInfoStack("Operator", "", "", "operator");
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            view.editor.setText("Preserve this draft");
            view.uiAPI.appendUserMessage?.("Keep the conversation visible");
            view.uiAPI.setBusy?.(true);
            tui.renderNow(true);
            await terminal.flush();
            const screen = terminal.getScreenText();
            assertStringIncludes(screen, "Preserve this draft");
            assertStringIncludes(screen, "Keep the conversation visible");
            const drawing = mascotForAgent("operator")!.frames[0].lines.filter((line) => line.trim());
            for (const line of drawing) assertStringIncludes(screen, line.trimEnd());
            const question = view.uiAPI.promptText("Your answer?");
            tui.renderNow(true);
            await terminal.flush();
            assertEquals(view.runningTasksComponent.isBusy, false);
            assertStringIncludes(terminal.getScreenText(), "Your answer?");
            view.uiAPI.abortActivePrompt();
            await question;
            view.uiAPI.setBusy?.(false);
            session.resetAgentInfoStack("Recorder", "", "", "recorder");
            tui.renderNow(true);
            await terminal.flush();
            assert(!terminal.getScreenText().includes("██   ██"));
            session.resetAgentInfoStack("Operator", "", "", "operator");
            terminal.resize(60, 16);
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "▛▀▀▀▀▀▜");
            assertStringIncludes(terminal.getScreenText(), "Preserve this draft");
        } finally {
            view.uiAPI.dispose?.();
            view.dispose();
            tui.stop();
        }
    });
});

Deno.test("disabling a live TUI mascot removes rail and compact face without losing input", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session, projectRoot }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 45 });
        const tui = new TuiAltScreen(terminal);
        session.resetAgentInfoStack("Operator", "", "", "operator");
        const view = await createChatView({
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        try {
            tui.start();
            view.editor.setText("Keep my input");
            view.uiAPI.setBusy?.(true);
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "██   ██");
            await setCustomSetting("mascot", false, "project", projectRoot);
            for (const [columns, rows] of [[150, 45], [60, 16]]) {
                terminal.resize(columns, rows);
                tui.renderNow(true);
                await terminal.flush();
                const screen = terminal.getScreenText();
                assert(!screen.includes("██   ██"));
                assert(!screen.includes("▛▀▀▀▀▀▜"));
                assertStringIncludes(screen, "Keep my input");
            }
            await setCustomSetting("mascot", true, "project", projectRoot);
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "▛▀▀▀▀▀▜");
        } finally {
            view.uiAPI.dispose?.();
            view.dispose();
            tui.stop();
        }
    });
});
