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

import { defaultWorkspace, initializeWorkspace } from "../src/setup.ts";
import { saveWorkspace, getWorkspace } from "../src/store.ts";

await check("the default workspace has the requested display label", () => {
    assert.equal(defaultWorkspace().label, "My Workspace");
});
await check("setup preserves an existing workspace selection and custom label", async () => {
    const root = await mkdtemp(join(tmpdir(), "existing-workspace-"));
    try {
        const saved = { id: "research", label: "Field Research" };
        await saveWorkspace(root, saved);
        assert.deepEqual(await initializeWorkspace(root), saved);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("a stored workspace can be retrieved without changing its label", async () => {
    const root = await mkdtemp(join(tmpdir(), "saved-workspace-"));
    try {
        const saved = { id: "default", label: "Personal Notes" };
        await saveWorkspace(root, saved);
        assert.deepEqual(await getWorkspace(root), saved);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
