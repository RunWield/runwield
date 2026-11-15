import { seedPlan } from "./shared/testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "./shared/testing/retained-plan-fixture.ts";
import { test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertRejects } from "./testing/assertions.ts";
import { ensurePlanIdentity, listPlans } from "./plan-store/index.ts";

import { addEntry, listEntries } from "./shared/worktree-registry.js";
import { defineCommittedGitFixture, git } from "./shared/git-test-fixture.ts";
import { resolveWorkflowPlanLocation } from "./plan-store/index.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Plan catalog isolation\n" });

interface MissingExecutionPlan {
    cwd: string;
    path: string;
}

async function withMissingExecutionPlan(run: (fixture: MissingExecutionPlan) => Promise<void>) {
    const cwd = await fixture.checkout();
    try {
        await withRetainedPlanFixture(cwd, async () => {
            const path = join(cwd, "execution");
            await git(cwd, ["worktree", "add", "-b", "worktree/broken", path]);
            await seedPlan(cwd, "broken", "# Primary copy\n", { planId: "broken-id", status: "in_progress" });
            await seedPlan(cwd, "healthy", "# Healthy\n", { planId: "healthy-id", status: "implemented" });
            await addEntry(cwd, {
                id: "broken-worktree",
                planName: "broken",
                planId: "broken-id",
                path,
                branch: "worktree/broken",
                baseBranch: "main",
                baseRef: "HEAD",
                baseCommit: await git(cwd, ["rev-parse", "HEAD"]),
                status: "active",
                createdAt: "2026-10-12T00:00:00.000Z",
                updatedAt: "2026-10-12T00:00:00.000Z",
            });
            await run({ cwd, path });
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}

test("Plan catalog excludes a missing execution document without blocking healthy Plans", async () => {
    await withMissingExecutionPlan(async ({ cwd }) => {
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
});

test("validation identity preparation works when another execution Plan is missing", async () => {
    await withMissingExecutionPlan(async ({ cwd }) => {
        assertEquals((await ensurePlanIdentity(cwd, "healthy")).planId, "healthy-id");
    });
});

test("loading the affected Plan still rejects the missing execution document", async () => {
    await withMissingExecutionPlan(async ({ cwd }) => {
        await assertRejects(() => resolveWorkflowPlanLocation(cwd, "broken"), Error, "execution Plan is missing");
    });
});

test("identity assignment reserves IDs of missing execution Plans", async () => {
    await withMissingExecutionPlan(async ({ cwd }) => {
        await rm(join(cwd, "docs/plans/broken.md"));
        await seedPlan(cwd, "new-plan", "# New\n", { status: "draft" });
        const ids = ["broken-id", "new-id"];
        const result = await ensurePlanIdentity(cwd, "new-plan", { idGenerator: () => ids.shift() || "unexpected-id" });
        assertEquals(result.planId, "new-id");
    });
});
