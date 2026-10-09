import {
    chmod as fsChmod,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { match as assertMatch, doesNotMatch as assertNotMatch, fail } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { createSingleEditToolDefinition } from "../edit.js";

/**
 * Helper to execute the edit tool with typed parameters.
 *
 * @param {import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>} tool
 * @param {unknown} params
 * @returns {Promise<{ content: Array<{ type: string, text?: string }>, details?: { diff?: string, firstChangedLine?: number } }>}
 */
async function executeEdit(tool, params) {
    const execute =
        /** @type {(id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: object) => Promise<any>} */ (
            tool.execute
        );
    return await execute("edit-call-1", params, new AbortController().signal, () => {}, {});
}

test("createSingleEditToolDefinition exposes expected metadata", () => {
    const tool = createSingleEditToolDefinition("/tmp");
    assertEquals(tool.name, "edit");
    assertEquals(tool.label, "edit");
    assertMatch(tool.description, /single file/i);
    assertEquals(typeof tool.execute, "function");
    assertEquals(typeof tool.parameters, "object");

    const properties = /** @type {{ properties: Record<string, unknown> }} */ (tool.parameters).properties;
    assertEquals(Object.keys(properties), ["path", "oldText", "newText"]);
});

test("edit: normal successful edit", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const filePath = join(dir, "test.txt");
    const originalContent = "Hello world\nFoo bar\nBaz qux\n";
    await fsWriteFile(filePath, originalContent);

    const tool = createSingleEditToolDefinition(dir);
    const result = await executeEdit(tool, {
        path: "test.txt",
        oldText: "Foo bar",
        newText: "Foo baz",
    });

    const text = result.content.map((c) => c.text || "").join("");
    assertMatch(text, /successfully replaced/i);
    assertMatch(text, /1 block/i);

    // Verify file was actually modified
    const afterContent = await fsReadFile(filePath, "utf8");
    assertEquals(afterContent, "Hello world\nFoo baz\nBaz qux\n");

    await fsRm(dir, { recursive: true });
});

test("edit: propagates permission errors without file contents", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const filePath = join(dir, "readonly.txt");
    const originalContent = "Line 1: alpha\nLine 2: beta\nLine 3: gamma\nLine 4: delta\n";
    await fsWriteFile(filePath, originalContent);

    // Make file read-only
    const stat = await fsStat(filePath);
    if (stat.mode !== null) {
        await fsChmod(filePath, 0o444);
    }

    try {
        const tool = createSingleEditToolDefinition(dir);
        const error = await assertRejects(
            () =>
                executeEdit(tool, {
                    path: filePath,
                    oldText: "Line 2: beta",
                    newText: "Line 2: replaced",
                }),
            Error,
        );
        assertMatch(error.message, /permission denied|EACCES|EPERM/i);
        assertNotMatch(error.message, /Line 1: alpha|Line 4: delta|File exists on disk/);
        assertEquals(await fsReadFile(filePath, "utf8"), originalContent);
    } finally {
        await fsChmod(filePath, 0o644);
        await fsRm(dir, { recursive: true });
    }
});

test("edit: failed match in a large file does not dump source", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const filePath = join(dir, "large.txt");

    // Create a file with well over 1000 lines
    const lines = [];
    for (let i = 1; i <= 1500; i++) {
        lines.push(`Line ${i}: content data here`);
    }
    const originalContent = lines.join("\n");
    await fsWriteFile(filePath, originalContent);

    try {
        const tool = createSingleEditToolDefinition(dir);
        const error = await assertRejects(
            () =>
                executeEdit(tool, {
                    path: filePath,
                    oldText: "This text is absent from the file",
                    newText: "replacement",
                }),
            Error,
        );
        assertMatch(error.message, /not find|not found|match/i);
        assertNotMatch(error.message, /content data here|Showing first|File exists on disk/);
        assertEquals(await fsReadFile(filePath, "utf8"), originalContent);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("edit: propagates error when file does not exist", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const tool = createSingleEditToolDefinition(dir);

    try {
        await executeEdit(tool, {
            path: "nonexistent-file.txt",
            oldText: "anything",
            newText: "replacement",
        });
        fail("Expected an error but edit succeeded");
    } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        const ok =
            msg.includes("could not edit file") ||
            msg.includes("cannot") ||
            msg.includes("not found") ||
            msg.includes("no such file");
        if (!ok) {
            throw new Error(`Unexpected error message: ${msg}`);
        }
    }

    await fsRm(dir, { recursive: true });
});

test("edit: rejects an empty path", async () => {
    const tool = createSingleEditToolDefinition("/tmp");

    try {
        await executeEdit(tool, {
            path: "",
            oldText: "a",
            newText: "b",
        });
        fail("Expected an error but edit succeeded");
    } catch {
        // Expected — error was thrown
    }
});

test("edit: works with relative path", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const filePath = join(dir, "relative-test.txt");
    const originalContent = "First line\nSecond line\nThird line\n";
    await fsWriteFile(filePath, originalContent);

    const tool = createSingleEditToolDefinition(dir);
    const result = await executeEdit(tool, {
        path: "relative-test.txt",
        oldText: "Second line",
        newText: "Second line (edited)",
    });

    const text = result.content.map((c) => c.text || "").join("");
    assertMatch(text, /successfully replaced/i);

    await fsRm(dir, { recursive: true });
});

test("edit: accepts legacy single-entry edits array", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const filePath = join(dir, "legacy-test.txt");
    await fsWriteFile(filePath, "First line\nSecond line\n");

    const tool = createSingleEditToolDefinition(dir);
    const prepared = tool.prepareArguments?.({
        path: "legacy-test.txt",
        edits: [{ oldText: "Second line", newText: "Updated line" }],
    });

    assertEquals(prepared, {
        path: "legacy-test.txt",
        oldText: "Second line",
        newText: "Updated line",
    });

    const result = await executeEdit(tool, prepared);
    const text = result.content.map((c) => c.text || "").join("");
    assertMatch(text, /successfully replaced/i);
    assertEquals(await fsReadFile(filePath, "utf8"), "First line\nUpdated line\n");

    await fsRm(dir, { recursive: true });
});
