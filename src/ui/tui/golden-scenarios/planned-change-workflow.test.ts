import { assertEquals } from "@std/assert";
import {
    onboardingTutorialDeliveryScenario,
    plannedChangeFrontendIdentityScenario,
    plannedChangeReviewRepairValidationScenario,
} from "./planned-change-workflow.js";

const scenarios = {
    plannedChangeReviewRepairValidationScenario,
    onboardingTutorialDeliveryScenario,
    plannedChangeFrontendIdentityScenario,
};

for (const [exportName, scenario] of Object.entries(scenarios)) {
    Deno.test({
        name: `golden PLANNED_CHANGE workflow: ${scenario.name}`,
        fn: async () => {
            const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
            const result = await runGoldenScenarioChildProcess({
                scenarioModule: "src/ui/tui/golden-scenarios/planned-change-workflow.js",
                exportName,
                timeoutMs: ("timeoutMs" in scenario ? scenario.timeoutMs : undefined) || 120000,
            });
            assertEquals(result.result.actor.remaining, []);
        },
    });
}
