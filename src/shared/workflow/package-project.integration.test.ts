import { test } from "node:test";
import { equal, deepEqual, rejects } from "node:assert/strict";
import { create, packageFixture, tree } from "../testing/plan-package-fixture.ts";
import { listPlanPackages } from "../../plan-store/packages.ts";
import { currentWorkRecordOwner } from "../work-records/owner.ts";
import { loadPackageWorkflowPlan } from "../../plan-store/workflows.ts";
import { currentPackageProject, withPackageProject } from "../../plan-store/workflows.ts";
import { currentPackageSelection, withPackageWorkflow } from "../../plan-store/workflows.ts";

test("Project package access can inspect an empty store without selecting a Plan or writing files", async () => {
    const fixture = await packageFixture();
    try {
        const before = await tree(fixture.root);
        await withPackageProject(fixture.root, fixture.identity, async () => {
            equal(currentPackageSelection(), undefined);
            equal(currentPackageProject()?.projectId, fixture.identity.projectId);
            equal(currentWorkRecordOwner()?.projectId, fixture.identity.projectId);
            deepEqual(await listPlanPackages(fixture.identity), { packages: [], issues: [] });
        });
        deepEqual(await tree(fixture.root), before);
        equal(currentPackageProject(), undefined);
        equal(currentWorkRecordOwner(), undefined);
    } finally {
        await fixture.cleanup();
    }
});

test("Project reads retain package identity and independent workflow revision admission", async () => {
    const fixture = await packageFixture();
    try {
        const plan = await create(fixture.identity);
        await withPackageProject(fixture.root, fixture.identity, async () => {
            const loaded = await loadPackageWorkflowPlan("one");
            equal(loaded.attrs.planId, plan.metadata.planId);
            equal(loaded.hasFrontMatter, false);
            await rejects(
                withPackageWorkflow(
                    fixture.root,
                    { identity: fixture.identity, planId: plan.metadata.planId, expectedRevision: 0 },
                    async () => {},
                ),
                /changed; reload/,
            );
            equal(currentPackageSelection(), undefined);
        });
    } finally {
        await fixture.cleanup();
    }
});

test("Project package access rejects another repository and does not inherit its selected Plan", async () => {
    const first = await packageFixture();
    const second = await packageFixture();
    try {
        const plan = await create(first.identity);
        await rejects(
            withPackageProject(second.root, first.identity, async () => {}),
            /launch owner and repository/,
        );
        await withPackageWorkflow(
            first.root,
            { identity: first.identity, planId: plan.metadata.planId, expectedRevision: 1 },
            async () => {
                await withPackageProject(second.root, second.identity, async () => {
                    equal(currentPackageSelection(), undefined);
                    equal(currentPackageProject()?.projectId, second.identity.projectId);
                    await rejects(loadPackageWorkflowPlan("one"), /No canonical package/);
                });
                equal(currentPackageSelection()?.planId, plan.metadata.planId);
            },
        );
    } finally {
        await first.cleanup();
        await second.cleanup();
    }
});
