import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../src/testing/assertions.ts";
import { confirm, deliver } from "./exporter.ts";
import { captured, type JsonRecord, native, observation, withServer } from "./test-fixture.ts";
interface PriceModel {
    modelName: string;
    prices: Record<string, number>;
}
interface ProtocolFixture {
    sourceCommit: string;
    models: PriceModel[];
    v2FieldGroups: string[];
    v2Pagination: JsonRecord;
    otlpSuccess: JsonRecord;
    otlpWarning: JsonRecord;
    otlpRejected: JsonRecord;
}
const fixture: ProtocolFixture = JSON.parse(
    await fsReadFile(new URL("./fixtures/protocol.json", import.meta.url), "utf8"),
);
test("native bucket spelling is supported by the pinned Langfuse primary price catalog", async () => {
    assertEquals(fixture.sourceCommit, "cb2cebae9f8e7d53e8e514780fce8493d680ecfb");
    await captured(observation({ reasoningTokens: 12, cacheWriteTokens: 10 }), (s) => {
        const usage = native(s, "usage_details")!;
        assertEquals(Object.keys(usage).sort(), [
            "input",
            "input_cache_creation",
            "input_cache_read",
            "output",
            "output_reasoning",
        ]);
        for (const key of Object.keys(usage)) {
            assert(
                fixture.models.some((model) => Object.hasOwn(model.prices, key)),
                key,
            );
        }
        assert(!fixture.models.some((model) => Object.hasOwn(model.prices, "input_cache_write")));
    });
});
for (const [key, expected] of [
    ["otlpSuccess", "accepted"],
    ["otlpWarning", "accepted"],
    ["otlpRejected", "not_accepted"],
] as const) {
    test(`source-shaped single-span OTLP fixture ${key}`, async () => {
        await withServer(
            async ({ context }) => assertEquals((await deliver(observation(), context)).outcome, expected),
            () => Response.json(fixture[key]),
        );
    });
}

test("pinned v2 pagination and field groups support a bounded absence lookup", async () => {
    await withServer(
        async ({ context, requests }) => {
            assertEquals(await confirm(observation(), context), { status: "not_found_yet" });
            assertEquals(requests[0].url.searchParams.get("fields"), fixture.v2FieldGroups.join(","));
        },
        () => Response.json(fixture.v2Pagination),
    );
});
