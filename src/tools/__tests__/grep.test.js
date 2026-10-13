import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { __test, createRunWieldGrepToolDefinition } from "../grep.js";

/**
 * @param {import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>} tool
 * @param {unknown} params
 * @returns {Promise<{ content: Array<{ type: string, text?: string }>, details?: any }>}
 */
async function executeGrep(tool, params) {
    const execute =
        /** @type {(id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: object) => Promise<any>} */ (tool
            .execute);
    return await execute("grep-call-1", params, new AbortController().signal, () => {}, {});
}

test("grep wrapper exposes expected metadata and prepares paths alias", () => {
    const tool = createRunWieldGrepToolDefinition("/tmp");

    assertEquals(tool.name, "grep");
    assertEquals(tool.label, "grep");
    assertEquals(typeof tool.execute, "function");
    assertEquals(tool.prepareArguments?.({ pattern: "needle", paths: ["src", "tests"] }), {
        pattern: "needle",
        paths: ["src", "tests"],
        path: ["src", "tests"],
    });
});

test("grep wrapper splits shell-shaped paths while preserving quotes", () => {
    assertEquals(__test.splitShellLike("src/shared/session src/cmd"), ["src/shared/session", "src/cmd"]);
    assertEquals(__test.splitShellLike('"src/with space" src/cmd'), ["src/with space", "src/cmd"]);
    assertEquals(__test.splitShellLike("'docs/plans/feature*.md' src"), ["docs/plans/feature*.md", "src"]);
});

test("grep wrapper searches multiple paths passed as one string", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsMkdir(join(dir, "src", "shared", "session"), { recursive: true });
        await fsMkdir(join(dir, "src", "cmd"), { recursive: true });
        await fsWriteFile(
            join(dir, "src", "shared", "session", "chat-session.js"),
            "export function setActiveAgent() {}\n",
        );
        await fsWriteFile(
            join(dir, "src", "cmd", "agents.js"),
            "const current = 'setActiveAgent';\n",
        );

        const tool = createRunWieldGrepToolDefinition(dir);
        const result = await executeGrep(tool, {
            pattern: "setActiveAgent",
            path: "src/shared/session src/cmd",
        });
        const text = result.content.map((part) => part.text || "").join("");

        assertStringIncludes(text, "src/shared/session/chat-session.js:1:");
        assertStringIncludes(text, "src/cmd/agents.js:1:");
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
            path: "docs/plans/feature*.md src",
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
