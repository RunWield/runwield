import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { concurrentPlansIdentityScenario, concurrentWorkflowScenarios } from "./concurrent-workflow.ts";

const scenarioExportNames = new Map<object, string>([
    [concurrentPlansIdentityScenario, "concurrentPlansIdentityScenario"],
]);

for (const scenario of concurrentWorkflowScenarios) {
    test(`golden concurrent workflow: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/concurrent-workflow.ts",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: scenario.timeoutMs || 60000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
