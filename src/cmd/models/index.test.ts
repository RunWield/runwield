import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { getSettingsManager, setCustomSetting } from "../../shared/settings.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { getModelCompletions, runModelsCommand } from "./index.ts";

const FIXTURE_MODEL = "runtime-command-fixture/fixture-model";

interface ModelSelectItem {
    value: string;
    label: string;
}

interface SystemMessage {
    text: string;
    isError: boolean;
}

interface ModelsUiFixture {
    editor: {
        disableSubmit: boolean;
        setText(text: string): void;
    };
    messages: SystemMessage[];
    uiAPI: {
        appendSystemMessage(message: string, isError?: boolean): void;
        promptSelect(title: string, options: ModelSelectItem[]): Promise<string | null>;
        showModelSelector?: () => Promise<void> | void;
    };
}

function makeUi(selection: string | null = null): ModelsUiFixture {
    const messages: SystemMessage[] = [];
    return {
        messages,
        editor: {
            disableSubmit: true,
            setText: () => {},
        },
        uiAPI: {
            appendSystemMessage: (message, isError = false) => messages.push({ text: message, isError }),
            promptSelect: (_title, options) => {
                if (selection && !options.some((option) => option.value === selection)) {
                    throw new Error(`Fixture model was not offered: ${selection}`);
                }
                return Promise.resolve(selection);
            },
        },
    };
}

async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
    }
    return logs;
}

test("runModelsCommand switches an explicit configured model through the real registry", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async ({ projectRoot }) => {
        const ui = makeUi();
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });

            await runModelsCommand([FIXTURE_MODEL], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "fixture-model");
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "runtime-command-fixture");
            assertEquals(ui.messages, [{ text: `Switched model to ${FIXTURE_MODEL}`, isError: false }]);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runModelsCommand switches a new in-memory Session before its first message", async () => {
    await withRuntimeCommandFixture(
        "runwield-model-command-",
        async ({ projectRoot, setModelResponse }) => {
            setModelResponse("The selected model handled the first turn.");
            const ui = makeUi();
            const runtime = createSessionRuntime();
            try {
                const sessionId = await runtime.createPromptReadySession({
                    cwd: projectRoot,
                    agentName: "router",
                    deferPersistenceUntilFirstMessage: true,
                });
                assertEquals(runtime.getSessionSnapshot(sessionId)?.sessionManagerId, null);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, { model: "", provider: "" });

                await runModelsCommand([FIXTURE_MODEL], {
                    uiAPI: ui.uiAPI,
                    sessionId,
                    sessionRuntime: runtime,
                });

                assertEquals(runtime.getSessionSnapshot(sessionId)?.sessionManagerId, null);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.managed, null);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });
                assertEquals(ui.messages, [{ text: `Switched model to ${FIXTURE_MODEL}`, isError: false }]);

                const firstTurn = await runtime.promptUserTurn(sessionId, { initialRequest: "Use this model" });
                assertEquals(firstTurn.ok, true);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });
            } finally {
                runtime.closeAllSessions();
            }
        },
        { providerState: "provider-no-model" },
    );
});

test("runModelsCommand keeps a manual model choice ahead of the active preset on the next turn", async () => {
    await withRuntimeCommandFixture(
        "runwield-model-command-",
        async ({ projectRoot, setModelResponse }) => {
            await setCustomSetting(
                "modelPresets",
                { active: { agents: { router: { model: "runtime-command-fixture/preset-model" } } } },
                "global",
                projectRoot,
            );
            await setCustomSetting("activeModelPreset", "active", "global", projectRoot);
            setModelResponse("The manual model handled this turn.");
            const ui = makeUi();
            const runtime = createSessionRuntime();
            try {
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "preset-model",
                    provider: "runtime-command-fixture",
                });

                await runModelsCommand([FIXTURE_MODEL], {
                    uiAPI: ui.uiAPI,
                    sessionId,
                    sessionRuntime: runtime,
                });
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });

                const turn = await runtime.promptUserTurn(sessionId, { initialRequest: "Continue" });
                assertEquals(turn.ok, true);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });
            } finally {
                runtime.closeAllSessions();
            }
        },
        { additionalModels: [{ id: "preset-model", name: "Preset Model" }] },
    );
});

test("runModelsCommand fallback selector lists and switches real configured models", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async ({ projectRoot }) => {
        const ui = makeUi(FIXTURE_MODEL);
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });

            await runModelsCommand([], {
                uiAPI: ui.uiAPI,
                editor: ui.editor,
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            assertEquals(ui.messages, [{ text: `Switched model to ${FIXTURE_MODEL}`, isError: false }]);
            assertEquals(ui.editor.disableSubmit, false);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runModelsCommand uses the shared picker and restores the editor", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async () => {
        const ui = makeUi(FIXTURE_MODEL);

        await runModelsCommand([], { uiAPI: ui.uiAPI, editor: ui.editor });

        assertEquals(ui.messages, [{ text: `Set default model to ${FIXTURE_MODEL}`, isError: false }]);
        assertEquals(ui.editor.disableSubmit, false);
    });
});

test("runModelsCommand validates and resolves model references with real machinery", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async () => {
        const ui = makeUi();

        await runModelsCommand(["fixture-model"], { uiAPI: ui.uiAPI });
        await runModelsCommand(["runtime-command-fixture/missing"], { uiAPI: ui.uiAPI });

        assertEquals(ui.messages, [
            { text: "Invalid model format. Use /model to switch.", isError: true },
            { text: "Unknown model: runtime-command-fixture/missing. Use /model to switch.", isError: true },
        ]);
    });
});

test("runModelsCommand keeps the current model after unavailable selections and recovers", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async ({ projectRoot }) => {
        const ui = makeUi();
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runModelsCommand([FIXTURE_MODEL], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            ui.messages.length = 0;

            await runModelsCommand(["runtime-command-fixture/missing"], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });
            await runModelsCommand(["missing-provider/missing"], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            assertEquals(getSettingsManager(projectRoot).getDefaultModel(), "fixture-model");
            assertEquals(getSettingsManager(projectRoot).getDefaultProvider(), "runtime-command-fixture");
            assertEquals(ui.messages, [
                { text: "Unknown model: runtime-command-fixture/missing. Use /model to switch.", isError: true },
                { text: "Unknown model: missing-provider/missing. Use /model to switch.", isError: true },
            ]);

            await runModelsCommand([FIXTURE_MODEL], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            assertEquals(ui.messages.at(-1), { text: `Switched model to ${FIXTURE_MODEL}`, isError: false });
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runModelsCommand reports CLI usage without reading user configuration", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async () => {
        const logs = await captureLogs(() => runModelsCommand([]));
        assertEquals(logs.length, 1);
        assertStringIncludes(logs[0], "Usage: wld model");
    });
});

test("runModelsCommand sets the fixture-scoped default from the standalone CLI", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async ({ alternateRoot }) => {
        const logs = await captureLogs(() => runModelsCommand([FIXTURE_MODEL]));
        assertEquals(logs, [`Set default model to ${FIXTURE_MODEL}`]);
        assertEquals(getSettingsManager(alternateRoot).getDefaultModel(), "fixture-model");
        assertEquals(getSettingsManager(alternateRoot).getDefaultProvider(), "runtime-command-fixture");
    }, { providerState: "provider-no-model" });
});

test("runModelsCommand completes and accepts only supported Agy CLI base models", async () => {
    await withRuntimeCommandFixture("runwield-model-command-agy-cli-", async ({ alternateRoot }) => {
        const completions = await getModelCompletions("agy-cli/");
        assertEquals(completions.map((completion) => completion.value), [
            "agy-cli/gemini-3.1-pro",
            "agy-cli/gemini-3.8-flash",
        ]);

        const logs = await captureLogs(() => runModelsCommand(["agy-cli/gemini-3.8-flash"]));
        assertEquals(logs, ["Set default model to agy-cli/gemini-3.8-flash"]);
        assertEquals(getSettingsManager(alternateRoot).getDefaultModel(), "gemini-3.8-flash");
        assertEquals(getSettingsManager(alternateRoot).getDefaultProvider(), "agy-cli");

        const rejected = await captureLogs(() => runModelsCommand(["agy-cli/gemini-3.8-flash-high"]));
        assertEquals(rejected, [
            "Unsupported Antigravity CLI model: agy-cli/gemini-3.8-flash-high. Select agy-cli/gemini-3.8-flash or agy-cli/gemini-3.1-pro.",
        ]);
        assertEquals(getSettingsManager(alternateRoot).getDefaultModel(), "gemini-3.8-flash");
    }, { providerState: "provider-no-model" });
});

test("runModelsCommand rejects unsupported Agy CLI model selection for the current Session", async () => {
    await withRuntimeCommandFixture("runwield-model-command-agy-reject-", async ({ projectRoot }) => {
        const ui = makeUi();
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runModelsCommand([FIXTURE_MODEL], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            ui.messages.length = 0;

            await runModelsCommand(["agy-cli/fixture-model"], {
                uiAPI: ui.uiAPI,
                sessionId,
                sessionRuntime: runtime,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                model: "fixture-model",
                provider: "runtime-command-fixture",
            });
            assertEquals(ui.messages, [{
                text:
                    "Unsupported Antigravity CLI model: agy-cli/fixture-model. Select agy-cli/gemini-3.8-flash or agy-cli/gemini-3.1-pro.",
                isError: true,
            }]);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runModelsCommand reports canceled selection and failed explicit selection without changing command effects", async () => {
    await withRuntimeCommandFixture("runwield-model-command-", async ({ projectRoot }) => {
        const ui = makeUi();
        const runtime = createSessionRuntime();
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            assertEquals(await runModelsCommand([], { ...ui, sessionId, sessionRuntime: runtime }), "canceled");
            assertEquals(ui.editor.disableSubmit, false);
            assertEquals(
                await runModelsCommand(["invalid-model"], { ...ui, sessionId, sessionRuntime: runtime }),
                "failed",
            );
            assertEquals(ui.messages.at(-1)?.isError, true);
        } finally {
            runtime.closeAllSessions();
        }
    });
});
