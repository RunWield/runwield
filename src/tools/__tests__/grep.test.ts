import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { createRunWieldGrepToolDefinition, type RunWieldGrepParams } from "../grep.ts";

type GrepTool = ReturnType<typeof createRunWieldGrepToolDefinition>;
type GrepToolContext = Parameters<GrepTool["execute"]>[4];

interface GrepContentPart {
    type: string;
    text?: string;
}

interface GrepExecutionResult {
    content: GrepContentPart[];
}

async function executeGrep(tool: GrepTool, params: RunWieldGrepParams): Promise<GrepExecutionResult> {
    const execute = tool.execute;
    return await execute(
        "grep-call-1",
        tool.prepareArguments?.(params) as RunWieldGrepParams,
        new AbortController().signal,
        () => {},
        {} as GrepToolContext,
    );
}

test("grep wrapper searches multiple paths passed as one string", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsMkdir(join(dir, "src", "with space", "session"), { recursive: true });
        await fsMkdir(join(dir, "src", "cmd"), { recursive: true });
        await fsWriteFile(
            join(dir, "src", "with space", "session", "chat-session.js"),
            "export function setActiveAgent() {}\n",
        );
        await fsWriteFile(join(dir, "src", "cmd", "agents.js"), "const current = 'setActiveAgent';\n");

        const tool = createRunWieldGrepToolDefinition(dir);
        for (const params of [
            { pattern: "setActiveAgent", path: '"src/with space/session" src/cmd' },
            { pattern: "setActiveAgent", paths: ["src/with space/session", "src/cmd"] },
        ]) {
            const result = await executeGrep(tool, params);
            const text = result.content.map((part) => part.text || "").join("");

            assertStringIncludes(text, "src/with space/session/chat-session.js:1:");
            assertStringIncludes(text, "src/cmd/agents.js:1:");
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("grep wrapper searches a path glob mixed with a normal path", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsMkdir(join(dir, "docs", "plans"), { recursive: true });
        await fsMkdir(join(dir, "src"), { recursive: true });
        await fsWriteFile(join(dir, "docs", "plans", "feature-one.md"), "finalize this slice\n");
        await fsWriteFile(join(dir, "docs", "plans", "project.md"), "finalize the project\n");
        await fsWriteFile(join(dir, "src", "workflow.js"), "const step = 'finalize';\n");

        const tool = createRunWieldGrepToolDefinition(dir);
        const result = await executeGrep(tool, {
            pattern: "finaliz",
            path: "'docs/plans/feature*.md' src",
        });
        const text = result.content.map((part) => part.text || "").join("");

        assertStringIncludes(text, "docs/plans/feature-one.md:1:");
        assertStringIncludes(text, "src/workflow.js:1:");
        assertEquals(text.includes("docs/plans/project.md"), false);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("grep wrapper preserves path prefix for a single path glob", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsMkdir(join(dir, "docs", "plans"), { recursive: true });
        await fsWriteFile(join(dir, "docs", "plans", "feature-two.md"), "finalize this slice\n");

        const tool = createRunWieldGrepToolDefinition(dir);
        const result = await executeGrep(tool, {
            pattern: "finaliz",
            path: "docs/plans/feature*.md",
        });
        const text = result.content.map((part) => part.text || "").join("");

        assertStringIncludes(text, "docs/plans/feature-two.md:1:");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
