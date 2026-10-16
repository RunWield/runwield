import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { getCwd } from "../../constants.js";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import {
    registerScriptedOAuthProvider,
    SCRIPTED_OAUTH_MODEL,
    SCRIPTED_OAUTH_PROVIDER_ID,
    withRuntimeCommandFixture,
} from "../../cmd/testing/runtime-command-fixture.ts";
import { getModelRegistry } from "../../shared/models/model-registry.ts";
import { getSettingsManager } from "../../shared/settings.js";
import { startRunWieldAcpServer } from "../../acp/server.js";
import { initTUIWithPair, stopTUI } from "./tui.ts";
import { runTerminalAuthSetup } from "./terminal-auth-setup.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";

interface AcpMessage {
    id?: string;
    result?: { sessionId?: string };
    error?: { code?: number; message?: string };
}

interface AcpHandle {
    inputWriter: WritableStreamDefaultWriter<Uint8Array>;
    outputReader: ReadableStreamDefaultReader<Uint8Array>;
    connection: { close(): void; closed: Promise<void> };
}

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../../..");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pathExists(path: string): Promise<boolean> {
    try {
        await fsStat(path);
        return true;
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        throw error;
    }
}

async function waitForScreen(terminal: VirtualTerminal, text: string, timeoutMs = 10_000): Promise<string> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const screen = terminal.getScreenText();
        if (screen.includes(text)) return screen;
        await new Promise((resolveStep) => setTimeout(resolveStep, 25));
    }
    const screen = terminal.getScreenText();
    throw new Error(`Timed out waiting for ${text}. Screen:\n${screen}`);
}

function installVirtualTui(): VirtualTerminal {
    stopTUI();
    const terminal = new VirtualTerminal({ columns: 120, rows: 40 });
    initTUIWithPair({ terminal, tui: new TuiMainScreen(terminal) });
    return terminal;
}

function startAcpServer(): AcpHandle {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const connection = startRunWieldAcpServer(input.readable, output.writable, { diagnostic: () => {} });
    return {
        inputWriter: input.writable.getWriter(),
        outputReader: output.readable.getReader(),
        connection,
    };
}

async function requestAcpSessionNew(cwd: string): Promise<AcpMessage> {
    const handle = startAcpServer();
    try {
        await handle.inputWriter.write(
            encoder.encode(
                `${
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: "new",
                        method: "session/new",
                        params: { cwd, mcpServers: [] },
                    })
                }\n`,
            ),
        );
        const chunk = await handle.outputReader.read();
        assert(!chunk.done, "ACP server should respond");
        return JSON.parse(decoder.decode(chunk.value).trim()) as AcpMessage;
    } finally {
        await handle.inputWriter.close();
        handle.connection.close();
        await handle.connection.closed;
        handle.outputReader.releaseLock();
    }
}

async function assertNoRunWieldSessionState(homeDir: string): Promise<void> {
    assertEquals(await pathExists(join(homeDir, ".wld", "sessions")), false);
    assertEquals(await pathExists(join(homeDir, ".wld", "projects")), false);
}

test("terminal auth setup saves an API key, default model, cleanup, and then permits a real ACP Session", async () => {
    await withRuntimeCommandFixture("terminal-auth-api-key-", async ({ alternateRoot, homeDir }) => {
        const registry = getModelRegistry();
        await registry.logoutProvider("runtime-command-fixture");
        const settings = getSettingsManager(getCwd());
        await settings.setDefaultModel("");
        await settings.setDefaultProvider("");
        const terminal = installVirtualTui();
        try {
            const setup = runTerminalAuthSetup(["api-key", "runtime-command-fixture"]);
            await waitForScreen(terminal, "Enter API key for Runtime Command Fixture Provider:");
            terminal.typeText("terminal-auth-secret");
            terminal.pressEnter();
            await waitForScreen(terminal, "Only showing models from configured providers");
            terminal.pressEnter();
            const result = await setup;

            assertEquals(result.status, "ready");
            assertEquals(terminal.stopped, true);
            assertEquals(await registry.getStoredCredentialType("runtime-command-fixture"), "api_key");
            assertEquals(settings.getDefaultProvider(), "runtime-command-fixture");
            assertEquals(settings.getDefaultModel(), "fixture-model");
            await assertNoRunWieldSessionState(homeDir);

            const acp = await requestAcpSessionNew(alternateRoot);
            assert(acp.result?.sessionId, JSON.stringify(acp));
        } finally {
            stopTUI();
        }
    }, { providerState: "provider-no-model" });
});

test("terminal auth setup saves scripted OAuth credentials and a default model", async () => {
    await withRuntimeCommandFixture("terminal-auth-oauth-", async ({ homeDir }) => {
        const provider = await registerScriptedOAuthProvider();
        provider.setOutcome({ kind: "success" });
        const terminal = installVirtualTui();
        try {
            const setup = runTerminalAuthSetup(["subscription", SCRIPTED_OAUTH_PROVIDER_ID]);
            await waitForScreen(terminal, "Paste the redirect URL");
            terminal.typeText("https://fixture.example/callback");
            terminal.pressEnter();
            await waitForScreen(terminal, "Only showing models from configured providers");
            terminal.typeText(SCRIPTED_OAUTH_MODEL);
            terminal.pressEnter();
            const result = await setup;

            assertEquals(result.status, "ready");
            assertEquals(await getModelRegistry().getStoredCredentialType(SCRIPTED_OAUTH_PROVIDER_ID), "oauth");
            assertEquals(getSettingsManager(getCwd()).getDefaultProvider(), SCRIPTED_OAUTH_PROVIDER_ID);
            assertEquals(getSettingsManager(getCwd()).getDefaultModel(), SCRIPTED_OAUTH_MODEL);
            await assertNoRunWieldSessionState(homeDir);
        } finally {
            await provider.unregister();
            stopTUI();
        }
    }, { providerState: "none" });
});

test("terminal auth setup can choose Claude CLI without provider credentials", async () => {
    await withRuntimeCommandFixture("terminal-auth-claude-cli-", async ({ homeDir }) => {
        const terminal = installVirtualTui();
        try {
            const setup = runTerminalAuthSetup([]);
            await waitForScreen(terminal, "Welcome to RunWield");
            terminal.pressEnter();
            await waitForScreen(terminal, "Only showing models from configured providers");
            terminal.pressEnter();
            const result = await setup;

            assertEquals(result.status, "ready");
            assertEquals(getSettingsManager(getCwd()).getDefaultProvider(), "claude-cli");
            assertEquals(getSettingsManager(getCwd()).getDefaultModel(), "sonnet");
            await assertNoRunWieldSessionState(homeDir);
        } finally {
            stopTUI();
        }
    }, { providerState: "none" });
});

test("terminal auth setup can choose Antigravity CLI without provider credentials", async () => {
    await withRuntimeCommandFixture("terminal-auth-agy-cli-", async ({ homeDir }) => {
        const terminal = installVirtualTui();
        try {
            const setup = runTerminalAuthSetup([]);
            await waitForScreen(terminal, "Welcome to RunWield");
            terminal.typeText("Antigravity");
            terminal.pressEnter();
            await waitForScreen(terminal, "Only showing models from configured providers");
            await waitForScreen(terminal, "agy-cli/gemini-3.8-flash");
            await waitForScreen(terminal, "agy-cli/gemini-3.1-pro");
            terminal.pressEnter();
            const result = await setup;

            assertEquals(result.status, "ready");
            assertEquals(getSettingsManager(getCwd()).getDefaultProvider(), "agy-cli");
            assert(
                ["gemini-3.8-flash", "gemini-3.1-pro"].includes(getSettingsManager(getCwd()).getDefaultModel() || ""),
            );
            assertEquals(await pathExists(join(homeDir, ".gemini")), false);
            await assertNoRunWieldSessionState(homeDir);
        } finally {
            stopTUI();
        }
    }, { providerState: "none" });
});

test("terminal auth setup exits nonzero state when model selection is canceled after login", async () => {
    await withRuntimeCommandFixture("terminal-auth-cancel-model-", async () => {
        const registry = getModelRegistry();
        await registry.logoutProvider("runtime-command-fixture");
        const settings = getSettingsManager(getCwd());
        await settings.setDefaultModelAndProvider("claude-cli", "sonnet");
        const terminal = installVirtualTui();
        try {
            const setup = runTerminalAuthSetup(["api-key", "runtime-command-fixture"]);
            await waitForScreen(terminal, "Enter API key for Runtime Command Fixture Provider:");
            terminal.typeText("terminal-auth-secret");
            terminal.pressEnter();
            await waitForScreen(terminal, "Only showing models from configured providers");
            terminal.pressEscape();
            const result = await setup;

            assertEquals(result.status, "canceled");
            assertStringIncludes(result.message, "Model selection canceled");
            assertEquals(await registry.getStoredCredentialType("runtime-command-fixture"), "api_key");
            assertEquals(settings.getDefaultProvider(), "claude-cli");
            assertEquals(settings.getDefaultModel(), "sonnet");
        } finally {
            stopTUI();
        }
    }, { providerState: "provider-no-model" });
});

test("terminal auth setup cancels at the shared setup choice", async () => {
    await withRuntimeCommandFixture("terminal-auth-auth-type-cancel-", async () => {
        const terminal = installVirtualTui();
        const setup = runTerminalAuthSetup([]);
        await waitForScreen(terminal, "Welcome to RunWield");
        terminal.pressEscape();
        assertEquals((await setup).status, "canceled");
    }, { providerState: "none" });
});

test("terminal auth setup cancellations and failures do not report ready or store invalid credentials", async () => {
    await withRuntimeCommandFixture("terminal-auth-failures-", async () => {
        const registry = getModelRegistry();
        await registry.logoutProvider("runtime-command-fixture");

        let terminal = installVirtualTui();
        let setup = runTerminalAuthSetup(["api-key"]);
        await waitForScreen(terminal, "Select provider to configure:");
        await new Promise((resolveStep) => setTimeout(resolveStep, 100));
        terminal.pressEscape();
        await terminal.flush();
        await waitForScreen(terminal, "Select authentication method:");
        await new Promise((resolveStep) => setTimeout(resolveStep, 100));
        terminal.pressEscape();
        await terminal.flush();
        assertEquals((await setup).status, "canceled");

        terminal = installVirtualTui();
        setup = runTerminalAuthSetup(["api-key", "runtime-command-fixture"]);
        await waitForScreen(terminal, "Enter API key for Runtime Command Fixture Provider:");
        await new Promise((resolveStep) => setTimeout(resolveStep, 100));
        terminal.pressEscape();
        await terminal.flush();
        assertEquals((await setup).status, "canceled");

        terminal = installVirtualTui();
        setup = runTerminalAuthSetup(["api-key", "runtime-command-fixture"]);
        await waitForScreen(terminal, "Enter API key for Runtime Command Fixture Provider:");
        terminal.typeText("   ");
        terminal.pressEnter();
        await new Promise((resolveStep) => setTimeout(resolveStep, 100));
        terminal.pressEscape();
        await terminal.flush();
        const whitespace = await setup;
        assertEquals(whitespace.status, "canceled");
        assertEquals(await registry.getStoredCredentialType("runtime-command-fixture"), undefined);
    }, { providerState: "provider-no-model" });
});

test("terminal auth setup maps OAuth cancellation and provider failure to non-ready results", async () => {
    await withRuntimeCommandFixture("terminal-auth-oauth-failures-", async () => {
        const provider = await registerScriptedOAuthProvider();
        try {
            provider.setOutcome({ kind: "cancel" });
            installVirtualTui();
            let setup = runTerminalAuthSetup(["subscription", SCRIPTED_OAUTH_PROVIDER_ID]);
            const canceled = await setup;
            assertEquals(canceled.status, "canceled");
            assertEquals(await getModelRegistry().getStoredCredentialType(SCRIPTED_OAUTH_PROVIDER_ID), undefined);

            provider.setOutcome({ kind: "failure", error: "scripted provider failure" });
            installVirtualTui();
            setup = runTerminalAuthSetup(["subscription", SCRIPTED_OAUTH_PROVIDER_ID]);
            const failed = await setup;
            assertEquals(failed.status, "failed");
            assertStringIncludes(failed.message, "scripted provider failure");
            assertEquals(await getModelRegistry().getStoredCredentialType(SCRIPTED_OAUTH_PROVIDER_ID), undefined);
        } finally {
            await provider.unregister();
            stopTUI();
        }
    }, { providerState: "none" });
});

test("terminal auth setup does not import the normal chat Session composition", async () => {
    const source = await fsReadFile("src/ui/tui/terminal-auth-setup.ts", "utf8");
    assert(!source.includes("chat-session"));
    assert(!source.includes("createInteractiveSession"));
    assert(!source.includes("SessionRuntime"));
});

async function symlinkEntries(sourceDir: string, targetDir: string, skip: Set<string>): Promise<void> {
    await fsMkdir(targetDir, { recursive: true });
    for await (const entry of await fsReaddir(sourceDir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        await fsSymlink(join(sourceDir, entry.name), join(targetDir, entry.name), entry.isDirectory() ? "dir" : "file");
    }
}

test("terminal auth setup succeeds against a temporary source mutation where createInteractiveSession throws", async () => {
    const tempRoot = await fsMkdtemp(join(tmpdir(), "terminal-auth-mutated-source-"));
    try {
        await fsSymlink(join(REPO_ROOT, "runtime-root.js"), join(tempRoot, "runtime-root.js"));
        await fsSymlink(join(REPO_ROOT, "node_modules"), join(tempRoot, "node_modules"), "dir");
        await symlinkEntries(join(REPO_ROOT, "src"), join(tempRoot, "src"), new Set(["shared"]));
        await symlinkEntries(join(REPO_ROOT, "src", "shared"), join(tempRoot, "src", "shared"), new Set(["session"]));
        await symlinkEntries(
            join(REPO_ROOT, "src", "shared", "session"),
            join(tempRoot, "src", "shared", "session"),
            new Set(["session-runtime.ts"]),
        );
        const runtimeSource = await fsReadFile(
            join(REPO_ROOT, "src", "shared", "session", "session-runtime.ts"),
            "utf8",
        );
        const mutatedRuntimeSource = runtimeSource.replace(
            '    createInteractiveSession(...args: Parameters<RuntimeLifecycle["createInteractiveSession"]>) {',
            '    createInteractiveSession(...args: Parameters<RuntimeLifecycle["createInteractiveSession"]>) {\n' +
                '        throw new Error("mutated createInteractiveSession called");',
        );
        assert(mutatedRuntimeSource !== runtimeSource);
        await fsWriteFile(join(tempRoot, "src", "shared", "session", "session-runtime.ts"), mutatedRuntimeSource);
        const childScript = join(tempRoot, "mutation-proof.ts");
        await fsWriteFile(
            childScript,
            `import { assertEquals } from ${JSON.stringify(import.meta.resolve("../../testing/assertions.ts"))};\n` +
                `import { TuiMainScreen } from "@earendil-works/pi-tui";\n` +
                `import { withRuntimeCommandFixture } from "./src/cmd/testing/runtime-command-fixture.ts";\n` +
                `import { getModelRegistry } from "./src/shared/models/model-registry.ts";\n` +
                `import { getSettingsManager } from "./src/shared/settings.js";\n` +
                `import { initTUIWithPair, stopTUI } from "./src/ui/tui/tui.ts";\n` +
                `import { runTerminalAuthSetup } from "./src/ui/tui/terminal-auth-setup.ts";\n` +
                `import { VirtualTerminal } from "./src/ui/tui/testing/virtual-terminal.js";\n` +
                `async function waitForScreen(terminal: VirtualTerminal, text: string): Promise<void> {\n` +
                `  const startedAt = Date.now();\n` +
                `  while (Date.now() - startedAt < 10000) {\n` +
                `    if (terminal.getScreenText().includes(text)) return;\n` +
                `    await new Promise((resolveStep) => setTimeout(resolveStep, 25));\n` +
                `  }\n` +
                `  throw new Error("Timed out waiting for " + text + ". Screen:\\n" + terminal.getScreenText());\n` +
                `}\n` +
                `await withRuntimeCommandFixture("terminal-auth-mutation-proof-", async () => {\n` +
                `  await getModelRegistry().logoutProvider("runtime-command-fixture");\n` +
                `  const settings = getSettingsManager((await import("node:process")).cwd());\n` +
                `  await settings.setDefaultModel("");\n` +
                `  await settings.setDefaultProvider("");\n` +
                `  stopTUI();\n` +
                `  const terminal = new VirtualTerminal({ columns: 120, rows: 40 });\n` +
                `  initTUIWithPair({ terminal, tui: new TuiMainScreen(terminal) });\n` +
                `  const setup = runTerminalAuthSetup(["api-key", "runtime-command-fixture"]);\n` +
                `  await waitForScreen(terminal, "Enter API key for Runtime Command Fixture Provider:");\n` +
                `  terminal.typeText("terminal-auth-secret");\n` +
                `  terminal.pressEnter();\n` +
                `  await waitForScreen(terminal, "Only showing models from configured providers");\n` +
                `  terminal.pressEnter();\n` +
                `  assertEquals((await setup).status, "ready");\n` +
                `}, { providerState: "provider-no-model" });\n`,
        );
        const output = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "--no-check", "--config", join(REPO_ROOT, "deno.json"), childScript]),
            cwd: tempRoot,
        });
        assertEquals(
            output.code,
            0,
            `mutation proof failed\nstdout:\n${decoder.decode(output.stdout)}\nstderr:\n${
                decoder.decode(output.stderr)
            }`,
        );
    } finally {
        await fsRm(tempRoot, { recursive: true }).catch(() => {});
    }
});
