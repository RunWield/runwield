import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { __test, createRunWieldReadToolDefinition } from "../read.js";

initTheme();

/**
 * @param {import('@earendil-works/pi-coding-agent').ToolDefinition<any, any>} tool
 * @param {unknown} params
 * @returns {Promise<{ content: Array<{ type: string, text?: string }>, details?: any, isError?: boolean }>}
 */
async function executeRead(tool, params) {
    const execute =
        /** @type {(id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: object) => Promise<any>} */ (tool
            .execute);
    return await execute("read-call-1", params, new AbortController().signal, () => {}, {});
}

test("read wrapper exposes expected metadata", () => {
    const tool = createRunWieldReadToolDefinition("/tmp");

    assertEquals(tool.name, "read");
    assertEquals(tool.label, "read");
    assertEquals(typeof tool.execute, "function");
    assertStringIncludes(tool.description || "", "Suppresses binary/control-byte text");
});

test("read wrapper still returns binary git index content to the model", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsMkdir(join(dir, ".git"), { recursive: true });
        await fsWriteFile(join(dir, ".git", "index"), new Uint8Array([68, 73, 82, 67, 0, 7, 1, 2]));

        const tool = createRunWieldReadToolDefinition(dir);
        const result = await executeRead(tool, { path: ".git/index" });

        assertEquals(result.isError, undefined);
        assertEquals(result.details?.blocked, undefined);
        assertStringIncludes(result.content[0].text || "", "DIRC");
        assertEquals((result.content[0].text || "").includes("\u0007"), true);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("read wrapper renders binary/control-byte results as header-only output", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsWriteFile(join(dir, "blob.bin"), new Uint8Array([97, 7, 98]));

        const tool = createRunWieldReadToolDefinition(dir);
        const result = await executeRead(tool, { path: "blob.bin" });
        const component = /** @type {Text} */ (tool.renderResult?.(
            /** @type {any} */ (result),
            /** @type {any} */ ({ expanded: true }),
            /** @type {any} */ ({}),
            /** @type {any} */ ({ lastComponent: new Text("stale", 0, 0) }),
        ));

        assertEquals(__test.resultHasBinaryDisplaySuppression(result), true);
        assertEquals(component.render(80), []);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("read wrapper keeps binary display suppression after result serialization", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsWriteFile(join(dir, "archive.zip"), new Uint8Array([80, 75, 3, 4, 20, 0, 0, 0]));

        const tool = createRunWieldReadToolDefinition(dir);
        const result = await executeRead(tool, { path: "archive.zip" });
        const serializedResult = JSON.parse(JSON.stringify(result));
        const component = /** @type {Text} */ (tool.renderResult?.(
            /** @type {any} */ (serializedResult),
            /** @type {any} */ ({ expanded: true }),
            /** @type {any} */ ({}),
            /** @type {any} */ ({ lastComponent: new Text("stale", 0, 0) }),
        ));

        assertEquals(result.content[0].text?.startsWith("PK"), true);
        assertEquals(__test.resultHasBinaryDisplaySuppression(serializedResult), true);
        assertEquals(component.render(80), []);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("read wrapper attaches display images for at-prefixed image paths", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        await fsWriteFile(join(dir, "image.png"), imageBytes);

        const tool = createRunWieldReadToolDefinition(dir);
        const result = await executeRead(tool, { path: "@image.png" });

        assertEquals(result.details?.runwieldDisplayImages, [{ base64: "iVBORw0KGgo=", mimeType: "image/png" }]);
        assertEquals(__test.resultHasBinaryDisplaySuppression(result), false);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("read wrapper exposes image files to the model when upstream returns text only", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        await fsWriteFile(join(dir, "image.png"), imageBytes);

        const tool = createRunWieldReadToolDefinition(dir);
        const result = await executeRead(tool, { path: "@image.png" });

        assertEquals(result.content.some((part) => part.type === "image"), true);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("read wrapper delegates image rendering to terminal capability handling", () => {
    const tool = createRunWieldReadToolDefinition("/tmp");
    const component = /** @type {Text} */ (tool.renderResult?.(
        /** @type {any} */ ({
            content: [
                { type: "text", text: "Read image file [image/png]" },
                { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
        }),
        /** @type {any} */ ({ expanded: true }),
        /** @type {any} */ ({ fg: (/** @type {string} */ _name, /** @type {string} */ text) => text }),
        /** @type {any} */ ({
            lastComponent: new Text("", 0, 0),
            args: { path: "image.png" },
            showImages: false,
        }),
    ));

    const rendered = component.render(80).join("\n");
    assertStringIncludes(rendered, "Read image file [image/png]");
    assertStringIncludes(rendered, "image/png");
});

test("read wrapper allows normal text files to render normally", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "portable-tool-"));
    try {
        await fsWriteFile(join(dir, "README.md"), "# Hello\n\nSafe text.\n");

        const tool = createRunWieldReadToolDefinition(dir);
        const result = await executeRead(tool, { path: "README.md" });
        const component = /** @type {Text} */ (tool.renderResult?.(
            /** @type {any} */ (result),
            /** @type {any} */ ({ expanded: true }),
            /** @type {any} */ ({ fg: (/** @type {string} */ _name, /** @type {string} */ text) => text }),
            /** @type {any} */ ({ lastComponent: new Text("", 0, 0), args: { path: "README.md" } }),
        ));

        assertEquals(result.isError, undefined);
        assertStringIncludes(result.content[0].text || "", "# Hello");
        assertEquals(component.render(80).join("\n").includes("# Hello"), true);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("read wrapper unsafe display detection catches bell, nul, and replacement chars", () => {
    assertEquals(__test.containsUnsafeDisplayText("A\t\n\rB"), false);
    assertEquals(__test.containsUnsafeDisplayText("A\u0007B"), true);
    assertEquals(__test.containsUnsafeDisplayText("A\u0000B"), true);
    assertEquals(__test.containsUnsafeDisplayText("A\ufffdB"), true);
});
