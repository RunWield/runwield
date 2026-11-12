import { seedPlan } from "./testing/plan-state-fixture.ts";
import { test } from "node:test";
import { deepEqual, equal, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { listPlans, listPlanResources, loadPlan, readPlanResourceCatalog } from "../plan-store/index.ts";

import { importPlans, authorLocalPlan } from "../plan-store/index.ts";
import { updateArchivedPlanFrontMatter } from "../plan-store.js";
import { packageFixture, tree } from "./testing/plan-package-fixture.ts";

test("ordinary catalogs ignore checkout Plans, then show only explicitly imported home documents", async () => {
    const fixture = await packageFixture();
    try {
        const directory = join(fixture.root, "docs/plans");
        const selected = join(directory, "selected.md");
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(selected, "# Selected external Plan\n");
        await fs.writeFile(join(directory, "unselected.md"), "# Not imported\n");
        const before = await tree(fixture.root);
        deepEqual(await listPlans(fixture.root), []);
        deepEqual(await listPlanResources(fixture.root), []);
        equal(await loadPlan(fixture.root, "selected"), null);
        deepEqual(await tree(fixture.root), before);
        const imported = await importPlans(fixture.root, selected);
        equal(imported.kind, "committed");
        const plans = await listPlans(fixture.root);
        equal(plans.length, 1);
        equal(plans[0].name, "selected");
        equal(plans[0].attrs.status, "draft");
        equal((await loadPlan(fixture.root, "selected"))?.markdown, "# Selected external Plan\n");
        equal(await loadPlan(fixture.root, "unselected"), null);
        const after = await tree(fixture.root);
        // Explicit admission maintains the owned runtime ignore rule; import preserves source bytes.
        equal((await fs.readFile(join(fixture.root, ".gitignore"), "utf8")).includes(".wld/internal/"), true);
        delete after[".gitignore"];
        deepEqual(after, before);
        const catalog = await readPlanResourceCatalog(fixture.root);
        equal(catalog.resources.length, 1);
        equal(catalog.resources[0].planId, plans[0].attrs.planId);
    } finally {
        await fixture.cleanup();
    }
});

test("ordinary authoring creates a first canonical draft and preserves identity on revisioned edits", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, {
            planName: "first",
            contextMarkdown: "# First\n",
            definition: { summary: "First Plan" },
        });
        equal((await loadPlan(fixture.root, "first"))!.path.includes("/.wld/projects/"), true);
        const first = await loadPlan(fixture.root, "first");
        equal(first?.attrs.status, "draft");
        equal(first?.markdown, "# First\n");
        await authorLocalPlan(fixture.root, {
            planName: "first",
            contextMarkdown: "# Updated\n",
            definition: { summary: "Updated Plan" },
            expectedRevision: first!.revision,
        });
        const updated = await loadPlan(fixture.root, "first");
        equal(updated?.attrs.planId, first?.attrs.planId);
        equal(updated?.markdown, "# Updated\n");
        equal(updated?.attrs.summary, "Updated Plan");
        equal((await listPlans(fixture.root)).length, 1);
        equal(await fs.stat(join(fixture.root, "docs/plans")).catch(() => null), null);
    } finally {
        await fixture.cleanup();
    }
});

test("archive and restore use canonical metadata and preserve document identity without checkout copies", async () => {
    const fixture = await packageFixture();
    try {
        const {
            archivePlan,
            listArchivedPlans,
            loadArchivedPlan,
            restoreArchivedPlan,
            resolvePlan,
            deleteArchivedPlanUnit,
        } = await import("../plan-store/index.ts");
        await seedPlan(fixture.root, "retained", "# Keep the bytes\n");
        const first = await loadPlan(fixture.root, "retained");
        await archivePlan(fixture.root, "retained", { force: true, reason: "Finished" });
        deepEqual(await listPlans(fixture.root), []);
        equal((await listArchivedPlans(fixture.root)).length, 1);
        equal((await loadArchivedPlan(fixture.root, first!.attrs.planId!))?.body, "# Keep the bytes\n");
        await updateArchivedPlanFrontMatter(fixture.root, "retained", { summary: "Archived definition updated" });
        equal((await loadArchivedPlan(fixture.root, "retained"))?.body, "# Keep the bytes\n");
        equal((await loadArchivedPlan(fixture.root, "retained"))?.attrs.summary, "Archived definition updated");
        await rejects(deleteArchivedPlanUnit(fixture.root, "retained"), /history retention is not enabled/);
        await restoreArchivedPlan(fixture.root, "retained", { to: "restored" });
        deepEqual(await listArchivedPlans(fixture.root), []);
        const restored = await resolvePlan(fixture.root, "restored");
        equal(restored.attrs.planId, first!.attrs.planId);
        equal(restored.markdown, first!.markdown);
        equal(await fs.stat(join(fixture.root, "docs/plans")).catch(() => null), null);
    } finally {
        await fixture.cleanup();
    }
});
