import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "../../../testing/assertions.ts";
import { reviewCollapseStatePlugin } from "./review-collapse-state.ts";

const component = new URL(
    "../../../../third_party/plannotator/packages/review-editor/components/AllFilesCodeView.tsx",
    import.meta.url,
);

test("review build adapts the pinned component without changing its source", async () => {
    const source = await fsReadFile(component, "utf8");
    const result = reviewCollapseStatePlugin().transform(source, component.pathname);
    if (!result) throw new Error("Review component must be adapted.");
    assertStringIncludes(result.code, "rememberedCollapse.current.set(filePath, collapsed)");
    assertStringIncludes(result.code, "rememberedCollapse.get(file.path) ?? (seedCollapsed");
    assertStringIncludes(result.code, "identity.items.every(item => item.collapsed === true)");
    assertEquals(await fsReadFile(component, "utf8"), source);
});

test("review build accepts a CRLF checkout of the pinned component", async () => {
    const source = (await fsReadFile(component, "utf8")).replaceAll("\r\n", "\n");
    const plugin = reviewCollapseStatePlugin();
    assertEquals(plugin.transform(source.replaceAll("\n", "\r\n"), component.pathname),
        plugin.transform(source, component.pathname));
});

test("review build leaves other components unchanged", () => {
    assertEquals(reviewCollapseStatePlugin().transform("export const other = 1;", "/other.tsx"), null);
});

test("review build rejects an incompatible upstream component", () => {
    assertThrows(
        () => reviewCollapseStatePlugin().transform("export const changed = 1;", component.pathname),
        Error,
        "no longer matches",
    );
});
