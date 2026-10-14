import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { createCollaborationClient } from "./client.js";

/**
 * @param {(url: string, init: RequestInit) => Response | Promise<Response>} handler
 * @returns {typeof fetch}
 */
function fakeFetch(handler) {
    return /** @type {typeof fetch} */ ((input, init) => Promise.resolve(handler(String(input), init ?? {})));
}

test("client sends JSON requests to fragment-free endpoint URLs", async () => {
    let seenUrl = "";
    let seenInit = /** @type {RequestInit | undefined} */ (undefined);
    const client = createCollaborationClient({
        serverUrl: "https://plans.example.test/root/",
        bearerCapability: "raw-capability",
        fetch: fakeFetch((url, init) => {
            seenUrl = url;
            seenInit = init;
            return Response.json({ ok: true });
        }),
    });
    assertEquals(await client.requestJson("/api/spaces", { method: "POST", body: { planId: "plan" } }), { ok: true });
    assertEquals(seenUrl, "https://plans.example.test/root/api/spaces");
    assert(!seenUrl.includes("#"));
    assertEquals(
        /** @type {HeadersInit & Record<string, string>} */ (seenInit?.headers).Authorization,
        "Bearer raw-capability",
    );
    assertEquals(seenInit?.body, JSON.stringify({ planId: "plan" }));
});

test("client rejects absolute endpoint URLs before attaching capabilities", async () => {
    let fetchCalled = false;
    const client = createCollaborationClient({
        serverUrl: "https://plans.example.test",
        bearerCapability: "secret-cap",
        fetch: fakeFetch(() => {
            fetchCalled = true;
            return Response.json({ ok: true });
        }),
    });
    await assertRejects(
        async () => await client.requestJson("https://other-host.example/api"),
        Error,
        "API path must be relative",
    );
    assertEquals(fetchCalled, false);
});

test("client surfaces JSON API errors with redacted messages and payloads", async () => {
    const client = createCollaborationClient({
        serverUrl: "https://plans.example.test",
        bearerCapability: "secret-cap",
        fetch: fakeFetch(() =>
            Response.json({
                error: "forbidden",
                message: "raw secret-cap denied",
                nested: { capability: "secret-cap" },
            }, {
                status: 403,
            })
        ),
    });
    const error = await assertRejects(async () => await client.requestJson("/api"), Error, "[redacted-capability]");
    assert(error instanceof Error);
    assert(!error.message.includes("secret-cap"));
    assert(!JSON.stringify(/** @type {any} */ (error).payload).includes("secret-cap"));
});

test("client handles non-JSON errors", async () => {
    const client = createCollaborationClient({
        serverUrl: "https://plans.example.test",
        bearerCapability: "secret-cap",
        fetch: fakeFetch(() => new Response("plain failure", { status: 500 })),
    });
    await assertRejects(async () => await client.requestJson("/api"), Error, "plain failure");
});

test("client redacts network failure messages", async () => {
    const client = createCollaborationClient({
        serverUrl: "https://plans.example.test",
        bearerCapability: "secret-cap",
        fetch: fakeFetch(() => {
            throw new Error("Authorization: Bearer secret-cap failed");
        }),
    });
    const error = await assertRejects(async () => await client.requestJson("/api"));
    assert(error instanceof Error);
    assert(!error.message.includes("secret-cap"));
});

test("client typed methods use Shared Space API paths", async () => {
    /** @type {{ url: string, method: string, body: BodyInit | null | undefined, authorization?: string }[]} */
    const calls = [];
    const client = createCollaborationClient({
        serverUrl: "https://plans.example.test",
        bearerCapability: "raw-capability",
        fetch: fakeFetch((url, init) => {
            calls.push({
                url,
                method: init.method ?? "GET",
                body: init.body,
                authorization: /** @type {Record<string, string>} */ (init.headers).Authorization,
            });
            return Response.json({ ok: true });
        }),
    });
    await client.createSharedSpace({
        planId: "plan-1",
        initialRevision: { payloadCiphertext: "cipher-plan" },
        capabilities: [
            { scope: "reviewer", capabilityHash: "sha256:reviewer" },
            { scope: "maintainer", capabilityHash: "sha256:maintainer" },
        ],
    });
    await client.getSharedSpace("space 1");
    await client.getRevision("space 1", 2);
    await client.appendRevision("space 1", { payloadCiphertext: "cipher-rev", expectedRevision: 2 });
    await client.listComments("space 1", 2);
    await client.appendComment("space 1", 2, { ciphertext: "cipher-comment" });
    await client.setCommentState("space 1", "comment 1", { action: "resolve" });
    await client.updateSharedSpaceLifecycle("space 1", { action: "close" });
    await client.deleteSharedSpace("space 1");

    assertEquals(calls[0].authorization, undefined);
    assertEquals(calls[1].authorization, "Bearer raw-capability");
    assertEquals(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
        "POST /api/spaces",
        "GET /api/spaces/space%201",
        "GET /api/spaces/space%201/revisions/2",
        "POST /api/spaces/space%201/revisions",
        "GET /api/spaces/space%201/revisions/2/comments",
        "POST /api/spaces/space%201/revisions/2/comments",
        "POST /api/spaces/space%201/comments/comment%201/state",
        "POST /api/spaces/space%201/lifecycle",
        "POST /api/spaces/space%201/lifecycle",
    ]);
    assertEquals(JSON.parse(String(calls[8].body)), { action: "delete" });
});
