import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../src/testing/assertions.ts";
import { confirm, deliver } from "./exporter.ts";
import { type JsonRecord, observation, type ObservationFields, readback, span, withServer } from "./test-fixture.ts";

const confirmationCases: ObservationFields[] = [
    {},
    {
        measurementAvailability: "partial",
        cacheWriteTokens: null,
        reasoningTokens: 12,
    },
    { costSource: "unavailable", costAmount: null },
    { inputCacheBasis: "unknown", costSource: "unavailable", costAmount: null },
    { startedAt: null, endedAt: null },
];
for (const fields of confirmationCases) {
    test(`bounded v2 lookup confirms matching native metrics and correlation: ${JSON.stringify(fields)}`, async () => {
        let row: JsonRecord;
        await withServer(
            async ({ context, requests }) => {
                const o = observation(fields);
                await deliver(o, context);
                assertEquals(await confirm(o, context), { status: "present" });
                assertEquals(requests.length, 2);
                const query = requests[1];
                assertEquals(query.method, "GET");
                assertEquals(query.url.pathname, "/api/public/v2/observations");
                assertEquals(query.url.searchParams.get("fields"), "core,basic,usage,model,metadata");
                assertEquals(query.url.searchParams.get("limit"), "100");
                const from = Date.parse(query.url.searchParams.get("fromStartTime")!);
                const to = Date.parse(query.url.searchParams.get("toStartTime")!);
                assertEquals(to - from, 2000);
                assertEquals(from + 1000, Date.parse(String(row.startTime)));
                assertEquals(JSON.parse(query.url.searchParams.get("filter")!), [
                    {
                        type: "string",
                        column: "id",
                        operator: "=",
                        value: row.id,
                    },
                ]);
                assertEquals(query.body, "");
                assertEquals(query.headers.get("authorization"), `Basic ${btoa("pk-fixture:sk-fixture")}`);
            },
            (wire) => {
                if (wire.method === "POST") {
                    row = readback(span(wire));
                    return Response.json({});
                }
                return Response.json({ data: [row], meta: {} });
            },
        );
    });
}
for (const field of [
    "id",
    "projectId",
    "traceId",
    "parentObservationId",
    "type",
    "name",
    "startTime",
    "endTime",
    "metadata",
    "usageDetails",
    "costDetails",
    "totalUsage",
    "totalCost",
    "model",
]) {
    test(`readback mismatch in ${field} is not confirmation`, async () => {
        let row: JsonRecord;
        await withServer(
            async ({ context }) => {
                const o = observation();
                await deliver(o, context);
                assertEquals(await confirm(o, context), { status: "mismatch" });
            },
            (wire) => {
                if (wire.method === "POST") {
                    row = readback(span(wire));
                    row[field] = "MISMATCH";
                    return Response.json({});
                }
                return Response.json({ data: [row], meta: {} });
            },
        );
    });
}
for (const field of [
    "projectId",
    "traceId",
    "parentObservationId",
    "type",
    "name",
    "startTime",
    "endTime",
    "metadata",
    "usageDetails",
    "costDetails",
    "totalUsage",
    "totalCost",
    "model",
]) {
    test(`incomplete v2 data missing ${field} cannot falsely confirm`, async () => {
        let row: JsonRecord;
        await withServer(
            async ({ context }) => {
                await deliver(observation(), context);
                assertEquals(await confirm(observation(), context), {
                    status: "mismatch",
                });
            },
            (wire) => {
                if (wire.method === "POST") {
                    row = readback(span(wire));
                    delete row[field];
                    return Response.json({});
                }
                return Response.json({ data: [row], meta: {} });
            },
        );
    });
}
test("unexpected inferred zero cost is a mismatch, not proof of an unavailable-cost observation", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context }) => {
            const o = observation({ costSource: "unavailable", costAmount: null });
            await deliver(o, context);
            assertEquals(await confirm(o, context), { status: "mismatch" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                row.totalCost = 0;
                row.costDetails = { total: 0 };
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        },
    );
});
test("incorrect destination totals cannot hide duplicated usage", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), { status: "mismatch" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                row.usageDetails = {
                    input: 100,
                    output: 20,
                    input_cache_read: 30,
                    input_cache_creation: 0,
                    total: 300,
                };
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        },
    );
});
test("changed availability metadata cannot be confirmed even when usage numbers match", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), { status: "mismatch" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                if (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata))
                    row.metadata.usage_complete = false;
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        },
    );
});
test("asynchronous absence is not_found_yet, never a rejection", async () => {
    await withServer(
        async ({ context }) =>
            assertEquals(await confirm(observation(), context), {
                status: "not_found_yet",
            }),
        () => Response.json({ data: [], meta: {} }),
    );
});
test("unrelated observations are not presence evidence", async () => {
    await withServer(
        async ({ context }) =>
            assertEquals(await confirm(observation(), context), {
                status: "not_found_yet",
            }),
        () => Response.json({ data: [{ id: "unrelated", metadata: {} }], meta: {} }),
    );
});
test("cursor pagination reaches a matching row before returning present", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context, requests }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), { status: "present" });
            assertEquals(requests.length, 3);
            assertEquals(requests[2].url.searchParams.get("cursor"), "fixture-cursor");
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                return Response.json({});
            }
            return wire.url.searchParams.has("cursor")
                ? Response.json({ data: [row], meta: {} })
                : Response.json({ data: [], meta: { cursor: "fixture-cursor" } });
        },
    );
});
test("identical observations across bounded pages confirm the same immutable fact", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), { status: "present" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                return Response.json({});
            }
            return Response.json({
                data: [row],
                meta: wire.url.searchParams.has("cursor") ? {} : { cursor: "next" },
            });
        },
    );
});
for (const mode of ["cycle", "unbounded", "oversized_cursor", "invalid_cursor"]) {
    test(`unsafe pagination ${mode} stops without false presence`, async () => {
        let page = 0;
        await withServer(
            async ({ context, requests }) => {
                assertEquals(await confirm(observation(), context), {
                    status: "not_found_yet",
                });
                assert(requests.length <= 3);
                if (mode === "cycle") assertEquals(requests.length, 2);
                if (mode === "unbounded") assertEquals(requests.length, 3);
            },
            () =>
                Response.json({
                    data: [],
                    meta: {
                        cursor:
                            mode === "cycle"
                                ? "same"
                                : mode === "oversized_cursor"
                                  ? "x".repeat(4097)
                                  : mode === "invalid_cursor"
                                    ? 123
                                    : String(++page),
                    },
                }),
        );
    });
}
for (const body of ["SECRET_RESPONSE", '{"data":[]}', '{"data":{},"meta":{}}', '{"data":[],"meta":null}']) {
    test(`invalid query response cannot establish absence or presence: ${body}`, async () => {
        await withServer(
            async ({ context }) =>
                assertEquals(await confirm(observation(), context), {
                    status: "not_found_yet",
                }),
            () => new Response(body),
        );
    });
}
test("query failures stay not_found_yet and never copy remote diagnostics", async () => {
    await withServer(
        async ({ context }) =>
            assertEquals(await confirm(observation(), context), {
                status: "not_found_yet",
            }),
        () => new Response("SECRET", { status: 401 }),
    );
});
test("confirmation deadline includes its response body", async () => {
    await withServer(
        async ({ context }) => {
            const start = Date.now();
            assertEquals(await confirm(observation(), { ...context, deadline: start + 100 }), {
                status: "not_found_yet",
            });
            assert(Date.now() - start < 1500);
        },
        () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("{"));
                    },
                }),
            ),
    );
});
test("workflow span can confirm without model usage or a parent observation", async () => {
    let row: JsonRecord;
    const o = {
        ...observation({ outcome: "succeeded", elapsedMs: 2.75 }),
        kind: "execution_finished" as const,
    };
    delete o.executionRef;
    await withServer(
        async ({ context }) => {
            await deliver(o, context);
            assertEquals(await confirm(o, context), { status: "present" });
            delete row.parentObservationId;
            assertEquals(await confirm(o, context), { status: "mismatch" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        },
    );
});
test("query pages larger than the explicit limit cannot confirm presence", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), {
                status: "not_found_yet",
            });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                return Response.json({});
            }
            return Response.json({
                data: [row, ...Array.from({ length: 100 }, () => ({ id: "unrelated" }))],
                meta: {},
            });
        },
    );
});
test("confirmation redirects do not forward project credentials", async () => {
    await withServer(async (target) => {
        await withServer(
            async ({ context }) =>
                assertEquals(await confirm(observation(), context), {
                    status: "not_found_yet",
                }),
            () =>
                new Response(null, {
                    status: 307,
                    headers: { location: `${target.context.endpoint}/leak` },
                }),
        );
        assertEquals(target.requests.length, 0);
    });
});
test("a destination-derived total is allowed only when it equals the sent known buckets", async () => {
    let row: JsonRecord;
    await withServer(
        async ({ context }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), { status: "present" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                row.usageDetails = {
                    input: 100,
                    output: 20,
                    input_cache_read: 30,
                    input_cache_creation: 0,
                    total: 150,
                };
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        },
    );
});
test("source-pinned empty usage and zero total confirm absence without inventing a measurement", async () => {
    let row: JsonRecord;
    const fixture: AbsentUsageFixture = JSON.parse(
        await fsReadFile(new URL("./fixtures/protocol.json", import.meta.url), "utf8"),
    );
    const o = observation({
        inputCacheBasis: "unknown",
        costSource: "unavailable",
        costAmount: null,
    });
    await withServer(
        async ({ context }) => {
            await deliver(o, context);
            assertEquals(await confirm(o, context), { status: "present" });
        },
        (wire) => {
            if (wire.method === "POST") {
                row = { ...readback(span(wire)), ...fixture.v2AbsentUsage };
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        },
    );
});
interface AbsentUsageFixture {
    v2AbsentUsage: JsonRecord;
}
