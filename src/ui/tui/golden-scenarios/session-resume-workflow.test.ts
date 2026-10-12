import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import {
    resumeCorruptSessionScenario,
    resumeInterruptedSessionScenario,
    resumePersistedSessionScenario,
    resumeQuickFixSessionScenario,
    sessionResumeWorkflowScenarios,
} from "./session-resume-workflow.ts";

interface ModelTurn {
    agent?: string;
    runtimeAgent?: string;
    systemPrompt?: string;
}

const scenarioExportNames = new Map<object, string>([
    [resumePersistedSessionScenario, "resumePersistedSessionScenario"],
    [resumeQuickFixSessionScenario, "resumeQuickFixSessionScenario"],
    [resumeCorruptSessionScenario, "resumeCorruptSessionScenario"],
    [resumeInterruptedSessionScenario, "resumeInterruptedSessionScenario"],
]);

test("execution Agent context identity survives recovery", async () => {
    const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
    const result = await runGoldenScenarioChildProcess({
        scenarioModule: "src/ui/tui/golden-scenarios/session-resume-workflow.ts",
        exportName: "resumeQuickFixSessionScenario",
        timeoutMs: resumeQuickFixSessionScenario.timeoutMs || 90000,
    });

    assertEquals(result.result.actor.remaining, []);
    assertEquals(
        result.result.state.snapshot?.activeAgent,
        "engineer",
        "Expected runtime:agent:engineer after recovery.",
    );
    const turns: ModelTurn[] = Array.isArray(result.result.state.modelTurns) ? result.result.state.modelTurns : [];
    const executionTurn = turns.find((turn) =>
        turn?.runtimeAgent === "engineer" &&
        String(turn?.systemPrompt || "").includes("Quick Fix Checklist")
    );
    assert(
        executionTurn,
        `Expected recovered Engineer systemPrompt evidence; got ${
            JSON.stringify(turns.map((turn) => ({ agent: turn?.agent, runtimeAgent: turn?.runtimeAgent })))
        }`,
    );
    assertStringIncludes(String(executionTurn.systemPrompt || ""), "You are the Engineer");
});

for (const scenario of sessionResumeWorkflowScenarios) {
    test(`golden Session resume: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.js");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/session-resume-workflow.ts",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: scenario.timeoutMs || 90000,
        });
        assertEquals(result.result.actor.remaining, []);
    });
}
