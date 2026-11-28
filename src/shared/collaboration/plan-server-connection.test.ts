import { test } from "node:test";
import { notEqual } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { serveHttp } from "../http-server.ts";
import {
    hashCapability,
    MAINTAINER_SCOPE,
    REVIEWER_SCOPE,
    decryptJsonPayload,
    importContentKey,
    normalizeEncryptedPlanPayload,
    openPlanServerConnection,
} from "@runwield/plans/plan-server";

import type { CreateSharedSpacePayload } from "@runwield/plans/plan-server";

interface RecordedRequest {
    method: string;
    path: string;
    authorization: string | null;
    requestId: string | null;
    body: CreateSharedSpacePayload;
}

test("signed-out Plan Server connections prepare fresh secrets and only send ciphertext and capability hashes", async () => {
    const requests: RecordedRequest[] = [];
    const server = serveHttp({ hostname: "127.0.0.1", port: 0 }, async (request) => {
        requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            authorization: request.headers.get("Authorization"),
            requestId: request.headers.get("Idempotency-Key"),
            body: await request.json(),
        });
        return Response.json({
            space: {
                spaceId: "space-1",
                planId: "plan-1",
                createdAt: "2026-11-27T12:00:00.000Z",
                updatedAt: "2026-11-27T12:00:00.000Z",
                latestRevision: 1,
            },
        });
    });
    try {
        const connection = openPlanServerConnection(`  http://127.0.0.1:${server.addr.port}/review/  `);
        const payload = {
            planId: "plan-1",
            title: "Private title",
            metadata: { tickets: [{ title: "Example ticket", labels: ["example"], archivedAt: null }] },
            body: "Private body",
        };
        for (const metadata of [null, 1, []]) {
            await assertRejects(
                // @ts-expect-error An untyped caller may still pass invalid metadata.
                () => connection.prepareSharedSpace({ ...payload, metadata }),
                Error,
                "metadata must be an object",
            );
        }
        assertEquals(requests, []);
        const prepared = await connection.prepareSharedSpace(payload);
        const second = await connection.prepareSharedSpace(payload);
        notEqual(prepared.contentKey, second.contentKey);
        notEqual(prepared.reviewerCapability, second.reviewerCapability);
        notEqual(prepared.maintainerCapability, second.maintainerCapability);
        notEqual(prepared.reviewerCapability, prepared.maintainerCapability);

        const { createPayload } = prepared;
        assertEquals(
            normalizeEncryptedPlanPayload(
                await decryptJsonPayload(
                    createPayload.initialRevision.payloadCiphertext,
                    await importContentKey(prepared.contentKey),
                ),
            ),
            payload,
        );
        assertEquals(createPayload.capabilities, [
            { scope: REVIEWER_SCOPE, capabilityHash: await hashCapability(prepared.reviewerCapability) },
            { scope: MAINTAINER_SCOPE, capabilityHash: await hashCapability(prepared.maintainerCapability) },
        ]);
        const requestId = crypto.randomUUID();
        assertEquals((await connection.replaySharedSpace(createPayload, requestId)).spaceId, "space-1");
        assertEquals(
            requests.map(({ method, path, authorization, requestId }) => [method, path, authorization, requestId]),
            [["POST", "/review/api/spaces/replay", null, requestId]],
        );
        for (const request of requests) assertEquals(request.body, createPayload);
    } finally {
        await server.shutdown();
    }
});
