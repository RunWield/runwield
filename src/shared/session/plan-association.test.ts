import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { normalizePlanAssociation, PLAN_ASSOCIATION_CUSTOM_TYPE, readPlanAssociations } from "./plan-association.ts";

test("normalizes valid Plan Association evidence", () => {
    assertEquals(
        normalizePlanAssociation({
            planId: " plan-1 ",
            planName: " docs/plans/example.md ",
            purpose: "planning",
            segmentId: "segment-1",
            segmentKind: "planning",
            recordedAt: "2026-01-01T00:00:00.000Z",
        }),
        {
            planId: "plan-1",
            planName: "docs/plans/example.md",
            purpose: "planning",
            segmentId: "segment-1",
            segmentKind: "planning",
            recordedAt: "2026-01-01T00:00:00.000Z",
        },
    );
});

test("rejects malformed Plan Association evidence", () => {
    assertEquals(normalizePlanAssociation({ planName: "example", purpose: "planning", segmentId: "segment" }), null);
    assertEquals(normalizePlanAssociation({ planId: "plan", purpose: "unknown", segmentId: "segment" }), null);
    assertEquals(normalizePlanAssociation({ planId: "plan", purpose: "planning" }), null);
});

test("reads Plan Associations in transcript order without deduplication", () => {
    const first = {
        planId: "plan-1",
        planName: "example",
        purpose: "planning",
        segmentId: "segment-1",
        segmentKind: "planning",
        recordedAt: "2026-01-01T00:00:00.000Z",
    };
    const second = { ...first, purpose: "review", recordedAt: "2026-01-01T00:01:00.000Z" };
    assertEquals(
        readPlanAssociations([
            { type: "custom", customType: PLAN_ASSOCIATION_CUSTOM_TYPE, data: first },
            { type: "custom", customType: "runwield.workflow_context", data: { planName: "example" } },
            { type: "custom", customType: PLAN_ASSOCIATION_CUSTOM_TYPE, data: second },
        ]),
        [first, second],
    );
});
