import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { formatGuidedReviewGenerator, formatGuidedReviewUsageStatus } from "./guided-review-status.ts";

test("Guided Review usage status distinguishes pending from unavailable", () => {
    assertEquals(formatGuidedReviewUsageStatus({ usageState: "pending", tokens: null, cost: null }), {
        tokens: "tokens pending",
        cost: "cost pending",
    });
    assertEquals(formatGuidedReviewUsageStatus({ usageState: "unavailable", tokens: null, cost: null }), {
        tokens: "tokens unavailable",
        cost: "cost unavailable",
    });
});

test("Guided Review usage status renders compact reported totals", () => {
    assertEquals(
        formatGuidedReviewUsageStatus({
            usageState: "available",
            tokens: {
                inputTokens: 1240,
                outputTokens: 250,
                cacheReadTokens: 800,
                cacheWriteTokens: 0,
                costUsd: 0.125,
            },
            cost: { usd: 0.125 },
        }),
        {
            tokens: "tokens 1.2k in / 250 out / 800 read / 0 write",
            cost: "cost $0.125",
        },
    );
});

test("Guided Review usage status keeps reported zero usage available", () => {
    assertEquals(
        formatGuidedReviewUsageStatus({
            usageState: "available",
            tokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0,
            },
            cost: { usd: 0 },
        }),
        {
            tokens: "tokens 0 in / 0 out / 0 read / 0 write",
            cost: "cost $0.000",
        },
    );
});

test("Guided Review attribution uses actual metadata and omits missing fields", () => {
    assertEquals(
        formatGuidedReviewGenerator({ providerName: "openai", model: "gpt-model", thinkingLevel: "high" }),
        "openai/gpt-model (high)",
    );
    assertEquals(formatGuidedReviewGenerator({ providerName: "custom", model: "model" }), "custom/model");
    assertEquals(formatGuidedReviewGenerator({ model: "wld" }), undefined);
    assertEquals(formatGuidedReviewGenerator({ providerName: "wld", model: "wld" }), undefined);
    assertEquals(formatGuidedReviewGenerator(null), undefined);
});
