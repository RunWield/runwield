import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Window } from "happy-dom";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";

const projectPage = await readFile(new URL("./pages/projects/index.astro", import.meta.url), "utf8");
const settingsPage = await readFile(new URL("./pages/projects/[projectId]/settings.astro", import.meta.url), "utf8");
const operations = ["link", "relink", "disable", "enable", "remove", "rescan"];

function mount(operation) {
    const window = new Window({ url: "http://workspace.test/projects/project/settings?tab=general" });
    const isLink = operation === "link";
    const isForm = isLink || operation === "relink";
    // Execute the page's real inline script against the browser boundary's minimal DOM.
    window.document.body.innerHTML = isLink
        ? `<section class="project-link-card"><form data-project-register>
            <input name="root" value="/synthetic/project"><input name="displayName" value="Example">
            <button type="submit">Link Project</button></form>
            <p data-project-register-status role="status"></p></section>`
        : `<section class="project-settings-card"><form data-project-relink="project">
            <input name="newRoot" value="/synthetic/new-root"><button type="submit">Relink</button></form>
            <p data-project-relink-status role="status"></p></section>
            <section class="project-settings-card"><button data-project-action="project" data-action="${operation}">Action</button>
            <button data-project-action="project" data-action="rescan">Rescan</button>
            <p data-project-action-status role="status"></p><pre data-project-diagnostics="project" hidden></pre></section>`;
    const target = window.document.querySelector(isLink ? "form" : isForm ? "form" : "[data-project-action]");
    let listener;
    target.addEventListener = (_type, callback) => {
        listener = callback;
    };
    const notices = [];
    const navigations = [];
    window.alert = (message) => notices.push(message);
    window.confirm = () => true;
    window.document.addEventListener("runwield:workspace-navigate", (event) => {
        event.preventDefault();
        navigations.push(event.detail.href);
    });
    const script = (isLink ? projectPage : settingsPage).match(
        /<script is:inline data-astro-rerun>([\s\S]*?)<\/script>/,
    )?.[1];
    if (!script) throw new Error("Project page script missing");
    window.eval(script);
    return {
        window,
        target,
        notices,
        navigations,
        async act() {
            return await listener(new window.Event(isForm ? "submit" : "click", { cancelable: true }));
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
            assertEquals(page.navigations, []);
            assertEquals(requests, 1);
            assertEquals(page.target.querySelector("button")?.disabled ?? page.target.disabled, false);
            if (operation === "link")
                assertEquals(page.target.querySelector('[name="root"]').value, "/synthetic/project");
            if (operation === "relink")
                assertEquals(page.target.querySelector('[name="newRoot"]').value, "/synthetic/new-root");
            page.window.fetch = () => {
                requests++;
                return Promise.resolve(Response.json({ project: { projectId: "linked" } }));
            };
            await page.act();
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
            assertEquals(page.target.querySelector("button")?.disabled ?? page.target.disabled, true);
            for (const control of page.window.document.querySelectorAll("[data-project-action]")) {
                if (operation !== "relink") assertEquals(control.disabled, true);
            }
            await page.act();
            assertEquals(requests, 1);
            complete(Response.json({ project: { projectId: "linked" } }));
            await pending;
            for (const control of page.window.document.querySelectorAll("[data-project-action]")) {
                assertEquals(control.disabled, false);
            }
            assertEquals(page.target.querySelector("button")?.disabled ?? page.target.disabled, false);
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
            assertEquals(page.navigations, []);
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
            if (operation === "rescan") {
                const diagnostics = page.window.document.querySelector("[data-project-diagnostics]");
                assertEquals(diagnostics.hidden, false);
                assertStringIncludes(diagnostics.textContent, "synthetic diagnostic");
                assertEquals(page.navigations, []);
            } else {
                assertEquals(page.navigations, [
                    operation === "link"
                        ? "/projects/linked/settings"
                        : operation === "remove"
                          ? "/projects"
                          : "/projects/project/settings?tab=general",
                ]);
            }
        } finally {
            await page.window.happyDOM.close();
        }
    });
}
