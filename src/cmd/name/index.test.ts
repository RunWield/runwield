import { getCwd } from "../../constants.js";
import process from "node:process";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
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
        const previousHome = process.env["HOME"];
        const previousSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousCwd = getCwd();
        const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-name-command-"));
        const homeDir = join(fixtureRoot, "home");
        const projectRoot = join(fixtureRoot, "project");
        await Promise.all([
            fsMkdir(homeDir, { recursive: true }),
            fsMkdir(projectRoot, { recursive: true }),
        ]);

        try {
            process.env["HOME"] = homeDir;
            process.env["WLD_TEST_SANDBOX_HOME"] = homeDir;
            process.chdir(projectRoot);
            __resetSettingsForTests();
            initRunWieldTheme();
            await run({ projectRoot });
        } finally {
            __resetSettingsForTests();
            process.chdir(previousCwd);
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            if (previousSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = previousSandboxHome;
            await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
        }
    });
}

async function createRuntimeSession(projectRoot: string): Promise<{ runtime: SessionRuntime; sessionId: string }> {
    const runtime = createSessionRuntime();
    const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
    return { runtime, sessionId: created.sessionId };
}

test("runNameCommand persists and reports a sanitized name through a real Runtime session", async () => {
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

test("runNameCommand reports unnamed and missing real Runtime sessions", async () => {
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

test("runNameCommand reports unavailable interactive state", async () => {
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
