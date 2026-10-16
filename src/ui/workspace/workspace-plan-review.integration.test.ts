// @ts-nocheck: Deno test imports are checked by scripts/run-tests.js, not Astro check.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertFalse, assertStringIncludes } from "../../testing/assertions.ts";

const ROUTE_PATH = "src/ui/workspace/pages/projects/[projectId]/plans/[planId].astro";
const SESSION_CONTINUATION_PATH = "src/ui/workspace/server/session-continuation.js";
const PLAN_REVIEW_SURFACE_PATH = "src/ui/workspace/react/PlanReviewSurface.tsx";

test("stable Plan page switches from live review to settled Plan home", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");

    assertStringIncludes(route, "PlanReviewSurface");
    assertStringIncludes(route, "PlanHomeSurface");
    assertStringIncludes(route, "getLivePlanReview");
    assertFalse(route.includes("const liveReview = Boolean(runwieldSessionId && operationId && interactionId)"));
    assertStringIncludes(route, "WorkspaceLayout");
    assertStringIncludes(route, "const Layout = reviewPayload ? ReviewLayout : WorkspaceLayout");
    assertStringIncludes(route, 'presentation="workspace"');
});

test("Workspace Plan review returns Feedback to the same live Core interaction", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const surface = await fsReadFile(PLAN_REVIEW_SURFACE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(route, "interactionAnswerUrl");
    assertStringIncludes(route, "/session-operations/${");
    assertStringIncludes(surface, 'response: { outcome: "accepted", _meta: body }');
    assertStringIncludes(continuation, "operation.answer.resolve(runtimeResponse)");
});

test("Workspace Plan review carries the initial Plan into revised review rounds", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(continuation, 'previousPlan: typeof meta.previousPlan === "string"');
    assertStringIncludes(continuation, "planVersions: Array.isArray(meta.planVersions)");
    assertStringIncludes(route, "previousPlan: liveReview.request?.planReview?.previousPlan");
    assertStringIncludes(route, "planVersions: liveReview.request?.planReview?.planVersions");
});

test("lost review interaction prepares but does not send Agent resubmission", async () => {
    const route = await fsReadFile(ROUTE_PATH, "utf8");
    const continuation = await fsReadFile(SESSION_CONTINUATION_PATH, "utf8");

    assertStringIncludes(continuation, 'request.type === "plan_review"');
    assertStringIncludes(continuation, "operation=${");
    assert(!route.includes("startContinuation"));
});
