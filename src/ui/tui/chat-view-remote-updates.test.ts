import { test } from "node:test";
import { rm } from "node:fs/promises";
import { getUpdateCheckCachePath, SYSTEM_UPDATE_CHECK_PORTS } from "../../shared/update-check.js";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { assertEquals } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { configureRemotePersonalResources } from "../../shared/remote/personal-resources.ts";
import { createChatView } from "./chat-view.ts";
import { initTUIWithPair, stopTUI } from "./tui.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

// Remote roots are process-lifetime state; the runner gives this test its own process.
test("a remote view does not contact GitHub for launcher updates", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        configureRemotePersonalResources({ globalRoot: join(getHomeDir(), ".wld") });
        await rm(getUpdateCheckCachePath(), { force: true });
        const originalFetch = SYSTEM_UPDATE_CHECK_PORTS.network.fetch;
        const requests: string[] = [];
        SYSTEM_UPDATE_CHECK_PORTS.network.fetch = Object.assign(
            (input: Parameters<typeof fetch>[0]) => {
                requests.push(String(input));
                return Promise.reject(new Error("Server has no internet access"));
            },
            { preconnect: originalFetch.preconnect },
        );
        try {
            const terminal = new VirtualTerminal({ columns: 70, rows: 30 });
            const tui = new TuiAltScreen(terminal);
            initTUIWithPair({ tui, terminal });
            const view = await createChatView({
                browser: NO_OPEN_BROWSER_PORT,
                tui,
                documentLinks: null,
                suppressStartupHeader: false,
                getSessionId: () => sessionId,
                sessionRuntime: runtime,
                setActiveModel: () => Promise.resolve({ status: "active" }),
            });
            try {
                assertEquals(requests, []);
            } finally {
                view.dispose();
            }
        } finally {
            stopTUI();
            SYSTEM_UPDATE_CHECK_PORTS.network.fetch = originalFetch;
        }
    });
});
