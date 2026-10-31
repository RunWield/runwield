import type { RuntimeUsage } from "./session-runtime-events.js";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { createSessionRuntimeEvent, normalizeRuntimeUsage, RuntimeEventTypes } from "./session-runtime-events.js";

const unavailable = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
} satisfies RuntimeUsage;

test("Runtime usage preserves absent measurements", () => {
    for (const source of [undefined, null, {}, { cost: {} }]) {
        assertEquals(normalizeRuntimeUsage(source), unavailable);
    }
});

test("Runtime usage distinguishes supplied zero from absent categories", () => {
    assertEquals(normalizeRuntimeUsage({ input: 7, output: 0, cost: { total: 0 } }), {
        ...unavailable,
        inputTokens: 7,
        outputTokens: 0,
        costUsd: 0,
    });
    assertEquals(normalizeRuntimeUsage({ inputTokens: 0, cacheReadTokens: 0, costUsd: 0.5 }), {
        ...unavailable,
        inputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0.5,
    });
});

test("Runtime usage does not report invalid numbers as measurements", () => {
    for (const value of [-1, Infinity, -Infinity, NaN, "0", false, ""]) {
        assertEquals(
            normalizeRuntimeUsage({
                input: value,
                output: value,
                cacheRead: value,
                cacheWrite: value,
                costUsd: value,
                contextWindow: value,
            }),
            unavailable,
        );
    }
});

test("Runtime usage events accept unavailable and measured zero fields", () => {
    const usage = { ...unavailable, inputTokens: 0, outputTokens: 3 };
    const event = createSessionRuntimeEvent("session-usage", { type: RuntimeEventTypes.USAGE, usage });
    if (event.type !== RuntimeEventTypes.USAGE) throw new Error("unexpected event type");
    assertEquals(event.usage, usage);
});

test("Runtime usage events reject missing and invalid measurements", () => {
    for (const field of Object.keys(unavailable)) {
        for (const value of [undefined, -1, NaN, Infinity, -Infinity, "0", false]) {
            assertThrows(
                () =>
                    createSessionRuntimeEvent("session-usage", {
                        type: RuntimeEventTypes.USAGE,
                        usage: { ...unavailable, [field]: value },
                    }),
                TypeError,
                `usage.${field} must be a finite nonnegative number or null`,
            );
        }
    }
});
