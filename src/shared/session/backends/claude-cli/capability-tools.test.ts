import { writeRuntimeExecutableFixture } from "../../../../testing/runtime-executable-fixture.ts";
import { delimiter } from "node:path";
import { getCwd } from "../../../../constants.js";
import process from "node:process";
import { mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertArrayIncludes } from "../../../../testing/assertions.ts";
import { match as assertMatch } from "node:assert/strict";
import { join } from "node:path";
import { CLAUDE_CLI_CAPABILITY_TOOL_NAMES, createClaudeCliCapabilityTools } from "./capability-tools.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { withProcessGlobalTestLock } from "../../../../testing/process-global-lock.ts";

async function writeExecutable(path: string, content: string): Promise<void> {
    const source = `${path}.ts`;
    await fsWriteFile(source, content);
    await writeRuntimeExecutableFixture(path, source);
}

function getTool(tools: ReturnType<typeof createClaudeCliCapabilityTools>, name: string) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

function fakeContext(): ExtensionToolContext {
    return {} as ExtensionToolContext;
}

async function executeText(tool: ReturnType<typeof getTool>, params: Record<string, string | boolean>) {
    const result = await tool.execute("call", params, new AbortController().signal, () => undefined, fakeContext());
    return result.content[0]?.type === "text" ? result.content[0].text : "";
}

test("Claude CLI capability factory returns the canonical capability tool names", () => {
    const tools = createClaudeCliCapabilityTools({ cwd: getCwd() });

    assertEquals(
        tools.map((tool) => tool.name),
        [...CLAUDE_CLI_CAPABILITY_TOOL_NAMES],
    );
});

test("Claude CLI capability tools execute PATH helper binaries", () =>
    withProcessGlobalTestLock(async () => {
        const tempDir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const oldPath = process.env["PATH"] || "";
        try {
            await writeExecutable(join(tempDir, "git"), 'console.log("/repo/runwield/.git");');
            await writeExecutable(
                join(tempDir, "mnemoteca"),
                'console.log(process.argv[2] === "search" ? "memory-hit" : "ok");',
            );
            await writeExecutable(join(tempDir, "cymbal"), 'console.log("cymbal:" + process.argv.slice(2).join(" "));');
            await writeExecutable(
                join(tempDir, "ketch"),
                'console.log(JSON.stringify([{title: "Web", url: "https://example.test"}]));',
            );
            process.env["PATH"] = `${tempDir}${delimiter}${oldPath}`;
            const tools = createClaudeCliCapabilityTools({ cwd: tempDir });

            const memoryText = await executeText(getTool(tools, "memory"), { action: "recall", query: "test" });
            const codeText = await executeText(getTool(tools, "code_search"), { query: "Thing" });
            const webText = await executeText(getTool(tools, "web_search"), { query: "current docs" });

            assertEquals(
                memoryText,
                "Project memories (runwield) — these take precedence over global memories:\nmemory-hit\n\nGlobal memories (cross-project defaults):\nmemory-hit",
            );
            assertEquals(codeText, "cymbal:--no-federate search Thing");
            assertEquals(webText, "Web - https://example.test");
        } finally {
            process.env["PATH"] = oldPath;
            await fsRm(tempDir, { recursive: true });
        }
    }));

test("Claude CLI memory capability reports missing mnemoteca binary", () =>
    withProcessGlobalTestLock(async () => {
        const tempDir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const oldPath = process.env["PATH"] || "";
        try {
            await writeExecutable(join(tempDir, "git"), "process.exit(1);");
            await writeExecutable(join(tempDir, "cymbal"), 'console.log("ok");');
            process.env["PATH"] = tempDir;
            const tools = createClaudeCliCapabilityTools({ cwd: tempDir });

            const text = await executeText(getTool(tools, "memory"), { action: "recall", query: "test" });

            assertMatch(text, /mnemoteca binary not found/i);
        } finally {
            process.env["PATH"] = oldPath;
            await fsRm(tempDir, { recursive: true });
        }
    }));

test("Claude CLI capability list includes memory, code, and web families", () => {
    assertArrayIncludes(
        [...CLAUDE_CLI_CAPABILITY_TOOL_NAMES],
        ["memory", "code_investigate", "web_search", "web_fetch", "web_code_search", "web_docs_search"],
    );
});
