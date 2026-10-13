import { test } from "node:test";
import { match as assertMatch } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createKetchTools, type KetchToolHost, MAX_WEB_FETCH_CHARS } from "./tools.ts";
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
    const host: KetchToolHost = {
        cwd: "/repo/runwield",
        async exec(command, args, options) {
            calls.push({ command, args, cwd: options.cwd });
            return await execImpl(command, args, options.cwd);
        },
    };
    const tools = createKetchTools(host);
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
    params: Record<string, string | number | boolean>,
) {
    return await tool.execute("call", params, new AbortController().signal, () => undefined, fakeContext());
}

function firstText(result: Awaited<ReturnType<typeof executeTool>>): string {
    return result.content[0]?.type === "text" ? result.content[0].text : "";
}

test("web_search builds pinned search arguments and formats title URL rows", async () => {
    const { calls, getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify([{ title: "RunWield", url: "https://example.test/runwield" }]),
        stderr: "",
    }));

    const result = await executeTool(getTool("web_search"), { query: "runwield", limit: 2 });

    assertEquals(calls[0], {
        command: "ketch",
        args: ["search", "-b", "keenable", "--json", "--limit", "2", "runwield"],
        cwd: "/repo/runwield",
    });
    assertEquals(firstText(result), "RunWield - https://example.test/runwield");
});

test("web_search can fuse page content and truncate it", async () => {
    const longContent = "x".repeat(60);
    const { calls, getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify([{ title: "Doc", url: "https://example.test/doc", content: longContent }]),
        stderr: "",
    }));

    const result = await executeTool(getTool("web_search"), {
        query: "docs",
        scrape: true,
        maxChars: 25,
        backend: "brave",
    });

    assertEquals(calls[0]?.args, [
        "search",
        "-b",
        "brave",
        "--json",
        "--scrape",
        "--max-chars",
        "25",
        "docs",
    ]);
    assertMatch(firstText(result), /web_search output truncated at 25 characters/);
});

test("web_fetch scrapes one URL and truncates Markdown", async () => {
    const { calls, getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify({ url: "https://example.test", title: "Example", markdown: "abcdef" }),
        stderr: "",
    }));

    const result = await executeTool(getTool("web_fetch"), { url: "https://example.test", maxChars: 3 });

    assertEquals(calls[0]?.args, ["scrape", "https://example.test", "--json"]);
    assertStringIncludes(firstText(result), "abc");
    assertMatch(firstText(result), /web_fetch output truncated at 3 characters/);
});

test("web_code_search builds pinned code arguments and formats code rows", async () => {
    const { calls, getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify([{
            repo: "owner/repo",
            path: "src/main.ts",
            line: 12,
            snippet: "const value = 1;",
            url: "https://github.com/owner/repo/blob/main/src/main.ts#L12",
            source: "grepapp",
        }]),
        stderr: "",
    }));

    const result = await executeTool(getTool("web_code_search"), {
        query: "const value",
        limit: 1,
        lang: "typescript",
        regex: true,
    });

    assertEquals(calls[0]?.args, [
        "code",
        "-b",
        "grepapp",
        "--json",
        "--limit",
        "1",
        "--lang",
        "typescript",
        "--regex",
        "const value",
    ]);
    assertStringIncludes(firstText(result), "owner/repo src/main.ts line 12");
    assertStringIncludes(firstText(result), "https://github.com/owner/repo/blob/main/src/main.ts#L12");
});

test("web_docs_search formats docs rows and returns setup guidance on missing Context7 key", async () => {
    const { calls, getTool } = setup((_command, args) => {
        if (args.includes("needs-key")) {
            return {
                code: 5,
                stdout: "",
                stderr: "Error: context7: API key not set (get one then: ketch config set context7_api_key <key>)",
            };
        }
        return {
            code: 0,
            stdout: JSON.stringify([{ library: "deno", title: "KV", snippet: "Deno KV stores values." }]),
            stderr: "",
        };
    });

    const success = await executeTool(getTool("web_docs_search"), {
        query: "deno kv",
        library: "deno",
        tokens: 1000,
    });
    const missingKey = await executeTool(getTool("web_docs_search"), { query: "needs-key" });

    assertEquals(calls[0]?.args, [
        "docs",
        "-b",
        "context7",
        "--json",
        "--library",
        "deno",
        "--tokens",
        "1000",
        "deno kv",
    ]);
    assertStringIncludes(firstText(success), "Deno KV stores values.");
    assertStringIncludes(firstText(missingKey), "ketch config set context7_api_key");
});

test("empty JSON arrays return no results and unknown JSON shapes return raw text", async () => {
    const { getTool } = setup((_command, args) => ({
        code: 0,
        stdout: args[0] === "code" ? JSON.stringify({ unexpected: true }) : "[]",
        stderr: "",
    }));

    assertEquals(firstText(await executeTool(getTool("web_search"), { query: "nothing" })), "No results found.");
    assertEquals(firstText(await executeTool(getTool("web_code_search"), { query: "raw" })), '{"unexpected":true}');
});

test("non-key failures include exit code, cleaned ketch message, and alternate backends", async () => {
    const { getTool } = setup(() => ({
        code: 4,
        stdout: "",
        stderr: "grep.app returned status 504\nUsage: ketch code ...",
    }));

    const result = await executeTool(getTool("web_code_search"), { query: "Session" });

    assertEquals(
        firstText(result),
        "Error (exit 4): grep.app returned status 504 Alternate backends accepted by backend: sourcegraph, github.",
    );
});

test("web_fetch default ceiling uses explicit truncation marker", async () => {
    const { getTool } = setup(() => ({
        code: 0,
        stdout: JSON.stringify({ markdown: "x".repeat(MAX_WEB_FETCH_CHARS + 1) }),
        stderr: "",
    }));

    const result = await executeTool(getTool("web_fetch"), { url: "https://example.test" });

    assertMatch(firstText(result), /web_fetch output truncated at 50000 characters/);
});
