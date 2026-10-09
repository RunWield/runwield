import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { createGenerationGuard } from "./generation-guard.ts";

// ─── Tests for the real createGenerationGuard() factory ───

test("isCurrent returns true before any bump", () => {
    const { bump, isCurrent } = createGenerationGuard();
    // Initial generation is 0
    assertEquals(isCurrent(0), true);
    // After bump, generation 0 is stale
    bump();
    assertEquals(isCurrent(0), false);
});

test("isCurrent returns true for current, false for stale", () => {
    const { bump, isCurrent } = createGenerationGuard();
    const gen1 = bump(); // gen1 = 1
    assertEquals(isCurrent(gen1), true);

    const gen2 = bump(); // gen2 = 2
    assertEquals(isCurrent(gen1), false); // gen1 is stale
    assertEquals(isCurrent(gen2), true); // gen2 is current
});

test("multiple bumps invalidate all previous generations", () => {
    const { bump, isCurrent } = createGenerationGuard();
    const generations = [bump(), bump(), bump()];
    // Only the last one should be current
    assertEquals(isCurrent(generations[0]), false);
    assertEquals(isCurrent(generations[1]), false);
    assertEquals(isCurrent(generations[2]), true);
});

test("invalidateAll bumps without exposing the new id", () => {
    const { bump, isCurrent, invalidateAll } = createGenerationGuard();
    const gen = bump();
    assertEquals(isCurrent(gen), true);
    invalidateAll();
    assertEquals(isCurrent(gen), false);
});

test("late result suppression pattern works correctly", async () => {
    const { bump, isCurrent } = createGenerationGuard();
    const results: string[] = [];

    // Simulate starting an operation
    const gen = bump();

    // Simulate user pressing Esc BEFORE the async completes
    // (this bumps the generation, making `gen` stale)
    bump();

    // Now simulate the async operation completing
    await new Promise<void>((resolve) => {
        const r = resolve;
        setTimeout(() => {
            if (isCurrent(gen)) {
                results.push("completed");
            }
            r();
        }, 50);
    });

    // Result should be suppressed because generation changed
    assertEquals(results.length, 0);
});

test("completed result is accepted when not canceled", async () => {
    const { bump, isCurrent } = createGenerationGuard();
    const results: string[] = [];

    const gen = bump();

    await new Promise<void>((resolve) => {
        const r = resolve;
        setTimeout(() => {
            if (isCurrent(gen)) {
                results.push("completed");
            }
            r();
        }, 10);
    });

    // Don't bump generation — let it complete naturally
    assertEquals(results, ["completed"]);
});
