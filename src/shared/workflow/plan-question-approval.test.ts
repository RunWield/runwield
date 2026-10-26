import { test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { makeValidationProjectRoot } from "./validation-test-helpers.js";
import { loadPlan, savePlan } from "../../plan-store.js";
import { applySharedPlanReviewDecision } from "./plan-review-actions.ts";
import type { SharedPlanReviewDecision } from "./plan-review-actions.ts";

const body =
    '# Plan\n\nBefore.\n\n```wld-question\n{"id":"scope","type":"multiple_choice","prompt":"Who can export?","choices":[{"value":"admins","label":"Admins only"},{"value":"all","label":"All members"}],"default":"admins"}\n```\n\nBetween.\n\n```wld-question\n{"id":"keep","type":"yes_no","prompt":"Keep old links?","default":true}\n```\n\nAfter.\n';

interface QuestionPlanFixture {
    root: string;
    decide: (decision: SharedPlanReviewDecision) => ReturnType<typeof applySharedPlanReviewDecision>;
    path: string;
}
async function withQuestionPlan(verify: (fixture: QuestionPlanFixture) => Promise<void>) {
    const root = await makeValidationProjectRoot("questions", { status: "draft" });
    try {
        const initial = await loadPlan(root, "questions");
        assert(initial);
        await savePlan(
            root,
            "questions",
            body,
            {
                classification: "PLANNED_CHANGE",
                status: "draft",
                affectedPaths: [],
            },
            { expectedRevision: initial.revision },
        );
        const plan = await loadPlan(root, "questions");
        assert(plan);
        const decide = (decision: SharedPlanReviewDecision) =>
            applySharedPlanReviewDecision({
                cwd: root,
                planName: "questions",
                planPath: plan.path,
                planWithFrontMatter: plan.markdown,
                planRevision: plan.revision,
                originalAttrs: plan.attrs,
                trustedClassification: "PLANNED_CHANGE",
                decision,
            });
        await verify({ root, decide, path: plan.path });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("approval writes owner and recommended answers to the real Plan file and cannot apply twice", async () => {
    await withQuestionPlan(async ({ root, decide, path }) => {
        const decision: SharedPlanReviewDecision = {
            approved: true,
            approvalAction: "later",
            questionAnswers: [{ id: "scope", value: "all" }],
        };
        assertEquals((await decide(decision)).approved, true);
        const written = await readFile(path, "utf8");
        assertEquals(written.includes("```wld-question"), false);
        assertStringIncludes(written, "All members (answered in review)");
        assertStringIncludes(written, "Yes (recommended; not answered in review)");
        assertStringIncludes(written, "Before.");
        assertStringIncludes(written, "Between.");
        assertStringIncludes(written, "After.");
        const repeated = await decide(decision);
        assertEquals(repeated.approved, false);
        assertEquals(await readFile(path, "utf8"), written);
        assertEquals((await loadPlan(root, "questions"))?.attrs.status, "approved");
    });
});

test("feedback leaves question fences in the real Plan file", async () => {
    await withQuestionPlan(async ({ decide, path }) => {
        await decide({ approved: false, feedback: "Please revise.", questionAnswers: [{ id: "scope", value: "all" }] });
        const written = await readFile(path, "utf8");
        assertEquals(written.slice(written.indexOf("# Plan")), body);
        assertEquals(written.includes("answered in review"), false);
    });
});

test("a stale question Plan cannot overwrite newer instructions on approval", async () => {
    await withQuestionPlan(async ({ decide, path }) => {
        const changed = (await readFile(path, "utf8")).replace("Before.", "New instructions.");
        await writeFile(path, changed);
        const result = await decide({
            approved: true,
            approvalAction: "later",
            questionAnswers: [{ id: "scope", value: "all" }],
        });
        assertEquals(result.approved, false);
        assertEquals(result.cancellationReason, "stale_plan_review");
        assertEquals(await readFile(path, "utf8"), changed);
    });
});
