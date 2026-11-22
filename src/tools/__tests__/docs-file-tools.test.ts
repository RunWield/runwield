import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { match as assertMatch, doesNotMatch as assertNotMatch } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { createWriteToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { toolRegistry } from "@runwield/tools";
import { createEditDocsToolDefinition, createWriteDocsToolDefinition } from "../docs-file-tools.ts";
import { createSingleEditToolDefinition } from "../edit.ts";

type DocsTool = ReturnType<typeof createWriteDocsToolDefinition | typeof createEditDocsToolDefinition>;

interface FixtureDocsParams {
    path: string;
    content?: string;
    oldText?: string;
    newText?: string;
}

interface FixtureContentPart extends Partial<Omit<TextContent, "type">> {
    type?: string;
}

interface FixtureDocsResult {
    content?: FixtureContentPart[];
    isError?: boolean;
}

type FixtureExecute = (
    id: string,
    params: FixtureDocsParams,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: ExtensionToolContext,
) => Promise<FixtureDocsResult>;

async function executeTool(tool: DocsTool, params: FixtureDocsParams, context: Partial<ExtensionToolContext> = {}) {
    const execute = tool.execute as FixtureExecute;
    return await execute(
        "docs-tool-call-1",
        params,
        new AbortController().signal,
        () => {},
        context as ExtensionToolContext,
    );
}

function toolText(result: FixtureDocsResult) {
    const typed = result;
    return (typed.content || []).map((item) => item.text || "").join("\n");
}

test("write_docs uses the registry definition with a Pi-compatible schema", () => {
    const definition = toolRegistry.get("write_docs").definition;
    const tool = createWriteDocsToolDefinition("/tmp");

    assertEquals(definition.parameters, createWriteToolDefinition("/tmp").parameters);
    assertEquals(tool.parameters, definition.parameters);
    assertEquals(tool.description, definition.description);
    assertEquals(tool.promptSnippet, definition.promptSnippet);
    assertEquals(tool.promptGuidelines, definition.promptGuidelines);
});

test("edit_docs shares the registry's single-replacement schema and preserves legacy argument preparation", () => {
    const definition = toolRegistry.get("edit_docs").definition;
    const tool = createEditDocsToolDefinition("/tmp");

    assertEquals(tool.parameters, definition.parameters);
    assertEquals(createSingleEditToolDefinition("/tmp").parameters, definition.parameters);
    assertEquals(tool.description, definition.description);
    assertEquals(tool.promptSnippet, definition.promptSnippet);
    assertEquals(tool.promptGuidelines, definition.promptGuidelines);
    assertEquals(tool.prepareArguments?.({ file_path: "guide.md", edits: [{ oldText: "old", newText: "new" }] }), {
        path: "guide.md",
        oldText: "old",
        newText: "new",
    });
});

test("Markdown adapters forward the active tool context to Pi", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const fallback = join(dir, "fallback");
        const context = { cwd: join(dir, "active") };
        await executeTool(createWriteDocsToolDefinition(fallback), { path: "guide.md", content: "# Old\n" }, context);
        await executeTool(
            createEditDocsToolDefinition(fallback),
            { path: "guide.md", oldText: "Old", newText: "New" },
            context,
        );
        assertEquals(await fsReadFile(join(context.cwd, "guide.md"), "utf8"), "# New\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("edit_docs reports a failed match without dumping the document", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const filePath = join(dir, "guide.md");
        const originalContent = "# Guide\n\nUnrelated document contents.\n";
        await fsWriteFile(filePath, originalContent);
        const tool = createEditDocsToolDefinition(dir);
        const error = await assertRejects(
            () =>
                executeTool(tool, {
                    path: "guide.md",
                    oldText: "Absent section",
                    newText: "Replacement section",
                }),
            Error,
        );
        assertMatch(error.message, /not find|not found|match/i);
        assertNotMatch(error.message, /Unrelated document contents|File exists on disk/);
        assertEquals(await fsReadFile(filePath, "utf8"), originalContent);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("write_docs creates and overwrites relative Markdown files, including parent directories", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const tool = createWriteDocsToolDefinition(dir);
        const first = await executeTool(tool, {
            path: "docs/walkthrough.md",
            content: "# Walkthrough\n\nFirst version.\n",
        });
        assertMatch(toolText(first), /Successfully wrote/);
        assertEquals(
            await fsReadFile(join(dir, "docs", "walkthrough.md"), "utf8"),
            "# Walkthrough\n\nFirst version.\n",
        );

        const second = await executeTool(tool, {
            path: "docs/walkthrough.md",
            content: "# Walkthrough\n\nSecond version.\n",
        });
        assertMatch(toolText(second), /Successfully wrote/);
        assertEquals(
            await fsReadFile(join(dir, "docs", "walkthrough.md"), "utf8"),
            "# Walkthrough\n\nSecond version.\n",
        );
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("write_docs accepts absolute .md paths and case-insensitive .MD suffix", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const absolutePath = join(dir, "ABSOLUTE.MD");
        const tool = createWriteDocsToolDefinition("/tmp");
        const result = await executeTool(tool, {
            path: absolutePath,
            content: "# Absolute\n",
        });
        assertMatch(toolText(result), /Successfully wrote/);
        assertEquals(await fsReadFile(absolutePath, "utf8"), "# Absolute\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("edit_docs replaces one exact block in Markdown", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const filePath = join(dir, "guide.md");
        await fsWriteFile(filePath, "# Guide\n\nOld section.\n");
        const tool = createEditDocsToolDefinition(dir);
        const result = await executeTool(tool, {
            path: "guide.md",
            oldText: "Old section.",
            newText: "New section.",
        });
        assertMatch(toolText(result), /Successfully replaced/);
        assertEquals(await fsReadFile(filePath, "utf8"), "# Guide\n\nNew section.\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("edit_docs accepts absolute Markdown paths", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const filePath = join(dir, "absolute.md");
        await fsWriteFile(filePath, "alpha\nbeta\n");
        const tool = createEditDocsToolDefinition("/tmp");
        const result = await executeTool(tool, {
            path: filePath,
            oldText: "beta",
            newText: "gamma",
        });
        assertMatch(toolText(result), /Successfully replaced/);
        assertEquals(await fsReadFile(filePath, "utf8"), "alpha\ngamma\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("write_docs rejects non-.md suffixes before creating files", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const tool = createWriteDocsToolDefinition(dir);
        for (const path of ["report.txt", "report.markdown", "report.mdx", "report"]) {
            const result = await executeTool(tool, { path, content: "should not write" });
            assertEquals(result.isError, true);
            assertMatch(toolText(result), /only Markdown \.md files/i);
            let exists = true;
            try {
                await fsStat(join(dir, path));
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") exists = false;
                else throw error;
            }
            assertEquals(exists, false, `${path} should not be created`);
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("edit_docs rejects non-.md suffixes before changing files", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        const filePath = join(dir, "notes.txt");
        await fsWriteFile(filePath, "alpha\n");
        const tool = createEditDocsToolDefinition(dir);
        const result = await executeTool(tool, {
            path: "notes.txt",
            oldText: "alpha",
            newText: "beta",
        });
        assertEquals(result.isError, true);
        assertMatch(toolText(result), /only Markdown \.md files/i);
        assertEquals(await fsReadFile(filePath, "utf8"), "alpha\n");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
