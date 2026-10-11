import { assert, assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { getHomeDir } from "../../constants.js";
import { configureRemotePersonalResources } from "../../shared/remote/personal-resources.ts";
import { createSessionSnapshotWindow } from "./session-snapshot-window.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";

// Remote personal roots are process-lifetime state; this file runs in isolation.
Deno.test("snapshot window gives a slow completed read the full freshness interval", async () => {
    await withSessionViewFixture(({ runtime, sessionId }) => {
        const settingsPath = join(getHomeDir(), ".wld", "settings.json");
        configureRemotePersonalResources({ globalRoot: join(getHomeDir(), ".wld") });
        const realNow = Date.now;
        const realRead = Deno.readTextFileSync;
        let now = realNow();
        let delayed = false;
        Date.now = () => now;
        // Keep the real filesystem result. Only elapsed boundary time is
        // scripted, so the real Runtime and settings projection still execute.
        Deno.readTextFileSync = (path) => {
            const content = realRead(path);
            if (path === settingsPath && !delayed) {
                delayed = true;
                now += 750;
            }
            return content;
        };
        const window = createSessionSnapshotWindow(runtime, () => sessionId, 500);
        try {
            const snapshot = window.read();
            assert(snapshot);
            assert(delayed, "the real settings-file read must advance the boundary clock");
            assertStrictEquals(window.read(), snapshot);
            now += 499;
            assertStrictEquals(window.read(), snapshot);
            now++;
            assertNotStrictEquals(window.read(), snapshot);
        } finally {
            window.dispose();
            Deno.readTextFileSync = realRead;
            Date.now = realNow;
        }
    });
});
