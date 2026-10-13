import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import {
    assertGoldenScenarioCoverage,
    collectGoldenScenarioCoverage,
    GOLDEN_TUI_REQUIRED_CAPABILITY_IDS,
} from "../testing/mod.ts";
import { goldenTuiPortfolioScenarios } from "./catalog.ts";

test("golden TUI portfolio declares asserted coverage for every required capability", () => {
    const scenarios =
        /** @type {import('../testing/scenario-runner.js').GoldenScenario[]} */ (/** @type {unknown} */ (goldenTuiPortfolioScenarios));
    assertGoldenScenarioCoverage(scenarios);
    const owners = collectGoldenScenarioCoverage(scenarios);
    assertEquals(GOLDEN_TUI_REQUIRED_CAPABILITY_IDS.every((capability) => owners.has(capability)), true);
});
