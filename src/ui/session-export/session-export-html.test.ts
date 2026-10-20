import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { SessionExport, SessionExportTimelineEvent } from "../../shared/session/session-export.ts";
import { renderSessionExportHtml } from "./session-export-html.ts";
import { createReplayEvents } from "../../shared/session/session-transcript-projection.js";

function fixture(): SessionExport {
    const base = {
        sessionId: "runtime",
        timestamp: "2026-10-19T12:00:00Z",
        segmentOrdinal: 0,
        segmentKind: "planning" as const,
    };
    const tool = { ...base, toolCallId: "tool", toolName: "read", title: "Read report", kind: "read" as const };
    const timeline: SessionExportTimelineEvent[] = [
        { ...base, type: "user_message", messageId: "user", text: "plan the export", images: [] },
        {
            ...base,
            type: "assistant_text_delta",
            messageId: "assistant",
            agentName: "Planner",
            messageKind: "assistant",
            delta: "**Plan",
        },
        {
            ...base,
            type: "assistant_text_delta",
            messageId: "assistant",
            agentName: "Planner",
            messageKind: "assistant",
            delta: "ned**",
        },
        {
            ...base,
            type: "assistant_thinking_delta",
            messageId: "thinking",
            agentName: "Planner",
            delta: "Think carefully",
        },
        { ...tool, type: "tool_start", args: { path: "report.md" } },
        {
            ...tool,
            type: "tool_end",
            output: "Report content",
            content: [{ type: "text", text: "Report content" }],
            details: null,
            isError: false,
            durationMs: 1,
        },
        {
            ...base,
            segmentOrdinal: 1,
            segmentKind: "execution",
            type: "assistant_text_delta",
            messageId: "assistant",
            agentName: "Plan Engineer",
            messageKind: "assistant",
            delta: "Implemented",
        },
    ];
    return {
        document: {
            format: "runwield.session-export",
            version: 1,
            exportedAt: base.timestamp,
            session: {
                runwieldSessionId: "session-id",
                name: "Complete export",
                cwd: "/project",
                createdAt: base.timestamp,
                updatedAt: base.timestamp,
            },
            artifacts: [
                {
                    artifactId: "report",
                    kind: "report",
                    path: "report.md",
                    title: "Export report",
                    registeredAt: base.timestamp,
                    registeredBy: "test",
                    sourceSegmentId: null,
                },
            ],
            planAssociations: [
                {
                    planId: "plan",
                    planName: "complete-export",
                    purpose: "planning",
                    segmentId: "first",
                    segmentKind: "planning",
                    recordedAt: base.timestamp,
                    committedGeneration: 0,
                },
            ],
            segments: [
                {
                    ordinal: 0,
                    kind: "planning",
                    label: "Planning segment 1",
                    piSessionId: "first",
                    sealed: true,
                    current: false,
                    entries: [],
                },
                {
                    ordinal: 1,
                    kind: "execution",
                    label: "Execution segment 2",
                    piSessionId: "second",
                    sealed: false,
                    current: true,
                    entries: [],
                },
            ],
        },
        timeline,
    };
}

test("HTML shows Session facts, references, ordered segments, and combined Markdown messages", () => {
    const html = renderSessionExportHtml(fixture());
    for (const expected of [
        "Complete export",
        "session-id",
        "/project",
        "Created",
        "Updated",
        "Exported",
        "Export report",
        "report.md",
        "complete-export",
        "<strong>Planned</strong>",
        "Implemented",
    ])
        assert.ok(html.includes(expected), expected);
    assert.ok(html.indexOf("Planning segment 1") < html.indexOf("Execution segment 2"));
    assert.ok(html.indexOf("plan the export") < html.indexOf("Implemented"));
    assert.equal(html.match(/<h3>Planner<\/h3>/g)?.length, 1);
});

test("tools and thinking use closed native disclosure elements", () => {
    const html = renderSessionExportHtml(fixture());
    assert.match(html, /<details><summary>Thinking<\/summary><pre>Think carefully<\/pre><\/details>/);
    assert.match(
        html,
        /<details><summary>Read report<\/summary>[^]*Arguments[^]*report.md[^]*Result[^]*Report content[^]*<\/details>/,
    );
    assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test("untrusted transcript text and Markdown cannot execute or load remote resources", () => {
    const exported = fixture();
    exported.document.session.name = '</title><script>alert("name")</script>';
    const user = exported.timeline[0];
    assert.equal(user.type, "user_message");
    if (user.type === "user_message") user.text = "<script>alert(1)</script>";
    const assistant = exported.timeline[1];
    if (assistant.type === "assistant_text_delta")
        assistant.delta =
            '<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29) ![remote](https://remote.example/pixel) [safe](https://example.com)';
    const start = exported.timeline[4];
    if (start.type === "tool_start") start.args = { value: "</pre><script>args</script>" };
    const end = exported.timeline[5];
    if (end.type === "tool_end") end.output = '</pre><img src=x onerror="alert(2)">';
    const html = renderSessionExportHtml(exported);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(html.includes("&lt;/pre&gt;&lt;script&gt;args&lt;/script&gt;"));
    assert.doesNotMatch(html, /<script\b|<img\b|href="javascript:|<[^>]+\sonerror=/i);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.ok(html.includes("[image]"));
    assert.ok(html.includes("Content-Security-Policy"));
    assert.doesNotMatch(html, /<script\s+src|<link\b|<iframe\b|<style[^>]+src/i);
});

test("HTML embeds RunWield theme tokens without external assets", () => {
    const html = renderSessionExportHtml(fixture());
    assert.ok(html.startsWith("<!doctype html>"));
    assert.match(html, /--rw-page-bg:/);
    assert.match(html, /color: var\(--rw-text\)/);
    assert.doesNotMatch(html, /@import|url\(|<script\b|<link\b/);
});

for (const content of [
    "Recorded <result>",
    [
        { type: "text", text: "Recorded <result>" },
        { type: "text", text: "\nSecond block" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
]) {
    test(`HTML preserves legacy ${typeof content === "string" ? "string" : "structured"} tool results from replay`, () => {
        const exported = fixture();
        exported.timeline = createReplayEvents("runtime", [
            {
                type: "message",
                id: "call",
                message: {
                    role: "assistant",
                    content: [{ type: "tool_use", id: "legacy-tool", name: "read", input: { path: "report.md" } }],
                },
            },
            {
                type: "message",
                id: "result",
                message: {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "legacy-tool", content, is_error: true }],
                },
            },
        ]).map((event) => ({ ...event, segmentOrdinal: 0, segmentKind: "planning" }) as SessionExportTimelineEvent);
        const result = exported.timeline.find((event) => event.type === "tool_end");
        assert.ok(result?.type === "tool_end");
        assert.equal(result.toolCallId, "legacy-tool");
        assert.equal(result.toolName, "read");
        assert.equal(result.isError, true);
        assert.equal(result.output, typeof content === "string" ? content : "Recorded <result>\nSecond block");
        assert.deepEqual(result.content, typeof content === "string" ? [{ type: "text", text: content }] : content);
        const html = renderSessionExportHtml(exported);
        assert.match(html, /<details><summary>[^<]* — Failed<\/summary>[^]*Recorded &lt;result&gt;/);
        assert.doesNotMatch(html, /\[tool result replayed\]/);
        if (Array.isArray(content)) {
            assert.ok(html.includes("Second block"));
            assert.ok(html.includes("[image]"));
        }
    });
}
