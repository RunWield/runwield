// @ts-nocheck: Astro workspace check uses browser tsconfig without Deno/JSR test globals.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import {
    buildPlanReviewExecutionPolicyPayload,
    readPlanReviewExecutionPolicy,
    updatePlanReviewExecutionPolicy,
} from "./plan-review-policy.ts";

test("workflow-supplied Engineer Pair policy survives review", () => {
    const policy = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "engineer", collaborationRecommendation: "pair", source: "canonical" },
    }, null);

    assertEquals(policy.executionAgent, "engineer");
    assertEquals(policy.collaborationRecommendation, "pair");
});

test("workflow-supplied Frontend Engineer Pair policy survives review", () => {
    const policy = readPlanReviewExecutionPolicy({
        executionPolicy: {
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
            source: "canonical",
        },
    }, null);

    assertEquals(policy.executionAgent, "frontend-engineer");
    assertEquals(policy.collaborationRecommendation, "pair");
});

test("Engineer Pair written only in Plan Front Matter survives review", () => {
    const policy = readPlanReviewExecutionPolicy(null, {
        classification: "PLANNED_CHANGE",
        executionAgent: '"engineer"',
        collaborationRecommendation: '"pair"',
    });

    assertEquals(policy.executionAgent, "engineer");
    assertEquals(policy.collaborationRecommendation, "pair");
});

test("a Plan without a collaboration recommendation defaults to autonomous", () => {
    const policy = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "frontend-engineer" },
    }, null);

    assertEquals(policy.executionAgent, "frontend-engineer");
    assertEquals(policy.collaborationRecommendation, "autonomous");
});

test("an unrecognized collaboration recommendation falls back to autonomous", () => {
    const policy = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "engineer", collaborationRecommendation: "duet" },
    }, null);

    assertEquals(policy.collaborationRecommendation, "autonomous");
});

test("an unrecognized execution agent falls back to Engineer", () => {
    const policy = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "architect", collaborationRecommendation: "pair" },
    }, null);

    assertEquals(policy.executionAgent, "engineer");
    assertEquals(policy.collaborationRecommendation, "pair");
});

test("a legacy frontend Plan resolves to autonomous Frontend Engineer", () => {
    const policy = readPlanReviewExecutionPolicy({
        frontmatter: { classification: "PLANNED_CHANGE", frontend: true },
    }, null);

    assertEquals(policy.executionAgent, "frontend-engineer");
    assertEquals(policy.collaborationRecommendation, "autonomous");
});

test("the workflow-resolved policy wins over Plan Front Matter", () => {
    const policy = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "engineer", collaborationRecommendation: "pair" },
        frontmatter: { executionAgent: "frontend-engineer", collaborationRecommendation: "autonomous" },
    }, null);

    assertEquals(policy.executionAgent, "engineer");
    assertEquals(policy.collaborationRecommendation, "pair");
});

test("a FEATURE Plan reads as PLANNED_CHANGE and can still choose its execution policy", () => {
    const policy = readPlanReviewExecutionPolicy({ classification: "FEATURE" }, null);

    assertEquals(policy.classification, "PLANNED_CHANGE");
    assertEquals(policy.canSelectExecutionPolicy, true);
});

test("a PROJECT Epic cannot choose an execution policy", () => {
    const policy = readPlanReviewExecutionPolicy({ classification: "PROJECT" }, null);

    assertEquals(policy.classification, "PROJECT");
    assertEquals(policy.canSelectExecutionPolicy, false);
});

test("choosing Pair for an Engineer-owned Plan is kept, not coerced back to autonomous", () => {
    const initial = readPlanReviewExecutionPolicy({ executionPolicy: { executionAgent: "engineer" } }, null);

    const paired = updatePlanReviewExecutionPolicy(initial, {
        field: "collaborationRecommendation",
        value: "pair",
    });

    assertEquals(paired.executionAgent, "engineer");
    assertEquals(paired.collaborationRecommendation, "pair");
});

test("switching owner in either direction leaves the chosen style alone", () => {
    const enginerPair = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "engineer", collaborationRecommendation: "pair" },
    }, null);

    const toFrontend = updatePlanReviewExecutionPolicy(enginerPair, {
        field: "executionAgent",
        value: "frontend-engineer",
    });
    const backToEngineer = updatePlanReviewExecutionPolicy(toFrontend, {
        field: "executionAgent",
        value: "engineer",
    });

    assertEquals(toFrontend, { ...enginerPair, executionAgent: "frontend-engineer" });
    assertEquals(backToEngineer, enginerPair);
});

test("an unrecognized control value leaves the current policy unchanged", () => {
    const current = readPlanReviewExecutionPolicy({
        executionPolicy: { executionAgent: "frontend-engineer", collaborationRecommendation: "pair" },
    }, null);

    assertEquals(updatePlanReviewExecutionPolicy(current, { field: "executionAgent", value: "architect" }), current);
    assertEquals(
        updatePlanReviewExecutionPolicy(current, { field: "collaborationRecommendation", value: "duet" }),
        current,
    );
});

test("the approval payload round-trips the reviewed policy back into a Plan", () => {
    const reviewed = updatePlanReviewExecutionPolicy(
        readPlanReviewExecutionPolicy({ classification: "PLANNED_CHANGE" }, null),
        { field: "collaborationRecommendation", value: "pair" },
    );

    const payload = buildPlanReviewExecutionPolicyPayload(reviewed);

    assertEquals(payload, { executionAgent: "engineer", collaborationRecommendation: "pair" });
    assertEquals(readPlanReviewExecutionPolicy({ executionPolicy: payload }, null), reviewed);
});

test("a PROJECT Epic sends no execution policy with its approval", () => {
    const epic = readPlanReviewExecutionPolicy({ classification: "PROJECT" }, null);

    assertEquals(buildPlanReviewExecutionPolicyPayload(epic), {});
});

test("the review surface delegates execution policy to this module", async () => {
    // The contradiction this Plan removed lived in the surface, so the surface
    // must hold no second copy of the rules: if it imports the module but also
    // sets policy state itself, the two can disagree again.
    const surface = await fsReadFile(new URL("./PlanReviewSurface.tsx", import.meta.url), "utf8");

    assertStringIncludes(surface, 'from "./plan-review-policy.ts"');
    assertStringIncludes(surface, "updatePlanReviewExecutionPolicy(");
    assertStringIncludes(surface, "buildPlanReviewExecutionPolicyPayload(");
    assertEquals(/setExecutionAgent|setCollaborationRecommendation/.test(surface), false);
});

test("a legacy FEATURE Plan keeps its execution policy controls through an owner change", () => {
    const legacy = readPlanReviewExecutionPolicy({ classification: "FEATURE" }, null);

    const switched = updatePlanReviewExecutionPolicy(legacy, {
        field: "executionAgent",
        value: "frontend-engineer",
    });

    assertEquals(switched.classification, "PLANNED_CHANGE");
    assertEquals(switched.canSelectExecutionPolicy, true);
    assertEquals(buildPlanReviewExecutionPolicyPayload(switched), {
        executionAgent: "frontend-engineer",
        collaborationRecommendation: "autonomous",
    });
});
