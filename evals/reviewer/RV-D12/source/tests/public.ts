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
import { listRegistry } from "../src/registry.ts";
import { registerProject } from "../src/register.ts";
import { withRegistryLock } from "../src/lock.ts";
import type { CatalogPort } from "../src/catalog.ts";

const catalog: CatalogPort = { lookup: async (id) => ({ id, label: "Atlas" }) };
await check("a new registry is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "registry-"));
    try {
        assert.deepEqual(await listRegistry(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("catalog refusal leaves no registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "registry-"));
    try {
        await assert.rejects(() => registerProject(root, "atlas", { lookup: async () => null }), /Catalog refused/);
        assert.deepEqual(await listRegistry(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("catalog outage is not reported as a successful registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "registry-"));
    try {
        await assert.rejects(
            () =>
                registerProject(root, "atlas", {
                    lookup: async () => {
                        throw new Error("Catalog unavailable");
                    },
                }),
            /Catalog unavailable/,
        );
        assert.deepEqual(await listRegistry(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
