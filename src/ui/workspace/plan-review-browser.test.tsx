import { assertEquals } from "../../testing/assertions.ts";
// @ts-nocheck: browser test sets happy-dom globals.
import { test } from "node:test";
import { Window } from "happy-dom";
import { requestWorkspacePlanReview } from "./islands/SessionSurface.jsx";

test("Workspace Plan review command navigates to the existing interaction without sending a turn", async () => {
    const browser = new Window({ url: "http://127.0.0.1:8787" });
    const names = ["document", "location", "CustomEvent"];
    const previous = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const previousFetch = globalThis.fetch;
    const requests = [];
    const navigations = [];
    try {
        for (const name of names) {
            Object.defineProperty(globalThis, name, {
                configurable: true,
                writable: true,
                value: browser[name],
            });
        }
        browser.document.addEventListener("runwield:workspace-navigate", (event) => {
            navigations.push(event.detail.href);
            event.preventDefault();
        });
        globalThis.fetch = (url, options) => {
            requests.push({ path: String(url), method: options?.method || "GET" });
            if (String(url).endsWith("/plan-review")) {
                return Promise.resolve(Response.json({
                    kind: "starting",
                    operationId: "review-operation",
                }));
            }
            return Promise.resolve(Response.json({
                operation: {
                    operationId: "review-operation",
                    status: "running",
                    liveInteraction: {
                        request: {
                            type: "plan_review",
                            reviewUrl: "/projects/project-1/plans/saved?session=session-1",
                        },
                    },
                },
            }));
        };
        await requestWorkspacePlanReview("project-1", "session-1", 4);
        assertEquals(requests, [
            { path: "/api/owner/projects/project-1/sessions/session-1/plan-review", method: "POST" },
            { path: "/api/owner/projects/project-1/sessions/session-1/live", method: "GET" },
        ]);
        assertEquals(navigations, ["/projects/project-1/plans/saved?session=session-1"]);
    } finally {
        globalThis.fetch = previousFetch;
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
});
