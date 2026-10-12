import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { startWorkspaceNotifications } from "./workspace-notifications.ts";

class BrowserEventSource {
    static connections: BrowserEventSource[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    closed = false;
    constructor(public url: string) {
        BrowserEventSource.connections.push(this);
    }
    close() {
        this.closed = true;
    }
}

class BrowserNotification {
    static permission = "granted";
    static titles: string[] = [];
    onclick: (() => void) | null = null;
    constructor(title: string) {
        BrowserNotification.titles.push(title);
    }
    close() {}
}

test("Workspace alerts survive page navigation and reconnect after browser page suspension", async () => {
    Reflect.set(globalThis, "EventSource", BrowserEventSource);
    Reflect.set(globalThis, "Notification", BrowserNotification);
    Reflect.set(globalThis, "location", { href: "https://workspace.example/projects" });
    Reflect.set(globalThis, "document", { visibilityState: "hidden", hasFocus: () => false });
    try {
        startWorkspaceNotifications();
        startWorkspaceNotifications();
        dispatchEvent(new Event("astro:page-load"));
        assertEquals(BrowserEventSource.connections.length, 1);
        const stream = BrowserEventSource.connections[0];
        assertEquals(stream.url, "/api/owner/notifications/stream");
        stream.onmessage?.(
            new MessageEvent("message", {
                data: JSON.stringify({
                    event: {
                        type: "attention_requested",
                        reason: "agentStopped",
                        notificationSurface: "workspace",
                        sessionName: "Original Session",
                    },
                    url: "/projects/project/sessions/original-session",
                    policy: { enabled: true },
                }),
            }),
        );
        await Promise.resolve();
        assertEquals(BrowserNotification.titles, ["Agent stopped — Original Session"]);
        dispatchEvent(new Event("pagehide"));
        assertEquals(stream.closed, true);
        dispatchEvent(new Event("pageshow"));
        assertEquals(BrowserEventSource.connections.length, 2);
        dispatchEvent(new Event("pagehide"));
    } finally {
        for (const name of ["EventSource", "Notification", "location", "document"]) {
            Reflect.deleteProperty(globalThis, name);
        }
    }
});
