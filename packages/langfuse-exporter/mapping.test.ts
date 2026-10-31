import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { assertEquals } from "../../src/testing/assertions.ts";
import { deliver, type MetricsExportKind } from "./exporter.ts";
import {
    attributes,
    captured,
    metadata,
    native,
    observation,
    type ObservationFields,
    span,
    withServer,
} from "./test-fixture.ts";

test("complete measured request has native non-overlapping buckets and supplied estimated USD cost", async () => {
    await captured(observation({ reasoningTokens: 12 }), (s, wire) => {
        assertEquals(native(s, "usage_details"), {
            input: 100,
            input_cache_read: 30,
            input_cache_creation: 0,
            output: 8,
            output_reasoning: 12,
        });
        assertEquals(native(s, "cost_details"), { total: 0.01 });
        assertEquals(attributes(s)["langfuse.observation.model.name"], "gemini-3.8-flash");
        assertEquals(metadata(s).usage_complete, true);
        assertEquals(metadata(s).native_usage_available, true);
        assertEquals(metadata(s).reasoning_available, true);
        assertEquals(metadata(s).cost_available, true);
        assertEquals(metadata(s).missing_cost, false);
        assertEquals(metadata(s).costSource, "calculated");
        assertEquals(metadata(s).inputCacheBasis, "excludes_cache");
        assertEquals(s.startTimeUnixNano, "1789905600100000000");
        assertEquals(s.endTimeUnixNano, "1789905602200000000");
        assertEquals(metadata(s).timing_measured, true);
        assertEquals(wire.method, "POST");
        assertEquals(wire.url.pathname, "/api/public/otel/v1/traces");
        assertEquals(wire.headers.get("authorization"), `Basic ${btoa("pk-fixture:sk-fixture")}`);
        assertEquals(wire.headers.get("x-langfuse-ingestion-version"), "4");
        assertEquals(wire.headers.get("content-type"), "application/json");
        assertEquals(attributes(s)["langfuse.observation.type"], "generation");
        assertEquals(s.kind, 1);
    });
});
test("reported zero is evidence, not an unavailable cost", async () => {
    await captured(observation({ costSource: "reported", costAmount: 0 }), (s) =>
        assertEquals(native(s, "cost_details"), { total: 0 }),
    );
});
test("reported partial cost stays metadata-only and cannot invite inferred spend", async () => {
    await captured(observation({ costSource: "reported", costAvailability: "partial", costAmount: 0.25 }), (s) => {
        assertEquals(native(s, "cost_details"), undefined);
        assertEquals(attributes(s)["langfuse.observation.model.name"], undefined);
        assertEquals(metadata(s).costAmount, 0.25);
        assertEquals(metadata(s).cost_complete, false);
        assertEquals(metadata(s).cost_available, false);
    });
});
test("complete usage without cost has no pricing model and cannot invite inferred spend", async () => {
    await captured(observation({ costSource: "unavailable", costAmount: null }), (s) => {
        assertEquals(native(s, "cost_details"), undefined);
        assertEquals(attributes(s)["langfuse.observation.model.name"], undefined);
        assertEquals(metadata(s).model, "gemini-3.8-flash");
        assertEquals(metadata(s).missing_cost, true);
        assertEquals(native(s, "usage_details")?.input, 100);
    });
});
interface AgyUsageFixture {
    fixture: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: null;
}
interface AgyFixtureFile {
    rows: AgyUsageFixture[];
}
const agy: AgyFixtureFile = JSON.parse(await fsReadFile(new URL("./fixtures/agy-usage.json", import.meta.url), "utf8"));
for (const row of agy.rows) {
    test(`partial agy fixture ${row.fixture} keeps known buckets without inventing cache writes or totals`, async () => {
        await captured(
            observation({
                backend: "agy-cli",
                usageKind: "turn",
                aggregationBasis: "turn",
                measurementAvailability: "partial",
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                reasoningTokens: row.reasoningTokens,
                cacheReadTokens: row.cacheReadTokens,
                cacheWriteTokens: row.cacheWriteTokens,
            }),
            (s) => {
                assertEquals(native(s, "usage_details"), {
                    input: row.inputTokens,
                    output: row.outputTokens - row.reasoningTokens,
                    output_reasoning: row.reasoningTokens,
                    input_cache_read: row.cacheReadTokens,
                });
                assertEquals(metadata(s).usage_complete, false);
                assertEquals(metadata(s).missing_input_cache_creation, true);
                assertEquals(metadata(s).missing_input_cache_read, false);
            },
        );
    });
}
const costCases: ObservationFields[] = [
    { costAvailability: "unavailable" },
    { costSource: "unavailable", costAmount: 0.1 },
    { costSource: "calculated", costAmount: null },
    { costCurrency: "EUR" },
    { costAmount: -1 },
    { costAmount: NaN },
    { costAmount: Infinity },
];
for (const defect of costCases) {
    test(`partial or invalid cost is omitted: ${JSON.stringify(defect)}`, async () => {
        await captured(observation(defect), (s) => {
            assertEquals(native(s, "cost_details"), undefined);
            assertEquals(attributes(s)["langfuse.observation.model.name"], undefined);
            assertEquals(metadata(s).cost_available, false);
        });
    });
}
test("CLI aggregate sends one labeled generation with subprocess timing and no child events", async () => {
    await captured(
        observation({
            backend: "claude-cli",
            aggregationBasis: "turn",
            usageKind: "turn",
        }),
        (s) => {
            assertEquals(s.name, "RunWield backend-turn aggregate");
            assertEquals(metadata(s).backend_turn_aggregate, true);
            assertEquals(attributes(s)["langfuse.observation.type"], "generation");
            assertEquals(s.endTimeUnixNano, "1789905602200000000");
            assert(!Object.hasOwn(s, "events"));
        },
    );
});
test("includes-cache input subtracts both known cache counts", async () => {
    await captured(
        observation({
            inputCacheBasis: "includes_cache",
            cacheReadTokens: 30,
            cacheWriteTokens: 10,
        }),
        (s) => assertEquals(native(s, "usage_details")?.input, 60),
    );
});
test("includes-cache input is absent if either cache count is missing", async () => {
    for (const field of ["cacheReadTokens", "cacheWriteTokens"]) {
        await captured(observation({ inputCacheBasis: "includes_cache", [field]: null }), (s) => {
            assertEquals(native(s, "usage_details")?.input, undefined);
            assertEquals(native(s, "usage_details")?.output, 20);
            assertEquals(metadata(s).usage_complete, false);
        });
    }
});
test("unknown cache basis keeps counts only in approved metadata", async () => {
    await captured(observation({ inputCacheBasis: "unknown" }), (s) => {
        assertEquals(native(s, "usage_details"), undefined);
        assertEquals(metadata(s).inputTokens, 100);
        assertEquals(metadata(s).native_usage_available, false);
        assertEquals(metadata(s).usage_complete, false);
    });
});
test("partial output can send observed reasoning without an absent output count", async () => {
    await captured(
        observation({
            outputTokens: null,
            reasoningTokens: 12,
            measurementAvailability: "partial",
        }),
        (s) => {
            assertEquals(native(s, "usage_details")?.output, undefined);
            assertEquals(native(s, "usage_details")?.output_reasoning, 12);
            assertEquals(metadata(s).missing_output, true);
        },
    );
});
test("inconsistent counts do not create negative or overlapping buckets", async () => {
    await captured(
        observation({
            inputCacheBasis: "includes_cache",
            cacheReadTokens: 200,
            reasoningTokens: 25,
        }),
        (s) => {
            assertEquals(native(s, "usage_details"), {
                input_cache_read: 200,
                input_cache_creation: 0,
            });
            assertEquals(metadata(s).usage_complete, false);
        },
    );
});
test("absent and invalid token counts stay absent rather than becoming zero", async () => {
    await captured(
        observation({
            inputTokens: null,
            outputTokens: -1,
            cacheReadTokens: 0.5,
            cacheWriteTokens: Infinity,
        }),
        (s) => {
            assertEquals(native(s, "usage_details"), undefined);
            assertEquals(metadata(s).usage_complete, false);
            assertEquals(metadata(s).outputTokens, undefined);
            assertEquals(metadata(s).cacheReadTokens, undefined);
        },
    );
});
const timingCases: ObservationFields[] = [
    { startedAt: null },
    { endedAt: null },
    { startedAt: "2026-02-30T00:00:00Z" },
    { startedAt: "2026-09-21T00:00:00Z" },
    { startedAt: "prompt content" },
];
for (const times of timingCases) {
    test(`unobserved or invalid timing uses occurredAt only: ${JSON.stringify(times)}`, async () => {
        await captured(observation(times), (s) => {
            assertEquals(s.startTimeUnixNano, "1789905603000000000");
            assertEquals(s.endTimeUnixNano, s.startTimeUnixNano);
            assertEquals(metadata(s).timing_measured, false);
        });
    });
}
test("ISO offsets preserve measured start and end", async () => {
    await captured(
        observation({
            startedAt: "2026-09-20T08:00:00.100-04:00",
            endedAt: "2026-09-20T08:00:02.200-04:00",
        }),
        (s) => assertEquals(s.startTimeUnixNano, "1789905600100000000"),
    );
});
for (const kind of [
    "execution_finished",
    "tool_call_finished",
    "validation_attempt",
    "repair_round_finished",
    "publication_confirmed",
    "workflow_abandoned",
] satisfies MetricsExportKind[]) {
    test(`${kind} is a fixed-name, content-free span`, async () => {
        await captured(
            {
                ...observation({
                    outcome: "succeeded",
                    reason: "completed",
                    callCount: 2,
                    coverage: { tools: "complete", usage: "partial" },
                }),
                kind,
            },
            (s) => {
                assertMatch(s.name, /^RunWield (execution|tool|validation|repair|publication|abandonment)$/);
                assertEquals(attributes(s)["langfuse.observation.type"], "span");
                assertEquals(native(s, "usage_details"), undefined);
                assertEquals(native(s, "cost_details"), undefined);
                assertEquals(metadata(s).outcome, "succeeded");
                assertEquals(metadata(s).model, undefined);
                if (kind === "execution_finished") {
                    assertEquals(metadata(s).callCount, 2);
                    assertEquals(metadata(s).coverage_tools, "complete");
                    assertEquals(metadata(s).coverage_usage, "partial");
                }
            },
        );
    });
}
test("deterministic hex IDs group operations without sending extra parent spans", async () => {
    await withServer(async ({ context, requests }) => {
        await deliver(observation(), context);
        await deliver(observation(), context);
        await deliver({ ...observation(), observationId: "a".repeat(64) }, context);
        const [a, b, c] = requests.map(span);
        assertMatch(a.traceId, /^[a-f0-9]{32}$/);
        assertMatch(a.spanId, /^[a-f0-9]{16}$/);
        assertMatch(a.parentSpanId!, /^[a-f0-9]{16}$/);
        assertEquals(a, b);
        assertEquals(a.traceId, c.traceId);
        assertEquals(a.parentSpanId, c.parentSpanId);
        assert(a.spanId !== c.spanId);
    });
});
test("model and tool spans point to the exported execution, and nested executions point to their parent", async () => {
    await withServer(async ({ context, requests }) => {
        const root = observation();
        await deliver(
            {
                ...root,
                kind: "execution_finished",
                observationId: "b".repeat(64),
            },
            context,
        );
        await deliver(root, context);
        await deliver(
            {
                ...root,
                kind: "tool_call_finished",
                observationId: "c".repeat(64),
            },
            context,
        );
        await deliver(
            {
                ...root,
                kind: "execution_finished",
                observationId: "d".repeat(64),
                executionRef: "e".repeat(64),
                parentExecutionRef: root.executionRef,
            },
            context,
        );
        const [execution, model, tool, nested] = requests.map(span);
        assertEquals(model.parentSpanId, execution.spanId);
        assertEquals(tool.parentSpanId, execution.spanId);
        assertEquals(nested.parentSpanId, execution.spanId);
        assertEquals(model.traceId, execution.traceId);
        assertEquals(tool.traceId, execution.traceId);
        assertEquals(nested.traceId, execution.traceId);
    });
});
test("cross-Session execution trees share a trace even when children arrive first", async () => {
    await withServer(async ({ context, requests }) => {
        const root = observation();
        const child = {
            ...root,
            observationId: "a".repeat(64),
            sessionRef: "6".repeat(64),
            executionRef: "7".repeat(64),
            parentExecutionRef: root.executionRef,
        };
        const grandchild = {
            ...child,
            observationId: "b".repeat(64),
            sessionRef: "8".repeat(64),
            executionRef: "9".repeat(64),
            parentExecutionRef: child.executionRef,
            planRef: "f".repeat(64),
        };
        await deliver({ ...grandchild, kind: "execution_finished" }, context);
        await deliver({ ...child, kind: "tool_call_finished" }, context);
        await deliver({ ...child, kind: "execution_finished", observationId: "c".repeat(64) }, context);
        await deliver(child, context);
        await deliver({ ...root, kind: "execution_finished", observationId: "d".repeat(64) }, context);
        const [nested, tool, execution, model, parent] = requests.map(span);
        assertEquals(execution.parentSpanId, parent.spanId);
        assertEquals(nested.parentSpanId, execution.spanId);
        assertEquals(tool.parentSpanId, execution.spanId);
        assertEquals(model.parentSpanId, execution.spanId);
        for (const s of [nested, tool, execution, model]) {
            assertEquals(s.traceId, parent.traceId);
        }
        assertEquals(metadata(execution).sessionRef, child.sessionRef);
        assertEquals(metadata(nested).planRef, grandchild.planRef);
        await deliver({ ...root, projectRef: "e".repeat(64) }, context);
        assert(span(requests[5]).traceId !== parent.traceId);
    });
});
test("own allowlists reject malicious extra fields, text, paths, credentials, and resource content", async () => {
    const o = observation({
        prompt: "SECRET_PROMPT",
        input: "SECRET_INPUT",
        output: "SECRET_OUTPUT",
        path: "/SECRET_PATH",
        model: "/SECRET_MODEL",
        provider: "file:/SECRET_PROVIDER",
        toolName: "../SECRET_TOOL",
        reason: "SECRET_REASON",
        costSource: "SECRET_COST",
        unavailableReason: "SECRET_UNAVAILABLE",
        inputTokens: "SECRET_COUNT",
        phase: "SECRET_PHASE",
        events: "SECRET_EVENTS",
        exception: "SECRET_ERROR",
    });
    Object.assign(o, {
        input: "SECRET_TOP_INPUT",
        output: "SECRET_TOP_OUTPUT",
        resource: { path: "/SECRET_RESOURCE" },
        externalProject: "SECRET_EXTERNAL",
    });
    await captured(o, (s, wire) => {
        assert(!wire.body.includes("SECRET"));
        assertEquals(Object.keys(JSON.parse(wire.body)), ["resourceSpans"]);
        assertEquals(Object.keys(JSON.parse(wire.body).resourceSpans[0]), ["scopeSpans"]);
        assertEquals(Object.keys(s).sort(), [
            "attributes",
            "endTimeUnixNano",
            "kind",
            "name",
            "parentSpanId",
            "spanId",
            "startTimeUnixNano",
            "traceId",
        ]);
    });
});
test("inherited fields cannot smuggle usage or metadata", async () => {
    const o = observation();
    o.fields = Object.create({
        inputTokens: 77,
        costAmount: 99,
        costSource: "reported",
        costCurrency: "USD",
        model: "SECRET",
        inputCacheBasis: "excludes_cache",
    });
    await captured(o, (s, wire) => {
        assertEquals(native(s, "usage_details"), undefined);
        assertEquals(native(s, "cost_details"), undefined);
        assert(!wire.body.includes("SECRET"));
    });
});
test("immutable contract observations remain unchanged after export", async () => {
    const o = observation();
    Object.freeze(o.fields);
    Object.freeze(o);
    const before = JSON.stringify(o);
    await captured(o, () => assertEquals(JSON.stringify(o), before));
});
test("malicious optional references and coverage extras cannot enter correlation metadata", async () => {
    const o = {
        ...observation({ coverage: { tools: "complete", usage: "SECRET" } }),
        kind: "execution_finished" as const,
        sessionRef: "/SECRET_SESSION",
        parentExecutionRef: "SECRET_PARENT",
    };
    Object.assign(o.fields.coverage!, {
        prompt: "SECRET_PROMPT",
        path: "SECRET_PATH",
    });
    await captured(o, (s, wire) => {
        assert(!wire.body.includes("SECRET"));
        assertEquals(metadata(s).coverage_tools, "complete");
        assertEquals(metadata(s).coverage_usage, undefined);
    });
});
test("inherited coverage does not claim measurement availability", async () => {
    const o = {
        ...observation({ coverage: Object.create({ tools: "complete" }) }),
        kind: "execution_finished" as const,
    };
    await captured(o, (s) => assertEquals(metadata(s).coverage_tools, undefined));
});
test("workflow durations retain valid fractional milliseconds in approved metadata", async () => {
    await captured({ ...observation({ elapsedMs: 2.75 }), kind: "execution_finished" }, (s) =>
        assertEquals(metadata(s).elapsedMs, 2.75),
    );
});
