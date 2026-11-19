import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { match as assertMatch, throws as assertThrows } from "node:assert/strict";
import { join } from "node:path";
import { createMultiFileEditTool, type MultiFileEditParams } from "../multi_file_edit.ts";

type MultiFileEditTool = ReturnType<typeof createMultiFileEditTool>;

type MultiFileEditContext = Parameters<MultiFileEditTool["execute"]>[4];
type NativeExecutionResult = Awaited<ReturnType<MultiFileEditTool["execute"]>>;

interface MultiFileEditExecutionResult extends NativeExecutionResult {
    isError?: boolean;
}

interface ToolContentProjection {
    type: string;
    text?: string;
}

async function executeMultiFileEdit(
    tool: MultiFileEditTool,
    params: MultiFileEditParams,
): Promise<MultiFileEditExecutionResult> {
    validateToolArguments(tool, {
        type: "toolCall",
        id: "multi-file-edit-call-1",
        name: tool.name,
        arguments: { ...params, edits: params.edits.map((edit) => ({ ...edit })) },
    });
    const execute = tool.execute;
    return await execute(
        "multi-file-edit-call-1",
        params,
        new AbortController().signal,
        () => {},
        {} as MultiFileEditContext,
    );
}

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

    const text = result.content.map((c: ToolContentProjection) => c.text || "").join("");
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

    const text = result.content.map((c: ToolContentProjection) => c.text || "").join("");
    assertMatch(text, /2 replacements across 1 file/i);
    assertEquals(await fsReadFile(filePath, "utf8"), "FIRST\nsecond\nTHIRD\n");

    await fsRm(dir, { recursive: true });
});

test("multi_file_edit applies legacy edits and rejects incomplete edits without changing the file", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        const filePath = join(dir, "legacy.txt");
        await fsWriteFile(filePath, "a\nb\n");
        const tool = createMultiFileEditTool(dir);
        const prepared = tool.prepareArguments?.({
            path: "legacy.txt",
            edits: [
                { oldText: "a", newText: "A" },
                { oldText: "b", newText: "B" },
            ],
        }) as MultiFileEditParams;
        await executeMultiFileEdit(tool, prepared);
        assertEquals(await fsReadFile(filePath, "utf8"), "A\nB\n");
        for (const input of [{ foo: "bar" }, { edits: [] }, { path: "legacy.txt", edits: [{ oldText: "A" }] }]) {
            const args = tool.prepareArguments?.(input) as JsonObject;
            assertThrows(
                () =>
                    validateToolArguments(tool, {
                        type: "toolCall",
                        id: "bad-edit",
                        name: tool.name,
                        arguments: args,
                    }),
                /Validation failed/,
            );
            assertEquals(await fsReadFile(filePath, "utf8"), "A\nB\n");
        }
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
