import { assertEquals } from "@std/assert";
import { projectRoutingWorkflowScenarios, routerArchitectSlicerScenario } from "./project-routing-workflow.ts";

const scenarioExportNames = new Map([
    [routerArchitectSlicerScenario, "routerArchitectSlicerScenario"],
]);

for (const scenario of projectRoutingWorkflowScenarios) {
    Deno.test({
        name: `golden PROJECT routing: ${scenario.name}`,
        fn: async () => {
            const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
            const result = await runGoldenScenarioChildProcess({
                scenarioModule: "src/ui/tui/golden-scenarios/project-routing-workflow.ts",
                exportName: scenarioExportNames.get(scenario) || "",
                timeoutMs: scenario.timeoutMs || 90000,
            });
            assertEquals(result.result.actor.remaining, []);
        },
    });
}
