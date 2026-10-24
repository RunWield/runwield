import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRepository } from "../src/repository.ts";
import { SummaryBrowser } from "../src/browser.ts";
import type { PlanRef } from "../src/model.ts";

const dimension = process.argv[2];
if (!["project-scope", "owner-scope", "plan-scope"].includes(dimension)) throw new Error("Select a scope proof");
const first: PlanRef = { projectId: "atlas", ownerId: "lee", planId: "plan-1", name: "Delivery" };
const second: PlanRef = { ...first };
if (dimension === "project-scope") second.projectId = "beacon";
if (dimension === "owner-scope") second.ownerId = "sam";
if (dimension === "plan-scope") second.planId = "plan-2";
const root = await mkdtemp(join(tmpdir(), "scope-proof-"));
try {
    const repository = new PlanRepository(root);
    await repository.save(first, { title: "Delivery", body: "Private first draft" });
    await repository.save(second, { title: "Delivery", body: "Second scope draft" });
    const browser = new SummaryBrowser(repository);
    await browser.load(first);
    assert.equal((await browser.load(second)).excerpt, "Second scope draft", "RV-D04-CACHE-SCOPE");
    console.log("PASS " + dimension);
} finally {
    await rm(root, { recursive: true, force: true });
}
