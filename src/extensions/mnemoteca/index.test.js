import { assertArrayIncludes, assertEquals, assertMatch } from "@std/assert";
import { basename } from "@std/path";
import mnemotecaExtension from "./index.ts";

/**
 * @param {(command: string, args: string[], opts: { cwd: string }) => Promise<{code: number, stdout: string, stderr: string}> | {code: number, stdout: string, stderr: string}} execImpl
 */
function setup(execImpl) {
    /** @type {Map<string, (event: object, ctx: object) => unknown>} */
    const handlers = new Map();
    /** @type {Array<any>} */
    const tools = [];
    /** @type {Array<{command: string, args: string[], opts: { cwd: string }}>} */
    const calls = [];

    const pi = /** @type {import('@earendil-works/pi-coding-agent').ExtensionAPI} */ ({
        on(event, handler) {
            handlers.set(event, /** @type {(event: object, ctx: object) => unknown} */ (handler));
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

    mnemotecaExtension(pi);

    /** @param {string} name */
    const getTool = (name) => {
        const tool = tools.find((registeredTool) => registeredTool.name === name);
        if (!tool) throw new Error(`Tool not found in test setup: ${name}`);
        return tool;
    };

    return { handlers, tools, calls, getTool };
}

/**
 * @param {{ execute: unknown }} tool
 * @param {object} params
 */
async function executeTool(tool, params) {
    const execute =
        /** @type {(id: string, params: object, signal: AbortSignal, onUpdate: () => void, context: object) => Promise<{ content: Array<{ type: string, text?: string }>, details: unknown, callMessage?: string }>} */ (tool
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

Deno.test("mnemoteca extension registers one action-based memory tool", () => {
    const { tools } = setup(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));

    const names = tools.map((tool) => tool.name);
    assertEquals(names, ["memory"]);

    for (const tool of tools) {
        assertEquals(typeof tool.label, "string");
        assertEquals(typeof tool.description, "string");
        assertEquals(typeof tool.parameters, "object");
        assertEquals(typeof tool.execute, "function");
    }
});

Deno.test("memory recall searches both scopes and escapes quotes", async () => {
    const { getTool, calls } = setup((_command, args) => {
        if (args[0] === "init") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        if (args.includes("--global")) return Promise.resolve({ code: 0, stdout: "global hit", stderr: "" });
        return Promise.resolve({ code: 0, stdout: "  found memory  \n", stderr: "" });
    });
    const tool = getTool("memory");

    const params = { action: "recall", query: 'he said "hello"' };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(
        firstText(result),
        `Project memories (${
            basename(Deno.cwd())
        }) — these take precedence over global memories:\nfound memory\n\nGlobal memories (cross-project defaults):\nglobal hit`,
    );
    assertArrayIncludes(calls.map((call) => call.args.join(" ")), [
        ["search", "--name", basename(Deno.cwd()), "--format", "plain", '"he said ""hello"""'].join(" "),
        ["search", "--global", "--format", "plain", '"he said ""hello"""'].join(" "),
    ]);
});

Deno.test("memory recall returns one missing binary message when mnemoteca is unavailable", async () => {
    const { getTool } = setup(() => Promise.resolve({ code: 127, stdout: "", stderr: "" }));
    const tool = getTool("memory");

    const result = await executeTool(tool, { action: "recall", query: "test" });

    assertMatch(firstText(result), /mnemoteca binary not found/i);
    assertMatch(firstText(result), /RunWield installer/i);
    assertEquals(firstText(result).match(/mnemoteca binary not found/gi)?.length, 1);
});

Deno.test("memory stores project memory with optional core tag", async () => {
    const { getTool, calls } = setup(() => Promise.resolve({ code: 0, stdout: "stored", stderr: "" }));
    const tool = getTool("memory");

    const params = { action: "store", content: "Use deno task ci", core: true };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "stored");
    assertEquals(result.callMessage, "Storing project memory:\n\nUse deno task ci");
    assertEquals(calls.at(-1)?.args, [
        "add",
        "--name",
        basename(Deno.cwd()),
        "--tag",
        "core",
        "Use deno task ci",
    ]);
});

Deno.test("memory initializes global storage then adds memory", async () => {
    const { getTool, calls } = setup(() => Promise.resolve({ code: 0, stdout: "ok", stderr: "" }));
    const tool = getTool("memory");

    const params = { action: "store", scope: "global", content: "Prefer concise commit messages", core: true };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "ok");
    assertEquals(result.callMessage, "Storing global memory:\n\nPrefer concise commit messages");
    assertEquals(calls[0]?.args, ["init", "--global"]);
    assertEquals(calls[1]?.args, [
        "add",
        "--global",
        "--tag",
        "core",
        "Prefer concise commit messages",
    ]);
});

Deno.test("memory delete checks the requested scope before deleting by id", async () => {
    const { getTool, calls } = setup((_command, args) => {
        if (args[0] === "init") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        if (args[0] === "list" && args.includes("--global")) {
            return Promise.resolve({ code: 0, stdout: "42 global memory", stderr: "" });
        }
        if (args[0] === "list") return Promise.resolve({ code: 0, stdout: "7 project memory", stderr: "" });
        return Promise.resolve({ code: 0, stdout: "   ", stderr: "" });
    });
    const tool = getTool("memory");

    const params = { action: "delete", id: 42, scope: "global" };
    const result = await executeTool(tool, params);

    assertEquals(result.details, params);
    assertEquals(firstText(result), "Memory deleted.");
    assertEquals(calls.at(-1)?.args, ["delete", "42"]);
});
