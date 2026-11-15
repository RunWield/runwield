import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, read } from "../testing/plan-package-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { importPlans } from "../../plan-store/index.ts";
import { addEntry, updateEntry, getWorktreeRegistryPath } from "../worktree-registry.js";
import { loadPlan } from "../../plan-store/index.ts";
import { withLocalPlanWorkflow } from "../../plan-store/index.ts";
import { capturePlanAccess } from "../../plan-store/index.ts";

async function retainedFixture() {
    const fixture = await packageFixture();
    const directory = join(fixture.root, "docs/plans");
    await fs.mkdir(directory, { recursive: true });
    const source = join(directory, "active.md");
    await fs.writeFile(
        source,
        "---\nplanId: retained-plan\nclassification: PLANNED_CHANGE\nstatus: implemented\n---\n# Original attempt\n",
    );
    await git(fixture.root, ["add", "docs"]);
    await git(fixture.root, ["commit", "-m", "legacy fixture"]);
    const commit = await git(fixture.root, ["rev-parse", "HEAD"]);
    const execution = join(fixture.root, "execution");
    await git(fixture.root, ["worktree", "add", "-b", "execution", execution]);
    await addEntry(fixture.root, {
        id: "original-attempt",
        planName: "active",
        planId: "retained-plan",
        path: execution,
        branch: "execution",
        baseBranch: "main",
        baseRef: "main",
        baseCommit: commit,
        status: "active",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
    });
    equal((await importPlans(fixture.root, source)).kind, "committed");
    return { ...fixture, execution };
}

test("imported active attempt continues its recorded owner and abandoned settlement survives checkout removal", async () => {
    const fixture = await retainedFixture();
    try {
        await withLocalPlanWorkflow(fixture.root, "active", async () => {
            equal(capturePlanAccess(), undefined);
            const plan = await loadPlan(fixture.root, "active");
            equal(plan?.attrs.worktreeId, "original-attempt");
            await updateEntry(fixture.root, "original-attempt", { status: "abandoned" });
        });
        const settled = await read(fixture.identity, "retained-plan");
        equal(settled.metadata.workflow?.legacySettlement?.outcome, "abandoned");
        equal(settled.metadata.workflow?.legacySettlement?.attemptId, "original-attempt");
        await fs.rm(join(fixture.root, "docs"), { recursive: true });
        await fs.rm(fixture.execution, { recursive: true });
        await withLocalPlanWorkflow(fixture.root, "active", async () => {
            ok(capturePlanAccess());
            equal((await loadPlan(fixture.root, "active"))?.body, "# Original attempt\n");
        });
    } finally {
        await fixture.cleanup();
    }
});

test("changed retained execution identity cannot silently start canonical work", async () => {
    const fixture = await retainedFixture();
    try {
        const registryPath = getWorktreeRegistryPath(fixture.root);
        const original = await fs.readFile(registryPath, "utf8");
        await fs.writeFile(registryPath, original.replace('"branch": "execution"', '"branch": "changed"'));
        let entered = false;
        await rejects(
            withLocalPlanWorkflow(fixture.root, "active", () => {
                entered = true;
                return Promise.resolve();
            }),
            /owner changed/,
        );
        equal(entered, false);
        equal((await read(fixture.identity, "retained-plan")).metadata.workflow?.legacySettlement, undefined);
    } finally {
        await fixture.cleanup();
    }
});

test("publication settlement requires target evidence and remains canonical after legacy documents disappear", async () => {
    const fixture = await retainedFixture();
    try {
        const path = join(fixture.execution, "docs/plans/active.md");
        const original = await fs.readFile(path, "utf8");
        await fs.writeFile(path, original.replace("status: implemented", "status: validated\ntargetBranch: main"));
        await git(fixture.execution, ["add", "docs/plans/active.md"]);
        await git(fixture.execution, ["commit", "-m", "validated legacy delivery"]);
        await updateEntry(fixture.root, "original-attempt", { status: "validated" });
        // A terminal registry label alone cannot prove that the target received this work.
        await withLocalPlanWorkflow(fixture.root, "active", () => {
            equal(capturePlanAccess(), undefined);
            return Promise.resolve();
        });
        equal((await read(fixture.identity, "retained-plan")).metadata.workflow?.legacySettlement, undefined);
        await git(fixture.root, ["merge", "--ff-only", "execution"]);
        await withLocalPlanWorkflow(fixture.root, "active", () => {
            ok(capturePlanAccess());
            return Promise.resolve();
        });
        const settled = await read(fixture.identity, "retained-plan");
        equal(settled.metadata.workflow?.legacySettlement?.outcome, "published");
        equal(settled.metadata.workflow?.legacySettlement?.targetBranch, "main");
        await fs.rm(join(fixture.root, "docs"), { recursive: true });
        await fs.rm(fixture.execution, { recursive: true });
        await withLocalPlanWorkflow(fixture.root, "active", async () => {
            ok(capturePlanAccess());
            equal((await loadPlan(fixture.root, "active"))?.attrs.status, "verified");
        });
    } finally {
        await fixture.cleanup();
    }
});
