import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
async function check(name: string, assertion: () => void | Promise<void>): Promise<void> {
    await assertion();
    passed += 1;
    console.log("PASS " + name);
}

import { saveHistory, listHistory } from "../src/store.ts";
import { pruneHistory } from "../src/retention.ts";

const now = new Date("2026-03-31T12:00:00.000Z");
await check("an empty history remains empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "empty-history-"));
    try {
        assert.deepEqual(await pruneHistory(root, now), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("pruning retains the recent audit window in newest-first order", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-window-"));
    try {
        const recent = Array.from({ length: 10 }, (_, index) => ({
            id: "recent-" + index,
            createdAt: new Date(now.getTime() - index * 86400000).toISOString(),
            result: "completed " + index,
        }));
        const old = [
            { id: "old-one", createdAt: "2026-01-01T12:00:00.000Z", result: "done" },
            { id: "old-two", createdAt: "2026-01-02T12:00:00.000Z", result: "done" },
        ];
        await saveHistory(root, [...old, ...recent].reverse());
        await pruneHistory(root, now);
        assert.deepEqual(await listHistory(root), recent);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("a small recent history retains every field", async () => {
    const root = await mkdtemp(join(tmpdir(), "short-history-"));
    try {
        const records = [{ id: "one", createdAt: now.toISOString(), result: "complete with notes" }];
        await saveHistory(root, records);
        assert.deepEqual(await pruneHistory(root, now), records);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
