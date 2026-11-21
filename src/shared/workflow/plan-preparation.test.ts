import { seedPlanState, seedPlan } from "../testing/plan-state-fixture.ts";
import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { rm } from "node:fs/promises";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";

import { loadPlan } from "../../plan-store/index.ts";

import { preparePlanWorkflow } from "../../plan-store/index.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Plan preparation\n" });

test("Canonical Plan actions retain allocated identity through document saves", async () => {
    const root = await fixture.checkout();
    try {
        await seedPlan(root, "demo", "# Demo\n", { status: "reviewed", humanReviewMode: "always" });
        await seedPlanState(root, "demo", { humanReviewMode: "always" });
        const pending = await loadPlan(root, "demo");
        strictEqual(pending?.readAvailability?.kind, undefined);
        ok(pending?.attrs.planId);

        await preparePlanWorkflow(root, "demo");
        const prepared = await loadPlan(root, "demo");
        ok(prepared?.attrs.planId);
        strictEqual(prepared.attrs.planId, pending.attrs.planId);
        strictEqual(prepared.readAvailability?.kind, undefined);
        strictEqual(prepared.attrs.humanReviewMode, "always");

        await seedPlan(root, "demo", "# Revised definition\n", {}, { expectedRevision: prepared.revision });
        const saved = await loadPlan(root, "demo");
        strictEqual(saved?.attrs.planId, prepared.attrs.planId);
        strictEqual(saved?.attrs.humanReviewMode, "always");
        strictEqual(saved?.readAvailability?.kind, undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
