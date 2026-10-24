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
import { PlanRepository } from "../src/repository.ts";
import { SummaryBrowser } from "../src/browser.ts";
import { summarize } from "../src/summary.ts";

const ref = { projectId: "atlas", ownerId: "owner-one", planId: "plan-1", name: "Delivery" };
await check("summaries collapse markup and whitespace", () => {
    assert.deepEqual(summarize({ title: "Delivery", body: "# Ship  **the**\n change" }), {
        title: "Delivery",
        excerpt: "Ship the change",
        words: 3,
    });
});
await check("the browser reads the saved Plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-"));
    try {
        const repository = new PlanRepository(root);
        await repository.save(ref, { title: "Delivery", body: "Ready to ship" });
        const browser = new SummaryBrowser(repository);
        assert.equal((await browser.load(ref)).excerpt, "Ready to ship");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
