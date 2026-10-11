import { assertEquals } from "@std/assert";
import { confirm, deliver } from "./exporter.ts";
import { type JsonRecord, observation, readback, span, withServer } from "./test-fixture.ts";

interface ProtocolFixture {
    otlpQueued: JsonRecord;
}
const fixture: ProtocolFixture = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/protocol.json", import.meta.url)),
);

for (
    const defect of [
        "none",
        "arbitrary",
        "wrong_project",
        "wrong_key",
        "wrong_file",
        "wrong_version",
        "invalid_auth",
        "wrong_queue",
        "wrong_name",
        "missing_id",
        "not_queued",
        "extra_status",
    ]
) {
    Deno.test(`live Langfuse queue acknowledgement remains destination-bound: ${defect}`, async () => {
        const body = structuredClone(fixture.otlpQueued);
        // Fixture-only JSON traversal; the production parser independently validates every boundary.
        const data = body.data as JsonRecord;
        const payload = data.payload as JsonRecord;
        const auth = payload.authCheck as JsonRecord;
        const scope = auth.scope as JsonRecord;
        const upload = payload.data as JsonRecord;
        if (defect === "wrong_project") scope.projectId = "other-project";
        if (defect === "wrong_key") upload.publicKey = "other-key";
        if (defect === "wrong_file") {
            upload.fileKey = "events/otel/other-project/batch.json";
        }
        if (defect === "wrong_version") payload.ingestionVersion = "3";
        if (defect === "invalid_auth") auth.validKey = false;
        if (defect === "wrong_queue") body.queueQualifiedName = "bull:other-queue";
        if (defect === "wrong_name") data.name = "other-job";
        if (defect === "missing_id") delete body.id;
        if (defect === "not_queued") body.attemptsMade = 1;
        if (defect === "extra_status") body.partialSuccess = { rejectedSpans: 1 };
        await withServer(async ({ context }) => {
            assertEquals(
                await deliver(observation(), context),
                defect === "none"
                    ? { outcome: "accepted", code: "langfuse_queued" }
                    : { outcome: "uncertain", code: "ambiguous_response" },
            );
        }, () => Response.json(defect === "arbitrary" ? { accepted: true } : body));
    });
}
for (
    const kind of [
        "model_usage",
        "execution_finished",
        "tool_call_finished",
        "validation_attempt",
    ] as const
) {
    Deno.test(`native empty representations preserve absent evidence: ${kind}`, async () => {
        let row: JsonRecord;
        const o = {
            ...observation({
                inputCacheBasis: "unknown",
                costSource: "unavailable",
                costAmount: null,
            }),
            kind,
        };
        await withServer(async ({ context }) => {
            await deliver(o, context);
            assertEquals(await confirm(o, context), { status: "present" });
            row.usageDetails = { input: 0 };
            assertEquals(await confirm(o, context), { status: "mismatch" });
            row.usageDetails = {};
            row.totalUsage = 1;
            assertEquals(await confirm(o, context), { status: "mismatch" });
            row.totalUsage = 0;
            delete row.model;
            assertEquals(await confirm(o, context), { status: "mismatch" });
        }, (wire) => {
            if (wire.method === "POST") {
                row = { ...readback(span(wire)), totalUsage: 0, model: "" };
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        });
    });
}
for (
    const [sent, stored, status] of [
        [0.014 + 2 * 0.006, 0.026, "present"],
        [0.1 + 0.2, 0.3, "present"],
        [1, 1 + 2 * Number.EPSILON, "present"],
        [1, 1 + 3 * Number.EPSILON, "mismatch"],
        [0.01, 0.0100000001, "mismatch"],
        [1e-30, 0, "mismatch"],
        [0, 1e-30, "mismatch"],
        [1e-30, 2e-30, "mismatch"],
    ] as const
) {
    Deno.test(`native cost permits only roundoff, never zero or absence substitution: ${sent} -> ${stored}`, async () => {
        let row: JsonRecord;
        const o = observation({ costAmount: sent });
        await withServer(async ({ context }) => {
            await deliver(o, context);
            assertEquals(await confirm(o, context), { status });
        }, (wire) => {
            if (wire.method === "POST") {
                row = {
                    ...readback(span(wire)),
                    costDetails: { total: stored },
                    totalCost: stored,
                };
                return Response.json({});
            }
            return Response.json({ data: [row], meta: {} });
        });
    });
}
for (
    const conflict of [
        "none",
        "usage",
        "cost",
        "metadata",
        "parent",
        "extra_field",
        "extra_value",
        "extra_metadata_value",
        "missing_field",
    ] as const
) {
    Deno.test(`replayed readback must agree in every returned fact: ${conflict}`, async () => {
        let row: JsonRecord;
        let repeated: JsonRecord;
        await withServer(async ({ context }) => {
            await deliver(observation(), context);
            assertEquals(await confirm(observation(), context), {
                status: conflict === "none" ? "present" : "mismatch",
            });
        }, (wire) => {
            if (wire.method === "POST") {
                row = readback(span(wire));
                if (conflict === "extra_value") row.modelId = "original-model";
                if (conflict === "extra_metadata_value") {
                    row.metadata = { ...row.metadata as JsonRecord, extra: "original-value" };
                }
                // Reordered JSON keys are not a conflict; all nested values still must agree.
                repeated = Object.fromEntries(
                    Object.entries(structuredClone(row)).reverse(),
                );
                if (conflict === "usage") repeated.usageDetails = { input: 999 };
                if (conflict === "cost") repeated.totalCost = 0.02;
                if (conflict === "metadata") {
                    repeated.metadata = {
                        ...row.metadata as JsonRecord,
                        extra: "conflict",
                    };
                }
                if (conflict === "parent") {
                    repeated.parentObservationId = "other-parent";
                }
                if (conflict === "extra_field") {
                    repeated.environment = "other-environment";
                }
                if (conflict === "extra_value") repeated.modelId = "changed-model";
                if (conflict === "extra_metadata_value") {
                    repeated.metadata = { ...row.metadata as JsonRecord, extra: "changed-value" };
                }
                if (conflict === "missing_field") delete repeated.model;
                return Response.json({});
            }
            return Response.json({ data: [row, repeated], meta: {} });
        });
    });
}
