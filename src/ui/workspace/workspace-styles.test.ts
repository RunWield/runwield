import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { readWorkspaceStyles } from "./workspace-styles.ts";

test("Workspace stylesheet assembly preserves the declared cascade and surrounding rules", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "workspace-css-order-"));
    try {
        await fsMkdir(join(root, "workspace-styles"));
        await fsWriteFile(join(root, "workspace-styles/base.css"), ".panel { display: block; }\n");
        await fsWriteFile(join(root, "workspace-styles/override.css"), ".panel { display: grid; }\n");
        const path = join(root, "workspace.css");
        await fsWriteFile(
            path,
            '/* before */\n@import "./workspace-styles/base.css";\n@import "./workspace-styles/override.css";\n/* after */\n',
        );
        assertEquals(
            await readWorkspaceStyles(path),
            "/* before */\n.panel { display: block; }\n.panel { display: grid; }\n/* after */\n",
        );
    } finally {
        await fsRm(root, { recursive: true });
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
