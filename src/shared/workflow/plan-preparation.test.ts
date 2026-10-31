import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { rm } from "node:fs/promises";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { preparePlanWorkflow } from "./plan-preparation.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Plan preparation\n" });

test("Plan actions prepare pending identity and retain it through document saves", async () => {
    const root = await fixture.checkout();
    try {
        await savePlan(root, "demo", "# Demo\n", { status: "reviewed", humanReviewMode: "always" });
        const pending = await loadPlan(root, "demo");
        strictEqual(pending?.readAvailability?.kind, "pending");
        strictEqual(pending?.attrs.planId, undefined);

        await preparePlanWorkflow(root, "demo");
        const prepared = await loadPlan(root, "demo");
        ok(prepared?.attrs.planId);
        strictEqual(prepared.readAvailability?.kind, "ready");
        strictEqual(prepared.attrs.humanReviewMode, "always");

        await savePlan(root, "demo", "# Revised definition\n", {}, { expectedRevision: prepared.revision });
        const saved = await loadPlan(root, "demo");
        strictEqual(saved?.attrs.planId, prepared.attrs.planId);
        strictEqual(saved?.attrs.humanReviewMode, "always");
        strictEqual(saved?.readAvailability?.kind, "ready");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
