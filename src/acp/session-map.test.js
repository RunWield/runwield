import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
/**
 * @module acp/session-map.test
 */

import { ok as assert } from "node:assert/strict";
import { AcpSessionMap } from "./session-map.ts";

test("AcpSessionMap correlates runtime-owned turns without enforcing exclusion", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ id: "hosted-1", cwd: "/repo" }), {
        acpSessionId: "acp-1",
    });

    const first = sessionMap.beginPrompt("acp-1", "turn-1", "request-1");
    const second = sessionMap.beginPrompt("acp-1", "turn-2", "request-2");
    assert(first);
    assert(second);
    assertEquals(sessionMap.isCurrentPrompt("acp-1", first), false);
    assertEquals(sessionMap.isCurrentPrompt("acp-1", second), true);
    assertEquals(sessionMap.endPrompt("acp-1", first), false);
    assertEquals(sessionMap.markCancelled("acp-1"), true);
    assertEquals(second.cancelled, true);
    assertEquals(sessionMap.endPrompt("acp-1", second), true);
});

test("AcpSessionMap leaves prompt completion to the caller, not a cancellation promise", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), { acpSessionId: "acp-1" });

    const prompt = sessionMap.beginPrompt("acp-1", "turn-1", "request-1");
    assert(prompt);
    assertEquals(Object.keys(prompt).sort(), ["cancelled", "requestId", "turnId"]);

    assertEquals(sessionMap.markCancelled("acp-1"), true);
    assertEquals(sessionMap.markCancelled("acp-1"), true);
    assertEquals(prompt.cancelled, true);
});

test("AcpSessionMap accumulates usage cost across a Session's turns", () => {
    const sessionMap = new AcpSessionMap();
    const record = sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), {
        acpSessionId: "acp-1",
    });

    assertEquals(record.usageCostUsd, 0);
    assertEquals(sessionMap.addUsageCost("acp-1", 0.25), 0.25);
    assertEquals(sessionMap.addUsageCost("acp-1", 0.25), 0.5);
});

test("AcpSessionMap keeps the cost total with the ACP session, not the runtime session", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), { acpSessionId: "acp-1" });
    sessionMap.addUsageCost("acp-1", 0.4);

    sessionMap.replaceRuntimeSession("acp-1", { sessionId: "runtime-2", cwd: "/repo" });
    assertEquals(sessionMap.getRecord("acp-1")?.usageCostUsd, 0.4);
    assertEquals(sessionMap.addUsageCost("acp-1", 0.1), 0.5);

    sessionMap.deleteRecord("acp-1");
    assertEquals(sessionMap.getRecord("acp-1"), null);
    assertEquals(sessionMap.addUsageCost("acp-1", 0.1), 0);
});

test("AcpSessionMap ignores usage events that carry no usable cost", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), { acpSessionId: "acp-1" });

    assertEquals(sessionMap.addUsageCost("acp-1", undefined), 0);
    assertEquals(sessionMap.addUsageCost("acp-1", Number.NaN), 0);
    assertEquals(sessionMap.addUsageCost("acp-1", 0.25), 0.25);
});

test("AcpSessionMap remaps a stable ACP session to a replacement runtime session", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), {
        acpSessionId: "acp-1",
    });

    const record = sessionMap.replaceRuntimeSession("acp-1", { sessionId: "runtime-2", cwd: "/repo" });
    assert(record);
    assertEquals(record.runtimeSessionId, "runtime-2");
    assertEquals(sessionMap.getRuntimeSessionId("acp-1"), "runtime-2");
    assertEquals(sessionMap.getAcpSessionIdForRuntimeSession("runtime-1"), null);
    assertEquals(sessionMap.getAcpSessionIdForRuntimeSession("runtime-2"), "acp-1");
});
