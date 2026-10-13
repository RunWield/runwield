import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import {
    extractRouterDecisionsFromEntries,
    extractToolCallNames,
    normalizeTriageDetails,
} from "./extract-router-decisions.js";

test("normalizeTriageDetails preserves canonical routing intent", () => {
    assertEquals(
        normalizeTriageDetails({
            routingIntent: "FEATURE",
            complexity: "MEDIUM",
            summary: "Build it",
            affectedPaths: ["src/a.js"],
        }),
        {
            routingIntent: "FEATURE",
            classification: "FEATURE",
            complexity: "MEDIUM",
            summary: "Build it",
            affectedPaths: ["src/a.js"],
            intentSource: "routingIntent",
        },
    );
});

test("normalizeTriageDetails accepts legacy classification", () => {
    assertEquals(
        normalizeTriageDetails({
            classification: "QUICK_FIX",
            complexity: "LOW",
            summary: "Fix it",
            affectedPaths: ["src/a.js"],
        }),
        {
            routingIntent: "QUICK_FIX",
            complexity: "LOW",
            summary: "Fix it",
            affectedPaths: ["src/a.js"],
            intentSource: "classification",
        },
    );
});

test("extractToolCallNames handles persisted Pi tool-call shapes", () => {
    assertEquals(
        extractToolCallNames([
            { type: "toolCall", name: "grep" },
            { type: "tool_use", name: "triage_report" },
            { type: "text", text: "ignore" },
        ]),
        ["grep", "triage_report"],
    );
});

test("extractRouterDecisionsFromEntries pairs router user request with triage_report", () => {
    const rows = extractRouterDecisionsFromEntries([
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
    ], { sessionFile: "/tmp/session.jsonl" });

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
