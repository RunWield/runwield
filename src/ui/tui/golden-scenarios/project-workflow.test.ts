import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import {
    projectChildCiFailureStopScenario,
    projectPlanReviewScenario,
    projectWorkflowScenarios,
    twoChildProjectContinuationScenario,
} from "./project-workflow.js";

type ProjectWorkflowScenario = (typeof projectWorkflowScenarios)[number] &
    Partial<Pick<typeof twoChildProjectContinuationScenario, "timeoutMs">>;

const scenarios: ProjectWorkflowScenario[] = projectWorkflowScenarios;

const scenarioExportNames = new Map<ProjectWorkflowScenario, string>([
    [projectPlanReviewScenario, "projectPlanReviewScenario"],
    [twoChildProjectContinuationScenario, "twoChildProjectContinuationScenario"],
    [projectChildCiFailureStopScenario, "projectChildCiFailureStopScenario"],
]);

for (const scenario of scenarios) {
    test(`golden PROJECT workflow: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/project-workflow.js",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: scenario.timeoutMs || 30000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
