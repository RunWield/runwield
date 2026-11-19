import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
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

test("Guided Review version 2 preserves missing, zero, and present measurements", () => {
    assertEquals(
        encodeGuidedReviewUsageEvent(usage),
        'RUNWIELD_GUIDED_REVIEW_EVENT {"version":2,"type":"usage","usage":{"inputTokens":12,"outputTokens":0,"cacheReadTokens":null,"cacheWriteTokens":null,"costUsd":null}}\n',
    );
    assertEquals(
        parseGuidedReviewUsageEventLine(
            'RUNWIELD_GUIDED_REVIEW_EVENT {"version":2,"type":"usage","usage":{"inputTokens":12,"outputTokens":0,"cacheReadTokens":null,"cacheWriteTokens":null,"costUsd":null}}\n',
        ),
        {
            version: 2,
            type: "usage",
            usage,
        },
    );
});

test("Guided Review rejects version 1 frames rather than treating old zero filling as measurements", () => {
    assertThrows(
        () =>
            parseGuidedReviewUsageEventLine(
                `${GUIDED_REVIEW_EVENT_PREFIX}${JSON.stringify({ version: 1, type: "usage", usage })}`,
            ),
        Error,
        "version 2",
    );
});

test("Guided Review requires explicit nullable categories", () => {
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

test("Guided Review rejects invalid negative measurements", () => {
    assertThrows(
        () =>
            parseGuidedReviewUsageEventLine(
                `RUNWIELD_GUIDED_REVIEW_EVENT ${JSON.stringify({ version: 2, type: "usage", usage: { ...usage, inputTokens: -1 } })}`,
            ),
        Error,
        "inputTokens",
    );
});
