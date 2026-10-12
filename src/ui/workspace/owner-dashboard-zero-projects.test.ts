import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { loadOwnerDashboard, subscribeOwnerDashboard } from "./server/owner-dashboard.ts";

test("Dashboard with no registered Projects completes all four empty sections", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "rw-dashboard-empty-"));
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const continuation = {
        operations: new Map(),
        listSessions() {
            return Promise.resolve({ sessions: [] });
        },
    };
    try {
        const frames: Array<{ type: string; sections: Array<{ items: Array<{ planId: string }> }> }> = [];
        const unsubscribe = subscribeOwnerDashboard(store, continuation, (frame) => frames.push(frame));
        const result = await loadOwnerDashboard(store, continuation);
        unsubscribe();
        assertEquals(frames.at(-1)?.type, "complete");
        assertEquals(result.dashboard.sections.length, 4);
        assertEquals(result.dashboard.sections.every((section) => section.items.length === 0), true);
    } finally {
        store.close();
        await fsRm(dir, { recursive: true });
    }
});
