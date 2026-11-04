import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { createReplayEvents } from "./session-transcript-projection.js";

test("saved native, legacy and extension tool calls replay with useful titles and action kinds", () => {
    const fixtures = [
        { name: "run_command", args: { CommandLine: "git status" }, title: "run_command git status", kind: "execute" },
        {
            name: "view_file",
            args: { AbsolutePath: "/project/README.md" },
            title: "view_file /project/README.md",
            kind: "read",
        },
        { name: "write_docs", args: { path: "docs/report.md" }, title: "write_docs docs/report.md", kind: "edit" },
        {
            name: "grep",
            args: { pattern: "SessionRuntime", path: ["src", "tests"] },
            title: "grep SessionRuntime in src tests",
            kind: "search",
        },
        { name: "memory", args: { action: "delete", id: 42 }, title: "memory - delete: id: 42", kind: "delete" },
        {
            name: "memory_store",
            args: { content: "Historical transcript memory" },
            title: "memory_store Historical transcript memory",
            kind: "other",
        },
        {
            name: "web_fetch",
            args: { url: "https://example.test/guide" },
            title: "web_fetch https://example.test/guide",
            kind: "fetch",
        },
        {
            name: "pair_checkpoint",
            args: { summary: "Rendered the responsive account settings form with validation states and diagnostics" },
            title: "pair_checkpoint Rendered the responsive account settings form with valida...",
            kind: "other",
        },
        { name: "external_fixture", args: {}, title: "external_fixture", kind: "other" },
    ];
    const events = createReplayEvents(
        "tool-replay",
        fixtures.map((fixture, index) => ({
            type: "message",
            id: `entry-${index}`,
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: `call-${index}`, name: fixture.name, arguments: fixture.args }],
            },
        })),
    );
    assertEquals(
        events
            .filter((event) => event.type === "tool_start")
            .map((event) => ({ title: event.title, kind: event.kind })),
        fixtures.map((fixture) => ({ title: fixture.title, kind: fixture.kind })),
    );
});
