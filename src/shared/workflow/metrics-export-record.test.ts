import { assert, assertEquals } from "@std/assert";
import {
    buildMetricsExportObservation,
    type MetricsExportKind,
    type MetricsJournalRow,
} from "./metrics-export-record.ts";

const identity = { ownerRef: "owner-local-id", referenceKey: "ab".repeat(32) };
const row: MetricsJournalRow = {
    v: 2,
    event: "model_usage",
    eventId: "raw-event",
    ts: "2026-01-01T00:00:00.000Z",
    historyEpoch: "epoch",
    sessionId: "raw-session",
    planId: "raw-plan",
    executionId: "raw-execution",
    parentExecutionId: "raw-parent",
    attemptId: "raw-attempt",
    inputTokens: 7,
    outputTokens: 2,
    costAmount: 0.4,
    model: "safe-model",
    cwdHash: "raw-cwd",
    planName: "private-plan",
    prompt: "private-prompt",
    toolName: "read",
    outcome: "succeeded",
    reason: "completed",
    durationMs: 10,
};
for (
    const kind of [
        "model_usage",
        "execution_finished",
        "tool_call_finished",
        "validation_attempt",
        "repair_round_finished",
        "publication_confirmed",
        "workflow_abandoned",
    ] as MetricsExportKind[]
) {
    Deno.test(`contract 1 ${kind} contains only its fields and opaque stable references`, async () => {
        const observation = await buildMetricsExportObservation({ ...row, event: kind }, "/private/project", identity);
        assert(observation);
        assertEquals(observation.contract, 1);
        assertEquals(observation.kind, kind);
        assertEquals(
            JSON.stringify(observation),
            JSON.stringify(await buildMetricsExportObservation({ ...row, event: kind }, "/private/project", identity)),
        );
        assert(Object.isFrozen(observation) && Object.isFrozen(observation.fields));
        for (
            const reference of [
                observation.ownerRef,
                observation.projectRef,
                observation.sessionRef,
                observation.planRef,
                observation.executionRef,
                observation.parentExecutionRef,
                observation.attemptRef,
                observation.observationId,
            ]
        ) assert(/^[a-f0-9]{64}$/.test(reference!));
        const text = JSON.stringify(observation);
        for (const forbidden of ["raw-", "/private/project", "private-plan", "private-prompt", "cwdHash"]) {
            assert(!text.includes(forbidden));
        }
        assertEquals(Object.hasOwn(observation.fields, "inputTokens"), kind === "model_usage");
        assertEquals(Object.hasOwn(observation.fields, "toolName"), kind === "tool_call_finished");
    });
}
Deno.test("legacy and non-exportable rows produce no export observation", async () => {
    assertEquals(await buildMetricsExportObservation({ ...row, v: 1 }, "root", identity), null);
    for (
        const event of [
            "execution_started",
            "context_snapshot",
            "tool_exposure",
            "command_finished",
            "response_latency",
        ]
    ) {
        assertEquals(await buildMetricsExportObservation({ ...row, event }, "root", identity), null);
    }
});
Deno.test("references differ across Projects and host keys without exposing local names", async () => {
    const first = await buildMetricsExportObservation(row, "first", identity);
    const second = await buildMetricsExportObservation(row, "second", identity);
    const host = await buildMetricsExportObservation(row, "first", { ...identity, referenceKey: "cd".repeat(32) });
    assert(first?.projectRef !== second?.projectRef);
    assert(first?.observationId !== second?.observationId);
    assert(first?.sessionRef !== host?.sessionRef);
});

Deno.test("namespaced model identity is retained without accepting absolute paths", async () => {
    const observation = await buildMetricsExportObservation(
        { ...row, model: "anthropic/claude-sonnet-4-5", provider: "openrouter" },
        "project",
        identity,
    );
    assertEquals(observation?.fields.model, "anthropic/claude-sonnet-4-5");
    const path = await buildMetricsExportObservation({ ...row, model: "/private/model" }, "project", identity);
    assertEquals(path?.fields.model, undefined);
});
