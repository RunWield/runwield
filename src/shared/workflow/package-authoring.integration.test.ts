import { seedPlan } from "../testing/plan-state-fixture.ts";
import { test } from "node:test";
import { equal, deepEqual, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { type ChildFeaturePlanDescriptor } from "../../plan-format.ts";
import { loadPlan, listPlans, saveChildFeaturePlans } from "../../plan-store/index.ts";

import { packageFixture } from "../testing/plan-package-fixture.ts";
import { authorPackageChildren } from "../../plan-store/index.ts";
import { recoverPlanPackages, type PlanPackageBatchWrite } from "../../plan-store/packages.ts";

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
        await seedPlan(fixture.root, "family", "# Family\n", {
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
        await seedPlan(fixture.root, "family", "# Family\n", { classification: "PROJECT", status: "approved" });
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
        await seedPlan(fixture.root, "sequence", "# Sequence\n", { classification: "PROJECT", type: "sequence" });
        await saveChildFeaturePlans(fixture.root, "sequence", [child("First", ["sequence/second"]), child("Second")]);
        equal((await loadPlan(fixture.root, "sequence"))?.attrs.status, "draft");
        deepEqual((await loadPlan(fixture.root, "sequence/first"))?.attrs.dependencies, ["sequence/second"]);
        equal((await loadPlan(fixture.root, "sequence/second"))?.attrs.parentPlan, "sequence");
    } finally {
        await fixture.cleanup();
    }
});

import { archivePlan, restoreArchivedPlan, authorLocalPlan } from "../../plan-store/index.ts";

test("restored Epics and draft children remain active for decomposition, regeneration and dependencies", async () => {
    const fixture = await packageFixture();
    try {
        await seedPlan(fixture.root, "family", "# Family\n", {
            classification: "PROJECT",
            type: "epic",
            status: "approved",
        });
        await saveChildFeaturePlans(fixture.root, "family", [child("First"), child("Second")]);
        for (const name of ["family", "family/first", "family/second"]) {
            await archivePlan(fixture.root, name, { force: true });
            await restoreArchivedPlan(fixture.root, name);
        }
        const before = (await loadPlan(fixture.root, "family/first"))!;
        await authorPackageChildren(fixture.root, "family", [], {}, true);
        equal((await loadPlan(fixture.root, "family"))?.attrs.status, "ready_for_work");
        const updated = await saveChildFeaturePlans(
            fixture.root,
            "family",
            [{ ...child("First", ["family/second"]), content: "# Regenerated\n" }],
            { expectedRevisions: { "family/first": before.revision } },
        );
        equal(updated[0].action, "updated");
        const after = (await loadPlan(fixture.root, "family/first"))!;
        equal(after.attrs.planId, before.attrs.planId);
        equal(after.markdown, "# Regenerated\n");
        deepEqual(after.attrs.dependencies, ["family/second"]);
        await archivePlan(fixture.root, "family/second", { force: true });
        await rejects(
            saveChildFeaturePlans(fixture.root, "family", [child("Third", ["family/second"])]),
            /No canonical Plan/,
        );
        equal(await loadPlan(fixture.root, "family/third"), null);
    } finally {
        await fixture.cleanup();
    }
});

test("prose authoring preserves omitted typed facts and relationships while accepting explicit changes", async () => {
    const fixture = await packageFixture();
    try {
        for (const name of ["parent", "other", "dependency"]) {
            await authorLocalPlan(fixture.root, { planName: name, contextMarkdown: `# ${name}\n` });
        }
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            contextMarkdown: "# Proposal\n",
            validationMarkdown: "Keep checks\n",
            parentPlan: "parent",
            dependencies: ["dependency"],
            definition: {
                classification: "PROJECT",
                type: "sequence",
                summary: "Typed summary",
                targetBranch: "main",
                order: 3,
                frontend: true,
            },
        });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        equal(before.attrs.summary, "Typed summary");
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            contextMarkdown: "# Revised prose\n",
            expectedRevision: before.revision,
            definition: { summary: undefined, targetBranch: undefined },
        });
        const after = (await loadPlan(fixture.root, "proposal"))!;
        for (const key of [
            "classification",
            "type",
            "summary",
            "targetBranch",
            "order",
            "frontend",
            "parentPlan",
            "dependencies",
        ] as const) {
            deepEqual(after.attrs[key], before.attrs[key], key);
        }
        equal(after.markdown, "# Revised prose\n");
        await rejects(
            authorLocalPlan(fixture.root, {
                planName: "proposal",
                contextMarkdown: "# Stale\n",
                expectedRevision: before.revision,
                definition: { summary: "Lost" },
                dependencies: [],
            }),
            /changed|stale|revision/i,
        );
        equal((await loadPlan(fixture.root, "proposal"))?.revision, after.revision);
        await authorLocalPlan(fixture.root, {
            planName: "proposal",
            contextMarkdown: "# Explicit update\n",
            expectedRevision: after.revision,
            parentPlan: "other",
            dependencies: [],
            definition: { type: "epic", summary: "New summary", targetBranch: "release", order: 0, frontend: false },
        });
        const changed = (await loadPlan(fixture.root, "proposal"))!;
        equal(changed.attrs.classification, "PROJECT");
        equal(changed.attrs.type, "epic");
        equal(changed.attrs.summary, "New summary");
        equal(changed.attrs.targetBranch, "release");
        equal(changed.attrs.order, 0);
        equal(changed.attrs.frontend, false);
        equal(changed.attrs.parentPlan, "other");
        deepEqual(changed.attrs.dependencies, []);
    } finally {
        await fixture.cleanup();
    }
});
