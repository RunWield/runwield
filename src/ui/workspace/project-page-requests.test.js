import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Window } from "happy-dom";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

const settingsPage = await readFile(new URL("./pages/projects/[projectId]/settings.astro", import.meta.url), "utf8");
const operations = ["disable", "enable", "remove", "rescan"];

function mount(operation) {
    const window = new Window({ url: "http://workspace.test/projects/project/settings?tab=general" });
    // Execute the page's real inline script with native event registration.
    window.document.body.innerHTML = `<section class="project-settings-card">
        <button data-project-action="project" data-action="${operation}">Action</button>
        <button data-project-action="project" data-action="rescan">Rescan</button>
        <p data-project-action-status role="status"></p><pre data-project-diagnostics="project" hidden></pre></section>`;
    const target = window.document.querySelector("[data-project-action]");
    const notices = [];
    const navigations = [];
    window.alert = (message) => notices.push(message);
    window.confirm = () => true;
    window.document.addEventListener("runwield:workspace-navigate", (event) => {
        event.preventDefault();
        navigations.push(event.detail.href);
    });
    const script = settingsPage.match(/<script is:inline data-astro-rerun>([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error("Project page script missing");
    window.eval(script);
    assertEquals(window.document.querySelector(".rw-thinking-glyph"), null);
    return {
        window,
        target,
        notices,
        navigations,
        async act() {
            target.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
            // Native dispatch does not await the async handler. Drain its fetch/JSON microtasks.
            await new Promise((resolve) => setImmediate(resolve));
        },
        visibleFeedback() {
            return [
                ...notices,
                ...Array.from(window.document.querySelectorAll('[role="status"]'), (node) => node.textContent),
            ].join(" ");
        },
    };
}

for (const operation of operations) {
    test(`Project ${operation}: rejected fetch is visible and the action can be retried`, async () => {
        const page = mount(operation);
        try {
            let requests = 0;
            page.window.fetch = () => {
                requests++;
                return Promise.reject(new TypeError("Failed to fetch"));
            };
            const result = await Promise.allSettled([page.act()]);
            assertEquals(result[0].status, "fulfilled");
            assertStringIncludes(page.visibleFeedback(), "Check your connection and try again.");
            assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
            assertEquals(page.navigations, []);
            assertEquals(requests, 1);
            assertEquals(page.target.disabled, false);
            page.window.fetch = () => {
                requests++;
                return Promise.resolve(Response.json({ project: { projectId: "linked" } }));
            };
            await page.act();
            assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
            assertEquals(requests, 2);
            assertEquals(page.visibleFeedback().includes("Check your connection"), false);
            if (operation !== "rescan") assertEquals(page.navigations.length, 1);
        } finally {
            await page.window.happyDOM.close();
        }
    });

    test(`Project ${operation}: pending requests prevent duplicate submission`, async () => {
        const page = mount(operation);
        try {
            let complete;
            let requests = 0;
            page.window.fetch = () => {
                requests++;
                return new Promise((resolve) => {
                    complete = resolve;
                });
            };
            const pending = page.act();
            assertEquals(page.target.disabled, true);
            const glyph = page.window.document.querySelector("[data-project-action-status] .rw-thinking-glyph");
            assertEquals(glyph?.getAttribute("aria-hidden"), "true");
            assertStringIncludes(page.visibleFeedback(), "Updating Project...");
            for (const control of page.window.document.querySelectorAll("[data-project-action]")) {
                assertEquals(control.disabled, true);
            }
            await page.act();
            page.window.document.querySelectorAll("[data-project-action]")[1].click();
            assertEquals(requests, 1);
            complete(Response.json({ project: { projectId: "linked" } }));
            await pending;
            await new Promise((resolve) => setImmediate(resolve));
            assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
            for (const control of page.window.document.querySelectorAll("[data-project-action]")) {
                assertEquals(control.disabled, false);
            }
            assertEquals(page.target.disabled, false);
        } finally {
            await page.window.happyDOM.close();
        }
    });

    test(`Project ${operation}: HTTP errors remain visible without navigation`, async () => {
        const page = mount(operation);
        try {
            page.window.fetch = () =>
                Promise.resolve(Response.json({ error: "Synthetic server rejection" }, { status: 409 }));
            await page.act();
            assertStringIncludes(page.visibleFeedback(), "Synthetic server rejection");
            assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
            assertEquals(page.navigations, []);
        } finally {
            await page.window.happyDOM.close();
        }
    });

    test(`Project ${operation}: interrupted successful response stays retryable without claiming completion`, async () => {
        const page = mount(operation);
        try {
            page.window.fetch = () =>
                Promise.resolve(
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.error(new TypeError("Connection lost while reading response"));
                            },
                        }),
                        { status: 200 },
                    ),
                );
            await page.act();
            assertStringIncludes(page.visibleFeedback(), "Check your connection and try again.");
            assertEquals(page.navigations, []);
            assertEquals(page.target.disabled, false);
            assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
            assertEquals(page.window.document.querySelector("[data-project-diagnostics]").hidden, true);
        } finally {
            await page.window.happyDOM.close();
        }
    });

    test(`Project ${operation}: success keeps its established result`, async () => {
        const page = mount(operation);
        try {
            page.window.fetch = () =>
                Promise.resolve(
                    Response.json({ project: { projectId: "linked" }, diagnostics: ["synthetic diagnostic"] }),
                );
            await page.act();
            assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
            if (operation === "rescan") {
                const diagnostics = page.window.document.querySelector("[data-project-diagnostics]");
                assertEquals(diagnostics.hidden, false);
                assertStringIncludes(diagnostics.textContent, "synthetic diagnostic");
                assertEquals(page.window.document.querySelector(".rw-thinking-glyph"), null);
                assertEquals(page.navigations, []);
            } else {
                assertEquals(page.navigations, [
                    operation === "remove" ? "/projects" : "/projects/project/settings?tab=general",
                ]);
            }
        } finally {
            await page.window.happyDOM.close();
        }
    });
}
