import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { handleBashCommand } from "./bash-interceptor.ts";

/**
 * @param {string} userRequest
 * @param {boolean} [concurrent]
 */
function makeContext(userRequest, concurrent = false) {
    /** @type {any[]} */
    const calls = [];
    const sessionRuntime = /** @type {import('../../shared/session/session-runtime.ts').SessionRuntime} */ (
        /** @type {unknown} */ ({
            runLocalShellCommand: (/** @type {string} */ sessionId, /** @type {any} */ options) => {
                calls.push({ sessionId, options });
                return Promise.resolve({ ok: true, exitCode: 0, output: "" });
            },
        })
    );
    return { userRequest, concurrent, sessionRuntime, sessionId: "runtime-session", calls };
}

test("handleBashCommand ignores non-bang input and swallows an empty bang", async () => {
    const ordinary = makeContext("hello");
    const empty = makeContext("!");

    assertEquals(await handleBashCommand(ordinary), false);
    assertEquals(await handleBashCommand(empty), true);
    assertEquals(ordinary.calls, []);
    assertEquals(empty.calls, []);
});

test("handleBashCommand delegates persistent commands to SessionRuntime", async () => {
    const ctx = makeContext("!printf hello");

    assertEquals(await handleBashCommand(ctx), true);
    assertEquals(ctx.calls, [{
        sessionId: "runtime-session",
        options: { command: "printf hello", userRequest: "!printf hello", persist: true },
    }]);
});

test("handleBashCommand marks double-bang commands ephemeral", async () => {
    const ctx = makeContext("!!printf hidden");

    assertEquals(await handleBashCommand(ctx), true);
    assertEquals(ctx.calls[0].options.persist, false);
    assertEquals(ctx.calls[0].options.command, "printf hidden");
});

test("handleBashCommand never persists commands submitted during an active turn", async () => {
    const ctx = makeContext("!printf concurrent", true);

    assertEquals(await handleBashCommand(ctx), true);
    assertEquals(ctx.calls[0].options.persist, false);
});
