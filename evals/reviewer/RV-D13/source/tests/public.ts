let passed = 0;
async function check(name: string, assertion: () => void | Promise<void>): Promise<void> {
    await assertion();
    passed += 1;
    console.log("PASS " + name);
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePlan, readPlan } from "../src/store.ts";
import { runCommand } from "../src/commands.ts";

const record = { id: "delivery", title: "Delivery", body: "Ship the current work" };
await check("a new catalog lists no Plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "plans-"));
    try {
        assert.deepEqual(JSON.parse(await runCommand(root, ["list"])), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("the ordinary list includes active and archived Plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "plans-"));
    try {
        const old = { ...record, id: "older", archivedAt: "2026-01-01T00:00:00.000Z" };
        await savePlan(root, "active", record);
        await savePlan(root, "archived", old);
        assert.deepEqual(JSON.parse(await runCommand(root, ["list"])), [record, old]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
