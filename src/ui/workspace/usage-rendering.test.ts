import { join } from "node:path";
import { Window } from "happy-dom";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { createOwnerWorkspaceApp } from "./server.js";
import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageTrend } from "../design-system/components/react/UsageTrend.tsx";
import { UsageHistoryClearNotice, UsageStatusStrip } from "./react/UsageReport.tsx";

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

test("Usage routes mark only their own header tab as current", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir }) => {
        const origin = "http://127.0.0.1:8787";
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const pairing = store.createPairingRequest();
        store.approvePairingRequest(pairing.code);
        const device = store.claimPairingRequest(pairing.proof);
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        const browser = new Window();
        try {
            for (const route of ["/usage", "/usage/settings"]) {
                const response = await app.handler()(
                    new Request(`${origin}${route}`, {
                        headers: { cookie: `rw_owner_device=${encodeURIComponent(device.credential)}` },
                    }),
                );
                assertEquals(response.status, 200);
                browser.document.body.innerHTML = await response.text();
                const links = [...browser.document.querySelectorAll('nav[aria-label="Usage views"] a')];
                assertEquals(
                    links.map((link) => [link.textContent, link.getAttribute("href")]),
                    [
                        ["Report", "/usage"],
                        ["Settings", "/usage/settings"],
                    ],
                );
                assertEquals(
                    links.map((link) => link.getAttribute("aria-current")),
                    route === "/usage" ? ["page", null] : [null, "page"],
                );
            }
        } finally {
            await browser.happyDOM.close();
            await app.close();
            store.close();
        }
    });
});

test("pending clear notice identifies the Project and offers an explicit retry", () => {
    const html = renderToStaticMarkup(
        createElement(UsageHistoryClearNotice, {
            projectId: "project",
            label: "Project A",
            onCleared: () => {},
        }),
    );
    assertStringIncludes(html, "Clear did not finish");
    assertStringIncludes(html, "Project A");
    assertStringIncludes(html, "Old measurements are hidden until the clear finishes.");
    assertStringIncludes(html, ">Retry clear</button>");
    assertStringIncludes(html, 'role="status"');
});
