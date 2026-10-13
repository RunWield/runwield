import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { match as assertMatch, strictEqual as assertStrictEquals } from "node:assert/strict";
import { join } from "node:path";
import { createMultiFileEditTool } from "../multi_file_edit.ts";

/**
 * @param {import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>} tool
 * @param {unknown} params
 * @returns {Promise<{ content: Array<{ type: string, text?: string }>, details?: { diff?: string, firstChangedLine?: number }, isError?: boolean }>}
 */
async function executeMultiFileEdit(tool, params) {
    const execute =
        /** @type {(id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: object) => Promise<any>} */ (tool
            .execute);
    return await execute("multi-file-edit-call-1", params, new AbortController().signal, () => {}, {});
}

test("multi_file_edit exposes distinct multi-file schema", () => {
    const tool = createMultiFileEditTool("/tmp");

    assertEquals(tool.name, "multi_file_edit");
    assertEquals(tool.label, "multi_file_edit");
    assertMatch(tool.description, /one or more files/i);

    const properties = /** @type {{ properties: Record<string, any> }} */ (tool.parameters).properties;
    assertEquals(Object.keys(properties), ["root", "edits"]);
    assertEquals(properties.edits.minItems, 1);

    const editProperties = properties.edits.items.properties;
    assertEquals(Object.keys(editProperties), ["path", "oldText", "newText"]);
});

test("multi_file_edit applies replacements across multiple files", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    const firstPath = join(dir, "first.txt");
    const secondPath = join(dir, "second.txt");
    await fsWriteFile(firstPath, "alpha\nbeta\ngamma\n");
    await fsWriteFile(secondPath, "one\ntwo\nthree\n");

    const tool = createMultiFileEditTool(dir);
    const result = await executeMultiFileEdit(tool, {
        edits: [
            { path: "first.txt", oldText: "beta", newText: "BETA" },
            { path: "second.txt", oldText: "two", newText: "TWO" },
        ],
    });

    const text = result.content.map((c) => c.text || "").join("");
    assertMatch(text, /2 replacements across 2 files/i);
    assertEquals(result.isError, undefined);
    assertEquals(await fsReadFile(firstPath, "utf8"), "alpha\nBETA\ngamma\n");
    assertEquals(await fsReadFile(secondPath, "utf8"), "one\nTWO\nthree\n");

    await fsRm(dir, { recursive: true });
});

test("multi_file_edit applies same-file replacements against original content", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    const filePath = join(dir, "same-file.txt");
    await fsWriteFile(filePath, "first\nsecond\nthird\n");

    const tool = createMultiFileEditTool(dir);
    const result = await executeMultiFileEdit(tool, {
        edits: [
            { path: "same-file.txt", oldText: "first", newText: "FIRST" },
            { path: "same-file.txt", oldText: "third", newText: "THIRD" },
        ],
    });

    const text = result.content.map((c) => c.text || "").join("");
    assertMatch(text, /2 replacements across 1 file/i);
    assertEquals(await fsReadFile(filePath, "utf8"), "FIRST\nsecond\nTHIRD\n");

    await fsRm(dir, { recursive: true });
});

test("multi_file_edit accepts legacy single-file multi-replace shape", () => {
    const tool = createMultiFileEditTool("/tmp");
    const prepared = tool.prepareArguments?.({
        path: "legacy.txt",
        edits: [
            { oldText: "a", newText: "A" },
            { oldText: "b", newText: "B" },
        ],
    });

    assertEquals(prepared, {
        edits: [
            { path: "legacy.txt", oldText: "a", newText: "A" },
            { path: "legacy.txt", oldText: "b", newText: "B" },
        ],
    });
});

test("multi_file_edit prepareArguments leaves malformed calls for schema validation", () => {
    const tool = createMultiFileEditTool("/tmp");

    const nonRecordInput = "not an edit request";
    assertStrictEquals(tool.prepareArguments?.(nonRecordInput), nonRecordInput);

    const unrecognizedInput = { foo: "bar" };
    assertStrictEquals(tool.prepareArguments?.(unrecognizedInput), unrecognizedInput);

    const malformedPrepared = tool.prepareArguments?.({
        path: "legacy.txt",
        edits: [{ oldText: "a" }],
    });
    assertEquals(malformedPrepared?.edits[0].path, "legacy.txt");
    assertEquals(malformedPrepared?.edits[0].oldText, "a");
    assertStrictEquals(malformedPrepared?.edits[0].newText, undefined);
});
