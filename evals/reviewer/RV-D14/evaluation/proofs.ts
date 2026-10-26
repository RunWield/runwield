import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveHistory, listHistory } from "../src/store.ts";
import { pruneHistory } from "../src/retention.ts";

if (process.argv[2] !== "age-retention") throw new Error("Select age-retention");
const root = await mkdtemp(join(tmpdir(), "age-retention-proof-"));
try {
    const now = new Date("2026-03-31T12:00:00.000Z");
    const young = Array.from({ length: 12 }, (_, index) => ({
        id: "young-" + index,
        createdAt: new Date(now.getTime() - index * 86400000).toISOString(),
        result: "complete",
    }));
    const old = [
        { id: "old-one", createdAt: "2026-01-01T00:00:00.000Z", result: "complete" },
        { id: "old-two", createdAt: "2026-01-02T00:00:00.000Z", result: "complete" },
    ];
    const youngRoot = join(root, "young");
    const oldRoot = join(root, "old");
    await saveHistory(youngRoot, young);
    await saveHistory(oldRoot, old);
    await pruneHistory(youngRoot, now);
    await pruneHistory(oldRoot, now);
    assert.deepEqual(
        {
            young: await listHistory(youngRoot),
            old: await listHistory(oldRoot),
        },
        { young, old: [] },
        "RV-D14-AGE-RETENTION",
    );
    console.log("PASS age-retention");
} finally {
    await rm(root, { recursive: true, force: true });
}
