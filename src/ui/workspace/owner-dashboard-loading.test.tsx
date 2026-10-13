import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { mountDashboard, newDashboardWindow } from "./dashboard-test-dom.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const keys = ["needs-you", "ready", "in-progress", "recently-finished"];
const frame = (type: string) => ({
    type,
    progress: { pending: type !== "complete" },
    diagnostics: [],
    sections: keys.map((key) => ({ key, items: [] })),
});

test("Dashboard pauses hidden refresh and rejects updates after navigation", async () => {
    const window = newDashboardWindow();
    let visibility = "visible";
    Object.defineProperty(window.document, "visibilityState", { get: () => visibility });
    const streams: Array<(response: Response) => void> = [];
    let requests = 0;
    Object.defineProperty(window, "fetch", {
        value: () => {
            requests++;
            return new Promise<Response>((resolve) => streams.push(resolve));
        },
    });
    try {
        mountDashboard(window);
        assertEquals(requests, 1);
        visibility = "hidden";
        window.document.dispatchEvent(new window.Event("visibilitychange"));
        await tick();
        assertEquals(requests, 1);
        visibility = "visible";
        window.document.dispatchEvent(new window.Event("visibilitychange"));
        assertEquals(requests, 1); // The first request is still active.
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
        streams.shift()?.(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        stream = controller;
                    },
                }),
            ),
        );
        await tick();
        stream?.enqueue(new TextEncoder().encode(JSON.stringify(frame("complete")) + "\n"));
        stream?.close();
        await tick();
        window.document.dispatchEvent(new window.Event("visibilitychange"));
        assertEquals(requests, 2);
        window.document.dispatchEvent(new window.Event("astro:before-swap"));
        assertEquals(window.document.querySelectorAll(".owner-dashboard-section").length, 4);
        assertEquals(requests, 2);
    } finally {
        await window.happyDOM.abort();
    }
});
