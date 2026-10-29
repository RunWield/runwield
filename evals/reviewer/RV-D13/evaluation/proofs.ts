import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePlan } from "../src/store.ts";
import { runCommand } from "../src/commands.ts";

if (process.argv[2] !== "archived-list") throw new Error("Select archived-list");
const root = await mkdtemp(join(tmpdir(), "list-proof-"));
try {
    const active = { id: "active", title: "Current", body: "Still working" };
    const archived = { id: "done", title: "Finished", body: "Delivered" };
    await savePlan(root, "active", active);
    await savePlan(root, "active", archived);
    const time = "2026-02-01T12:30:00.000Z";
    await runCommand(root, ["archive", archived.id], () => new Date(time));
    const actual = JSON.parse(await runCommand(root, ["list", "--archived-only"]));
    assert.deepEqual(actual, [{ ...archived, archivedAt: time }], "RV-D13-ARCHIVED-FILTER-IGNORED");
    console.log("PASS archived-list");
} finally {
    await rm(root, { recursive: true, force: true });
}
