import { assertEquals } from "@std/assert";
import {
    normalizePlanApprovalAction,
    PLAN_APPROVAL_ACTIONS,
    primaryPlanApprovalActionForClassification,
    readPlanApprovalAction,
} from "./plan-approval.ts";

Deno.test("normalizes FEATURE approval actions", () => {
    assertEquals(
        normalizePlanApprovalAction({ classification: "FEATURE", action: "run" }),
        PLAN_APPROVAL_ACTIONS.RUN,
    );
    assertEquals(
        normalizePlanApprovalAction({ classification: "FEATURE", action: "later" }),
        PLAN_APPROVAL_ACTIONS.LATER,
    );
    assertEquals(
        normalizePlanApprovalAction({ classification: "FEATURE", action: "decompose" }),
        PLAN_APPROVAL_ACTIONS.LATER,
    );
});

Deno.test("normalizes PROJECT approval actions", () => {
    assertEquals(
        normalizePlanApprovalAction({ classification: "PROJECT", action: "decompose" }),
        PLAN_APPROVAL_ACTIONS.DECOMPOSE,
    );
    assertEquals(
        normalizePlanApprovalAction({ classification: "PROJECT", action: "later" }),
        PLAN_APPROVAL_ACTIONS.LATER,
    );
    assertEquals(
        normalizePlanApprovalAction({ classification: "PROJECT", action: "run" }),
        PLAN_APPROVAL_ACTIONS.LATER,
    );
});

Deno.test("missing, unknown, and untrusted approval actions are deferred", () => {
    assertEquals(normalizePlanApprovalAction({ classification: "FEATURE" }), PLAN_APPROVAL_ACTIONS.LATER);
    assertEquals(
        normalizePlanApprovalAction({ classification: "PROJECT", action: "execute" }),
        PLAN_APPROVAL_ACTIONS.LATER,
    );
    assertEquals(
        normalizePlanApprovalAction({ classification: "QUICK_FIX", action: "run" }),
        PLAN_APPROVAL_ACTIONS.LATER,
    );
});

Deno.test("classification primary actions are explicit", () => {
    assertEquals(primaryPlanApprovalActionForClassification("PROJECT"), PLAN_APPROVAL_ACTIONS.DECOMPOSE);
    assertEquals(primaryPlanApprovalActionForClassification("FEATURE"), PLAN_APPROVAL_ACTIONS.RUN);
    assertEquals(primaryPlanApprovalActionForClassification(undefined), PLAN_APPROVAL_ACTIONS.RUN);
});

Deno.test("transport action reader only accepts known approval actions", () => {
    assertEquals(readPlanApprovalAction("run"), PLAN_APPROVAL_ACTIONS.RUN);
    assertEquals(readPlanApprovalAction("decompose"), PLAN_APPROVAL_ACTIONS.DECOMPOSE);
    assertEquals(readPlanApprovalAction("later"), PLAN_APPROVAL_ACTIONS.LATER);
    assertEquals(readPlanApprovalAction("execute"), undefined);
});
