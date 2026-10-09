import { assert, assertArrayIncludes, assertEquals, assertStringIncludes } from "@std/assert";
import cymbalExtension from "./index.ts";

/**
 * @param {(command: string, args: string[], opts: { cwd: string }) => Promise<{code: number, stdout: string, stderr: string}> | {code: number, stdout: string, stderr: string}} execImpl
 */
function setup(execImpl) {
    /** @type {Map<string, (event: any, ctx: any) => any>} */
    const handlers = new Map();
    /** @type {Array<any>} */
    const tools = [];
    /** @type {Array<{command: string, args: string[], opts: { cwd: string }}>} */
    const calls = [];

    const pi = /** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({
        on(event, handler) {
            handlers.set(event, handler);
        },
        registerTool(tool) {
            tools.push(tool);
        },
        async exec(
            /** @type {string} */ command,
            /** @type {string[]} */ args,
            /** @type {{ cwd: string }} */ opts,
        ) {
            calls.push({ command, args, opts });
            return await execImpl(command, args, opts);
        },
    });

    cymbalExtension(pi);

    /** @param {string} name */
    const getTool = (name) => {
        const tool = tools.find((registeredTool) => registeredTool.name === name);
        if (!tool) throw new Error(`Tool not found in test setup: ${name}`);
        return tool;
    };

    /** @param {string} event */
    const getHandler = (event) => {
        return handlers.get(event);
    };

    return { handlers, tools, calls, getTool, getHandler };
}

/**
 * @param {{ execute: unknown }} tool
 * @param {object} params
 */
async function executeTool(tool, params) {
    const execute =
        /** @type {(id: string, params: object, signal: AbortSignal, onUpdate: () => void, context: object) => Promise<{ content: Array<{ type: string, text?: string }>, details: unknown, isError?: boolean }>} */ (tool
            .execute);
    return await execute("tool-call-1", params, new AbortController().signal, () => {}, {});
}

/**
 * @param {{ content: Array<{ type: string, text?: string }> }} result
 */
function firstText(result) {
    const first = result.content[0];
    assertEquals(first?.type, "text");
    if (!first || first.type !== "text") throw new Error("Expected text content.");
    return first.text ?? "";
}

Deno.test("cymbal extension registers all tools", () => {
    const { tools } = setup(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));

    const names = tools.map((tool) => tool.name);
    assertArrayIncludes(names, [
        "code_search",
        "code_show",
        "code_outline",
        "code_batch",
        "code_refs",
        "code_impact",
        "code_trace",
        "code_investigate",
        "code_structure",
        "code_impls",
        "code_importers",
    ]);

    for (const tool of tools) {
        assertEquals(typeof tool.label, "string");
        assertEquals(typeof tool.description, "string");
        assertEquals(typeof tool.parameters, "object");
        assertEquals(typeof tool.execute, "function");
    }
});

Deno.test("code_search tool executes correctly", async () => {
    const { getTool, calls } = setup(() => Promise.resolve({ code: 0, stdout: "search result", stderr: "" }));
    const tool = getTool("code_search");

    const params = { query: "AuthHandler" };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "search result");

    const call = calls.at(-1);
    assertEquals(call?.command, "cymbal");
    assertEquals(call?.args, ["--no-federate", "search", "AuthHandler"]);
});

Deno.test("cymbal tools disable sibling worktree federation", async () => {
    const { getTool } = setup((_command, args) => {
        if (args[0] !== "--no-federate") {
            return Promise.resolve({
                code: 1,
                stdout: "",
                stderr:
                    "cymbal: skipped 2 unindexed sibling worktree(s); run `cymbal index .` inside each to include them.",
            });
        }
        return Promise.resolve({ code: 0, stdout: "indexed current worktree", stderr: "" });
    });

    assertEquals(
        firstText(await executeTool(getTool("code_search"), { query: "AuthHandler" })),
        "indexed current worktree",
    );
});

Deno.test("cymbal tools map public params to cymbal commands", async () => {
    const { getTool, calls, getHandler } = setup((_command, args) => {
        return Promise.resolve({ code: 0, stdout: `${args.join(" ")} output`, stderr: "" });
    });

    getHandler("session_start")?.({}, { cwd: "/project" });

    const cases = [
        {
            name: "code_search",
            params: { query: "AuthHandler", textSearch: true },
            args: ["--no-federate", "search", "--text", "AuthHandler"],
        },
        { name: "code_structure", params: {}, args: ["--no-federate", "structure"] },
        { name: "code_impls", params: { symbol: "Session" }, args: ["--no-federate", "impls", "Session"] },
        { name: "code_importers", params: { target: "./mod.js" }, args: ["--no-federate", "importers", "./mod.js"] },
        { name: "code_show", params: { target: "src/mod.js:1-5" }, args: ["--no-federate", "show", "src/mod.js:1-5"] },
        { name: "code_outline", params: { file: "src/mod.js" }, args: ["--no-federate", "outline", "src/mod.js"] },
        { name: "code_refs", params: { symbol: "run" }, args: ["--no-federate", "refs", "run"] },
        { name: "code_impact", params: { symbol: "run" }, args: ["--no-federate", "impact", "run"] },
        { name: "code_trace", params: { symbol: "run" }, args: ["--no-federate", "trace", "run"] },
        { name: "code_investigate", params: { symbol: "run" }, args: ["--no-federate", "investigate", "run"] },
    ];

    for (const item of cases) {
        const result = await executeTool(getTool(item.name), item.params);
        assertEquals(result.details, item.params);
        assertEquals(firstText(result), `${item.args.join(" ")} output`);
    }

    assertEquals(
        calls.map((call) => ({ args: call.args, cwd: call.opts.cwd })),
        cases.map((item) => ({ args: item.args, cwd: "/project" })),
    );
});

Deno.test("code_batch runs show and outline operations in order", async () => {
    const { getTool, calls, getHandler } = setup((_command, args) => {
        return Promise.resolve({ code: 0, stdout: `${args.join(" ")} output`, stderr: "" });
    });

    getHandler("session_start")?.({}, { cwd: "/project" });
    const result = await executeTool(getTool("code_batch"), {
        operations: [
            { op: "show", target: "buildAgentSession" },
            { op: "outline", file: "src/extensions/cymbal/index.js" },
        ],
    });

    assertEquals(result.details, {
        operationCount: 2,
        truncated: false,
        results: [
            { operation: { op: "show", target: "buildAgentSession" }, status: "success", truncated: false },
            {
                operation: { op: "outline", file: "src/extensions/cymbal/index.js" },
                status: "success",
                truncated: false,
            },
        ],
    });
    assertStringIncludes(firstText(result), "## 1. show buildAgentSession");
    assertStringIncludes(firstText(result), "show buildAgentSession output");
    assertStringIncludes(firstText(result), "## 2. outline src/extensions/cymbal/index.js");
    assertStringIncludes(firstText(result), "outline src/extensions/cymbal/index.js output");
    assertEquals(
        calls.map((call) => ({ args: call.args, cwd: call.opts.cwd })),
        [
            { args: ["--no-federate", "show", "buildAgentSession"], cwd: "/project" },
            { args: ["--no-federate", "outline", "src/extensions/cymbal/index.js"], cwd: "/project" },
        ],
    );
});

Deno.test("code_batch isolates per-operation errors and normalizes empty output", async () => {
    const { getTool } = setup((_command, args) => {
        if (args[1] === "show") {
            return Promise.resolve({ code: 2, stdout: "", stderr: "bad target\nUsage: cymbal show" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    const result = await executeTool(getTool("code_batch"), {
        operations: [
            { op: "show", target: "Missing" },
            { op: "outline", file: "src/empty.js" },
        ],
    });

    assertEquals(result.isError, false);
    assertEquals(result.details, {
        operationCount: 2,
        truncated: false,
        results: [
            { operation: { op: "show", target: "Missing" }, status: "error", truncated: false },
            { operation: { op: "outline", file: "src/empty.js" }, status: "success", truncated: false },
        ],
    });
    const text = firstText(result);
    assertStringIncludes(text, "## 1. show Missing");
    assertStringIncludes(text, "Error (exit 2): bad target");
    assertStringIncludes(text, "## 2. outline src/empty.js");
    assertStringIncludes(text, "No results found.");
});

Deno.test("code_batch validates operation count", async () => {
    const { getTool, calls } = setup(() => Promise.resolve({ code: 0, stdout: "unused", stderr: "" }));

    const result = await executeTool(getTool("code_batch"), {
        operations: [
            { op: "show", target: "a" },
            { op: "show", target: "b" },
            { op: "show", target: "c" },
            { op: "show", target: "d" },
            { op: "show", target: "e" },
            { op: "show", target: "f" },
        ],
    });

    assert(result.isError);
    assertStringIncludes(firstText(result), "at most 5 operations");
    assertEquals(calls.length, 0);
});

Deno.test("code_batch truncates large combined output", async () => {
    const { getTool } = setup(() => Promise.resolve({ code: 0, stdout: "x".repeat(60_000), stderr: "" }));

    const result = await executeTool(getTool("code_batch"), {
        operations: [{ op: "show", target: "Huge" }],
    });

    assertEquals(result.details, {
        operationCount: 1,
        truncated: true,
        results: [{ operation: { op: "show", target: "Huge" }, status: "success", truncated: true }],
    });
    const text = firstText(result);
    assert(text.length <= 50_000);
    assertStringIncludes(text, "[Result truncated.");
});

Deno.test("cymbal tools normalize empty, non-zero, and thrown command results", async () => {
    const emptySetup = setup(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));
    assertEquals(firstText(await executeTool(emptySetup.getTool("code_structure"), {})), "No results found.");

    const failingSetup = setup(() =>
        Promise.resolve({
            code: 2,
            stdout: "",
            stderr: "bad query\nUsage: cymbal search",
        })
    );
    assertEquals(
        firstText(await executeTool(failingSetup.getTool("code_refs"), { symbol: "Bad" })),
        "Error (exit 2): bad query",
    );

    const thrownSetup = setup(() => {
        throw new Error("missing binary");
    });
    assertEquals(
        firstText(await executeTool(thrownSetup.getTool("code_show"), { target: "src/mod.js" })),
        "Error running cymbal: missing binary",
    );
});

Deno.test("cymbal result hook forwards failed calls to Pi and consumes the status once", async () => {
    const { getTool, getHandler } = setup(() => ({ code: 1, stdout: "", stderr: "missing symbol" }));
    const result = await executeTool(getTool("code_show"), { target: "Missing" });
    assertEquals(result.isError, true);
    const event = {
        toolName: "code_show",
        toolCallId: "tool-call-1",
        input: { target: "Missing" },
        content: result.content,
        details: result.details,
        isError: false,
    };
    const handler = getHandler("tool_result");
    assert(handler);
    assertEquals(await handler(event, {}), { isError: true });
    assertEquals(await handler(event, {}), undefined);
});

Deno.test("cymbal result hook distinguishes total batch failure from partial success", async () => {
    for (const partial of [false, true]) {
        const { getTool, getHandler } = setup(() => ({
            code: 0,
            stdout: JSON.stringify({
                results: {
                    A: { error: "missing A" },
                    B: partial ? { file: "b.ts", lines: [] } : { error: "missing B" },
                },
            }),
            stderr: "",
        }));
        const result = await executeTool(getTool("code_batch"), {
            operations: [{ op: "show", target: "A" }, { op: "show", target: "B" }],
        });
        const handler = getHandler("tool_result");
        assert(handler);
        assertEquals(
            await handler({ toolCallId: "tool-call-1", toolName: "code_batch", isError: false }, {}),
            partial ? undefined : { isError: true },
        );
        assertEquals(result.isError, !partial);
    }
});

Deno.test("cymbal nudge correctly intercepts bash and grep", async () => {
    const { getHandler, calls } = setup((_command, args) => {
        if (args.includes("nudge")) {
            return Promise.resolve({ code: 0, stdout: "", stderr: "Consider using cymbal search instead" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });

    const handler = getHandler("tool_result");
    if (!handler) throw new Error("tool_result handler not registered");

    // Test intercepting grep
    const grepEvent = {
        toolName: "grep",
        input: { pattern: "auth system", path: "src" },
        content: [{ type: "text", text: "original output" }],
    };

    const result = await handler(grepEvent, {});
    assertEquals(calls.at(-1)?.args, [
        "--no-federate",
        "hook",
        "nudge",
        "--format=text",
        "--",
        'grep "auth system" src',
    ]);

    // Nudge should be appended
    assertEquals(result.content.length, 2);
    assertEquals(result.content[0].text, "original output");
    assertStringIncludes(result.content[1].text, "Consider using cymbal search instead");
});

Deno.test("cymbal nudge handles bash commands, array paths, and ignored events", async () => {
    const { getHandler, calls } = setup((_command, args) => {
        if (args.includes("no-output")) {
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "Try `cymbal refs`" });
    });
    const handler = getHandler("tool_result");
    if (!handler) throw new Error("tool_result handler not registered");

    const bashResult = await handler({
        toolName: "bash",
        input: { command: "rg Session src" },
        content: [{ type: "text", text: "rg output" }],
    }, {});

    assertEquals(calls.at(-1)?.args, ["--no-federate", "hook", "nudge", "--format=text", "--", "rg Session src"]);
    assertEquals(bashResult.content.at(-1)?.text, "\n\nTry `cymbal refs`");

    await handler({
        toolName: "grep",
        input: { pattern: "Session", path: ["src", "tests"] },
        content: [],
    }, {});
    assertEquals(calls.at(-1)?.args, [
        "--no-federate",
        "hook",
        "nudge",
        "--format=text",
        "--",
        'grep "Session" src tests',
    ]);

    const ignored = await handler({
        toolName: "read",
        input: {},
        content: [{ type: "text", text: "unchanged" }],
    }, {});
    assertEquals(ignored, undefined);

    const noOutput = await handler({
        toolName: "bash",
        input: { command: "no-output" },
        content: [{ type: "text", text: "same" }],
    }, {});
    assertEquals(noOutput, undefined);
});
