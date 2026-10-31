import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRunWieldRuntimeDir } from "../../constants.js";
import { getPlanRevisionForText, loadPlan } from "../../plan-store.js";
import { resolvePlanWithPrimaryRecovery } from "../../cmd/load-plan/primary-plan-recovery.ts";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { executePlanAction, loadPlanActionEvidence } from "./plan-actions.ts";

const planId = "83468a46-d34e-4e3d-af27-c4924dc4ab88";
const body = "# Original Plan\n\nKeep this body. Résumé 世界 🧭\n";
const markdown = `---\nplanId: ${planId}\nclassification: PLANNED_CHANGE\nstatus: draft\ncreatedAt: "2020-01-01T00:00:00.000Z"\nexecutionReport: Original workflow evidence\n---\n${body}`;
const fixture = defineCommittedGitFixture({ "docs/plans/demo.md": markdown });

async function seedLegacyRuntime(root: string) {
    const directory = join(getRunWieldRuntimeDir(root), "debug");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "legacy.txt"), "Retain legacy evidence\n");
}

for (const legacy of [false, true]) {
    test(`pending action evidence grants no authorization and does not prepare runtime (legacy: ${legacy})`, async () => {
        const root = await fixture.checkout();
        try {
            if (legacy) await seedLegacyRuntime(root);
            const marker = resolveProjectRuntimeLayout(root).primary.layoutMarkerPath;
            const evidence = await loadPlanActionEvidence(root, planId);
            strictEqual(evidence.kind, "invalid_action");
            if (evidence.kind === "invalid_action") ok(evidence.message.includes("pending"));
            strictEqual(
                await stat(marker)
                    .then(() => true)
                    .catch(() => false),
                false,
            );
            strictEqual(await readFile(join(root, "docs/plans/demo.md"), "utf8"), markdown);
            if (legacy)
                strictEqual(
                    await readFile(join(getRunWieldRuntimeDir(root), "debug/legacy.txt"), "utf8"),
                    "Retain legacy evidence\n",
                );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("lifecycle action prepares before checking revisions, then preserves the body and original age", async () => {
    const root = await fixture.checkout();
    try {
        await seedLegacyRuntime(root);
        const request = {
            planId,
            expectedRevision: "stale",
            expectedStatus: "draft",
            expectedWorktree: { kind: "none" as const },
            action: "put_on_hold" as const,
            holdReason: "Wait for owner input",
        };
        const stale = await executePlanAction(root, request);
        strictEqual(stale.kind, "refresh_required");
        const prepared = await loadPlan(root, "demo");
        strictEqual(prepared?.readAvailability?.kind, "ready");
        strictEqual(prepared?.attrs.executionReport, "Original workflow evidence");
        strictEqual(await readFile(join(root, "docs/plans/demo.md"), "utf8"), markdown);
        const changed = await executePlanAction(root, {
            ...request,
            expectedRevision: await getPlanRevisionForText(markdown),
        });
        strictEqual(changed.kind, "success");
        const held = await loadPlan(root, "demo");
        strictEqual(held?.attrs.status, "on_hold");
        strictEqual(held?.attrs.createdAt, "2020-01-01T00:00:00.000Z");
        strictEqual(held?.body, body);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const argument of ["demo", planId]) {
    test(`selected load prepares legacy runtime and controller without a preceding catalog (${argument})`, async () => {
        const root = await fixture.checkout();
        try {
            await seedLegacyRuntime(root);
            const selected = await resolvePlanWithPrimaryRecovery(root, argument);
            strictEqual(selected.plan.attrs.executionReport, "Original workflow evidence");
            strictEqual(selected.plan.readAvailability?.kind, "ready");
            strictEqual(selected.plan.body, body);
            strictEqual(selected.plan.attrs.createdAt, "2020-01-01T00:00:00.000Z");
            strictEqual(await readFile(join(root, "docs/plans/demo.md"), "utf8"), markdown);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
