// @ts-nocheck: Browser fixtures install happy-dom globals around the real review surface.
import { test } from "node:test";
import { act } from "react";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { withReview } from "./plan-review-test-dom.tsx";

test("review history selects an older base without replacing the current Plan", async () => {
    const plan = "# Plan\n\nCurrent scope.\n";
    await withReview(
        async ({ container, button, submitted }) => {
            await act(async () => button("Versions").click());
            assertStringIncludes(container.textContent, "Version 3 of 3");
            const initial = [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === "v1");
            await act(async () => initial.click());
            assertStringIncludes(container.textContent, "Comparing current revision with version 1");
            assertStringIncludes(container.textContent, "Original");
            assertStringIncludes(container.textContent, "Current scope");
            await act(async () => button("Approve & Run").click());
            assertEquals(submitted[0].plan, plan);
        },
        plan,
        { planVersions: [{ plan: "# Plan\n\nOriginal scope.\n" }, { plan: "# Plan\n\nMiddle scope.\n" }, { plan }] },
    );
});

test("reviewed execution style survives changing the owner and reaches approval", async () => {
    await withReview(async ({ container, button, submitted }) => {
        assertEquals(button("Pair Execution").getAttribute("aria-pressed"), "true");
        await act(async () => button("Engineer").click());
        assertEquals(button("Engineer").getAttribute("aria-pressed"), "true");
        assertEquals(button("Pair Execution").getAttribute("aria-pressed"), "true");
        await act(async () => button("Approve & Run").click());
        assertEquals(submitted[0].executionAgent, "engineer");
        assertEquals(submitted[0].collaborationRecommendation, "pair");
        assertStringIncludes(container.textContent, "Approved & Run");
    }, "# Plan\n\nKeep the chosen execution policy.\n");
});

test("compact review keeps both sidebars reachable without hiding the approval action", async () => {
    await withReview(async ({ browser, container, button }) => {
        await act(async () => browser.happyDOM.setWindowSize({ width: 390, height: 844 }));
        assertEquals(Boolean(button("Collapse contents sidebar")), false);
        assertEquals(Boolean(button("Collapse annotations sidebar")), false);
        await act(async () => button("Open contents sidebar").click());
        assertEquals(Boolean(button("Collapse contents sidebar")), true);
        await act(async () => button("Open annotations sidebar").click());
        assertEquals(Boolean(button("Collapse contents sidebar")), false);
        assertEquals(Boolean(button("Collapse annotations sidebar")), true);
        await act(async () => button("Collapse annotations sidebar").click());
        assertEquals(Boolean(button("Open annotations sidebar")), true);
        assertEquals(button("Approve & Run").disabled, false);
        assertStringIncludes(container.textContent, "Review me");
    }, "# Plan\n\n## Scope\n\nReview me.\n");
});

test("a stale approval preserves the review and offers an actual reload", async () => {
    await withReview(async ({ container, button }) => {
        globalThis.fetch = () =>
            Promise.resolve(Response.json({ error: "Plan changed while review was open" }, { status: 409 }));
        let reloads = 0;
        globalThis.location = { reload: () => reloads++ };
        await act(async () => button("Approve & Run").click());
        assertStringIncludes(container.querySelector('[role="alert"]').textContent, "Review is out of date");
        assertEquals(button("Approve & Run").disabled, false);
        assertStringIncludes(container.textContent, "Keep this scope");
        await act(async () => button("Reload review").click());
        assertEquals(reloads, 1);
    }, "# Plan\n\nKeep this scope.\n");
});

test("recovery-required approval withholds success and recovers using the displayed Session generation", async () => {
    await withReview(
        async ({ container, button, confirm }) => {
            const requests = [];
            globalThis.fetch = (url, options) => {
                requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
                return Promise.resolve(
                    Response.json(
                        String(url) === "/recover"
                            ? { ok: true }
                            : { status: "recovery_required", message: "The Session owner was interrupted." },
                    ),
                );
            };
            await act(async () => button("Approve & Run").click());
            assertStringIncludes(container.textContent, "Recovery needed");
            assertEquals(container.textContent.includes("Approved & Run"), false);
            await act(async () => button("Recover in Workspace").click());
            assertEquals(requests.length, 1);
            confirm(true);
            await act(async () => button("Recover in Workspace").click());
            assertEquals(requests[1], {
                url: "/recover",
                body: { expectedGeneration: 7, expectedCurrentSegmentId: "segment-7" },
                headers: { "content-type": "application/json", "x-runwield-csrf": "csrf-fixture" },
            });
            assertStringIncludes(container.textContent, "Recovery finished. Refresh the review");
            assertEquals(container.textContent.includes("Approved & Run"), false);
        },
        "# Plan\n\nPreserve this Plan.\n",
        {
            recoveryUrl: "/recover",
            recoveryExpectedGeneration: 7,
            recoveryExpectedCurrentSegmentId: "segment-7",
            csrfToken: "csrf-fixture",
        },
    );
});
