import { assertEquals } from "@std/assert";
import {
    managedSyncQueueImageScenario,
    presentationAndTerminalScenarios,
    replayHydrationScenario,
    terminalControlsScenario,
    toolFailureRecoveryScenario,
} from "./presentation-and-terminal.js";

const scenarioExportNames = new Map([
    [managedSyncQueueImageScenario, "managedSyncQueueImageScenario"],
    [terminalControlsScenario, "terminalControlsScenario"],
    [replayHydrationScenario, "replayHydrationScenario"],
    [toolFailureRecoveryScenario, "toolFailureRecoveryScenario"],
]);

for (const scenario of presentationAndTerminalScenarios) {
    Deno.test(`golden presentation/terminal: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/presentation-and-terminal.js",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: 30000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
