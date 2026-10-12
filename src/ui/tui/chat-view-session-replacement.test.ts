import { assertStringIncludes } from "@std/assert";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { createChatView } from "./chat-view.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";

Deno.test("chat view refreshes warmed sidebar state for events from a replacement Session", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, projectRoot, host }) => {
        const terminal = new VirtualTerminal({ columns: 150, rows: 35 });
        const tui = new TuiAltScreen(terminal);
        let activeId = sessionId;
        const view = await createChatView({
            documentLinks: null,
            tui,
            sessionRuntime: runtime,
            getSessionId: () => activeId,
            suppressStartupHeader: true,
            setActiveModel: () => Promise.resolve({ status: "active" }),
        });
        const realNow = Date.now;
        const now = realNow();
        Date.now = () => now;
        try {
            tui.start();
            tui.renderNow(true);
            const second = await runtime.createInteractiveSession({ cwd: projectRoot });
            activeId = second.sessionId;
            view.resetForSessionReplacement();
            tui.renderNow(true);
            // Warm the replacement snapshot before its next workflow event.
            host.requireSession(activeId).replaceWorkflowContext({
                routingIntent: "PLANNED_CHANGE",
                complexity: "LOW",
            });
            tui.renderNow(true);
            await terminal.flush();
            assertStringIncludes(terminal.getScreenText(), "PLANNED CHANGE");
        } finally {
            Date.now = realNow;
            view.dispose();
            tui.stop();
        }
    });
});
