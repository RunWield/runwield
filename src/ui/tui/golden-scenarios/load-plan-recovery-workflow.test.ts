import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import {
    loadPlanAbandonProgressScenario,
    loadPlanInterruptedRecoveryScenario,
    loadPlanWorktreeInspectResetScenario,
} from "./load-plan-workflow.ts";

const scenarios = {
    loadPlanInterruptedRecoveryScenario,
    loadPlanWorktreeInspectResetScenario,
    loadPlanAbandonProgressScenario,
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
