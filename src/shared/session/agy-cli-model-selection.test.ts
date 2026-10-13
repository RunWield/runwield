import { delimiter } from "node:path";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
    chmod as fsChmod,
    rm as fsRm,
    mkdir as fsMkdir,
    realpath as fsRealpath,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { AGENTS } from "../../constants.js";
import { runModelsCommand } from "../../cmd/models/index.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { assertModelExecutionBackendSupported } from "../models/model-execution.ts";
import { getModelRegistry } from "../models/model-registry.ts";
import { getSettingsManager } from "../settings.js";
import {
    inspectAgyCliMcpSetup,
    installAgyCliMcpSetup,
    resolveInstalledWldExecutable,
} from "./backends/agy-cli/mcp-setup.ts";
import { SessionHost } from "./session-host.ts";
import { createSessionRuntime, SessionRuntime } from "./session-runtime.ts";

const WLD_EXECUTABLE = process.platform === "win32" ? "wld.exe" : "wld";
const AGY_EXECUTABLE = process.platform === "win32" ? "agy.exe" : "agy";

const FIXTURE_MODEL = "runtime-command-fixture/fixture-model";
const AGY_FLASH = "agy-cli/gemini-3.8-flash";

async function installAgyModelSelectionFixture(homeDir: string): Promise<string> {
    const binDir = join(homeDir, "agy-bin");
    await fsMkdir(binDir, { recursive: true });
    // MCP setup inspects this binary header; the model-selection fixture never executes wld.
    await fsWriteFile(
        join(binDir, WLD_EXECUTABLE),
        process.platform === "win32"
            ? new Uint8Array([0x4d, 0x5a, 0, 0])
            : new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]),
    );
    await fsChmod(join(binDir, WLD_EXECUTABLE), 0o755);
    const agyPath = fileURLToPath(new URL("./backends/agy-cli/testing/fake-agy-model-selection.ts", import.meta.url));
    await writeRuntimeExecutableFixture(join(binDir, "agy"), agyPath);
    return binDir;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await fsStat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

test("approved Agy CLI models are registered and accepted by typed execution backend dispatch", () => {
    for (const modelId of ["gemini-3.8-flash", "gemini-3.1-pro"]) {
        const model = getModelRegistry().find("agy-cli", modelId);
        assert(model);
        assertEquals(model.id, modelId);
        assertModelExecutionBackendSupported(model);
    }
    assertEquals(getModelRegistry().find("agy-cli", "fixture-model"), undefined);
});

test("unsupported Agy CLI selection is rejected before approval, agy launch, or global files", async () => {
    await withRuntimeCommandFixture(
        "runwield-agy-cli-unsupported-",
        async ({ homeDir, projectRoot }) => {
            const messages: Array<{ text: string; isError: boolean }> = [];
            const runtime = createSessionRuntime();
            const agyLaunchLog = join(homeDir, "agy-launched.log");
            const previousPath = process.env["PATH"] || "";
            try {
                const binDir = await installAgyModelSelectionFixture(homeDir);
                await fsRm(join(binDir, AGY_EXECUTABLE));
                const unexpectedSource = join(binDir, "unexpected-launch.ts");
                await fsWriteFile(
                    unexpectedSource,
                    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(agyLaunchLog)}, "launched\\n"); process.exit(2);`,
                );
                await writeRuntimeExecutableFixture(join(binDir, "agy"), unexpectedSource);
                process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
                const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });

                await runModelsCommand(["agy-cli/fixture-model"], {
                    uiAPI: {
                        appendSystemMessage: (message, isError = false) => messages.push({ text: message, isError }),
                        promptSelect: () => Promise.resolve(null),
                    },
                    sessionId,
                    sessionRuntime: runtime,
                });

                assertEquals(messages.length, 1);
                assertEquals(messages[0].isError, true);
                assertStringIncludes(messages[0].text, "Unsupported Antigravity CLI model");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, { model: "", provider: "" });
                assertEquals(await pathExists(agyLaunchLog), false);
                assertEquals(await pathExists(join(homeDir, ".gemini")), false);
            } finally {
                process.env["PATH"] = previousPath;
                runtime.closeAllSessions();
            }
        },
        { providerState: "none" },
    );
});

test("declined Agy MCP setup keeps the approved selected model without launching agy", async () => {
    await withRuntimeCommandFixture("runwield-agy-cli-setup-decline-", async ({ homeDir, projectRoot }) => {
        let runtime: SessionRuntime | null = null;
        const agyLaunchLog = join(homeDir, "agy-launched.log");
        const previousPath = process.env["PATH"] || "";
        try {
            const binDir = await installAgyModelSelectionFixture(homeDir);
            await fsRm(join(binDir, AGY_EXECUTABLE));
            const unexpectedSource = join(binDir, "unexpected-launch.ts");
            await fsWriteFile(
                unexpectedSource,
                `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(agyLaunchLog)}, "launched\\n"); process.exit(2);`,
            );
            await writeRuntimeExecutableFixture(join(binDir, "agy"), unexpectedSource);
            process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
            assertEquals(await resolveInstalledWldExecutable(), await fsRealpath(join(binDir, WLD_EXECUTABLE)));

            const sessionHost = new SessionHost();
            const hostedSession = sessionHost.createSession({ cwd: projectRoot });
            hostedSession.setActiveModelState("fixture-model", "runtime-command-fixture", true);
            hostedSession.setRootAgentName(AGENTS.GUIDE);
            runtime = new SessionRuntime({
                sessionHost,
                sessionStore: null,
                ownerProcessKind: "test",
                ownerInstanceId: "agy-setup-decline-test",
            });
            let interactionCount = 0;
            hostedSession.setInteractionAdapter({
                requestInteraction: () => {
                    interactionCount += 1;
                    return { outcome: "accepted", value: "decline" };
                },
                supportsInteraction: () => true,
            });

            const activeRuntime = runtime;
            await assertRejects(
                () => activeRuntime.reconfigureSessionModel(hostedSession.id, "gemini-3.8-flash", "agy-cli"),
                Error,
                "not approved",
            );
            assertEquals(interactionCount, 1);
            assertEquals(runtime.getSessionSnapshot(hostedSession.id)?.activeModel, {
                model: "gemini-3.8-flash",
                provider: "agy-cli",
            });
            assertEquals(await pathExists(agyLaunchLog), false);
        } finally {
            process.env["PATH"] = previousPath;
            runtime?.closeAllSessions();
        }
    });
});

test("fresh Agy CLI model selection offers first-time MCP setup before the first turn", async () => {
    await withRuntimeCommandFixture("runwield-agy-cli-first-select-", async ({ homeDir, projectRoot }) => {
        const runtime = createSessionRuntime();
        const messages: string[] = [];
        const previousPath = process.env["PATH"] || "";
        try {
            const binDir = await installAgyModelSelectionFixture(homeDir);
            process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
            const { sessionId } = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            let interactionCount = 0;
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction: () => {
                    interactionCount += 1;
                    return { outcome: "accepted", value: "approve" };
                },
                supportsInteraction: () => true,
            });

            await runModelsCommand([AGY_FLASH], {
                uiAPI: {
                    appendSystemMessage: (message) => messages.push(message),
                    promptSelect: () => Promise.resolve(null),
                },
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(interactionCount, 1);
            assertEquals((await inspectAgyCliMcpSetup()).ok, true);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "gemini-3.8-flash",
                provider: "agy-cli",
            });
            assertStringIncludes(messages.at(-1) || "", `Switched model to ${AGY_FLASH}`);
        } finally {
            process.env["PATH"] = previousPath;
            runtime.closeAllSessions();
        }
    });
});

test("explicit approved Agy CLI selection updates the active runtime Session model without persisting defaults", async () => {
    await withRuntimeCommandFixture("runwield-agy-cli-selection-", async ({ homeDir, projectRoot }) => {
        const runtime = createSessionRuntime();
        const messages: string[] = [];
        const previousPath = process.env["PATH"] || "";
        try {
            const binDir = await installAgyModelSelectionFixture(homeDir);
            process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
            assertEquals(await resolveInstalledWldExecutable(), await fsRealpath(join(binDir, WLD_EXECUTABLE)));
            await installAgyCliMcpSetup();
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runModelsCommand([FIXTURE_MODEL], {
                uiAPI: {
                    appendSystemMessage: (message) => messages.push(message),
                    promptSelect: () => Promise.resolve(null),
                },
                sessionId,
                sessionRuntime: runtime,
            });
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            const firstTurn = await runtime.promptUserTurn(sessionId, { initialRequest: "Prime the fixture model" });
            assertEquals(firstTurn.ok, true);
            assertEquals((await runtime.switchAgent(sessionId, { agentName: AGENTS.GUIDE })).ok, true);
            messages.length = 0;

            await runModelsCommand([AGY_FLASH], {
                uiAPI: {
                    appendSystemMessage: (message) => messages.push(message),
                    promptSelect: () => Promise.resolve(null),
                },
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "gemini-3.8-flash",
                provider: "agy-cli",
            });
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "runtime-command-fixture");
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "fixture-model");
            assertStringIncludes(messages.at(-1) || "", `Switched model to ${AGY_FLASH}`);
        } finally {
            process.env["PATH"] = previousPath;
            runtime.closeAllSessions();
        }
    });
});
