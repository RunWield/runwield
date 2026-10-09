import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { reviewCollapseStatePlugin } from "./review-collapse-state.ts";

const component = new URL(
    "../../../../third_party/plannotator/packages/review-editor/components/AllFilesCodeView.tsx",
    import.meta.url,
);

Deno.test("review build adapts the pinned component without changing its source", async () => {
    const source = await Deno.readTextFile(component);
    const result = reviewCollapseStatePlugin().transform(source, component.pathname);
    if (!result) throw new Error("Review component must be adapted.");
    assertStringIncludes(result.code, "rememberedCollapse.current.set(filePath, collapsed)");
    assertStringIncludes(result.code, "rememberedCollapse.get(file.path) ?? (seedCollapsed");
    assertStringIncludes(result.code, "identity.items.every(item => item.collapsed === true)");
    assertEquals(await Deno.readTextFile(component), source);
});

Deno.test("review build leaves other components unchanged", () => {
    assertEquals(reviewCollapseStatePlugin().transform("export const other = 1;", "/other.tsx"), null);
});

Deno.test("review build rejects an incompatible upstream component", () => {
    assertThrows(
        () => reviewCollapseStatePlugin().transform("export const changed = 1;", component.pathname),
        Error,
        "no longer matches",
    );
});
