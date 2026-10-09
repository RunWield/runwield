import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { readWorkspaceStyles } from "./workspace-styles.ts";

test("Workspace stylesheet sections stay small and retain their import order", async () => {
    const entryUrl = new URL("./static/workspace.css", import.meta.url);
    const entry = await fsReadFile(entryUrl, "utf8");
    const paths = [...entry.matchAll(/@import "([^"]+)";/g)].map((match) => match[1]);
    assert(paths.length > 1);
    assert(entry.trimEnd().split("\n").length < 1000);
    const bundled = await readWorkspaceStyles(entryUrl);
    assertEquals(bundled.includes("@import"), false);
    let offset = 0;
    for (const path of paths) {
        const section = await fsReadFile(new URL(path, entryUrl), "utf8");
        assert(section.trimEnd().split("\n").length < 1000, `${path} must stay below 1,000 lines`);
        const position = bundled.indexOf(section, offset);
        assert(position >= offset, `${path} must appear unchanged in import order`);
        offset = position + section.length;
    }
});

test("Workspace stylesheet loading accepts packaged CSS and rejects missing sections", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const path = join(root, "workspace.css");
        const packaged = ".workspace-shell { display: grid; }\n";
        await fsWriteFile(path, packaged);
        assertEquals(await readWorkspaceStyles(path), packaged);
        await fsWriteFile(path, '@import "./workspace-styles/missing.css";\n');
        const error = await assertRejects(() => readWorkspaceStyles(path), Error);
        assertEquals(Reflect.get(error, "code"), "ENOENT");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
