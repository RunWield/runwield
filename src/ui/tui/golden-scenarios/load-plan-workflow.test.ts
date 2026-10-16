import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import {
    loadPlanActionsScenario,
    loadPlanMalformedFrontMatterScenario,
    loadPlanReadOnlyPickerScenario,
} from "./load-plan-workflow.ts";

const scenarios = {
    loadPlanReadOnlyPickerScenario,
    loadPlanActionsScenario,
    loadPlanMalformedFrontMatterScenario,
};

for (const [exportName, scenario] of Object.entries(scenarios)) {
    test(`golden /load-plan workflow: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/load-plan-workflow.ts",
            exportName,
            timeoutMs: ("timeoutMs" in scenario ? scenario.timeoutMs : undefined) || 60000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
