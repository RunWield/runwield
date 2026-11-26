import { test } from "node:test";
/**
 * @module acp/protocol-smoke.test
 */

import { ok as assert } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../src/testing/assertions.ts";
import { assertAcpFrameSchema } from "../../src/testing/acp-schema.ts";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { decodeAcpSteeringRequest, findAcpSchemaViolations } from "@runwield/acp/protocol";

test("ACP Cost requires an amount and a currency", () => {
    assertEquals(findAcpSchemaViolations("Cost", { amount: 0.5, currency: "USD" }), []);

    for (const invalid of [JSON.parse('{"amount":0.5}'), JSON.parse('{"currency":"USD"}'), 0.5]) {
        assert(
            findAcpSchemaViolations("Cost", invalid).length > 0,
            `ACP Cost should reject ${JSON.stringify(invalid)}`,
        );
    }
});

test("ACP schema validation rejects names outside the published definitions", () => {
    assertThrows(() => findAcpSchemaViolations("constructor", {}), Error, "Unknown ACP schema definition");
});

test("ACP usage_update carries cost as an object, never a bare number", () => {
    const usageUpdate = { sessionUpdate: "usage_update", used: 12, size: 200 };

    assertEquals(findAcpSchemaViolations("UsageUpdate", usageUpdate), []);
    assertEquals(
        findAcpSchemaViolations("UsageUpdate", { ...usageUpdate, cost: { amount: 1.5, currency: "USD" } }),
        [],
    );
    assert(findAcpSchemaViolations("UsageUpdate", { ...usageUpdate, cost: 1.5 }).length > 0);
});

test("assertAcpFrameSchema validates serialized NDJSON frames and handles malformed frames", () => {
    const validFrame = JSON.stringify({ result: { amount: 10, currency: "USD" } });
    assertAcpFrameSchema("Cost", validFrame, (message) => message.result);

    assertThrows(
        () => assertAcpFrameSchema("Cost", "{ not valid json", (message) => message.result),
        Error,
        "is not valid JSON",
    );

    assertThrows(
        () => assertAcpFrameSchema("Cost", "null", (message) => message.result),
        Error,
        "must be a JSON object",
    );

    assertThrows(
        () => assertAcpFrameSchema("Cost", "123", (message) => message.result),
        Error,
        "must be a JSON object",
    );
});

test("the public ACP steering decoder preserves request metadata", () => {
    const prompt = [{ type: "text", text: "Keep the logs" }];
    const request = {
        sessionId: "session-1",
        prompt,
        _meta: { steering: { idleBehavior: "promptRequired" }, clientHint: "test" },
    };
    assertEquals(decodeAcpSteeringRequest(request), request);
    const invalid = assertThrows(
        () => decodeAcpSteeringRequest({ ...request, _meta: { steering: { idleBehavior: "enqueue" } } }),
        RequestError,
        "_session/steering idleBehavior must be promptRequired",
    );
    assertEquals(invalid.code, -32602);
});
