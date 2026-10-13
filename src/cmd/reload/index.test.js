import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { runReloadCommand } from "./index.ts";

test("runReloadCommand reloads only through SessionRuntime", async () => {
    const messages = /** @type {string[]} */ ([]);
    await runReloadCommand([], {
        sessionId: "reload-test",
        sessionRuntime: /** @type {any} */ ({
            reloadSession: () => Promise.resolve({ ok: false }),
            getSessionSnapshot: () => ({ cwd: getCwd() }),
        }),
        uiAPI: /** @type {any} */ ({
            appendSystemMessage: (/** @type {string} */ message) => messages.push(message),
        }),
    });
    assertEquals(messages, ["Reload skipped (no active root session found)."]);
});

test("runReloadCommand reports deferred managed dormant reload", async () => {
    const messages = /** @type {string[]} */ ([]);
    await runReloadCommand([], {
        sessionId: "reload-test",
        sessionRuntime: /** @type {any} */ ({
            reloadSession: () => Promise.resolve({ ok: true, deferred: true }),
            getSessionSnapshot: () => ({ cwd: getCwd() }),
        }),
        uiAPI: /** @type {any} */ ({
            appendSystemMessage: (/** @type {string} */ message) => messages.push(message),
        }),
    });
    assertEquals(messages, [
        "Successfully reloaded configs and themes. Agent context will rebuild on the next managed turn.",
    ]);
});
