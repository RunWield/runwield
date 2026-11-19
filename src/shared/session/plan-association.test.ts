import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    normalizePlanAssociation,
    PLAN_ASSOCIATION_CUSTOM_TYPE,
    readPlanAssociations,
    planAssociationAtTime,
    type ManifestPlanAssociation,
} from "./plan-association.ts";
import type { SessionTranscriptSegment } from "./file-session-store-types.ts";

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

test("time scopes reject uncommitted, ambiguous, sealed, and wrong-scope associations", () => {
    const segment: SessionTranscriptSegment = {
        segmentId: "segment",
        runwieldSessionId: "session",
        projectId: "project",
        piSessionId: "pi",
        transcriptPath: "transcript.jsonl",
        transcriptCwd: "/fixture",
        ordinal: 0,
        kind: "execution",
        sealedAt: null,
        headerVersion: 3,
        headerTimestamp: null,
        firstCatalogedAt: "2026-01-01T00:00:00.000Z",
        lastCatalogedAt: "2026-01-01T00:00:00.000Z",
        lineageParentSegmentId: null,
        lineageParentPiSessionId: null,
        lineageGroupKey: null,
        lineageRecordedAt: null,
        sealedByteLength: null,
        sealedDigestHex: null,
        sealedTerminalEntryId: null,
    };
    const association: ManifestPlanAssociation = {
        planId: "plan-alpha",
        planName: "alpha",
        purpose: "execution",
        segmentId: "segment",
        segmentKind: "execution",
        recordedAt: "2026-01-01T00:00:10.000Z",
        committedGeneration: 1,
    };
    const scope = { segmentId: "segment", planName: "alpha", ts: "2026-01-01T00:00:15.000Z" };
    assertEquals(planAssociationAtTime([association], [segment], scope)?.planId, "plan-alpha");
    assertEquals(planAssociationAtTime([{ ...association, committedGeneration: null }], [segment], scope), undefined);
    assertEquals(
        planAssociationAtTime(
            [association, { ...association, planId: "plan-beta", planName: "beta" }],
            [segment],
            scope,
        ),
        undefined,
    );
    assertEquals(planAssociationAtTime([association], [{ ...segment, sealedAt: scope.ts }], scope), undefined);
    assertEquals(planAssociationAtTime([association], [segment], { ...scope, segmentId: "other" }), undefined);
    assertEquals(planAssociationAtTime([association], [segment], { ...scope, planName: "beta" }), undefined);
    assertEquals(planAssociationAtTime([association], [segment], { ...scope, planName: undefined }), undefined);
});
