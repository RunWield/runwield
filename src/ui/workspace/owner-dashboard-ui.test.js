import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { markup, mountDashboard, newDashboardWindow } from "./dashboard-test-dom.ts";

const labels = ["Needs You", "Ready to Continue", "In Progress", "Recently Finished"];
const keys = ["needs-you", "ready", "in-progress", "recently-finished"];
const first = {
    type: "plan",
    projectId: "p",
    planId: "1",
    href: "/plans/1",
    title: "First plan",
    projectName: "A",
    statusLabel: "Ready",
    updatedAt: "2026-09-20T12:00:00.000Z",
};
const second = { ...first, planId: "2", href: "/plans/2", title: "Second plan", updatedAt: "2026-09-21T12:00:00.000Z" };

function frame(type, items = [], diagnostics = [], sectionProgress = {}) {
    return {
        type,
        progress: { pending: type !== "complete" },
        diagnostics,
        sectionProgress,
        sections: keys.map((key, index) => ({ key, label: labels[index], items: index === 0 ? items : [] })),
    };
}
function dashboard() {
    const window = newDashboardWindow();
    const streams = [];
    window.fetch = () => new Promise((resolve) => streams.push(resolve));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    mountDashboard(window);
    async function start() {
        await tick();
        let stream;
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    stream = controller;
                },
            }),
        );
        streams.shift()(response);
        await tick();
        return {
            async send(value) {
                stream.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
                await tick();
            },
            async end() {
                stream.close();
                await tick();
            },
        };
    }
    return { window, start, tick };
}

test("Dashboard initial HTML shows four pending cards before JavaScript or data", () => {
    const window = newDashboardWindow();
    window.document.body.innerHTML = markup;
    assertEquals(
        [...window.document.querySelectorAll(".owner-dashboard-section h2")].map((node) => node.textContent),
        labels,
    );
    assertEquals(window.document.querySelectorAll('.owner-dashboard-section [role="status"]').length, 4);
    assertEquals(window.document.querySelectorAll(".owner-dashboard-section .empty").length, 0);
    window.happyDOM.abort();
});

test("Dashboard shows verified rows while other cards are loading, then distinguishes empty and errors", async () => {
    const { window, start } = dashboard();
    try {
        const stream = await start();
        await stream.send(frame("snapshot", [first]));
        assertEquals(window.document.querySelectorAll(".owner-dashboard-row").length, 1);
        assertStringIncludes(window.document.querySelector('[data-dashboard-card="ready"]').textContent, "Loading");
        assertEquals(window.document.querySelector(".owner-dashboard-section-heading span").textContent, "1+");
        await stream.send(frame("complete", [first]));
        await stream.end();
        assertStringIncludes(
            window.document.querySelector('[data-dashboard-card="ready"]').textContent,
            "Nothing here",
        );
        assertEquals(window.document.querySelectorAll(".owner-dashboard-error").length, 0);
    } finally {
        await window.happyDOM.abort();
    }
});

test("Dashboard preserves verified rows on failed refresh and replaces them on Retry", async () => {
    const { window, start, tick } = dashboard();
    try {
        let stream = await start();
        await stream.send(frame("complete", [first]));
        await stream.end();
        window.document.dispatchEvent(new window.Event("visibilitychange"));
        stream = await start();
        assertStringIncludes(
            window.document.querySelector('[data-dashboard-card="needs-you"]').textContent,
            "Updating",
        );
        await stream.end(); // EOF without a completion frame is an error, not empty.
        assertEquals(window.document.querySelectorAll(".owner-dashboard-row").length, 1);
        assertStringIncludes(window.document.querySelector(".owner-dashboard-error").textContent, "Could not update");
        window.document.querySelector("[data-dashboard-retry]").click();
        stream = await start();
        await stream.send(frame("complete", [second]));
        await stream.end();
        await tick();
        assertEquals(window.document.querySelector(".owner-dashboard-row").getAttribute("href"), second.href);
        assertEquals(window.document.querySelectorAll(".owner-dashboard-error").length, 0);
    } finally {
        await window.happyDOM.abort();
    }
});

test("Dashboard keeps sort, expansion and focused row during incremental updates", async () => {
    const { window, start } = dashboard();
    try {
        const stream = await start();
        await stream.send(frame("snapshot", [first, second]));
        window.document.querySelector("[data-dashboard-sort]").click();
        assertEquals(window.document.querySelector(".owner-dashboard-row").getAttribute("href"), first.href);
        window.document.querySelector(".owner-dashboard-row").focus();
        await stream.send(
            frame("snapshot", [
                second,
                first,
                ...Array.from(
                    { length: 5 },
                    (_, index) => ({
                        ...first,
                        planId: String(index + 3),
                        href: `/plans/${index + 3}`,
                        title: `Plan ${index + 3}`,
                    }),
                ),
            ]),
        );
        assertEquals(window.document.activeElement.textContent, "Needs You");
        window.document.querySelector("[data-dashboard-expand]").click();
        assertEquals(
            window.document.querySelectorAll('[data-dashboard-card="needs-you"] .owner-dashboard-row').length,
            7,
        );
        await stream.send(frame("complete", [second]));
        await stream.end();
        assertEquals(window.document.querySelectorAll(".owner-dashboard-row").length, 1);
        assertEquals(window.document.activeElement.textContent, "Needs You");
    } finally {
        await window.happyDOM.abort();
    }
});

test("Dashboard first-load error keeps verified partial rows and offers Retry", async () => {
    const { window, start } = dashboard();
    try {
        const stream = await start();
        await stream.send(frame("snapshot", [first]));
        await stream.send({ type: "error", error: "Project read failed." });
        await stream.end();
        assertEquals(window.document.querySelectorAll(".owner-dashboard-row").length, 1);
        assertStringIncludes(
            window.document.querySelector(".owner-dashboard-error").textContent,
            "Some results could not be checked",
        );
        assertEquals(window.document.querySelectorAll("[data-dashboard-retry]").length, 4);
    } finally {
        await window.happyDOM.abort();
    }
});

test("a failed card retains old rows while another completed card replaces its rows", async () => {
    const { window, start } = dashboard();
    try {
        let stream = await start();
        await stream.send(frame("complete", [first]));
        await stream.end();
        window.document.dispatchEvent(new window.Event("visibilitychange"));
        stream = await start();
        await stream.send(frame("complete", [], [{ message: "Readiness failed" }], {
            "needs-you": { pending: false, failed: true },
            ready: { pending: false, failed: false },
        }));
        await stream.end();
        assertEquals(
            window.document.querySelector('[data-dashboard-card="needs-you"] .owner-dashboard-row').getAttribute(
                "href",
            ),
            first.href,
        );
        assertStringIncludes(
            window.document.querySelector('[data-dashboard-card="needs-you"] .owner-dashboard-error').textContent,
            "Could not update",
        );
        assertEquals(
            window.document.querySelector('[data-dashboard-card="ready"] .empty').textContent,
            "Nothing here.",
        );
        assertEquals(window.document.querySelectorAll(".owner-dashboard-error").length, 1);
        window.document.querySelector("[data-dashboard-retry]").click();
        stream = await start();
        await stream.send(frame("complete", [second]));
        await stream.end();
        assertEquals(window.document.querySelector(".owner-dashboard-row").getAttribute("href"), second.href);
        assertEquals(window.document.querySelectorAll(".owner-dashboard-error").length, 0);
    } finally {
        await window.happyDOM.abort();
    }
});

test("Dashboard shows loading and failure together while checks remain pending", async () => {
    const { window, start } = dashboard();
    try {
        const stream = await start();
        await stream.send(frame("snapshot", [first], [], {
            "needs-you": { pending: true, failed: true },
        }));
        const card = window.document.querySelector('[data-dashboard-card="needs-you"]');
        assertStringIncludes(
            card.querySelector(".owner-dashboard-error").textContent,
            "Some results could not be checked",
        );
        assertStringIncludes(card.querySelector('[role="status"]').textContent, "Loading");
        assertEquals(card.querySelector(".owner-dashboard-section-heading span").textContent, "1+");
        assertStringIncludes(
            card.querySelector(".owner-dashboard-section-heading span").getAttribute("title"),
            "pending",
        );
        assertEquals(card.querySelectorAll("[data-dashboard-retry]").length, 1);
    } finally {
        await window.happyDOM.abort();
    }
});

test("Dashboard treats Project diagnostics as incomplete rather than empty", async () => {
    const { window, start } = dashboard();
    try {
        const stream = await start();
        await stream.send(
            frame("complete", [], [{ message: "Unavailable", repairHref: "/projects/1/settings" }], {
                ready: { pending: false, failed: true },
            }),
        );
        await stream.end();
        assertStringIncludes(window.document.querySelector(".owner-dashboard-error").textContent, "Could not load");
        assertEquals(
            window.document.querySelector('[data-dashboard-card="ready"] .empty').textContent,
            "Other items may be missing.",
        );
        assertEquals(
            window.document.querySelector('[data-dashboard-card="needs-you"] .empty').textContent,
            "Nothing here.",
        );
        assertEquals(window.document.querySelector("[data-dashboard-warning]").hidden, false);
    } finally {
        await window.happyDOM.abort();
    }
});
