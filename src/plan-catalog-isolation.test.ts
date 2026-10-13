import { test } from "node:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertRejects } from "./testing/assertions.ts";
import { ensurePlanIdentity, listPlans, savePlan } from "./plan-store.js";
import { addEntry, listEntries } from "./shared/worktree-registry.js";
import { defineCommittedGitFixture } from "./shared/git-test-fixture.ts";
import { resolveWorkflowPlanLocation } from "./shared/workflow/plan-location.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Plan catalog isolation\n" });

async function missingExecutionPlan() {
    const cwd = await fixture.checkout();
    const path = join(cwd, "execution");
    await mkdir(path);
    await savePlan(cwd, "broken", "# Primary copy\n", { planId: "broken-id", status: "in_progress" });
    await savePlan(cwd, "healthy", "# Healthy\n", { planId: "healthy-id", status: "implemented" });
    await addEntry(cwd, {
        id: "broken-worktree",
        planName: "broken",
        planId: "broken-id",
        path,
        branch: "worktree/broken",
        baseBranch: "main",
        baseRef: "HEAD",
        baseCommit: "abc123",
        status: "active",
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
    });
    return { cwd, path };
}

test("Plan catalog excludes a missing execution document without blocking healthy Plans", async () => {
    const { cwd } = await missingExecutionPlan();
    const primaryPath = join(cwd, "docs/plans/broken.md");
    const before = await readFile(primaryPath, "utf8");
    const registryBefore = await listEntries(cwd);
    assertEquals(
        (await listPlans(cwd)).map((plan) => plan.name),
        ["healthy"],
    );
    assertEquals(await readFile(primaryPath, "utf8"), before);
    assertEquals(await listEntries(cwd), registryBefore);
});

test("validation identity preparation works when another execution Plan is missing", async () => {
    const { cwd } = await missingExecutionPlan();
    assertEquals((await ensurePlanIdentity(cwd, "healthy")).planId, "healthy-id");
});

test("loading the affected Plan still rejects the missing execution document", async () => {
    const { cwd } = await missingExecutionPlan();
    await assertRejects(() => resolveWorkflowPlanLocation(cwd, "broken"), Error, "execution Plan is missing");
});

test("identity assignment reserves IDs of missing execution Plans", async () => {
    const { cwd } = await missingExecutionPlan();
    await rm(join(cwd, "docs/plans/broken.md"));
    await savePlan(cwd, "new-plan", "# New\n", { status: "draft" });
    const ids = ["broken-id", "new-id"];
    const result = await ensurePlanIdentity(cwd, "new-plan", { idGenerator: () => ids.shift() || "unexpected-id" });
    assertEquals(result.planId, "new-id");
});
