import { serveHttp } from "../../src/shared/http-server.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../src/testing/assertions.ts";
import { deliver } from "./exporter.ts";
import { observation, withServer } from "./test-fixture.ts";
type TimeoutHandle = ReturnType<typeof setTimeout>;

for (const [body, expected] of [
    ["{}", { outcome: "accepted", code: "otlp_success" }],
    [
        '{"partialSuccess":{"rejectedSpans":0,"errorMessage":"SECRET_WARNING"}}',
        {
            outcome: "accepted",
            code: "otlp_warning",
        },
    ],
    [
        '{"partialSuccess":{"errorMessage":"SECRET_WARNING"}}',
        {
            outcome: "accepted",
            code: "otlp_warning",
        },
    ],
    [
        '{"partialSuccess":{"rejectedSpans":"0"}}',
        {
            outcome: "accepted",
            code: "otlp_warning",
        },
    ],
    [
        '{"partialSuccess":{"rejectedSpans":1,"errorMessage":"SECRET_ERROR"}}',
        {
            outcome: "not_accepted",
            retry: "permanent",
            code: "otlp_rejected",
        },
    ],
    [
        '{"partialSuccess":{"rejectedSpans":"1"}}',
        {
            outcome: "not_accepted",
            retry: "permanent",
            code: "otlp_rejected",
        },
    ],
] as const) {
    test(`OTLP single-span acceptance contract: ${body}`, async () => {
        await withServer(
            async ({ context, requests }) => {
                assertEquals(await deliver(observation(), context), expected);
                assertEquals(requests.length, 1);
            },
            () => new Response(body, { headers: { "content-type": "application/json" } }),
        );
    });
}
for (const body of [
    "",
    "SECRET_NON_JSON",
    "null",
    "[]",
    '{"accepted":true}',
    '{"partialSuccess":null}',
    '{"partialSuccess":{"rejectedSpans":2}}',
    '{"partialSuccess":{"rejectedSpans":null}}',
    '{"partialSuccess":{"rejectedSpans":-1}}',
    '{"partialSuccess":{"rejectedSpans":"garbage"}}',
    '{"partialSuccess":{"rejectedSpans":0,"errorMessage":{}}}',
    '{"partialSuccess":{"SECRET_EXTRA":1}}',
]) {
    test(`ambiguous success body cannot authorize duplicate-safe retries: ${body}`, async () => {
        await withServer(
            async ({ context }) => {
                const result = await deliver(observation(), context);
                assertEquals(result.outcome, "uncertain");
                assert(!JSON.stringify(result).includes("SECRET"));
            },
            () => new Response(body),
        );
    });
}
for (const status of [401, 403, 404, 400]) {
    test(`HTTP ${status} proves nonacceptance and excludes remote diagnostics`, async () => {
        await withServer(
            async ({ context }) => {
                assertEquals(await deliver(observation(), context), {
                    outcome: "not_accepted",
                    retry: status === 400 ? "permanent" : "needs_correction",
                    code: `http_${status}`,
                });
            },
            () => new Response("SECRET_PATH_AND_CREDENTIALS", { status }),
        );
    });
}
for (const status of [202, 204, 408, 429, 500, 502, 503, 504]) {
    test(`HTTP ${status} alone cannot prove upstream nonacceptance`, async () => {
        await withServer(
            async ({ context, requests }) => {
                assertEquals(await deliver(observation(), context), {
                    outcome: "uncertain",
                    code: "ambiguous_response",
                });
                assertEquals(requests.length, 1);
            },
            () =>
                new Response(status === 204 ? null : "SECRET", {
                    status,
                    headers: { "retry-after": "1" },
                }),
        );
    });
}
test("deadline before ingestion proves no request was sent", async () => {
    await withServer(async ({ context, requests }) => {
        assertEquals(await deliver(observation(), { ...context, deadline: Date.now() - 1 }), {
            outcome: "not_accepted",
            retry: "retryable",
            code: "deadline_before_send",
        });
        assertEquals(requests.length, 0);
    });
});
test("deadline covers a stalled response body, not only headers", async () => {
    await withServer(
        async ({ context, requests }) => {
            const start = Date.now();
            assertEquals((await deliver(observation(), { ...context, deadline: start + 150 })).outcome, "uncertain");
            assert(Date.now() - start < 1500);
            assertEquals(requests.length, 1);
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
test("deadline covers delayed response headers", async () => {
    await withServer(
        async ({ context }) => {
            const start = Date.now();
            assertEquals((await deliver(observation(), { ...context, deadline: start + 100 })).outcome, "uncertain");
            assert(Date.now() - start < 1500);
        },
        async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return Response.json({});
        },
    );
});
test("transport failure is uncertain and has no automatic retry", async () => {
    const listener = serveHttp({ hostname: "127.0.0.1", port: 0 }, () => new Response());
    const port = listener.addr.port;
    await listener.shutdown();
    assertEquals(
        (
            await deliver(observation(), {
                endpoint: `http://127.0.0.1:${port}`,
                credentials: { publicKey: "pk", secretKey: "SECRET" },
                externalProject: "fixture",
                deadline: Date.now() + 1000,
            })
        ).outcome,
        "uncertain",
    );
});
test("response body failure cannot turn a lost acknowledgement into acceptance", async () => {
    await withServer(
        async ({ context }) => {
            assertEquals((await deliver(observation(), context)).outcome, "uncertain");
        },
        () => {
            let timer: TimeoutHandle | undefined;
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("{}"));
                        timer = setTimeout(() => controller.error(new Error("SECRET_REMOTE_ERROR")), 20);
                    },
                    cancel() {
                        clearTimeout(timer);
                    },
                }),
            );
        },
    );
});
test("oversized response is bounded and uncertain", async () => {
    await withServer(
        async ({ context }) => {
            assertEquals((await deliver(observation(), context)).outcome, "uncertain");
        },
        () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 0, errorMessage: "x".repeat(1048577) } })),
    );
});
test("redirects never forward project credentials or ingestion", async () => {
    await withServer(async (target) => {
        await withServer(
            async ({ context }) => {
                assertEquals((await deliver(observation(), context)).outcome, "uncertain");
            },
            () =>
                new Response(null, {
                    status: 307,
                    headers: { location: `${target.context.endpoint}/leak` },
                }),
        );
        assertEquals(target.requests.length, 0);
    });
});
for (const defect of ["missing_keys", "url_credentials", "nonlocal_http", "query", "invalid_keys"]) {
    test(`invalid configuration ${defect} is rejected before ingestion`, async () => {
        await withServer(async ({ context, requests }) => {
            if (defect === "missing_keys") context.credentials = {};
            if (defect === "url_credentials") {
                context.endpoint = "https://secret@example.com";
            }
            if (defect === "nonlocal_http") context.endpoint = "http://example.com";
            if (defect === "query") context.endpoint += "?SECRET";
            if (defect === "invalid_keys") {
                context.credentials.publicKey = "pk:secret";
            }
            assertEquals(await deliver(observation(), context), {
                outcome: "not_accepted",
                retry: "needs_correction",
                code: "invalid_configuration",
            });
            assertEquals(requests.length, 0);
        });
    });
}
test("invalid observation is a local permanent rejection without network I/O", async () => {
    await withServer(async ({ context, requests }) => {
        assertEquals(await deliver({ ...observation(), observationId: "/SECRET_PATH" }, context), {
            outcome: "not_accepted",
            retry: "permanent",
            code: "invalid_observation",
        });
        assertEquals(requests.length, 0);
    });
});
