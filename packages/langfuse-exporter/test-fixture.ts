import { assertEquals } from "../../src/testing/assertions.ts";
import { span, withServer, type CapturedSpan, type Wire } from "../../src/testing/langfuse-exporter-fixture.ts";
import { deliver, type MetricsExportObservation } from "./exporter.ts";

export type ObservationFields = MetricsExportObservation["fields"];

export function observation(fields: MetricsExportObservation["fields"] = {}): MetricsExportObservation {
    return {
        contract: 1,
        kind: "model_usage",
        observationId: "1".repeat(64),
        occurredAt: "2026-09-20T12:00:03.000Z",
        ownerRef: "2".repeat(64),
        projectRef: "3".repeat(64),
        sessionRef: "4".repeat(64),
        executionRef: "5".repeat(64),
        fields: {
            usageKind: "request",
            aggregationBasis: "request",
            backend: "pi",
            provider: "google",
            model: "gemini-3.8-flash",
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 0,
            reasoningTokens: null,
            inputCacheBasis: "excludes_cache",
            measurementAvailability: "complete",
            costCurrency: "USD",
            costSource: "calculated",
            costAmount: 0.01,
            startedAt: "2026-09-20T12:00:00.100Z",
            endedAt: "2026-09-20T12:00:02.200Z",
            ...fields,
        },
    };
}
export async function captured(
    o: MetricsExportObservation,
    check: (s: CapturedSpan, wire: Wire) => void,
): Promise<void> {
    await withServer(async ({ context, requests }) => {
        assertEquals(await deliver(o, context), {
            outcome: "accepted",
            code: "otlp_success",
        });
        assertEquals(requests.length, 1);
        check(span(requests[0]), requests[0]);
    });
}
