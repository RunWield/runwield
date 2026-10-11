import { assertEquals } from "@std/assert";

Deno.test("Workspace dev server pre-optimizes Base UI subpath dependencies", async () => {
    const config = await Deno.readTextFile(new URL("./astro.config.mjs", import.meta.url));
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
