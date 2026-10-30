import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import {
    buildMetricsExportObservation,
    isExportableMetric,
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
for (const kind of [
    "model_usage",
    "execution_finished",
    "tool_call_finished",
    "validation_attempt",
    "repair_round_finished",
    "publication_confirmed",
    "workflow_abandoned",
] as MetricsExportKind[]) {
    test(`contract 1 ${kind} contains only its fields and opaque stable references`, async () => {
        const observation = await buildMetricsExportObservation({ ...row, event: kind }, "/private/project", identity);
        assert(observation);
        assertEquals(observation.contract, 1);
        assertEquals(observation.kind, kind);
        assertEquals(
            JSON.stringify(observation),
            JSON.stringify(await buildMetricsExportObservation({ ...row, event: kind }, "/private/project", identity)),
        );
        assert(Object.isFrozen(observation) && Object.isFrozen(observation.fields));
        for (const reference of [
            observation.ownerRef,
            observation.projectRef,
            observation.sessionRef,
            observation.planRef,
            observation.executionRef,
            observation.parentExecutionRef,
            observation.attemptRef,
            observation.observationId,
        ])
            assert(/^[a-f0-9]{64}$/.test(reference!));
        const text = JSON.stringify(observation);
        for (const forbidden of ["raw-", "/private/project", "private-plan", "private-prompt", "cwdHash"]) {
            assert(!text.includes(forbidden));
        }
        assertEquals(Object.hasOwn(observation.fields, "inputTokens"), kind === "model_usage");
        assertEquals(Object.hasOwn(observation.fields, "toolName"), kind === "tool_call_finished");
    });
}
test("legacy and non-exportable rows produce no export observation", async () => {
    assertEquals(await buildMetricsExportObservation({ ...row, v: 1 }, "root", identity), null);
    for (const event of [
        "execution_started",
        "context_snapshot",
        "tool_exposure",
        "command_finished",
        "response_latency",
    ]) {
        assertEquals(await buildMetricsExportObservation({ ...row, event }, "root", identity), null);
    }
});
test("references differ across Projects and host keys without exposing local names", async () => {
    const first = await buildMetricsExportObservation(row, "first", identity);
    const second = await buildMetricsExportObservation(row, "second", identity);
    const host = await buildMetricsExportObservation(row, "first", {
        ...identity,
        referenceKey: "cd".repeat(32),
    });
    assert(first?.projectRef !== second?.projectRef);
    assert(first?.observationId !== second?.observationId);
    assert(first?.sessionRef !== host?.sessionRef);
});

test("namespaced model identity is retained without accepting absolute paths", async () => {
    const observation = await buildMetricsExportObservation(
        { ...row, model: "anthropic/claude-sonnet-4-5", provider: "openrouter" },
        "project",
        identity,
    );
    assertEquals(observation?.fields.model, "anthropic/claude-sonnet-4-5");
    const path = await buildMetricsExportObservation({ ...row, model: "/private/model" }, "project", identity);
    assertEquals(path?.fields.model, undefined);
});

test("model export preserves observed edges and reasoning without changing output", async () => {
    const startedAt = "2026-01-01T00:00:00.001Z";
    const endedAt = "2026-01-01T00:00:01.002Z";
    const observation = await buildMetricsExportObservation(
        { ...row, startedAt, endedAt, outputTokens: 20, reasoningTokens: 7 },
        "project",
        identity,
    );
    assertEquals(observation?.fields.startedAt, startedAt);
    assertEquals(observation?.fields.endedAt, endedAt);
    assertEquals(observation?.fields.reasoningTokens, 7);
    assertEquals(observation?.fields.outputTokens, 20);
    assertEquals(observation?.occurredAt, row.ts);
});

test("old model rows export null measurement fields without borrowing the journal write time", async () => {
    const observation = await buildMetricsExportObservation(row, "project", identity);
    assertEquals(
        [observation?.fields.startedAt, observation?.fields.endedAt, observation?.fields.reasoningTokens],
        [null, null, null],
    );
});

test("model export rejects altered timestamp text and invalid reasoning while retaining measured zero", async () => {
    for (const value of [
        "private-text",
        "/private/time",
        "2026-02-30T00:00:00.000Z",
        "2026-01-01",
        "2026-01-01T00:00:00.000Z-secret",
        42,
        null,
    ]) {
        const observation = await buildMetricsExportObservation(
            { ...row, startedAt: value, endedAt: value },
            "project",
            identity,
        );
        assertEquals([observation?.fields.startedAt, observation?.fields.endedAt], [null, null]);
    }
    for (const value of ["secret", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
        const observation = await buildMetricsExportObservation(
            { ...row, reasoningTokens: value },
            "project",
            identity,
        );
        assertEquals(observation?.fields.reasoningTokens, null);
    }
    const zero = await buildMetricsExportObservation({ ...row, reasoningTokens: 0 }, "project", identity);
    assertEquals(zero?.fields.reasoningTokens, 0);
});

test("model export normalizes valid ISO edges with offsets and keeps an unmeasured edge null", async () => {
    const observation = await buildMetricsExportObservation(
        { ...row, startedAt: "2026-01-01T00:00:00-05:00", endedAt: null },
        "project",
        identity,
    );
    assertEquals(observation?.fields.startedAt, "2026-01-01T05:00:00.000Z");
    assertEquals(observation?.fields.endedAt, null);
});

test("nested execution reference identifies the exported parent execution", async () => {
    const parent = await buildMetricsExportObservation(
        { ...row, event: "execution_finished", executionId: "raw-parent" },
        "project",
        identity,
    );
    const child = await buildMetricsExportObservation(row, "project", identity);
    assert(parent && child);
    assertEquals(child.parentExecutionRef, parent.executionRef);
});

test("Core excludes redundant alternatives for every backend without changing local measurements", async () => {
    for (const backend of ["claude-cli", "agy-cli", "pi"]) {
        const alternative: MetricsJournalRow = {
            ...row,
            backend,
            aggregationBasis: "alternative",
        };
        assertEquals(isExportableMetric(alternative), false);
        assertEquals(await buildMetricsExportObservation(alternative, "project", identity), null);
        assertEquals(alternative.inputTokens, 7);
        for (const aggregationBasis of ["turn", "request"]) {
            assert(await buildMetricsExportObservation({ ...alternative, aggregationBasis }, "project", identity));
        }
    }
});
