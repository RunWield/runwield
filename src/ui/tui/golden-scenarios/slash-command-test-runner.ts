import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";

type SlashCommandScenario = { name: string; timeoutMs?: number; initDone?: boolean; initArtifact?: boolean };

export function registerSlashCommandGoldenTests(
    scenarioModule: string,
    cases: Array<{ scenario: SlashCommandScenario; exportName: string; todoReason?: string }>,
): void {
    for (const testCase of cases) {
        test(
            `golden slash command: ${testCase.scenario.name}${
                testCase.todoReason ? ` TODO: ${testCase.todoReason}` : ""
            }`,
            { skip: Boolean(testCase.todoReason) },
            async () => {
                const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
                const result = await runGoldenScenarioChildProcess({
                    scenarioModule,
                    exportName: testCase.exportName,
                    timeoutMs: testCase.scenario.timeoutMs || 30000,
                    initDone: testCase.scenario.initDone,
                    initArtifact: testCase.scenario.initArtifact,
                });
                assertEquals(result.result.actor.remaining, []);
            },
        );
    }
}
