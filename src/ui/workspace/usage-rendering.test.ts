import { join } from "node:path";
import { Window } from "happy-dom";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { createOwnerWorkspaceApp } from "./server.js";
import { test } from "node:test";

import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { loadOwnerUsage } from "./server/owner-usage.ts";
import { UsageReport } from "./react/UsageReport.tsx";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getWorkflowMetricsFilePath } from "../../shared/workflow/metrics.js";
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

test("usage page renders daily costs and completeness from the real report and recovers from a failed fetch", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot: cwd }) => {
        const journal = getWorkflowMetricsFilePath(cwd);
        await mkdir(dirname(journal), { recursive: true });
        await writeFile(
            journal,
            [
                { v: 2, eventId: "on", event: "collection_epoch", ts: "2026-09-01T00:00:00Z", enabled: true },
                {
                    v: 2,
                    eventId: "cost",
                    event: "model_usage",
                    ts: "2026-09-01T12:00:00Z",
                    inputTokens: 10,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    inputCacheBasis: "excludes_cache",
                    aggregationBasis: "turn",
                    costAmount: 0.5,
                    costCurrency: "USD",
                    costSource: "calculated",
                    backend: "pi",
                    provider: "fixture",
                    model: "fixture",
                },
                { v: 2, eventId: "off", event: "collection_epoch", ts: "2026-09-03T00:00:00Z", enabled: false },
            ]
                .map((row) => JSON.stringify(row))
                .join("\n") + "\n",
        );
        const store = openOwnerCoordinationStore();
        store.registerProject({ root: cwd });
        const report = await loadOwnerUsage(store, new URLSearchParams({ start: "2026-09-01", end: "2026-09-04" }));
        const browser = new Window({ url: "http://workspace.local/usage" });
        let failed = true;
        const globals = {
            window: browser,
            document: browser.document,
            HTMLElement: browser.HTMLElement,
            Node: browser.Node,
            navigator: browser.navigator,
            IS_REACT_ACT_ENVIRONMENT: true,
            fetch: () =>
                Promise.resolve(
                    failed
                        ? Response.json({ error: "Usage source unavailable" }, { status: 503 })
                        : Response.json(report),
                ),
        };
        const previous = new Map(
            Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
        );
        for (const [name, value] of Object.entries(globals))
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(() => root.render(createElement(UsageReport)));
            assertStringIncludes(
                container.querySelector('[role="alert"]')?.textContent || "",
                "Usage source unavailable",
            );
            failed = false;
            const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
            if (!retry) throw new Error("Missing retry control");
            await act(() => retry.click());
            const summary = [...container.querySelectorAll("summary")].find(
                (node) => node.textContent === "Daily values and data completeness",
            );
            if (!summary) throw new Error("Missing daily usage disclosure");
            await act(() => summary.click());
            const daily = [...container.querySelectorAll("table")].find((table) =>
                table.querySelector("caption")?.textContent?.startsWith("Daily values in "),
            );
            if (!daily) throw new Error("Missing accessible daily usage table");
            assertStringIncludes(daily.textContent || "", "Estimated cost (USD)");
            assertStringIncludes(daily.textContent || "", "Data Complete");
            assertStringIncludes(daily.textContent || "", "$0.50");
            assertStringIncludes(daily.textContent || "", "Partial");
            const firstDay = [...daily.querySelectorAll("tbody tr")].find(
                (row) => row.querySelector("th")?.textContent === "2026-09-01",
            );
            assertEquals(firstDay?.querySelectorAll("td")[2]?.textContent, "Complete");
            assertEquals(container.querySelector('[role="alert"]'), null);
            assertEquals(
                [...container.querySelectorAll("button,a")].some((node) =>
                    /Download|Recorded activity/.test(node.textContent || ""),
                ),
                false,
            );
        } finally {
            await act(() => root.unmount());
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
            await browser.happyDOM.close();
            store.close();
        }
    });
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
