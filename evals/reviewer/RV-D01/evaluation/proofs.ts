import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshDigests } from "../src/batch.ts";
import { readProjects, saveProjects } from "../src/catalog.ts";

if (process.argv[2] !== "empty-selection") throw new Error("Select empty-selection");
const root = await mkdtemp(join(tmpdir(), "selection-proof-"));
try {
    await saveProjects(root, [
        { id: "alpha", title: "Alpha", notes: ["new"], digest: "published alpha" },
        { id: "beta", title: "Beta", notes: ["new"], digest: "published beta" },
    ]);
    const before = await readProjects(root);
    const result = await refreshDigests(root, []);
    assert.deepEqual(await readProjects(root), before, "RV-D01-EMPTY-SELECTION");
    assert.deepEqual(result.updated, [], "RV-D01-EMPTY-SELECTION");
    console.log("PASS empty-selection");
} finally {
    await rm(root, { recursive: true, force: true });
}
