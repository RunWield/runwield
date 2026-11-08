import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import type { JsonRecord } from "../../../shared/jsonc.ts";
import {
    resumeCorruptSessionScenario,
    resumeInterruptedSessionScenario,
    resumePersistedSessionScenario,
    resumeQuickFixSessionScenario,
    sessionResumeWorkflowScenarios,
} from "./session-resume-workflow.ts";

const scenarioExportNames = new Map<object, string>([
    [resumePersistedSessionScenario, "resumePersistedSessionScenario"],
    [resumeQuickFixSessionScenario, "resumeQuickFixSessionScenario"],
    [resumeCorruptSessionScenario, "resumeCorruptSessionScenario"],
    [resumeInterruptedSessionScenario, "resumeInterruptedSessionScenario"],
]);

test("execution Agent context identity survives recovery", async () => {
    const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.ts");
    const result = await runGoldenScenarioChildProcess({
        scenarioModule: "src/ui/tui/golden-scenarios/session-resume-workflow.ts",
        exportName: "resumeQuickFixSessionScenario",
        timeoutMs: resumeQuickFixSessionScenario.timeoutMs || 90000,
    });

    assert(result.result, "Expected a Golden child report");
    assertEquals(result.result.actor.remaining, []);
    const snapshot = result.result.state.snapshot;
    const activeAgent =
        snapshot && typeof snapshot === "object" && "activeAgent" in snapshot ? snapshot.activeAgent : undefined;
    assertEquals(activeAgent, "engineer", "Expected runtime:agent:engineer after recovery.");
    const modelTurns = result.result.state.modelTurns;
    const turns = Array.isArray(modelTurns)
        ? modelTurns.filter(
              (turn): turn is JsonRecord => Boolean(turn) && typeof turn === "object" && !Array.isArray(turn),
          )
        : [];
    const executionTurn = turns.find(
        (turn) => turn?.runtimeAgent === "engineer" && String(turn?.systemPrompt || "").includes("Quick Fix Checklist"),
    );
    assert(
        executionTurn,
        `Expected recovered Engineer systemPrompt evidence; got ${JSON.stringify(
            turns.map((turn) => ({ agent: turn?.agent, runtimeAgent: turn?.runtimeAgent })),
        )}`,
    );
    assertStringIncludes(String(executionTurn.systemPrompt || ""), "You are the Engineer");
});

for (const scenario of sessionResumeWorkflowScenarios.filter((entry) => entry !== resumeQuickFixSessionScenario)) {
    test(`golden Session resume: ${scenario.name}`, async () => {
        const { runGoldenScenarioChildProcess } = await import("../testing/child-protocol.ts");
        const result = await runGoldenScenarioChildProcess({
            scenarioModule: "src/ui/tui/golden-scenarios/session-resume-workflow.ts",
            exportName: scenarioExportNames.get(scenario) || "",
            timeoutMs: scenario.timeoutMs || 90000,
        });
        assertEquals(result.result?.actor.remaining, []);
    });
}
