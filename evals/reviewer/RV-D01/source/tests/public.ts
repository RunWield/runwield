import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshDigests } from "../src/batch.ts";
import { readProjects, saveProjects } from "../src/catalog.ts";

async function withCatalog(check: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "project-digests-"));
    try {
        await saveProjects(root, [
            { id: "alpha", title: "Alpha", notes: [" Ready "], digest: "old alpha" },
            { id: "beta", title: "Beta", notes: [], digest: "old beta" },
        ]);
        await check(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
await withCatalog(async (root) => {
    assert.deepEqual(
        (await readProjects(root)).map((project) => project.id),
        ["alpha", "beta"],
    );
});
console.log("PASS catalog preserves project identities");
await withCatalog(async (root) => {
    assert.deepEqual(await refreshDigests(root), { updated: ["alpha", "beta"] });
    assert.deepEqual(
        (await readProjects(root)).map((project) => project.digest),
        ["Alpha: Ready", "Beta: No updates"],
    );
});
console.log("PASS omitted selection refreshes all digests");
