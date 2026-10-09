import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { createTuiCrashGuards } from "./tui-crash-guards.ts";

function createFakeEventTarget() {
    /** @type {Array<{ type: string, handler: () => void }>} */
    const added = [];
    /** @type {Array<{ type: string, handler: () => void }>} */
    const removed = [];
    /** @type {Map<string, () => void>} */
    const handlers = new Map();

    return {
        added,
        removed,
        handlers,
        addEventListener: (/** @type {string} */ type, /** @type {() => void} */ handler) => {
            added.push({ type, handler });
            handlers.set(type, handler);
        },
        removeEventListener: (/** @type {string} */ type, /** @type {() => void} */ handler) => {
            removed.push({ type, handler });
            if (handlers.get(type) === handler) handlers.delete(type);
        },
    };
}

function createFakeSignalRuntime() {
    /** @type {Array<{ signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void }>} */
    const added = [];
    /** @type {Array<{ signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void }>} */
    const removed = [];
    /** @type {Map<string, () => void>} */
    const handlers = new Map();

    return {
        added,
        removed,
        handlers,
        addSignalListener: (
            /** @type {"SIGINT" | "SIGTERM" | "SIGHUP"} */ signal,
            /** @type {() => void} */ handler,
        ) => {
            added.push({ signal, handler });
            handlers.set(signal, handler);
        },
        removeSignalListener: (
            /** @type {"SIGINT" | "SIGTERM" | "SIGHUP"} */ signal,
            /** @type {() => void} */ handler,
        ) => {
            removed.push({ signal, handler });
            if (handlers.get(signal) === handler) handlers.delete(signal);
        },
    };
}

test("createTuiCrashGuards installs and uninstalls event and signal handlers idempotently", () => {
    const eventTarget = createFakeEventTarget();
    const signalRuntime = createFakeSignalRuntime();
    const guards = createTuiCrashGuards({
        stop: () => {},
        eventTarget,
        signalRuntime,
        os: "darwin",
        exit: (code) => {
            throw new Error(`exit ${code}`);
        },
    });

    guards.install();
    guards.install();

    assertEquals(guards.isInstalled(), true);
    assertEquals(eventTarget.added.map((entry) => entry.type), ["unhandledrejection", "error"]);
    assertEquals(signalRuntime.added.map((entry) => entry.signal), ["SIGINT", "SIGTERM", "SIGHUP"]);

    guards.uninstall();
    guards.uninstall();

    assertEquals(guards.isInstalled(), false);
    assertEquals(eventTarget.removed.map((entry) => entry.type), ["unhandledrejection", "error"]);
    assertEquals(signalRuntime.removed.map((entry) => entry.signal), ["SIGINT", "SIGTERM", "SIGHUP"]);
    assertStrictEquals(eventTarget.removed[0].handler, eventTarget.added[0].handler);
    assertStrictEquals(signalRuntime.removed[0].handler, signalRuntime.added[0].handler);
});

test("createTuiCrashGuards restores TUI for unhandled promise and error events", () => {
    const eventTarget = createFakeEventTarget();
    const signalRuntime = createFakeSignalRuntime();
    let stops = 0;
    const guards = createTuiCrashGuards({
        stop: () => {
            stops++;
            if (stops === 2) throw new Error("stop failed");
        },
        eventTarget,
        signalRuntime,
        os: "linux",
        exit: (code) => {
            throw new Error(`exit ${code}`);
        },
    });

    guards.install();
    eventTarget.handlers.get("unhandledrejection")?.();
    eventTarget.handlers.get("error")?.();

    assertEquals(stops, 2);
});

test("createTuiCrashGuards signal handlers stop and exit with shell-compatible codes", () => {
    const eventTarget = createFakeEventTarget();
    const signalRuntime = createFakeSignalRuntime();
    /** @type {number[]} */
    const exits = [];
    let stops = 0;
    let cleanups = 0;
    const guards = createTuiCrashGuards({
        stop: () => {
            stops++;
        },
        eventTarget,
        signalRuntime,
        os: "linux",
        exit: (code) => {
            exits.push(code);
            throw new Error(`exit ${code}`);
        },
        cleanup: () => {
            cleanups++;
        },
    });

    guards.install();

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        try {
            signalRuntime.handlers.get(signal)?.();
        } catch (_e) {
            // Fake exit throws to keep the test process alive.
        }
    }

    assertEquals(stops, 3);
    assertEquals(cleanups, 3);
    assertEquals(exits, [130, 143, 129]);
});

test("createTuiCrashGuards skips SIGHUP on windows and tolerates signal runtime failures", () => {
    const eventTarget = createFakeEventTarget();
    /** @type {string[]} */
    const attempted = [];
    const signalRuntime = {
        addSignalListener: (/** @type {"SIGINT" | "SIGTERM" | "SIGHUP"} */ signal) => {
            attempted.push(`add:${signal}`);
            throw new Error("no signals");
        },
        removeSignalListener: (/** @type {"SIGINT" | "SIGTERM" | "SIGHUP"} */ signal) => {
            attempted.push(`remove:${signal}`);
            throw new Error("no signals");
        },
    };
    const guards = createTuiCrashGuards({
        stop: () => {},
        eventTarget,
        signalRuntime,
        os: "windows",
        exit: (code) => {
            throw new Error(`exit ${code}`);
        },
    });

    guards.install();
    guards.uninstall();

    assertEquals(attempted, ["add:SIGINT", "remove:SIGINT"]);
    assertEquals(eventTarget.added.map((entry) => entry.type), ["unhandledrejection", "error"]);
    assertEquals(eventTarget.removed.map((entry) => entry.type), ["unhandledrejection", "error"]);
});
