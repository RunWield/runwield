import { assertEquals } from "@std/assert";
import {
    engineerQuickFixMechanicalValidationScenario,
    guideInquiryRoleJourneyScenario,
    ideationInterviewPrdScenario,
    operatorOperationScenario,
    roleJourneyScenarios,
} from "./role-journeys.js";

const scenarioExportNames = new Map([
    [guideInquiryRoleJourneyScenario, "guideInquiryRoleJourneyScenario"],
    [ideationInterviewPrdScenario, "ideationInterviewPrdScenario"],
    [operatorOperationScenario, "operatorOperationScenario"],
    [engineerQuickFixMechanicalValidationScenario, "engineerQuickFixMechanicalValidationScenario"],
]);

for (const scenario of roleJourneyScenarios) {
    Deno.test(`golden role journey: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/role-journeys.js",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: "timeoutMs" in scenario && typeof scenario.timeoutMs === "number" ? scenario.timeoutMs : 30000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
