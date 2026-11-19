import { delimiter } from "node:path";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
    chmod as fsChmod,
    rm as fsRm,
    mkdir as fsMkdir,
    realpath as fsRealpath,
    readFile as fsReadFile,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { AGENTS } from "../../constants.ts";
import { runModelsCommand } from "../../cmd/models/index.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { assertModelExecutionBackendSupported } from "../models/model-execution.ts";
import { getModelRegistry } from "../models/model-registry.ts";
import { __resetSettingsForTests, getSettingsManager, setCustomSetting } from "../settings.ts";
import { summarizeProjectedEntries } from "./session-transcript-projection.ts";
import type { SessionExportSegment } from "./session-export.ts";
import { resolveInstalledWldExecutable } from "./backends/agy-cli/mcp-setup.ts";
import { SessionHost } from "./session-host.ts";
import { createSessionRuntime, SessionRuntime } from "./session-runtime.ts";

const WLD_EXECUTABLE = process.platform === "win32" ? "wld.exe" : "wld";
const AGY_EXECUTABLE = process.platform === "win32" ? "agy.exe" : "agy";

const FIXTURE_MODEL = "runtime-command-fixture/fixture-model";
const AGY_FLASH = "agy-cli/gemini-3.8-flash";
const APPROVED_AGY_MODELS = [
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-3.8-flash",
    "gemini-3.1-pro",
];
const UNSUPPORTED_AGY_MODELS = [
    "agy-cli/fixture-model",
    ...["gemini-4-argon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-3.8-flash", "gemini-3.1-pro"].flatMap(
        (model) => ["low", "medium", "high", "xhigh"].map((effort) => `agy-cli/${model}-${effort}`),
    ),
    "agy-cli/claude-opus-5-5",
    "agy-cli/claude-opus-5-5-high",
    "agy-cli/claude-sonnet-5-5",
    "agy-cli/claude-sonnet-5-5-low",
    "agy-cli/gpt-oss-120b",
    "agy-cli/gpt-oss-120b-medium",
];

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
    const agyPath = fileURLToPath(new URL("./backends/agy-cli/testing/fake-agy-execution.ts", import.meta.url));
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
    assertEquals(
        getModelRegistry()
            .getSelectable()
            .filter((model) => model.provider === "agy-cli")
            .map((model) => model.id)
            .sort(),
        [...APPROVED_AGY_MODELS].sort(),
    );
    for (const modelId of APPROVED_AGY_MODELS) {
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

                for (const model of UNSUPPORTED_AGY_MODELS) {
                    messages.length = 0;
                    await runModelsCommand([model], {
                        uiAPI: {
                            appendSystemMessage: (message, isError = false) =>
                                messages.push({ text: message, isError }),
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
                }
            } finally {
                process.env["PATH"] = previousPath;
                runtime.closeAllSessions();
            }
        },
        { providerState: "none" },
    );
});

test("Agy model selection does not solicit MCP setup or launch agy", async () => {
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

            await runtime.reconfigureSessionModel(hostedSession.id, "gemini-3.8-flash", "agy-cli");
            assertEquals(interactionCount, 0);
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

test("fresh Agy CLI model selection leaves global MCP config untouched", async () => {
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

            assertEquals(interactionCount, 0);
            assertEquals(await pathExists(join(homeDir, ".gemini", "config", "mcp_config.json")), false);
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
            for (const modelId of ["gemini-4-argon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-3.1-pro"]) {
                await runModelsCommand([`agy-cli/${modelId}`], {
                    uiAPI: {
                        appendSystemMessage: (message) => messages.push(message),
                        promptSelect: () => Promise.resolve(null),
                    },
                    sessionId,
                    sessionRuntime: runtime,
                });
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: modelId,
                    provider: "agy-cli",
                });
                assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "runtime-command-fixture");
                assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "fixture-model");
                assertStringIncludes(messages.at(-1) || "", `Switched model to agy-cli/${modelId}`);
            }
        } finally {
            process.env["PATH"] = previousPath;
            runtime.closeAllSessions();
        }
    });
});

test("unsupported Agy public IDs do not overwrite an active model or start a process", async () => {
    await withRuntimeCommandFixture("runwield-agy-cli-keep-selection-", async ({ homeDir, projectRoot }) => {
        const runtime = createSessionRuntime();
        const launchLog = join(homeDir, "unexpected-agy.log");
        const previousPath = process.env["PATH"] || "";
        try {
            const binDir = await installAgyModelSelectionFixture(homeDir);
            const sourcePath = join(binDir, "unexpected-agy.ts");
            await fsWriteFile(
                sourcePath,
                `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launchLog)}, "launched\\n"); process.exit(2);`,
            );
            await writeRuntimeExecutableFixture(join(binDir, "agy"), sourcePath);
            process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
            const { sessionId } = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            const messages: Array<{ text: string; isError: boolean }> = [];
            const commandContext = {
                uiAPI: {
                    appendSystemMessage: (message: string, isError = false) =>
                        messages.push({ text: message, isError }),
                    promptSelect: () => Promise.resolve(null),
                },
                sessionId,
                sessionRuntime: runtime,
            };
            await runModelsCommand([FIXTURE_MODEL], commandContext);
            for (const model of UNSUPPORTED_AGY_MODELS) {
                messages.length = 0;
                await runModelsCommand([model], commandContext);
                assertEquals(messages.length, 1);
                assertEquals(messages[0].isError, true);
                assertStringIncludes(messages[0].text, "Unsupported Antigravity CLI model");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });
                assertEquals(await pathExists(launchLog), false);
                assertEquals(await pathExists(join(homeDir, ".gemini")), false);
            }
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            process.env["PATH"] = previousPath;
        }
    });
});

interface SelectionExecutionCall {
    model: string;
    effort: string;
    prompt: string;
}

async function withAgySelectionExecutionFixture(
    callback: (projectRoot: string, logPath: string) => Promise<void>,
): Promise<void> {
    await withRuntimeCommandFixture("runwield-agy-cli-pro-", async ({ homeDir, projectRoot }) => {
        const previousPath = process.env["PATH"] || "";
        const previousLog = process.env["RUNWIELD_AGY_EXECUTION_LOG"];
        const logPath = join(homeDir, "agy-execution.jsonl");
        try {
            const binDir = await installAgyModelSelectionFixture(homeDir);
            process.env["PATH"] = `${binDir}${delimiter}${previousPath}`;
            process.env["RUNWIELD_AGY_EXECUTION_LOG"] = logPath;
            await fsWriteFile(logPath, "");
            await callback(projectRoot, logPath);
        } finally {
            process.env["PATH"] = previousPath;
            if (previousLog === undefined) delete process.env["RUNWIELD_AGY_EXECUTION_LOG"];
            else process.env["RUNWIELD_AGY_EXECUTION_LOG"] = previousLog;
        }
    });
}

async function readSelectionExecutionCalls(logPath: string): Promise<SelectionExecutionCall[]> {
    return (await fsReadFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SelectionExecutionCall);
}

test("saved Pro defaults load without migration and the next request still uses Pro", async () => {
    await withAgySelectionExecutionFixture(async (projectRoot, logPath) => {
        await setCustomSetting("defaultProvider", "agy-cli", "global", projectRoot);
        await setCustomSetting("defaultModel", "gemini-3.1-pro", "global", projectRoot);
        __resetSettingsForTests();
        const runtime = createSessionRuntime();
        try {
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "gemini-3.1-pro");
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: AGENTS.GUIDE });
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "gemini-3.1-pro",
                provider: "agy-cli",
            });
            assertEquals(
                (await runtime.promptUserTurn(sessionId, { initialRequest: "Use my saved Pro model" })).ok,
                true,
            );
            const calls = await readSelectionExecutionCalls(logPath);
            assertEquals(calls.length, 1);
            assertEquals(calls[0].model, "gemini-3.1-pro");
            assertEquals(calls[0].effort, "low");
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "gemini-3.1-pro");
            const exported = await runtime.readSessionExport(sessionId);
            assertEquals(
                summarizeProjectedEntries(exported.document.segments.flatMap((segment) => segment.entries))
                    .executionBackend,
                {
                    backend: "agy-cli",
                    provider: "agy-cli",
                    model: "gemini-3.1-pro",
                    thinkingLevel: "off",
                    effort: "low",
                    backendModel: "gemini-3.1-pro-low",
                },
            );
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("persisted Pro Session resumes as Pro and preserves all prior execution evidence", async () => {
    await withAgySelectionExecutionFixture(async (projectRoot, logPath) => {
        const writer = createSessionRuntime();
        let persistedId = "";
        let priorEntries: SessionExportSegment["entries"] = [];
        try {
            const sessionId = await writer.createPromptReadySession({
                cwd: projectRoot,
                agentName: AGENTS.GUIDE,
                deferPersistenceUntilFirstMessage: true,
            });
            await runModelsCommand(["agy-cli/gemini-3.1-pro"], {
                uiAPI: { appendSystemMessage: () => {}, promptSelect: () => Promise.resolve(null) },
                sessionId,
                sessionRuntime: writer,
            });
            assertEquals((await writer.setSessionThinkingLevel(sessionId, "medium")).ok, true);
            assertEquals(
                (await writer.promptUserTurn(sessionId, { initialRequest: "Persist my Pro history" })).ok,
                true,
            );
            persistedId = writer.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || "";
            assert(persistedId);
            priorEntries = (await writer.readSessionExport(sessionId)).document.segments.flatMap(
                (segment) => segment.entries,
            );
            assertEquals(summarizeProjectedEntries(priorEntries).executionBackend, {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-3.1-pro",
                thinkingLevel: "medium",
                effort: "high",
                backendModel: "gemini-3.1-pro-high",
            });
        } finally {
            await writer.closeAllSessionsWhenIdle();
        }
        await setCustomSetting("defaultProvider", "agy-cli", "global", projectRoot);
        await setCustomSetting("defaultModel", "gemini-4-argon", "global", projectRoot);
        const reader = createSessionRuntime();
        try {
            const { sessionId } = await reader.createInteractiveSession({
                cwd: projectRoot,
                mode: "continue",
                resumeSessionId: persistedId,
            });
            assertEquals(reader.getSessionSnapshot(sessionId)?.activeModel, {
                model: "gemini-3.1-pro",
                provider: "agy-cli",
            });
            assertEquals(
                (await reader.promptUserTurn(sessionId, { initialRequest: "Continue with the persisted Pro model" }))
                    .ok,
                true,
            );
            const calls = await readSelectionExecutionCalls(logPath);
            assertEquals(
                calls.map((call) => [call.model, call.effort]),
                [
                    ["gemini-3.1-pro", "high"],
                    ["gemini-3.1-pro", "high"],
                ],
            );
            assertStringIncludes(calls[1].prompt, "Persist my Pro history");
            assertStringIncludes(calls[1].prompt, "agy:first");
            const entries = (await reader.readSessionExport(sessionId)).document.segments.flatMap(
                (segment) => segment.entries,
            );
            assertEquals(entries.slice(0, priorEntries.length), priorEntries);
            assertEquals(summarizeProjectedEntries(entries).executionBackend, {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-3.1-pro",
                thinkingLevel: "medium",
                effort: "high",
                backendModel: "gemini-3.1-pro-high",
            });
        } finally {
            await reader.closeAllSessionsWhenIdle();
        }
    });
});
