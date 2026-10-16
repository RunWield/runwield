import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { createManagedSessionSyncController } from "./managed-session-sync.js";

function createTimerFixture() {
    /** @type {Array<() => void | Promise<void>>} */
    const callbacks = [];
    /** @type {unknown[]} */
    const cleared = [];
    return {
        callbacks,
        cleared,
        port: {
            set(/** @type {() => void} */ callback) {
                callbacks.push(callback);
                return callback;
            },
            clear(/** @type {unknown} */ timer) {
                cleared.push(timer);
            },
        },
    };
}

test("managed sync controller schedules fixture timers around a real SessionRuntime", async () => {
    const runtime = createSessionRuntime();
    const timer = createTimerFixture();
    const controller = createManagedSessionSyncController({
        runtime,
        getSessionId: () => "missing-session",
        timer: timer.port,
    });

    controller.start();
    assertEquals(timer.callbacks.length, 1);
    await timer.callbacks.shift()?.();
    assertEquals(runtime.getSessionSnapshot("missing-session"), null);

    controller.resume();
    assertEquals(timer.callbacks.length, 1);
    await controller.pause();
    assertEquals(timer.cleared.length, 1);
    await controller.dispose();
    runtime.closeAllSessions();
});

test("managed sync controller never schedules after disposal", async () => {
    const runtime = createSessionRuntime();
    const timer = createTimerFixture();
    const controller = createManagedSessionSyncController({
        runtime,
        getSessionId: () => null,
        timer: timer.port,
    });

    await controller.dispose();
    controller.start();
    controller.resume();
    assertEquals(timer.callbacks, []);
    runtime.closeAllSessions();
});
