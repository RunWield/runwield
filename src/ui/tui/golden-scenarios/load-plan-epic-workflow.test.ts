import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import {
    loadPlanEpicArchitectReviewScenario,
    loadPlanEpicChildMenusScenario,
    loadPlanEpicDirectReviewFeedbackScenario,
    loadPlanEpicDirectReviewLaterScenario,
    loadPlanEpicDirectReviewScenario,
    loadPlanEpicDoneEnoughArchiveScenario,
    loadPlanEpicMenuOptionsScenario,
    loadPlanEpicSlicerScenario,
    loadPlanEpicWorkflowScenarios,
} from "./load-plan-epic-workflow.ts";

const scenarioExportNames = new Map<object, string>([
    [loadPlanEpicMenuOptionsScenario, "loadPlanEpicMenuOptionsScenario"],
    [loadPlanEpicDirectReviewScenario, "loadPlanEpicDirectReviewScenario"],
    [loadPlanEpicDirectReviewFeedbackScenario, "loadPlanEpicDirectReviewFeedbackScenario"],
    [loadPlanEpicDirectReviewLaterScenario, "loadPlanEpicDirectReviewLaterScenario"],
    [loadPlanEpicArchitectReviewScenario, "loadPlanEpicArchitectReviewScenario"],
    [loadPlanEpicSlicerScenario, "loadPlanEpicSlicerScenario"],
    [loadPlanEpicChildMenusScenario, "loadPlanEpicChildMenusScenario"],
    [loadPlanEpicDoneEnoughArchiveScenario, "loadPlanEpicDoneEnoughArchiveScenario"],
]);

for (const scenario of loadPlanEpicWorkflowScenarios) {
    test(`golden /load-plan Epic workflow: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/load-plan-epic-workflow.ts",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: scenario.timeoutMs || 90000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
