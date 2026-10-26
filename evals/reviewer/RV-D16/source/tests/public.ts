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

import { exportSummary } from "../src/summary.ts";
import { readSummary } from "../src/store.ts";
import { remindersForDay } from "../src/reminders.ts";

const events = [
    { title: "Planning", startsAt: "2026-01-15T12:00:00.000Z" },
    { title: "Delivery", startsAt: "2026-01-16T12:00:00.000Z" },
];
await check("summary exports remain title-only unless dates are requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "plain-summary-"));
    try {
        const path = join(root, "summary.txt");
        await exportSummary(path, events);
        assert.equal(await readSummary(path), "Planning\nDelivery");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("dated summaries contain UTC date prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dated-summary-"));
    try {
        const path = join(root, "summary.txt");
        await exportSummary(path, events, true);
        assert.equal(await readSummary(path), "2026-01-15 Planning\n2026-01-16 Delivery");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("an empty reminder day has no events", () => {
    assert.deepEqual(remindersForDay(events, "2025-12-01"), []);
});

console.log(`# tests ${passed}`);
