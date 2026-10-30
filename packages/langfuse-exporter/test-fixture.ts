import {
    mkdir as fsMkdir,
    readFile as fsReadFile,
    copyFile as fsCopyFile,
    readdir as fsReaddir,
} from "node:fs/promises";
import { join } from "node:path";
import { serveHttp } from "../../src/shared/http-server.ts";
import { assertEquals } from "../../src/testing/assertions.ts";
import { deliver, type MetricsExportContext, type MetricsExportObservation } from "./exporter.ts";

export interface Value {
    stringValue?: string;
    boolValue?: boolean;
    doubleValue?: number;
}
export interface CapturedAttribute {
    key: string;
    value: Value;
}
export interface CapturedSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: CapturedAttribute[];
}
export interface Payload {
    resourceSpans: ResourceSpan[];
}
interface ResourceSpan {
    scopeSpans: ScopeSpan[];
}
interface ScopeSpan {
    spans: CapturedSpan[];
}
export type ObservationFields = MetricsExportObservation["fields"];
export type Scalar = string | number | boolean;
export type Json = null | Scalar | Json[] | JsonRecord;
export interface JsonRecord {
    [key: string]: Json;
}
export interface Wire {
    url: URL;
    method: string;
    headers: Headers;
    body: string;
}
export interface ServerFixture {
    context: MetricsExportContext;
    requests: Wire[];
}
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
export async function withServer(
    run: (fixture: ServerFixture) => Promise<void>,
    handler: (wire: Wire) => Response | Promise<Response> = () => Response.json({}),
): Promise<void> {
    const requests: Wire[] = [];
    const server = serveHttp(
        { hostname: "127.0.0.1", port: 0, onListen() {}, onError: () => new Response(null, { status: 500 }) },
        async (request) => {
            const wire = {
                url: new URL(request.url),
                method: request.method,
                headers: request.headers,
                body: await request.text(),
            };
            requests.push(wire);
            return await handler(wire);
        },
    );
    try {
        await run({
            context: {
                endpoint: `http://127.0.0.1:${server.addr.port}`,
                externalProject: "fixture-project",
                credentials: { publicKey: "pk-fixture", secretKey: "sk-fixture" },
                deadline: Date.now() + 5000,
            },
            requests,
        });
    } finally {
        await server.shutdown();
    }
}
export function span(wire: Wire): CapturedSpan {
    const payload: Payload = JSON.parse(wire.body);
    assertEquals(payload.resourceSpans.length, 1);
    assertEquals(payload.resourceSpans[0].scopeSpans.length, 1);
    assertEquals(payload.resourceSpans[0].scopeSpans[0].spans.length, 1);
    return payload.resourceSpans[0].scopeSpans[0].spans[0];
}
export function attributes(s: CapturedSpan): Record<string, Scalar> {
    return Object.fromEntries(
        s.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.doubleValue!]),
    );
}
export function metadata(s: CapturedSpan): Record<string, Scalar> {
    const prefix = "langfuse.observation.metadata.";
    return Object.fromEntries(
        Object.entries(attributes(s))
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key.slice(prefix.length), value]),
    );
}
export function native(s: CapturedSpan, key: string): Record<string, number> | undefined {
    const value = attributes(s)[`langfuse.observation.${key}`];
    return typeof value === "string" ? JSON.parse(value) : undefined;
}
/** Fixture wire shape: pinned Langfuse observations v2 core/basic/usage/model/metadata groups. */
export function readback(s: CapturedSpan): JsonRecord {
    const usage = native(s, "usage_details"),
        cost = native(s, "cost_details");
    return {
        id: s.spanId,
        traceId: s.traceId,
        projectId: "fixture-project",
        parentObservationId: s.parentSpanId ?? null,
        type: attributes(s)["langfuse.observation.type"] === "generation" ? "GENERATION" : "SPAN",
        name: s.name,
        startTime: new Date(Number(BigInt(s.startTimeUnixNano) / 1000000n)).toISOString(),
        endTime: new Date(Number(BigInt(s.endTimeUnixNano) / 1000000n)).toISOString(),
        metadata: metadata(s),
        usageDetails: usage ?? {},
        costDetails: cost ?? {},
        totalUsage: usage ? Object.values(usage).reduce((a, b) => a + b, 0) : null,
        totalCost: cost?.total ?? null,
        model: attributes(s)["langfuse.observation.model.name"] ?? null,
        modelId: null,
        inputPrice: null,
        outputPrice: null,
        totalPrice: null,
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

interface Manifest {
    files: string[];
    wld: { metricsExporter: { contract: number; id: string; entry: string } };
}
export async function copyProduction(path: string): Promise<void> {
    await fsMkdir(path);
    const manifest: Manifest = JSON.parse(await fsReadFile(new URL("./package.json", import.meta.url), "utf8"));
    assertEquals(manifest.files, ["exporter.ts", "README.md", "LICENSE"]);
    for (const file of ["package.json", ...manifest.files]) {
        await fsCopyFile(new URL(file, import.meta.url), join(path, file));
    }
    assertEquals(
        (await Array.fromAsync(await fsReaddir(path, { withFileTypes: true }))).map((entry) => entry.name).sort(),
        ["LICENSE", "README.md", "exporter.ts", "package.json"],
    );
}
