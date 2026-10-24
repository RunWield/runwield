import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { handleBashCommand } from "./bash-interceptor.ts";

type ShellCommandOptions = Parameters<SessionRuntime["runLocalShellCommand"]>[1];

interface RecordedShellCommand {
    sessionId: string;
    options: ShellCommandOptions;
}

function makeContext(userRequest: string, concurrent = false) {
    const calls: RecordedShellCommand[] = [];
    // Preserve the existing partial runtime fixture; only local shell delegation is exercised here.
    const sessionRuntime = {
        runLocalShellCommand: (sessionId: string, options: ShellCommandOptions) => {
            calls.push({ sessionId, options });
            return Promise.resolve({ ok: true, exitCode: 0, output: "" });
        },
    } as Partial<SessionRuntime> as SessionRuntime;
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
    assertEquals(ctx.calls, [
        {
            sessionId: "runtime-session",
            options: { command: "printf hello", userRequest: "!printf hello", persist: true },
        },
    ]);
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
