import { test } from "node:test";
import { equal, deepEqual, rejects, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import {
    savePlan,
    loadPlan,
    listPlans,
    saveChildFeaturePlans,
    type ChildFeaturePlanDescriptor,
} from "../../plan-store.js";
import { packageFixture } from "../testing/plan-package-fixture.ts";
import { authorPackageChildren } from "./package-authoring.ts";
import { recoverPlanPackages, type PlanPackageBatchWrite } from "../plan-package-store.ts";

const child = (title: string, dependencies: string[] = []): ChildFeaturePlanDescriptor => ({
    title,
    summary: title,
    affectedPaths: ["src/"],
    dependencies,
    content: `# ${title}\n`,
    executionAgent: "engineer",
});

test("canonical family authoring resolves forward dependencies and commits parent readiness with all children", async () => {
    const fixture = await packageFixture();
    try {
        await savePlan(fixture.root, "family", "# Family\n", {
            classification: "PROJECT",
            type: "epic",
            status: "approved",
        });
        const results = await authorPackageChildren(
            fixture.root,
            "family",
            [child("First", ["family/second"]), child("Second")],
            {},
            true,
        );
        equal(results.length, 2);
        equal((await loadPlan(fixture.root, "family"))?.attrs.status, "ready_for_work");
        deepEqual((await loadPlan(fixture.root, "family/first"))?.attrs.dependencies, ["family/second"]);
        const before = await loadPlan(fixture.root, "family/first");
        await rejects(
            saveChildFeaturePlans(fixture.root, "family", [child("First"), child("Third", ["missing"])], {
                expectedRevisions: { "family/first": before!.revision },
            }),
            /No canonical Plan/,
        );
        equal((await loadPlan(fixture.root, "family/first"))?.revision, before?.revision);
        equal(await loadPlan(fixture.root, "family/third"), null);
    } finally {
        await fixture.cleanup();
    }
});

test("interrupted family generation stays hidden and recovers forward without overwriting outside edits", async () => {
    const fixture = await packageFixture();
    try {
        await savePlan(fixture.root, "family", "# Family\n", { classification: "PROJECT", status: "approved" });
        await authorPackageChildren(fixture.root, "family", [child("First"), child("Second")], {}, true);
        const home = join(fixture.identity.executionAccountHome, ".wld/projects", fixture.identity.projectId);
        const batchPath = join(home, "internal/plan-packages/batch.json");
        const batch: { phase: string; authoring: PlanPackageBatchWrite[] } = JSON.parse(
            await fs.readFile(batchPath, "utf8"),
        );
        batch.phase = "pending";
        await fs.writeFile(batchPath, JSON.stringify(batch));
        for (const write of batch.authoring) {
            const path = join(home, "plans", write.metadata.name);
            if (!write.before) await fs.rm(path, { recursive: true });
            else {
                await fs.writeFile(join(path, "plan.wld.json"), JSON.stringify(write.before.metadata, null, 2) + "\n");
            }
        }
        await rejects(listPlans(fixture.root), /pending|recover/i);
        const parentPath = join(home, "plans/family/context.md");
        await fs.writeFile(parentPath, "# Outside edit\n");
        await rejects(recoverPlanPackages(fixture.identity), /preserving both generations/);
        equal(await fs.readFile(parentPath, "utf8"), "# Outside edit\n");
        await fs.writeFile(parentPath, "# Family\n");
        await recoverPlanPackages(fixture.identity);
        equal((await listPlans(fixture.root)).length, 3);
        equal((await loadPlan(fixture.root, "family"))?.attrs.status, "ready_for_work");
        equal((await loadPlan(fixture.root, "family/second"))?.markdown, "# Second\n");
    } finally {
        await fixture.cleanup();
    }
});

test("a new Sequence can author draft children with forward relations without finalizing an Epic", async () => {
    const fixture = await packageFixture();
    try {
        await savePlan(fixture.root, "sequence", "# Sequence\n", { classification: "PROJECT", type: "sequence" });
        await saveChildFeaturePlans(fixture.root, "sequence", [child("First", ["sequence/second"]), child("Second")]);
        equal((await loadPlan(fixture.root, "sequence"))?.attrs.status, "draft");
        deepEqual((await loadPlan(fixture.root, "sequence/first"))?.attrs.dependencies, ["sequence/second"]);
        equal((await loadPlan(fixture.root, "sequence/second"))?.attrs.parentPlan, "sequence");
    } finally {
        await fixture.cleanup();
    }
});
