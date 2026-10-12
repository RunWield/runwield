import { assert, assertEquals } from "@std/assert";
import {
    buildMetricsExportObservation,
    type MetricsJournalRow,
} from "../../src/shared/workflow/metrics-export-record.ts";
import { deliver } from "./exporter.ts";
import { span, withServer } from "./test-fixture.ts";

Deno.test("Core nested execution references link exported spans in one trace", async () => {
    const root = await Deno.makeTempDir();
    try {
        const identity = { ownerRef: "owner", referenceKey: "ab".repeat(32) };
        const row: MetricsJournalRow = {
            v: 2,
            event: "execution_finished",
            eventId: "parent-finished",
            historyEpoch: "epoch",
            ts: "2026-09-20T12:00:03.000Z",
            sessionId: "session",
            executionId: "parent",
            backend: "claude-cli",
            outcome: "succeeded",
            elapsedMs: 10,
        };
        const parent = await buildMetricsExportObservation(row, root, identity);
        const child = await buildMetricsExportObservation(
            {
                ...row,
                eventId: "child-finished",
                executionId: "child",
                parentExecutionId: "parent",
            },
            root,
            identity,
        );
        assert(parent && child);
        await withServer(async ({ context, requests }) => {
            assertEquals((await deliver(parent, context)).outcome, "accepted");
            assertEquals((await deliver(child, context)).outcome, "accepted");
            const parentSpan = span(requests[0]);
            const childSpan = span(requests[1]);
            assertEquals(childSpan.parentSpanId, parentSpan.spanId);
            assertEquals(childSpan.traceId, parentSpan.traceId);
        });
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
