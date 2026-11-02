import { assertEquals } from "../../testing/assertions.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { runReloadCommand } from "./index.ts";
import type { CommandContext } from "../registry.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";

type ReloadFixtureSnapshot = Pick<NonNullable<ReturnType<SessionRuntime["getSessionSnapshot"]>>, "cwd">;

interface ReloadFixtureRuntime extends Pick<SessionRuntime, "reloadSession"> {
    getSessionSnapshot(...args: Parameters<SessionRuntime["getSessionSnapshot"]>): ReloadFixtureSnapshot;
}

interface ReloadFixtureContext extends Pick<CommandContext, "sessionId"> {
    sessionRuntime: ReloadFixtureRuntime;
    uiAPI: Pick<NonNullable<CommandContext["uiAPI"]>, "appendSystemMessage">;
}

type FixtureReloadCommand = (
    argv: Parameters<typeof runReloadCommand>[0],
    options: ReloadFixtureContext,
) => ReturnType<typeof runReloadCommand>;

test("runReloadCommand reloads only through SessionRuntime", async () => {
    const messages: string[] = [];
    await (runReloadCommand as FixtureReloadCommand)([], {
        sessionId: "reload-test",
        sessionRuntime: {
            reloadSession: () => Promise.resolve({ ok: false }),
            getSessionSnapshot: () => ({ cwd: getCwd() }),
        },
        uiAPI: {
            appendSystemMessage: (message) => messages.push(message),
        },
    });
    assertEquals(messages, ["Reload skipped (no active root session found)."]);
});

test("runReloadCommand reports deferred managed dormant reload", async () => {
    const messages: string[] = [];
    await (runReloadCommand as FixtureReloadCommand)([], {
        sessionId: "reload-test",
        sessionRuntime: {
            reloadSession: () => Promise.resolve({ ok: true, deferred: true }),
            getSessionSnapshot: () => ({ cwd: getCwd() }),
        },
        uiAPI: {
            appendSystemMessage: (message) => messages.push(message),
        },
    });
    assertEquals(messages, [
        "Successfully reloaded configs and themes. Agent context will rebuild on the next managed turn.",
    ]);
});
