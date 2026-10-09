import { assertArrayIncludes, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { CLAUDE_CLI_CAPABILITY_TOOL_NAMES, createClaudeCliCapabilityTools } from "./capability-tools.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { withProcessGlobalTestLock } from "../../../../testing/process-global-lock.ts";

async function writeExecutable(path: string, content: string): Promise<void> {
    await Deno.writeTextFile(path, content, { mode: 0o755 });
    await Deno.chmod(path, 0o755);
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

Deno.test("Claude CLI capability factory returns the canonical capability tool names", () => {
    const tools = createClaudeCliCapabilityTools({ cwd: Deno.cwd() });

    assertEquals(tools.map((tool) => tool.name), [...CLAUDE_CLI_CAPABILITY_TOOL_NAMES]);
});

Deno.test("Claude CLI capability tools execute PATH helper binaries", () =>
    withProcessGlobalTestLock(async () => {
        const tempDir = await Deno.makeTempDir();
        const oldPath = Deno.env.get("PATH") || "";
        try {
            await writeExecutable(join(tempDir, "git"), "#!/bin/sh\necho /repo/runwield/.git\n");
            await writeExecutable(
                join(tempDir, "mnemoteca"),
                '#!/bin/sh\nif [ "$1" = search ]; then echo memory-hit; else echo ok; fi\n',
            );
            await writeExecutable(join(tempDir, "cymbal"), "#!/bin/sh\necho cymbal:$*\n");
            await writeExecutable(
                join(tempDir, "ketch"),
                '#!/bin/sh\necho \'[{"title":"Web","url":"https://example.test"}]\'\n',
            );
            Deno.env.set("PATH", `${tempDir}:${oldPath}`);
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
            Deno.env.set("PATH", oldPath);
            await Deno.remove(tempDir, { recursive: true });
        }
    }));

Deno.test("Claude CLI memory capability reports missing mnemoteca binary", () =>
    withProcessGlobalTestLock(async () => {
        const tempDir = await Deno.makeTempDir();
        const oldPath = Deno.env.get("PATH") || "";
        try {
            await writeExecutable(join(tempDir, "git"), "#!/bin/sh\nexit 1\n");
            await writeExecutable(join(tempDir, "cymbal"), "#!/bin/sh\necho ok\n");
            Deno.env.set("PATH", tempDir);
            const tools = createClaudeCliCapabilityTools({ cwd: tempDir });

            const text = await executeText(getTool(tools, "memory"), { action: "recall", query: "test" });

            assertMatch(text, /mnemoteca binary not found/i);
        } finally {
            Deno.env.set("PATH", oldPath);
            await Deno.remove(tempDir, { recursive: true });
        }
    }));

Deno.test("Claude CLI capability list includes memory, code, and web families", () => {
    assertArrayIncludes([...CLAUDE_CLI_CAPABILITY_TOOL_NAMES], [
        "memory",
        "code_investigate",
        "web_search",
        "web_fetch",
        "web_code_search",
        "web_docs_search",
    ]);
});
