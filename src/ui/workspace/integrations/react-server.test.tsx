import { assertEquals, assertStringIncludes } from "@std/assert";
import { useState } from "react";
import renderer from "./react-server.mjs";

Deno.test("React renderer checks hook components inside the React render lifecycle", () => {
    let completedRenders = 0;
    function HookComponent() {
        const [value] = useState("Project root");
        completedRenders += 1;
        return <label>{value}</label>;
    }

    assertEquals(renderer.check(HookComponent, {}, {}), true);
    assertEquals(completedRenders, 1);
    assertStringIncludes(renderer.renderToStaticMarkup(HookComponent, {}).html, "Project root");
    assertEquals(completedRenders, 2);
    assertEquals(renderer.check(() => "not a React element", {}, {}), false);
});
