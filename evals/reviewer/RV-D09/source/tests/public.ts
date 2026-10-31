import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStatus } from "../src/lifecycle.ts";
import { readPlan } from "../src/plans.ts";

const root = await mkdtemp(join(tmpdir(), "transition-public-"));
try {
    const path = join(root, "plan.md");
    await writeFile(path, "---\nplanId: plan-1\nstatus: approved\n---\n# Delivery\n\nAuthor draft.\n");
    assert.equal(await planStatus(path), "approved");
    assert.equal((await readPlan(path)).body, "# Delivery\n\nAuthor draft.\n");
    console.log("PASS read author Plan");
} finally {
    await rm(root, { recursive: true, force: true });
}
