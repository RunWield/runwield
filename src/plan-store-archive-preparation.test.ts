import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
    getPlanRevisionForText,
    loadArchivedPlan,
    loadPlan,
    restoreArchivedPlan,
    updateArchivedPlanFrontMatter,
} from "./plan-store.js";
import { defineCommittedGitFixture } from "./shared/git-test-fixture.ts";
import { readControllerRecord } from "./shared/workflow/controller-registry.ts";

const planId = "archived-legacy-id";
const createdAt = "2020-01-01T00:00:00.000Z";
const updatedAt = "2020-01-02T00:00:00.000Z";
const body = "# Archived Plan\n\nKeep this body. Résumé 世界 🧭\n";
const markdown = `---\nplanId: ${planId}\nclassification: PLANNED_CHANGE\nstatus: implemented\ncreatedAt: ${createdAt}\nupdatedAt: "${updatedAt}"\narchivedAt: "2020-02-01T00:00:00.000Z"\nexecutionReport: Original archived evidence\nvalidationPhase: semantic\n---\n${body}`;
const fixture = defineCommittedGitFixture({ "docs/plans/archived/demo.md": markdown });

for (const action of ["update", "restore"] as const) {
    test(`archived ${action} imports raw legacy evidence before replacing document bytes`, async () => {
        const root = await fixture.checkout();
        try {
            const path = join(root, "docs/plans/archived/demo.md");
            const pending = await loadArchivedPlan(root, "demo");
            strictEqual(pending?.readAvailability?.kind, "pending");
            strictEqual(pending?.attrs.executionReport, undefined);
            strictEqual(await readFile(path, "utf8"), markdown);
            const revision = await getPlanRevisionForText(markdown);
            const now = "2026-09-01T00:00:00.000Z";
            if (action === "update") {
                await updateArchivedPlanFrontMatter(root, planId, { archiveReason: "Keep evidence", updatedAt: now });
            } else {
                await restoreArchivedPlan(root, planId, { now });
            }
            const loaded = action === "update" ? await loadArchivedPlan(root, "demo") : await loadPlan(root, "demo");
            ok(loaded);
            strictEqual(loaded.readAvailability?.kind, "ready");
            strictEqual(loaded.attrs.executionReport, "Original archived evidence");
            strictEqual(loaded.attrs.validationPhase, "semantic");
            strictEqual(loaded.attrs.status, "implemented");
            strictEqual(loaded.attrs.createdAt, createdAt);
            strictEqual(loaded.body, body);
            strictEqual(loaded.markdown.includes("executionReport:"), false);
            strictEqual(loaded.markdown.includes("validationPhase:"), false);
            ok((await getPlanRevisionForText(loaded.markdown)) !== revision);
            const controller = await readControllerRecord(root, { planName: "archived/demo", planId });
            strictEqual(controller?.revision, 1);
            strictEqual(controller?.state.updatedAt, updatedAt);
            // A second write must not replace imported state with its pending projection.
            if (action === "update") {
                await updateArchivedPlanFrontMatter(root, "demo", { archiveReason: "Revised reason" });
                strictEqual(
                    (await loadArchivedPlan(root, "demo"))?.attrs.executionReport,
                    "Original archived evidence",
                );
                strictEqual((await readControllerRecord(root, { planName: "archived/demo", planId }))?.revision, 1);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
