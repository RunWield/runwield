import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import {
    onboardingTutorialDeliveryScenario,
    plannedChangeFrontendIdentityScenario,
} from "./planned-change-workflow.ts";

const scenarios = {
    onboardingTutorialDeliveryScenario,
    plannedChangeFrontendIdentityScenario,
};

for (const [exportName, scenario] of Object.entries(scenarios)) {
    test(`golden PLANNED_CHANGE workflow: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.ts");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/planned-change-workflow.ts",
            exportName,
            timeoutMs: ("timeoutMs" in scenario ? scenario.timeoutMs : undefined) || 120000,
        });
        assertEquals(result.result?.actor.remaining, []);
    });
}
