import { assertEquals } from "@std/assert";
import { runGoldenScenarioChildProcess } from "../testing/child-protocol.js";

for (const exportName of ["initTutorialValidationCommandScenario", "routerValidationCommandRepairScenario"]) {
    Deno.test(`golden validation command persistence: ${exportName}`, async () => {
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/validation-command-persistence.ts",
            exportName,
            ...(exportName === "initTutorialValidationCommandScenario" ? { initDone: true, initArtifact: false } : {}),
            timeoutMs: 240000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
