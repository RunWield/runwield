import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { describeRuntimeTool } from "./tool-event-title.js";

test("Runtime provides one stable tool descriptor for live, replay, TUI, ACP, and future consumers", () => {
    assertEquals(describeRuntimeTool("bash", { command: "git status" }), {
        toolName: "bash",
        title: "$ git status",
        kind: "execute",
    });
    assertEquals(
        describeRuntimeTool("manage_task", { Action: "status", TaskId: "task-1" }).title,
        "manage_task status task-1",
    );
    assertEquals(describeRuntimeTool("run_command", { CommandLine: "git status" }), {
        toolName: "run_command",
        title: "run_command git status",
        kind: "execute",
    });
    assertEquals(
        describeRuntimeTool("view_file", { AbsolutePath: "/project/README.md" }).title,
        "view_file /project/README.md",
    );
    assertEquals(describeRuntimeTool("write_to_file", { TargetFile: "/project/new.txt" }), {
        toolName: "write_to_file",
        title: "write_to_file /project/new.txt",
        kind: "edit",
    });
    assertEquals(
        describeRuntimeTool("replace_file_content", { TargetFile: "/project/README.md" }).title,
        "replace_file_content /project/README.md",
    );
    assertEquals(describeRuntimeTool("read", { path: "README.md" }), {
        toolName: "read",
        title: "read README.md",
        kind: "read",
    });
    assertEquals(describeRuntimeTool("write_docs", { path: "docs/report.md" }), {
        toolName: "write_docs",
        title: "write_docs docs/report.md",
        kind: "edit",
    });
    assertEquals(describeRuntimeTool("edit_docs", { path: "docs/report.md" }), {
        toolName: "edit_docs",
        title: "edit_docs docs/report.md",
        kind: "edit",
    });
    assertEquals(describeRuntimeTool("grep", { pattern: "SessionRuntime", path: ["src", "tests"] }), {
        toolName: "grep",
        title: "grep SessionRuntime in src tests",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("plan_written", { planName: "runtime-boundary.md" }), {
        toolName: "plan_written",
        title: "plan_written docs/plans/runtime-boundary.md",
        kind: "other",
    });
    assertEquals(
        describeRuntimeTool("pair_checkpoint", {
            summary: "Rendered the responsive account settings form with validation states and diagnostics",
        }),
        {
            toolName: "pair_checkpoint",
            title: "pair_checkpoint Rendered the responsive account settings form with valida...",
            kind: "other",
        },
    );
    assertEquals(describeRuntimeTool("memory", { action: "recall", query: "docs style" }), {
        toolName: "memory",
        title: "memory - recall: docs style",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("memory", { action: "store", content: "Keep docs concise" }), {
        toolName: "memory",
        title: "memory - store: Keep docs concise",
        kind: "edit",
    });
    assertEquals(describeRuntimeTool("memory", { action: "delete", id: 42 }), {
        toolName: "memory",
        title: "memory - delete: id: 42",
        kind: "delete",
    });
    assertEquals(describeRuntimeTool("memory_store", { content: "Historical transcript memory" }), {
        toolName: "memory_store",
        title: "memory_store Historical transcript memory",
        kind: "other",
    });
    assertEquals(describeRuntimeTool("memory_recall_global", { query: "Historical transcript query" }), {
        toolName: "memory_recall_global",
        title: "memory_recall_global Historical transcript query",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("work_record_search", { query: "prior auth work" }), {
        toolName: "work_record_search",
        title: "work_record_search prior auth work",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("web_search", { query: "current Deno docs" }), {
        toolName: "web_search",
        title: "web_search current Deno docs",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("web_code_search", { query: "Deno.Command", lang: "ts" }), {
        toolName: "web_code_search",
        title: "web_code_search Deno.Command",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("web_docs_search", { query: "useEffect cleanup", library: "react" }), {
        toolName: "web_docs_search",
        title: "web_docs_search react useEffect cleanup",
        kind: "search",
    });
    assertEquals(describeRuntimeTool("web_fetch", { url: "https://deno.com/manual" }), {
        toolName: "web_fetch",
        title: "web_fetch https://deno.com/manual",
        kind: "fetch",
    });
    assertEquals(describeRuntimeTool("work_record_read", { recordId: "11111111-1111-4111-8111-111111111111" }), {
        toolName: "work_record_read",
        title: "work_record_read 11111111-1111-4111-8111-111111111111",
        kind: "read",
    });
    assertEquals(describeRuntimeTool("set_session_name", { name: "Name Here" }), {
        toolName: "set_session_name",
        title: "set_session_name Name Here",
        kind: "other",
    });
    assertEquals(describeRuntimeTool("delegate_agent", { mode: "write", brief: "Repair the execution worktree" }), {
        toolName: "delegate_agent",
        title: "delegate_agent write: Repair the execution worktree",
        kind: "think",
    });
});
