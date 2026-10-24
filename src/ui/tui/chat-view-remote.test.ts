import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { test } from "node:test";
import { rename as fsRename } from "node:fs/promises";
import { assertEquals, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { getHomeDir } from "../../constants.js";
import { configureRemotePersonalResources, PersonalResourcePathError } from "../../shared/remote/personal-resources.ts";
import { getSettingsManager, isMascotEnabled } from "../../shared/settings.js";
import { createChatView } from "./chat-view.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

// Remote personal roots are process-lifetime state. Isolate this mount-loss
// regression from other view fixtures with the per-file test runner.
test("chat view renders its warmed Session when unused personal settings become unavailable", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session, projectRoot }) => {
        session.resetAgentInfoStack("Router", "selected-model", "selected-provider", "router");
        assertEquals(isMascotEnabled(projectRoot), true);
        const mounted = join(getHomeDir(), ".wld");
        const detached = join(getHomeDir(), "detached-personal-root");
        const realNow = Date.now;
        const now = realNow();
        Date.now = () => now;
        const views = [];
        let mountRemoved = false;
        try {
            for (const columns of [70, 150]) {
                for (const TuiCtor of [TuiMainScreen, TuiAltScreen]) {
                    const terminal = new VirtualTerminal({ columns, rows: 30 });
                    const tui = new TuiCtor(terminal);
                    const view = await createChatView({
                        browser: NO_OPEN_BROWSER_PORT,
                        tui,
                        documentLinks: null,
                        suppressStartupHeader: true,
                        getSessionId: () => sessionId,
                        sessionRuntime: runtime,
                        setActiveModel: () => Promise.resolve({ status: "active" }),
                    });
                    views.push({ view, tui, terminal });
                    tui.start();
                    view.editor.setText("keep my draft");
                    tui.renderNow(true);
                    await terminal.flush();
                    assertStringIncludes(terminal.getScreenText(), "keep my draft");
                }
            }
            configureRemotePersonalResources({ globalRoot: mounted });
            await fsRename(mounted, detached);
            mountRemoved = true;
            assertThrows(() => getSettingsManager(projectRoot).getDefaultModel(), PersonalResourcePathError);
            // The existing 500 ms window stays warm. Rendering must not bypass
            // it to read the required compaction settings again.
            for (const { tui, terminal } of views) {
                tui.invalidate();
                tui.renderNow(true);
                await terminal.flush();
                assertStringIncludes(terminal.getScreenText(), "keep my draft");
            }
        } finally {
            if (mountRemoved) await fsRename(detached, mounted);
            for (const { view, tui } of views) {
                view.dispose();
                tui.stop();
            }
            Date.now = realNow;
        }
    });
});
