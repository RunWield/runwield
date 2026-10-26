import { test } from "node:test";
/**
 * @module acp/protocol-smoke.test
 */

import { ok as assert, strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../testing/assertions.ts";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { assertAcpFrameSchema, findAcpSchemaViolations } from "./schema-conformance.ts";

test("ACP SDK import exposes agent and NDJSON stream primitives under Deno", () => {
    const app = agent({ name: "RunWield ACP smoke" });
    const transport = new TransformStream<Uint8Array, Uint8Array>();
    const stream = ndJsonStream(transport.writable, transport.readable);

    assertEquals(methods.agent.initialize, "initialize");
    assertStrictEquals(PROTOCOL_VERSION, 1);
    assertEquals(typeof app.connect, "function");
    assertEquals(typeof stream.readable.getReader, "function");
    assertEquals(typeof stream.writable.getWriter, "function");
});

test("ACP method constants include session lifecycle and update methods", () => {
    assertEquals(methods.agent.session.new, "session/new");
    assertEquals(methods.agent.session.load, "session/load");
    assertEquals(methods.agent.session.prompt, "session/prompt");
    assertEquals(methods.agent.session.cancel, "session/cancel");
    assertEquals(methods.agent.session.close, "session/close");
    assertEquals(methods.client.session.update, "session/update");
});

test("ACP elicitation stayed on the same wire method after it left unstable", () => {
    assertEquals(methods.client.elicitation.create, "elicitation/create");
});

test("ACP Cost requires an amount and a currency", () => {
    assertEquals(findAcpSchemaViolations("Cost", { amount: 0.5, currency: "USD" }), []);

    for (const invalid of [JSON.parse('{"amount":0.5}'), JSON.parse('{"currency":"USD"}'), 0.5]) {
        assert(
            findAcpSchemaViolations("Cost", invalid).length > 0,
            `ACP Cost should reject ${JSON.stringify(invalid)}`,
        );
    }
});

test("ACP thought_level selector is a standard schema-valid config option", () => {
    assertEquals(
        findAcpSchemaViolations("SessionConfigOption", {
            id: "thought_level",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
                { value: "off", name: "Off" },
                { value: "high", name: "High" },
            ],
        }),
        [],
    );
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

test("ACP terminal auth accepts the RunWield login descriptor", () => {
    assertEquals(
        findAcpSchemaViolations("AuthMethod", {
            id: "runwield-terminal-login",
            name: "RunWield Login",
            description: "Open a terminal to configure RunWield credentials and choose a default model.",
            type: "terminal",
            args: ["login"],
        }),
        [],
    );
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
