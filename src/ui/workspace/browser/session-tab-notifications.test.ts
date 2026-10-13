import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { createSessionTabNotificationController } from "./session-tab-notifications.ts";

class FakeNotification {
    static permission = "granted";
    static created: FakeNotification[] = [];
    title: string;
    options: NotificationOptions;
    closed = false;
    onclick: ((event: Event) => void) | null = null;

    constructor(title: string, options: NotificationOptions = {}) {
        this.title = title;
        this.options = options;
        FakeNotification.created.push(this);
    }

    close() {
        this.closed = true;
    }
}

function installBrowser(
    options: { permission?: string; visibilityState?: string; focused?: boolean; throwOnConstruct?: boolean } = {},
) {
    let focusCount = 0;
    class TestNotification extends FakeNotification {
        static override permission = options.permission || "granted";
        constructor(title: string, notificationOptions: NotificationOptions = {}) {
            if (options.throwOnConstruct) throw new Error("blocked");
            super(title, notificationOptions);
        }
    }
    FakeNotification.created = [];
    Reflect.set(globalThis, "Notification", TestNotification);
    Reflect.set(globalThis, "document", {
        visibilityState: options.visibilityState || "hidden",
        hasFocus: () => options.focused === true,
    });
    Reflect.set(globalThis, "focus", () => focusCount += 1);
    return {
        created: FakeNotification.created,
        focusCount: () => focusCount,
        cleanup() {
            Reflect.deleteProperty(globalThis, "Notification");
            Reflect.deleteProperty(globalThis, "document");
            Reflect.deleteProperty(globalThis, "focus");
        },
    };
}

const enabledPolicy = { enabled: true, events: { agentStopped: true }, suppressWhenFocused: true };
const stoppedEvent = { type: "attention_requested", reason: "agentStopped", agentName: "Guide", sessionName: "Demo" };

test("browser notifications construct the real Notification and focus the tab on click", () => {
    const browser = installBrowser();
    try {
        const controller = createSessionTabNotificationController();
        controller.notifyAgentStopped(stoppedEvent, enabledPolicy);
        assertEquals(browser.created.length, 1);
        assertEquals(browser.created[0].title, "Guide: Agent stopped — Demo");
        assertEquals(browser.created[0].options.body, "The agent has stopped and is waiting for you.");
        browser.created[0].onclick?.(new Event("click"));
        assertEquals(browser.created[0].closed, true);
        assertEquals(browser.focusCount(), 1);
    } finally {
        browser.cleanup();
    }
});

test("browser notifications skip denied, missing API, disabled settings, and focused visible tabs", () => {
    const denied = installBrowser({ permission: "denied" });
    try {
        createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, enabledPolicy);
        assertEquals(denied.created.length, 0);
    } finally {
        denied.cleanup();
    }

    Reflect.deleteProperty(globalThis, "Notification");
    Reflect.set(globalThis, "document", { visibilityState: "hidden", hasFocus: () => false });
    Reflect.set(globalThis, "focus", () => {});
    createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, enabledPolicy);
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "focus");

    const disabled = installBrowser();
    try {
        createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, {
            enabled: false,
            events: { agentStopped: true },
            suppressWhenFocused: true,
        });
        createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, {
            enabled: true,
            events: { agentStopped: false },
            suppressWhenFocused: true,
        });
        assertEquals(disabled.created.length, 0);
    } finally {
        disabled.cleanup();
    }

    const focused = installBrowser({ visibilityState: "visible", focused: true });
    try {
        createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, enabledPolicy);
        assertEquals(focused.created.length, 0);
    } finally {
        focused.cleanup();
    }
});

test("browser notifications allow background and suppression-disabled focused delivery", () => {
    const focused = installBrowser({ visibilityState: "visible", focused: true });
    try {
        createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, {
            enabled: true,
            events: { agentStopped: true },
            suppressWhenFocused: false,
        });
        assertEquals(focused.created.length, 1);
    } finally {
        focused.cleanup();
    }
});

test("browser notifications ignore non-production event shapes and isolate failures", () => {
    const browser = installBrowser({ throwOnConstruct: true });
    try {
        const controller = createSessionTabNotificationController();
        controller.notifyAgentStopped({ type: "agentStopped" }, enabledPolicy);
        controller.notifyAgentStopped({ type: "attention_requested", reason: "planWritten" }, enabledPolicy);
        controller.notifyAgentStopped(stoppedEvent, enabledPolicy);
        assertEquals(browser.created.length, 0);
    } finally {
        browser.cleanup();
    }
});

test("browser notification disposal closes tracked notifications and clears click handlers", () => {
    const browser = installBrowser();
    try {
        const controller = createSessionTabNotificationController();
        controller.notifyAgentStopped(stoppedEvent, enabledPolicy);
        const notification = browser.created[0];
        controller.dispose();
        assertEquals(notification.closed, true);
        assertStrictEquals(notification.onclick, null);
    } finally {
        browser.cleanup();
    }
});

function installServiceWorker(
    registration: {
        active: boolean;
        showNotification(title: string, options: NotificationOptions): Promise<void>;
    } | undefined,
) {
    const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { getRegistration: () => Promise.resolve(registration) },
    });
    return () => {
        if (original) Object.defineProperty(navigator, "serviceWorker", original);
        else Reflect.deleteProperty(navigator, "serviceWorker");
    };
}

test("mobile notifications use the active service worker when the Notification constructor is unsupported", async () => {
    const browser = installBrowser({ throwOnConstruct: true });
    const shown: Array<{ title: string; options: NotificationOptions }> = [];
    const restore = installServiceWorker({
        active: true,
        showNotification(title, options) {
            shown.push({ title, options });
            return Promise.resolve();
        },
    });
    try {
        await createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, enabledPolicy);
        assertEquals(browser.created.length, 0);
        assertEquals(shown.length, 1);
        assertEquals(shown[0].title, "Guide: Agent stopped — Demo");
        assertEquals(shown[0].options.body, "The agent has stopped and is waiting for you.");
        assertEquals(shown[0].options.icon, "/pwa/icon-192.png");
    } finally {
        restore();
        browser.cleanup();
    }
});

test("notifications fall back to desktop delivery when no service worker is registered", async () => {
    const browser = installBrowser();
    const restore = installServiceWorker(undefined);
    try {
        await createSessionTabNotificationController().notifyAgentStopped(stoppedEvent, enabledPolicy);
        assertEquals(browser.created.length, 1);
    } finally {
        restore();
        browser.cleanup();
    }
});

test("leaving a Session cancels pending notification delivery", async () => {
    const browser = installBrowser();
    let count = 0;
    const restore = installServiceWorker({
        active: true,
        showNotification() {
            count++;
            return Promise.resolve();
        },
    });
    try {
        const controller = createSessionTabNotificationController();
        const delivery = controller.notifyAgentStopped(stoppedEvent, enabledPolicy);
        controller.dispose();
        await delivery;
        assertEquals(count, 0);
        assertEquals(browser.created.length, 0);
    } finally {
        restore();
        browser.cleanup();
    }
});

test("Workspace notifications ignore stops routed to another input surface", async () => {
    const browser = installBrowser();
    try {
        const controller = createSessionTabNotificationController();
        await controller.notifyAgentStopped({ ...stoppedEvent, notificationSurface: "tui" }, enabledPolicy);
        await controller.notifyAgentStopped({ ...stoppedEvent, notificationSurface: "acp" }, enabledPolicy);
        assertEquals(browser.created.length, 0);
        await controller.notifyAgentStopped({ ...stoppedEvent, notificationSurface: "workspace" }, enabledPolicy);
        assertEquals(browser.created.length, 1);
    } finally {
        browser.cleanup();
    }
});
