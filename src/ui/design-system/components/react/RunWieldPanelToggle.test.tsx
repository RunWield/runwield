import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assertEquals, assertStringIncludes } from "../../../../testing/assertions.ts";
import { RunWieldPanelToggle } from "./RunWieldPrimitives.tsx";

for (const side of ["left", "right"] as const) {
    test(`${side} sidebar uses the same panel icon when open and closed`, () => {
        const icons: string[] = [];
        for (const collapsed of [false, true]) {
            const html = renderToStaticMarkup(
                createElement(RunWieldPanelToggle, {
                    side,
                    collapsed,
                    label: "Contents",
                    controls: "contents",
                    onClick: () => {},
                }),
            );
            assertStringIncludes(html, `aria-label="${collapsed ? "Show" : "Collapse"} Contents"`);
            assertStringIncludes(html, `aria-expanded="${!collapsed}"`);
            assertStringIncludes(html, 'aria-controls="contents"');
            const icon = html.slice(html.indexOf("<svg"), html.indexOf("</svg>") + 6);
            assertStringIncludes(icon, 'aria-hidden="true"');
            assertStringIncludes(icon, 'stroke="currentColor"');
            assertStringIncludes(icon, 'd="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z');
            assertStringIncludes(icon, side === "left" ? "M9 3v18" : "M15 3v18");
            icons.push(icon);
        }
        assertEquals(icons[0], icons[1]);
    });
}
