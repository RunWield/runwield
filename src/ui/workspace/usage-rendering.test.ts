import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageTrend } from "../design-system/components/react/UsageTrend.tsx";

Deno.test("usage trend breaks at a gap and draws covered zero as a baseline point", () => {
    const html = renderToStaticMarkup(createElement(UsageTrend, {
        days: [
            { date: "2026-09-01", tokens: 10, gaps: [] },
            { date: "2026-09-02", tokens: 0, gaps: [] },
            { date: "2026-09-03", tokens: null, gaps: ["disabled"] },
            { date: "2026-09-04", tokens: 4, gaps: [] },
            { date: "2026-09-05", tokens: 6, gaps: [] },
        ],
    }));
    assertEquals((html.match(/<polyline/g) || []).length, 2);
    assertStringIncludes(html, 'points="20,25 210,150"');
    assertStringIncludes(html, 'cx="210" cy="150"');
    assertEquals(html.includes('cx="400"'), false);
    assertStringIncludes(html, 'class="rw-usage-gap" x="400"');
    assertStringIncludes(html, "See the daily table for values.");
});

Deno.test("usage page exposes readable daily costs and completeness without raw activity or settings controls", async () => {
    const page = await Deno.readTextFile(new URL("./react/UsageReport.tsx", import.meta.url));
    assertStringIncludes(page, "Daily values and data completeness");
    assertStringIncludes(page, '<th scope="col">Estimated cost (USD)</th>');
    assertStringIncludes(page, '<th scope="col">Data Complete</th>');
    assertStringIncludes(page, 'day.gaps.length ? "Partial" : "Complete"');
    assertStringIncludes(page, "Known subtotal:");
    assertStringIncludes(page, 'role="status"');
    assertStringIncludes(page, 'role="alert"');
    for (const control of ["Recorded activity", "Download", "Export", "Settings", "Recording on", "Recording off"]) {
        assertEquals(page.includes(control), false, control);
    }
});
