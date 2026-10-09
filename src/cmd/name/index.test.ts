import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { __resetSettingsForTests } from "../../shared/settings.js";
import { createSessionRuntime, type SessionRuntime } from "../../shared/session/session-runtime.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { initRunWieldTheme } from "../../ui/theme/theme.js";
import { runNameCommand } from "./index.ts";

interface NameCommandFixture {
    projectRoot: string;
}

async function withNameCommandFixture(run: (fixture: NameCommandFixture) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const previousSandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        const previousCwd = Deno.cwd();
        const fixtureRoot = await Deno.makeTempDir({ prefix: "runwield-name-command-" });
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            Deno.mkdir(homeDir, { recursive: true }),
            Deno.mkdir(projectRoot, { recursive: true }),
        ]);

        try {
            Deno.env.set("HOME", homeDir);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", homeDir);
            Deno.chdir(projectRoot);
            __resetSettingsForTests();
            initRunWieldTheme();
            await run({ projectRoot });
        } finally {
            __resetSettingsForTests();
            Deno.chdir(previousCwd);
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousSandboxHome === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", previousSandboxHome);
            await Deno.remove(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}

async function createRuntimeSession(projectRoot: string): Promise<{ runtime: SessionRuntime; sessionId: string }> {
    const runtime = createSessionRuntime();
    const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
    return { runtime, sessionId: created.sessionId };
}

Deno.test("runNameCommand persists and reports a sanitized name through a real Runtime session", async () => {
    await withNameCommandFixture(async ({ projectRoot }) => {
        const { runtime, sessionId } = await createRuntimeSession(projectRoot);
        const messages: string[] = [];
        const uiAPI = { appendSystemMessage: (message: string) => messages.push(message) };
        try {
            await runNameCommand(["  build", "coverage\n"], { uiAPI, sessionRuntime: runtime, sessionId });
            assertEquals(messages.length, 1);
            assertStringIncludes(messages[0], "Session name set: build coverage");

            messages.length = 0;
            await runNameCommand([], { uiAPI, sessionRuntime: runtime, sessionId });
            assertEquals(messages.length, 1);
            assertStringIncludes(messages[0], "Session name: build coverage");
        } finally {
            runtime.closeSession(sessionId);
        }
    });
});

Deno.test("runNameCommand reports unnamed and missing real Runtime sessions", async () => {
    await withNameCommandFixture(async ({ projectRoot }) => {
        const { runtime, sessionId } = await createRuntimeSession(projectRoot);
        const messages: string[] = [];
        const uiAPI = { appendSystemMessage: (message: string) => messages.push(message) };
        try {
            await runNameCommand([], { uiAPI, sessionRuntime: runtime, sessionId });
            assertStringIncludes(messages.at(-1) || "", "Usage: /name <name>");

            await runNameCommand(["missing"], {
                uiAPI,
                sessionRuntime: runtime,
                sessionId: "missing-session",
            });
            assertStringIncludes(messages.at(-1) || "", "Session name not changed: not_found");
        } finally {
            runtime.closeSession(sessionId);
        }
    });
});

Deno.test("runNameCommand reports unavailable interactive state", async () => {
    await withNameCommandFixture(async () => {
        const originalError = console.error;
        const errors: string[] = [];
        console.error = (message = "") => errors.push(String(message));
        try {
            await runNameCommand([]);
        } finally {
            console.error = originalError;
        }
        assertEquals(errors, ["The /name command is only available inside an interactive session."]);

        const messages: string[] = [];
        await runNameCommand(["name"], {
            uiAPI: { appendSystemMessage: (message: string) => messages.push(message) },
        });
        assertEquals(messages, ["Error: No active session."]);
    });
});
