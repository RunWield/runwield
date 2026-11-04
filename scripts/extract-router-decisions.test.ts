import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { extractRouterDecisionsFromEntries } from "./extract-router-decisions.js";

test("extractRouterDecisionsFromEntries pairs router user request with triage_report", () => {
    const rows = extractRouterDecisionsFromEntries(
        [
            { type: "session", id: "s1" },
            { type: "model_change", provider: "ollama-cloud", modelId: "gemma4:31b-cloud" },
            { type: "custom", customType: "runwield.active_agent", data: { agentName: "router" } },
            {
                type: "message",
                id: "u1",
                timestamp: "2026-06-19T00:00:00.000Z",
                message: { role: "user", content: [{ type: "text", text: "Where is Router?" }] },
            },
            {
                type: "message",
                id: "a1",
                message: {
                    role: "assistant",
                    provider: "ollama-cloud",
                    model: "gemma4:31b-cloud",
                    content: [{ type: "toolCall", name: "grep" }],
                },
            },
            {
                type: "message",
                id: "a2",
                message: {
                    role: "assistant",
                    provider: "ollama-cloud",
                    model: "gemma4:31b-cloud",
                    content: [{ type: "toolCall", name: "triage_report" }],
                },
            },
            {
                type: "message",
                id: "t1",
                timestamp: "2026-06-19T00:00:01.000Z",
                message: {
                    role: "toolResult",
                    toolName: "triage_report",
                    details: {
                        routingIntent: "INQUIRY",
                        complexity: "LOW",
                        summary: "Answer a location question",
                        affectedPaths: ["src/agent-definitions/router.md"],
                    },
                },
            },
        ],
        { sessionFile: "/tmp/session.jsonl" },
    );

    assertEquals(rows.length, 1);
    assertEquals(rows[0], {
        decisionId: "session.jsonl:t1",
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        triageEntryId: "t1",
        userEntryId: "u1",
        timestamp: "2026-06-19T00:00:01.000Z",
        requestText: "Where is Router?",
        hasImages: false,
        provider: "ollama-cloud",
        model: "gemma4:31b-cloud",
        routingIntent: "INQUIRY",
        complexity: "LOW",
        summary: "Answer a location question",
        affectedPaths: ["src/agent-definitions/router.md"],
        intentSource: "routingIntent",
        discoveryToolCount: 1,
        discoveryTools: ["grep"],
        attribution: "active_agent_router",
    });
});

test("extractRouterDecisionsFromEntries ignores sessions without active-agent router markers", () => {
    const entries = [
        { type: "session", id: "s1" },
        {
            type: "message",
            id: "u1",
            timestamp: "2026-05-01T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text: "Fix docs" }] },
        },
        {
            type: "message",
            id: "a1",
            message: {
                role: "assistant",
                provider: "ollama-cloud",
                model: "gemma4:31b-cloud",
                content: [{ type: "toolCall", name: "triage_report" }],
            },
        },
        {
            type: "message",
            id: "t1",
            timestamp: "2026-05-01T00:00:01.000Z",
            message: {
                role: "toolResult",
                toolName: "triage_report",
                details: {
                    classification: "QUICK_FIX",
                    complexity: "LOW",
                    summary: "Fix docs",
                    affectedPaths: ["README.md"],
                },
            },
        },
    ];

    assertEquals(extractRouterDecisionsFromEntries(entries).length, 0);
});

for (const details of [
    { routingIntent: "FEATURE", complexity: "MEDIUM", summary: "Build it", affectedPaths: ["src/a.js"] },
    { classification: "QUICK_FIX", complexity: "LOW", summary: "Fix it", affectedPaths: ["src/a.js"] },
]) {
    test(`persisted routing extraction preserves ${"routingIntent" in details ? "canonical" : "legacy"} intent and tool evidence`, () => {
        const rows = extractRouterDecisionsFromEntries(
            [
                { type: "session", id: "session" },
                { type: "custom", customType: "runwield.active_agent", data: { agentName: "router" } },
                { type: "message", id: "user", message: { role: "user", content: "Make the change" } },
                {
                    type: "message",
                    message: {
                        role: "assistant",
                        content: [
                            { type: "toolCall", name: "grep" },
                            { type: "tool_use", name: "read" },
                            { type: "text", text: "ignore" },
                            { type: "tool_use", name: "triage_report" },
                        ],
                    },
                },
                { type: "message", id: "result", message: { role: "toolResult", toolName: "triage_report", details } },
            ],
            { sessionFile: "session.jsonl" },
        );
        assertEquals(rows.length, 1);
        assertEquals(rows[0].requestText, "Make the change");
        assertEquals(rows[0].routingIntent, details.routingIntent ?? details.classification);
        assertEquals(rows[0].intentSource, "routingIntent" in details ? "routingIntent" : "classification");
        assertEquals(rows[0].classification, "routingIntent" in details ? "FEATURE" : undefined);
        assertEquals(rows[0].complexity, details.complexity);
        assertEquals(rows[0].summary, details.summary);
        assertEquals(rows[0].affectedPaths, ["src/a.js"]);
        assertEquals(rows[0].discoveryTools, ["grep", "read"]);
        assertEquals(rows[0].discoveryToolCount, 2);
    });
}
