import fs from "node:fs";
import { mock } from "bun:test";
import { test } from "node:test";
import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { notStrictEqual as assertNotStrictEquals } from "node:assert/strict";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { configureRemotePersonalResources } from "../../shared/remote/personal-resources.ts";
import { createSessionSnapshotWindow } from "./session-snapshot-window.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";

// Remote personal roots are process-lifetime state; this file runs in isolation.
test("snapshot window gives a slow completed read the full freshness interval", async () => {
    await withSessionViewFixture(({ runtime, sessionId }) => {
        configureRemotePersonalResources({ globalRoot: join(getHomeDir(), ".wld") });
        const settingsPath = join(getHomeDir(), ".wld", "settings.json");
        const realNow = Date.now;
        const realRead = fs.readFileSync;
        let now = realNow();
        let delayed = false;
        Date.now = () => now;
        // Keep real filesystem contents and the real Runtime projection. Only
        // elapsed time at the filesystem boundary is scripted.
        const delayedRead = (
            path: Parameters<typeof fs.readFileSync>[0],
            options?: Parameters<typeof fs.readFileSync>[1],
        ) => {
            const content = options === undefined ? realRead(path) : realRead(path, options);
            if (path === settingsPath && !delayed) {
                delayed = true;
                now += 750;
            }
            return content;
        };
        mock.module("node:fs", () => ({
            ...fs,
            readFileSync: delayedRead,
            default: { ...fs, readFileSync: delayedRead },
        }));
        const window = createSessionSnapshotWindow(runtime, () => sessionId, 500);
        try {
            const snapshot = window.read();
            assert(snapshot);
            assert(delayed, "the real settings read must advance time during the projection");
            assertStrictEquals(window.read(), snapshot);
            now += 499;
            assertStrictEquals(window.read(), snapshot);
            now++;
            assertNotStrictEquals(window.read(), snapshot);
        } finally {
            window.dispose();
            mock.module("node:fs", () => ({ ...fs, readFileSync: realRead, default: fs }));
            Date.now = realNow;
        }
    });
});
