import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { match as assertMatch } from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createMnemotecaTools, type MnemotecaToolHost } from "./tools.ts";
import type { HelperBinaryExecResult } from "../helper-binary-exec.ts";

interface RecordedCall {
    command: string;
    args: string[];
    cwd: string;
}

function setup(
    execImpl: (
        command: string,
        args: string[],
        cwd: string,
    ) => HelperBinaryExecResult | Promise<HelperBinaryExecResult>,
) {
    const calls: RecordedCall[] = [];
    const host: MnemotecaToolHost = {
        cwd: "/tmp/worktrees/project-feature",
        async exec(command, args, options) {
            calls.push({ command, args, cwd: options.cwd });
            return await execImpl(command, args, options.cwd);
        },
    };
    const tools = createMnemotecaTools(host);
    const getTool = (name: string) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`tool not found: ${name}`);
        return tool;
    };
    return { calls, getTool, host, tools };
}

function fakeContext(): ExtensionToolContext {
    return {} as ExtensionToolContext;
}

async function executeText(
    tool: ReturnType<ReturnType<typeof setup>["getTool"]>,
    params: Record<string, string | number | boolean>,
) {
    const result = await tool.execute("call", params, new AbortController().signal, () => undefined, fakeContext());
    return result.content[0]?.type === "text" ? result.content[0].text : "";
}

test("memory tools expose one action-based memory tool", () => {
    const { tools } = setup(() => ({ code: 0, stdout: "", stderr: "" }));

    assertEquals(tools.map((tool) => tool.name), ["memory"]);
});

test("memory recall searches project and global memory with labeled provenance", async () => {
    const { calls, getTool } = setup((command, args) => {
        if (command === "git") return { code: 0, stdout: "/repo/runwield/.git\n", stderr: "" };
        if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
        if (args.includes("--global")) return { code: 0, stdout: "global hit", stderr: "" };
        return { code: 0, stdout: "project hit", stderr: "" };
    });

    const text = await executeText(getTool("memory"), { action: "recall", query: 'he said "hello"' });

    assertEquals(
        text,
        "Project memories (runwield) — these take precedence over global memories:\nproject hit\n\nGlobal memories (cross-project defaults):\nglobal hit",
    );
    assertEquals(calls.map((call) => call.command), ["git", "mnemoteca", "mnemoteca", "mnemoteca"]);
    assertEquals(calls[1]?.args, ["init", "--name", "runwield"]);
    assertEquals(calls[2]?.args, ["search", "--name", "runwield", "--format", "plain", '"he said ""hello"""']);
    assertEquals(calls[3]?.args, ["search", "--global", "--format", "plain", '"he said ""hello"""']);
});

test("memory recall returns one missing binary message", async () => {
    const { getTool } = setup((command) => {
        if (command === "git") return { code: 1, stdout: "", stderr: "" };
        return { code: 127, stdout: "", stderr: "" };
    });

    const text = await executeText(getTool("memory"), { action: "recall", query: "test" });

    assertMatch(text, /mnemoteca binary not found/i);
    assertEquals(text.match(/mnemoteca binary not found/gi)?.length, 1);
});

test("memory recall returns a simple empty result when both scopes are empty", async () => {
    const { getTool } = setup((command) => {
        if (command === "git") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
    });

    assertEquals(await executeText(getTool("memory"), { action: "recall", query: "test" }), "No memories found.");
});

test("memory recall keeps one scope when the other scope fails", async () => {
    const { getTool } = setup((command, args) => {
        if (command === "git") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
        if (args.includes("--global")) return { code: 2, stdout: "", stderr: "global unavailable" };
        return { code: 0, stdout: "project hit", stderr: "" };
    });

    const text = await executeText(getTool("memory"), { action: "recall", query: "test" });

    assertEquals(
        text,
        "Project memories (project-feature) — these take precedence over global memories:\nproject hit\n\nGlobal memory search failed: global unavailable",
    );
});

test("memory stores project and global memories with scope and core tag", async () => {
    const { calls, getTool } = setup((command, args) => {
        if (command === "git") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: args[0] === "add" ? "stored" : "", stderr: "" };
    });

    await executeText(getTool("memory"), { action: "store", content: "Use deno task ci", core: true });
    await executeText(getTool("memory"), {
        action: "store",
        scope: "global",
        content: "Prefer STE",
        core: true,
    });

    assertEquals(calls[2]?.args, ["add", "--name", "project-feature", "--tag", "core", "Use deno task ci"]);
    assertEquals(calls[3]?.args, ["init", "--global"]);
    assertEquals(calls[4]?.args, ["add", "--global", "--tag", "core", "Prefer STE"]);
});

test("memory delete requires a scope", async () => {
    const { calls, getTool } = setup(() => ({ code: 0, stdout: "", stderr: "" }));

    const text = await executeText(getTool("memory"), { action: "delete", id: 42 });

    assertEquals(text, "Error: scope is required for delete.");
    assertEquals(calls, []);
});

test("memory delete refuses ambiguous IDs", async () => {
    const { calls, getTool } = setup((command, args) => {
        if (command === "git") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "list") return { code: 0, stdout: "42 duplicate memory", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
    });

    const text = await executeText(getTool("memory"), { action: "delete", id: 42, scope: "global" });

    assertEquals(text, "Error: id 42 is ambiguous across project and global memory. Refusing delete.");
    assertEquals(calls.some((call) => call.args[0] === "delete"), false);
});

test("memory delete checks the target scope before deleting by id", async () => {
    const { calls, getTool } = setup((command, args) => {
        if (command === "git") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "list" && args.includes("--global")) return { code: 0, stdout: "42 global memory", stderr: "" };
        if (args[0] === "list") return { code: 0, stdout: "7 project memory", stderr: "" };
        return { code: 0, stdout: "   ", stderr: "" };
    });

    const text = await executeText(getTool("memory"), { action: "delete", id: 42, scope: "global" });

    assertEquals(text, "Memory deleted.");
    assertEquals(calls.at(-3)?.args, ["list", "--name", "project-feature", "--format", "plain", "--limit", "100000"]);
    assertEquals(calls.at(-2)?.args, ["list", "--global", "--format", "plain", "--limit", "100000"]);
    assertEquals(calls.at(-1)?.args, ["delete", "42"]);
});

test("memory returns error results for missing required fields", async () => {
    const { getTool } = setup(() => ({ code: 0, stdout: "", stderr: "" }));

    assertEquals(
        await executeText(getTool("memory"), { action: "store" }),
        "Error: content is required for store.",
    );
    assertEquals(await executeText(getTool("memory"), { action: "delete" }), "Error: id is required for delete.");
    assertEquals(await executeText(getTool("memory"), { action: "recall" }), "Error: query is required for recall.");
});
