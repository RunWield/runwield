import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import process from "node:process";
import { assertValidationEvidenceRejectsCounterfeits } from "../testing/validation-workflow-coverage.ts";
import type { ValidationWorkflowBranchId } from "../testing/validation-workflow-coverage.ts";

type ValidationWorkflowScenario = {
    name: string;
    timeoutMs?: number;
    validationBranches?: ValidationWorkflowBranchId[];
};

export type ValidationWorkflowTestCase = {
    scenario: ValidationWorkflowScenario;
    exportName: string;
    todo?: string;
};

export function registerValidationWorkflowTests(
    scenarioModule: string,
    testCases: ValidationWorkflowTestCase[],
): void {
    const runTodoGoldens = process.env["RUNWIELD_RUN_TODO_GOLDENS"] === "1";
    for (const testCase of testCases) {
        const prefix = testCase.todo ? `TODO: ${testCase.todo} — ` : "";
        test(`${prefix}golden validation workflow: ${testCase.scenario.name}`, {
            skip: Boolean(testCase.todo) && !runTodoGoldens,
        }, async () => {
            const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
            const result = await runGoldenScenarioChildProcess({
                scenarioModule,
                exportName: testCase.exportName,
                timeoutMs: testCase.scenario.timeoutMs || 180000,
            });
            assertEquals(result.result.actor.remaining, []);
            for (const id of testCase.scenario.validationBranches || []) {
                assertValidationEvidenceRejectsCounterfeits(id, result.result);
            }
        });
    }
}
