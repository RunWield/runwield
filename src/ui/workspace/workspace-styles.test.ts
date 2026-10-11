import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { readWorkspaceStyles } from "./workspace-styles.ts";

Deno.test("Workspace stylesheet sections stay small and retain their import order", async () => {
    const entryUrl = new URL("./static/workspace.css", import.meta.url);
    const entry = await Deno.readTextFile(entryUrl);
    const paths = [...entry.matchAll(/@import "([^"]+)";/g)].map((match) => match[1]);
    assert(paths.length > 1);
    assert(entry.trimEnd().split("\n").length < 1000);
    const bundled = await readWorkspaceStyles(entryUrl);
    assertEquals(bundled.includes("@import"), false);
    let offset = 0;
    for (const path of paths) {
        const section = await Deno.readTextFile(new URL(path, entryUrl));
        assert(section.trimEnd().split("\n").length < 1000, `${path} must stay below 1,000 lines`);
        const position = bundled.indexOf(section, offset);
        assert(position >= offset, `${path} must appear unchanged in import order`);
        offset = position + section.length;
    }
});

Deno.test("Workspace stylesheet loading accepts packaged CSS and rejects missing sections", async () => {
    const root = await Deno.makeTempDir();
    try {
        const path = join(root, "workspace.css");
        const packaged = ".workspace-shell { display: grid; }\n";
        await Deno.writeTextFile(path, packaged);
        assertEquals(await readWorkspaceStyles(path), packaged);
        await Deno.writeTextFile(path, '@import "./workspace-styles/missing.css";\n');
        await assertRejects(() => readWorkspaceStyles(path), Deno.errors.NotFound);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
