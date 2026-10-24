let passed = 0;
async function check(name: string, assertion: () => void | Promise<void>): Promise<void> {
    await assertion();
    passed += 1;
    console.log("PASS " + name);
}

import assert from "node:assert/strict";
import type { ProjectCatalog } from "../src/model.ts";
import { listProjects } from "../src/project-list.ts";

await check("the default listing hides archived projects", async () => {
    const catalog: ProjectCatalog = {
        page: async () => ({
            items: [
                { id: "active", archived: false },
                { id: "old", archived: true },
            ],
        }),
    };
    assert.deepEqual(await listProjects(catalog), [{ id: "active", archived: false }]);
});
await check("a catalog failure is not reported as an empty successful listing", async () => {
    const catalog: ProjectCatalog = {
        page: async () => {
            throw new Error("Catalog unavailable");
        },
    };
    await assert.rejects(() => listProjects(catalog), /Catalog unavailable/);
});

console.log(`# tests ${passed}`);
