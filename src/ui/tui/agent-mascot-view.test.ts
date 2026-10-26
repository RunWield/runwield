import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { test } from "node:test";
import { setCustomSetting } from "../../shared/settings.js";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { createChatView } from "./chat-view.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.ts";
import { mascotForAgent } from "../mascot/mascot.ts";
import { createValidationSessionPort } from "../../shared/workflow/validation-session-adapter.ts";
import { attachTuiRuntimeAdapter } from "./runtime-adapter.js";

test("publication shows Base and default working text without an active Agent", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 45 });
        const tui = new TuiAltScreen(terminal);
        session.resetAgentInfoStack("Validation Repair Engineer", "", "", "reviewer-feedback-engineer");
        const view = await createChatView({
            browser: NO_OPEN_BROWSER_PORT,
            documentLinks: null,
            tui,
            suppressStartupHeader: true,
            getSessionId: () => sessionId,
            sessionRuntime: runtime,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        const adapter = attachTuiRuntimeAdapter({
            runtime,
            sessionId,
            uiAPI: view.uiAPI,
            browser: NO_OPEN_BROWSER_PORT,
            notifyRunWieldEvent: () => Promise.resolve(),
        });
        try {
            tui.start();
            view.uiAPI.setAgentBusyLines?.(["Fixing the validation failure..."]);
            view.uiAPI.setBusy?.(true);
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "Fixing the validation failure...");
            createValidationSessionPort(session).releaseActiveAgent();
            tui.renderNow(true);
            await terminal.flush();
            const screen = terminal.getScreenText();
            assertStringIncludes(screen, "Working...");
            assert(!screen.includes("Fixing the validation failure..."));
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, null);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgentInfo, null);
            for (const line of mascotForAgent("router")!.frames[0].lines.filter((line) => line.trim())) {
                assertStringIncludes(screen, line.trimEnd());
            }
        } finally {
            adapter.dispose();
            view.uiAPI.dispose?.();
            view.dispose();
            tui.stop();
        }
    });
});

test("live TUI reserves mascot space and pauses for questions without covering input", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 45 });
        const tui = new TuiAltScreen(terminal);
        assertEquals((await runtime.switchAgent(sessionId, { agentName: "operator" })).ok, true);
        const view = await createChatView({
            browser: NO_OPEN_BROWSER_PORT,
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
            assertEquals((await runtime.switchAgent(sessionId, { agentName: "recorder" })).ok, true);
            tui.renderNow(true);
            await terminal.flush();
            assert(!terminal.getScreenText().includes("██   ██"));
            assertEquals((await runtime.switchAgent(sessionId, { agentName: "operator" })).ok, true);
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

test("disabling a live TUI mascot removes rail and compact face without losing input", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, projectRoot }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 45 });
        const tui = new TuiAltScreen(terminal);
        assertEquals((await runtime.switchAgent(sessionId, { agentName: "operator" })).ok, true);
        const view = await createChatView({
            browser: NO_OPEN_BROWSER_PORT,
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
            for (const [columns, rows] of [
                [150, 45],
                [60, 16],
            ]) {
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
