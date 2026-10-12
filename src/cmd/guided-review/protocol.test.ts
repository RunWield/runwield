import { assertEquals, assertThrows } from "@std/assert";
import {
    encodeGuidedReviewUsageEvent,
    GUIDED_REVIEW_EVENT_PREFIX,
    type GuidedReviewUsage,
    parseGuidedReviewUsageEventLine,
} from "./protocol.ts";

const usage: GuidedReviewUsage = {
    inputTokens: 12,
    outputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
};

Deno.test("Guided Review version 2 preserves missing, zero, and present measurements", () => {
    assertEquals(parseGuidedReviewUsageEventLine(encodeGuidedReviewUsageEvent(usage)), {
        version: 2,
        type: "usage",
        usage,
    });
});

Deno.test("Guided Review rejects version 1 frames rather than treating old zero filling as measurements", () => {
    assertThrows(
        () =>
            parseGuidedReviewUsageEventLine(
                `${GUIDED_REVIEW_EVENT_PREFIX}${JSON.stringify({ version: 1, type: "usage", usage })}`,
            ),
        Error,
        "version 2",
    );
});

Deno.test("Guided Review requires explicit nullable categories", () => {
    const { costUsd: _cost, ...incomplete } = usage;
    assertThrows(
        () =>
            parseGuidedReviewUsageEventLine(
                `${GUIDED_REVIEW_EVENT_PREFIX}${JSON.stringify({ version: 2, type: "usage", usage: incomplete })}`,
            ),
        Error,
        "costUsd",
    );
});

Deno.test("Guided Review rejects invalid negative measurements", () => {
    assertThrows(
        () => parseGuidedReviewUsageEventLine(encodeGuidedReviewUsageEvent({ ...usage, inputTokens: -1 })),
        Error,
        "inputTokens",
    );
});
