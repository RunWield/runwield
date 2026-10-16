import { test } from "node:test";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createCymbalTools, type CymbalToolHost, MAX_CODE_BATCH_OUTPUT_CHARS } from "./tools.ts";
import type { HelperBinaryExecResult } from "../helper-binary-exec.ts";

interface RecordedCall {
    command: string;
    args: string[];
    cwd: string;
}

interface ToolResultStatus {
    isError?: boolean;
}

function toolFailed(result: Awaited<ReturnType<typeof executeTool>>): boolean {
    return (result as ToolResultStatus).isError === true;
}

function setup(
    execImpl: (
        command: string,
        args: string[],
        cwd: string,
    ) => HelperBinaryExecResult | Promise<HelperBinaryExecResult>,
) {
    const calls: RecordedCall[] = [];
    const host: CymbalToolHost = {
        cwd: "/repo/runwield",
        async exec(command, args, options) {
            calls.push({ command, args, cwd: options.cwd });
            return await execImpl(command, args, options.cwd);
        },
    };
    const tools = createCymbalTools(host);
    const getTool = (name: string) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`tool not found: ${name}`);
        return tool;
    };
    return { calls, getTool };
}

function fakeContext(): ExtensionToolContext {
    return {} as ExtensionToolContext;
}

async function executeTool(
    tool: ReturnType<ReturnType<typeof setup>["getTool"]>,
    params: Record<string, string | boolean | { op: string; target?: string; file?: string }[]>,
) {
    return await tool.execute("call", params, new AbortController().signal, () => undefined, fakeContext());
}

function firstText(result: Awaited<ReturnType<typeof executeTool>>): string {
    return result.content[0]?.type === "text" ? result.content[0].text : "";
}

test("every Cymbal invocation starts with no-federate", async () => {
    const { calls, getTool } = setup(() => ({ code: 0, stdout: "ok", stderr: "" }));

    await executeTool(getTool("code_search"), { query: "Session", textSearch: true });
    await executeTool(getTool("code_structure"), {});
    await executeTool(getTool("code_show"), { target: "file.ts" });

    for (const call of calls) {
        assertEquals(call.command, "cymbal");
        assertEquals(call.args[0], "--no-federate");
    }
    assertEquals(calls[0]?.args, ["--no-federate", "search", "--text", "Session"]);
});

test("Cymbal failures strip Usage tail and return text", async () => {
    const { getTool } = setup(() => ({ code: 2, stdout: "", stderr: "bad args\nUsage: cymbal ..." }));

    const result = await executeTool(getTool("code_refs"), { symbol: "Thing" });

    assertEquals(firstText(result), "Error (exit 2): bad args");
    assertEquals(toolFailed(result), true);
});

test("empty Cymbal output returns no results text", async () => {
    const { getTool } = setup(() => ({ code: 0, stdout: "", stderr: "" }));

    const result = await executeTool(getTool("code_outline"), { file: "src/a.ts" });

    assertEquals(firstText(result), "No results found.");
    assertEquals(toolFailed(result), false);
});

test("code_batch validates operations and limits batch size", async () => {
    const { getTool } = setup(() => ({ code: 0, stdout: "ok", stderr: "" }));
    const tool = getTool("code_batch");

    const tooMany = await executeTool(tool, {
        operations: [
            { op: "show", target: "a" },
            { op: "show", target: "b" },
            { op: "show", target: "c" },
            { op: "show", target: "d" },
            { op: "show", target: "e" },
            { op: "show", target: "f" },
        ],
    });
    const malformed = await executeTool(tool, { operations: [{ op: "show" }] });

    assertEquals((tooMany as { isError?: boolean }).isError, true);
    assertMatch(firstText(tooMany), /at most 5/);
    assertEquals((malformed as { isError?: boolean }).isError, true);
    assertMatch(firstText(malformed), /target must be/);
});

test("code_batch limits a large first result without hiding later results", async () => {
    const longText = "x".repeat(MAX_CODE_BATCH_OUTPUT_CHARS + 10);
    const { getTool } = setup((_command, args) => ({
        code: 0,
        stdout: args.includes("big") ? longText : "small",
        stderr: "",
    }));

    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "big" }, { op: "outline", file: "small.ts" }],
    });
    const text = firstText(result);

    assert(text.startsWith("## 1. show big"));
    assertMatch(text, /Result truncated/);
    assertMatch(text, /## 2\. outline small.ts\nStatus: success\n\nsmall/);
    assert(text.length <= MAX_CODE_BATCH_OUTPUT_CHARS);
    assertEquals(result.details, {
        operationCount: 2,
        truncated: true,
        results: [
            { operation: { op: "show", target: "big" }, status: "success", truncated: true },
            { operation: { op: "outline", file: "small.ts" }, status: "success", truncated: false },
        ],
    });
    assertEquals(toolFailed(result), false);
});

test("code_batch groups interleaved reads into one native call per kind and restores order", async () => {
    const { calls, getTool } = setup((_command, args) => ({
        code: 0,
        stdout: JSON.stringify({
            version: "0.1",
            results: args.includes("show")
                ? {
                    Missing: { error: "symbol not found: Missing" },
                    Beta: { file: "/repo/b.ts", lines: [{ line: 4, content: "export function Beta() {}" }] },
                    Alpha: { file: "/repo/a.ts", lines: [{ line: 1, content: "export function Alpha() {}" }] },
                }
                : {
                    "b.ts": null,
                    "a.ts": [{ name: "Alpha", kind: "function", start_line: 1, end_line: 3, depth: 0 }],
                },
        }),
        stderr: "",
    }));
    const result = await executeTool(getTool("code_batch"), {
        operations: [
            { op: "show", target: "Alpha" },
            { op: "outline", file: "a.ts" },
            { op: "show", target: "Beta" },
            { op: "outline", file: "b.ts" },
            { op: "show", target: "Missing" },
        ],
    });

    assertEquals(calls.map((call) => call.args), [
        ["--no-federate", "--json", "show", "--", "Alpha", "Beta", "Missing"],
        ["--no-federate", "--json", "outline", "--", "a.ts", "b.ts"],
    ]);
    const sections = firstText(result).split("\n\n---\n\n");
    assertEquals(sections.length, 5);
    assertMatch(sections[0], /## 1\. show Alpha\nStatus: success\n\nfile: \/repo\/a.ts\n1: export function Alpha/);
    assertMatch(sections[1], /## 2\. outline a.ts\nStatus: success\n\nfunction Alpha \(L1-3\)/);
    assertMatch(sections[2], /## 3\. show Beta\nStatus: success\n\nfile: \/repo\/b.ts\n4: export function Beta/);
    assertMatch(sections[3], /## 4\. outline b.ts\nStatus: success\n\nNo results found\./);
    assertMatch(sections[4], /## 5\. show Missing\nStatus: error\n\nError: symbol not found: Missing/);
    assertEquals(toolFailed(result), false);
    assertEquals(result.details, {
        operationCount: 5,
        truncated: false,
        results: [
            { operation: { op: "show", target: "Alpha" }, status: "success", truncated: false },
            { operation: { op: "outline", file: "a.ts" }, status: "success", truncated: false },
            { operation: { op: "show", target: "Beta" }, status: "success", truncated: false },
            { operation: { op: "outline", file: "b.ts" }, status: "success", truncated: false },
            { operation: { op: "show", target: "Missing" }, status: "error", truncated: false },
        ],
    });
});

test("code_batch reads duplicate targets once while retaining every requested section", async () => {
    const { calls, getTool } = setup(() => ({ code: 0, stdout: "function Alpha() {}", stderr: "" }));
    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "Alpha" }, { op: "show", target: "Alpha" }],
    });
    assertEquals(calls.map((call) => call.args), [["--no-federate", "show", "Alpha"]]);
    assertMatch(firstText(result), /## 1\. show Alpha/);
    assertMatch(firstText(result), /## 2\. show Alpha/);
    assertEquals(result.details, {
        operationCount: 2,
        truncated: false,
        results: [
            { operation: { op: "show", target: "Alpha" }, status: "success", truncated: false },
            { operation: { op: "show", target: "Alpha" }, status: "success", truncated: false },
        ],
    });
});

test("code_batch keeps ambiguous symbol alternatives visible", async () => {
    const { getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify({
            results: {
                Alpha: {
                    file: "/repo/a.ts",
                    lines: [{ line: 1, content: "function Alpha() {}" }],
                    match_count: 2,
                    also: [{
                        name: "Alpha",
                        kind: "function",
                        file: "/repo/b.ts",
                        rel_path: "b.ts",
                        start_line: 5,
                        end_line: 7,
                    }],
                },
                Beta: { error: "symbol not found: Beta" },
            },
        }),
        stderr: "",
    }));
    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "Alpha" }, { op: "show", target: "Beta" }],
    });
    assertMatch(firstText(result), /2 matching definitions/);
    assertMatch(firstText(result), /Also: b.ts:5/);
});

test("code_batch isolates invalid and missing result entries", async () => {
    const { getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify({
            results: {
                Good: { file: "good.ts", lines: [{ line: 1, content: "function Good() {}" }] },
                Bad: { file: "bad.ts", lines: [{ line: 1, content: null }] },
            },
        }),
        stderr: "",
    }));
    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "Bad" }, { op: "show", target: "Absent" }, { op: "show", target: "Good" }],
    });
    const sections = firstText(result).split("\n\n---\n\n");
    assertMatch(sections[0], /invalid result for this target/);
    assertMatch(sections[1], /omitted this target/);
    assertMatch(sections[2], /function Good\(\)/);
});

test("code_batch reports invalid JSON or command failures without per-target retries", async () => {
    for (
        const response of [
            { code: 0, stdout: "not JSON", stderr: "" },
            { code: 0, stdout: "null", stderr: "" },
            { code: 2, stdout: "", stderr: "index unavailable\nUsage: cymbal show" },
        ]
    ) {
        const { calls, getTool } = setup(() => response);
        const result = await executeTool(getTool("code_batch"), {
            operations: [{ op: "show", target: "Alpha" }, { op: "show", target: "Beta" }],
        });
        assertEquals(calls.length, 1);
        assertEquals(toolFailed(result), true);
        const sections = firstText(result).split("\n\n---\n\n");
        for (const section of sections) {
            assertMatch(section, response.code === 0 ? /invalid batch JSON/ : /Error \(exit 2\): index unavailable/);
        }
    }
});

test("code_batch bounds every result including large errors and preserves the final item", async () => {
    const { getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify({
            results: {
                Large: { file: "large.ts", lines: [{ line: 1, content: "x".repeat(60_000) }] },
                Bad: { error: "Failure ".repeat(10_000) },
                Last: { file: "last.ts", lines: [{ line: 1, content: "final result" }] },
            },
        }),
        stderr: "",
    }));
    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "Large" }, { op: "show", target: "Bad" }, { op: "show", target: "Last" }],
    });
    const text = firstText(result);
    assert(text.length <= MAX_CODE_BATCH_OUTPUT_CHARS);
    const sections = text.split("\n\n---\n\n");
    assertEquals(sections.length, 3);
    assertMatch(sections[0], /Status: success[\s\S]*Result truncated/);
    assertMatch(sections[1], /Status: error[\s\S]*Result truncated/);
    assertMatch(sections[2], /Status: success[\s\S]*final result/);
    assertEquals(toolFailed(result), false);
});

test("code_batch marks all native target failures as a failed tool call", async () => {
    const { getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify({ results: { A: { error: "missing A" }, B: { error: "missing B" } } }),
        stderr: "",
    }));
    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "A" }, { op: "show", target: "B" }],
    });
    assertEquals(toolFailed(result), true);
    assertEquals(firstText(result).match(/Status: error/g)?.length, 2);
});

test("code_batch marks a failed single target as a failed tool call", async () => {
    const { getTool } = setup(() => ({ code: 1, stdout: "", stderr: "missing A" }));
    const result = await executeTool(getTool("code_batch"), { operations: [{ op: "show", target: "A" }] });
    assertEquals(toolFailed(result), true);
    assertMatch(firstText(result), /Status: error/);
});

test("successful source beginning with Error is not mistaken for a tool failure", async () => {
    const { getTool } = setup(() => ({ code: 0, stdout: "Error is a source identifier", stderr: "" }));
    assertEquals(toolFailed(await executeTool(getTool("code_show"), { target: "A" })), false);
    const result = await executeTool(getTool("code_batch"), { operations: [{ op: "show", target: "A" }] });
    assertEquals(toolFailed(result), false);
    assertMatch(firstText(result), /Status: success/);
});

test("Cymbal process exceptions mark tool calls as failed", async () => {
    const { getTool } = setup(() => {
        throw new Error("missing executable");
    });
    const result = await executeTool(getTool("code_show"), { target: "A" });
    assertEquals(toolFailed(result), true);
    assertMatch(firstText(result), /missing executable/);
});

test("code_batch stops before the next group after cancellation", async () => {
    const controller = new AbortController();
    const { calls, getTool } = setup(() => {
        controller.abort(new Error("Cancelled batch"));
        return { code: 0, stdout: "", stderr: "" };
    });
    await assertRejects(
        () =>
            getTool("code_batch").execute(
                "call",
                {
                    operations: [{ op: "show", target: "Alpha" }, { op: "outline", file: "a.ts" }],
                },
                controller.signal,
                () => undefined,
                fakeContext(),
            ),
        Error,
        "Cancelled batch",
    );
    assertEquals(calls.length, 1);
});
