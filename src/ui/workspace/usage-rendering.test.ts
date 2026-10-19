import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageTrend } from "../design-system/components/react/UsageTrend.tsx";
import { UsageStatusStrip } from "./react/UsageReport.tsx";

test("usage trend breaks at a gap and draws covered zero as a baseline point", () => {
    const html = renderToStaticMarkup(
        createElement(UsageTrend, {
            days: [
                { date: "2026-09-01", tokens: 10, gaps: [] },
                { date: "2026-09-02", tokens: 0, gaps: [] },
                { date: "2026-09-03", tokens: null, gaps: ["disabled"] },
                { date: "2026-09-04", tokens: 4, gaps: [] },
                { date: "2026-09-05", tokens: 6, gaps: [] },
            ],
        }),
    );
    assertEquals((html.match(/<polyline/g) || []).length, 2);
    assertStringIncludes(html, 'points="20,25 210,150"');
    assertStringIncludes(html, 'cx="210" cy="150"');
    assertEquals(html.includes('cx="400"'), false);
    assertStringIncludes(html, 'class="rw-usage-gap" x="400"');
    assertStringIncludes(html, "See the daily table for values.");
});

test("usage page exposes readable daily costs and completeness without raw activity or downloads", async () => {
    const page = await fsReadFile(new URL("./react/UsageReport.tsx", import.meta.url), "utf8");
    assertStringIncludes(page, "Daily values and data completeness");
    assertStringIncludes(page, '<th scope="col">Estimated cost (USD)</th>');
    assertStringIncludes(page, '<th scope="col">Data Complete</th>');
    assertStringIncludes(page, 'day.gaps.length ? "Partial" : "Complete"');
    assertStringIncludes(page, "Known subtotal:");
    assertStringIncludes(page, 'role="status"');
    assertStringIncludes(page, 'role="alert"');
    for (const control of ["Recorded activity", "Download"]) {
        assertEquals(page.includes(control), false, control);
    }
});

test("usage strip shows recording states and all Core delivery counts with a Settings link", () => {
    for (const enabled of [true, false]) {
        const html = renderToStaticMarkup(
            createElement(UsageStatusStrip, {
                recording: {
                    globalEnabled: enabled,
                    projects: [{ projectId: "a", label: "A", enabled, setBy: "global" }],
                },
                exportStatus: {
                    available: true,
                    destinations: [
                        {
                            destinationId: "d",
                            exporterId: "langfuse",
                            counts: { pending: 3, accepted: 12, confirmed: 10, unconfirmed: 1, rejected: 2 },
                        },
                    ],
                },
            }),
        );
        assertStringIncludes(html, enabled ? "Recording on" : "Recording off");
        assertStringIncludes(html, 'href="/usage/settings"');
        assertStringIncludes(html, "12 accepted, 3 pending, 10 confirmed, 1 delivery unconfirmed, 2 rejected");
    }
    const mixed = renderToStaticMarkup(
        createElement(UsageStatusStrip, {
            recording: {
                globalEnabled: true,
                projects: [
                    { projectId: "a", label: "A", enabled: true, setBy: "global" },
                    { projectId: "b", label: "B", enabled: false, setBy: "project" },
                ],
            },
            exportStatus: { available: true, destinations: [] },
        }),
    );
    assertStringIncludes(mixed, "Recording on for 1 of 2 Projects");
});

test("Usage views share one header tab layout with active-page semantics", async () => {
    const layout = await fsReadFile(new URL("./layouts/UsageLayout.astro", import.meta.url), "utf8");
    assertStringIncludes(layout, 'slot="header-tabs"');
    assertStringIncludes(layout, "rw-underline-tabs");
    assertStringIncludes(layout, 'href="/usage"');
    assertStringIncludes(layout, 'href="/usage/settings"');
    for (const active of ["report", "settings"]) {
        assertStringIncludes(layout, `aria-current={active === "${active}" ? "page" : undefined}`);
    }
});
