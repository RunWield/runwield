import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";

test("Workspace dev server pre-optimizes Base UI subpath dependencies", async () => {
    const config = await fsReadFile(new URL("./astro.config.mjs", import.meta.url), "utf8");
    const requiredBaseUiSubpaths = [
        "@base-ui/react/button",
        "@base-ui/react/dialog",
        "@base-ui/react/menu",
        "@base-ui/react/merge-props",
        "@base-ui/react/popover",
        "@base-ui/react/tabs",
        "@base-ui/react/tooltip",
        "@base-ui/react/use-render",
    ];

    assertEquals(requiredBaseUiSubpaths.every((subpath) => config.includes(`\"${subpath}\"`)), true);
});
