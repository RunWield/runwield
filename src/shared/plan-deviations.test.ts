import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "../testing/assertions.ts";
import {
    appendPlanDeviation,
    mergeRecorderDeviationText,
    normalizePlanDeviations,
    renderApprovedPlanDeviations,
    renderPlanDeviationsForWorkRecord,
} from "./plan-deviations.ts";

test("Plan Deviation normalization is strict and preserves order", () => {
    const entries = normalizePlanDeviations([
        {
            id: "call-1",
            supersededRequirement: "  Replace nav. ",
            replacementRequirement: " Keep current nav. ",
            reason: " User decided. ",
            approvedAt: "2026-09-10T00:00:00.000Z",
        },
        {
            id: "call-2",
            supersededRequirement: "Use blue.",
            replacementRequirement: "Use green.",
            approvedAt: "2026-09-10T00:01:00.000Z",
        },
    ]);

    assertEquals(entries, [
        {
            id: "call-1",
            supersededRequirement: "Replace nav.",
            replacementRequirement: "Keep current nav.",
            reason: "User decided.",
            approvedAt: "2026-09-10T00:00:00.000Z",
        },
        {
            id: "call-2",
            supersededRequirement: "Use blue.",
            replacementRequirement: "Use green.",
            approvedAt: "2026-09-10T00:01:00.000Z",
        },
    ]);
});

test("Plan Deviation normalization rejects malformed entries", () => {
    assertThrows(
        () => normalizePlanDeviations([{ id: "call-1", replacementRequirement: "Keep it.", approvedAt: "now" }]),
        Error,
        "supersededRequirement",
    );
    assertThrows(
        () =>
            normalizePlanDeviations([
                {
                    id: "call-1",
                    supersededRequirement: "Old.",
                    replacementRequirement: " ",
                    approvedAt: "now",
                },
            ]),
        Error,
        "replacementRequirement",
    );
    assertThrows(
        () =>
            normalizePlanDeviations([
                {
                    id: "call-1",
                    supersededRequirement: "Old.",
                    replacementRequirement: "New.",
                    approvedAt: "now",
                    extra: "no",
                },
            ]),
        Error,
        "unsupported field extra",
    );
});

test("appendPlanDeviation is idempotent by entry id", () => {
    const first = appendPlanDeviation([], {
        id: "call-1",
        supersededRequirement: "Old.",
        replacementRequirement: "New.",
        approvedAt: "2026-09-10T00:00:00.000Z",
    });
    const second = appendPlanDeviation(first.entries, {
        id: "call-1",
        supersededRequirement: "Other old.",
        replacementRequirement: "Other new.",
        approvedAt: "2026-09-10T00:01:00.000Z",
    });

    assertEquals(first.alreadyCommitted, false);
    assertEquals(second.alreadyCommitted, true);
    assertEquals(second.entries, first.entries);
});

test("Plan Deviation renderers state precedence and Work Record facts", () => {
    const entries = [{
        id: "call-1",
        supersededRequirement: "Replace nav.",
        replacementRequirement: "Keep current nav.",
        reason: "User prefers continuity.",
        approvedAt: "2026-09-10T00:00:00.000Z",
    }];

    const prompt = renderApprovedPlanDeviations(entries);
    const record = renderPlanDeviationsForWorkRecord(entries);

    assertStringIncludes(prompt, "## Approved Plan Deviations");
    assertStringIncludes(prompt, "supersede conflicting original Plan text");
    assertStringIncludes(prompt, "Approved at: 2026-09-10T00:00:00.000Z");
    assertStringIncludes(record, "Superseded requirement: Replace nav.");
    assertEquals(record.includes("Approved at"), false);
});

test("Recorder deviation notes do not duplicate confirmed text", () => {
    const confirmed = [
        "1. Superseded requirement: Replace nav.",
        "   Replacement requirement: Keep nav.",
    ].join("\n");
    const merged = mergeRecorderDeviationText(
        confirmed,
        `${confirmed}\n\n2. Superseded requirement: Use blue.\n   Replacement requirement: Use green.`,
    );

    assertEquals((merged.match(/Replace nav\./g) || []).length, 1);
    assertStringIncludes(merged, "Additional Recorder notes:");
    assertStringIncludes(merged, "Use green.");
});

test("Recorder deviation notes do not duplicate one confirmed entry mixed with new notes", () => {
    const confirmed = [
        "1. Superseded requirement: Replace nav.",
        "   Replacement requirement: Keep nav.",
        "2. Superseded requirement: Use blue.",
        "   Replacement requirement: Use green.",
    ].join("\n");
    const merged = mergeRecorderDeviationText(
        confirmed,
        [
            "1. Superseded requirement: Replace nav.",
            "   Replacement requirement: Keep nav.",
            "",
            "Also changed the launch copy after user review.",
        ].join("\n"),
    );

    assertEquals((merged.match(/Replace nav\./g) || []).length, 1);
    assertStringIncludes(merged, "2. Superseded requirement: Use blue.");
    assertStringIncludes(merged, "Additional Recorder notes:");
    assertStringIncludes(merged, "Also changed the launch copy after user review.");
});
