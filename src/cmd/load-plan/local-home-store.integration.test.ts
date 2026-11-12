import { test } from "node:test";
import { equal, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture } from "../../shared/testing/plan-package-fixture.ts";
import { resolvePlanWithPrimaryRecovery } from "../../plan-store/index.ts";
import { listPlans } from "../../plan-store/index.ts";

test("load by name never adopts checkout prose; explicit path imports once and canonical references survive source deletion", async () => {
    const fixture = await packageFixture();
    try {
        const directory = join(fixture.root, "docs/plans");
        await fs.mkdir(directory, { recursive: true });
        const path = join(directory, "external.md");
        const original = "# External request\n\nBuild the requested behavior.\n";
        await fs.writeFile(path, original);
        await rejects(resolvePlanWithPrimaryRecovery(fixture.root, "external"), /not found|No canonical/);
        equal((await listPlans(fixture.root)).length, 0);
        const imported = await resolvePlanWithPrimaryRecovery(fixture.root, path);
        equal(imported.plan.markdown, original);
        equal(await fs.readFile(path, "utf8"), original);
        const repeated = await resolvePlanWithPrimaryRecovery(fixture.root, path);
        equal(repeated.plan.attrs.planId, imported.plan.attrs.planId);
        await fs.rm(directory, { recursive: true });
        const resumed = await resolvePlanWithPrimaryRecovery(fixture.root, imported.plan.attrs.planId!);
        equal(resumed.plan.attrs.planId, imported.plan.attrs.planId);
        equal(resumed.plan.path, imported.plan.path);
        equal((await listPlans(fixture.root)).length, 1);
    } finally {
        await fixture.cleanup();
    }
});
