import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { normalizePlanReviewVersions } from "./plan-review-versions.ts";

test("Plan review versions preserve every distinct review round", () => {
    const versions = normalizePlanReviewVersions("round three", null, [
        { plan: "round one", timestamp: "2026-08-23T01:00:00.000Z" },
        { plan: "round two", timestamp: "2026-08-23T02:00:00.000Z" },
        { plan: "round three", timestamp: "2026-08-23T03:00:00.000Z" },
    ]);

    assertEquals(versions, [
        { version: 1, plan: "round one", timestamp: "2026-08-23T01:00:00.000Z" },
        { version: 2, plan: "round two", timestamp: "2026-08-23T02:00:00.000Z" },
        { version: 3, plan: "round three", timestamp: "2026-08-23T03:00:00.000Z" },
    ]);
});

test("legacy initial/current payloads become a two-version history", () => {
    assertEquals(normalizePlanReviewVersions("revised", "initial", null), [
        { version: 1, plan: "initial", timestamp: "" },
        { version: 2, plan: "revised", timestamp: "" },
    ]);
});

test("duplicate supplied snapshots are collapsed", () => {
    assertEquals(
        normalizePlanReviewVersions("revised", null, [
            { plan: "initial" },
            { plan: "initial" },
            { plan: "revised" },
        ]).map((entry) => entry.plan),
        ["initial", "revised"],
    );
});
