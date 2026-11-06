import { readFile as fsReadFile } from "node:fs/promises";
import { Editor, TuiAltScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../ui/tui/testing/virtual-terminal.ts";
import { getEditorTheme } from "../../ui/theme/theme.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { createSessionRuntime, type SessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    getCodeReviewMode,
    getCustomSetting,
    getGuidedReviewMode,
    getSettingsManager,
    setCustomSetting,
} from "../../shared/settings.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runSettingsCommand } from "./index.ts";

interface SelectItem {
    value: string;
    label: string;
    description?: string;
}

interface TextOptions {
    defaultValue: string;
    placeholder: string;
    allowEmpty: boolean;
}

interface SettingsSelectRecord {
    title: string;
    options: SelectItem[];
}

interface SettingsFileRecord {
    activeModelPreset?: string | null;
}

test("settings exposes existing review policies and persists scope without replacing explicit overrides", async () => {
    await withRuntimeCommandFixture("runwield-policy-settings-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const harness = makeUiHarness([
            "codereview",
            "project",
            "always",
            "codereview",
            "global",
            "none",
            "guidedReview",
            "project",
            "none",
            "defaultProjectTrust",
            "never",
            "done",
        ]);
        try {
            await runSettingsCommand([], { uiAPI: harness.uiAPI, sessionRuntime: runtime, sessionId });
            await getSettingsManager(projectRoot).reload();
            assertEquals(getCodeReviewMode(projectRoot), "always");
            assertEquals(getCustomSetting("codereview", "global", projectRoot), "none");
            assertEquals(getGuidedReviewMode(projectRoot), "none");
            assertEquals(getSettingsManager(projectRoot).getDefaultProjectTrust(), "never");
            assertEquals(getCustomSetting("defaultProjectTrust", "project", projectRoot), undefined);
            assert(harness.messages.some((message) => message.includes("explicit override remains in effect")));
            assert(harness.selects[0].options.some((option) => option.value === "codereview"));
            assert(harness.selects[0].options.some((option) => option.value === "guidedReview"));
            assert(harness.selects[0].options.some((option) => option.value === "defaultProjectTrust"));
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("settings saves Plan auto-merge booleans in the selected scope and keeps other Plan keys", async () => {
    await withRuntimeCommandFixture("runwield-plan-merge-policy-", async ({ projectRoot }) => {
        await setCustomSetting("plans", { archiveKeepLast: 7 }, "project", projectRoot);
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const harness = makeUiHarness([
            "plans.autoMergeIntoTargetBranch",
            "project",
            "false",
            "plans.autoMergeIntoTargetBranch",
            "global",
            "true",
            "done",
        ]);
        try {
            await runSettingsCommand([], { uiAPI: harness.uiAPI, sessionRuntime: runtime, sessionId });
            assertEquals(getCustomSetting("plans", "project", projectRoot), {
                archiveKeepLast: 7,
                autoMergeIntoTargetBranch: false,
            });
            assertEquals(getCustomSetting("plans", "global", projectRoot), { autoMergeIntoTargetBranch: true });
            assert(harness.selects.some((record) => record.title === "Save auto-merge into target branch for"));
            assert(harness.messages.some((message) => message.includes("explicit override remains in effect")));
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("cancelling review policy selection preserves persisted choices", async () => {
    await withRuntimeCommandFixture("runwield-policy-cancel-", async ({ projectRoot }) => {
        await setCustomSetting("codereview", "none", "project", projectRoot);
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const harness = makeUiHarness(["codereview", null, "guidedReview", "project", null, "done"]);
        try {
            await runSettingsCommand([], { uiAPI: harness.uiAPI, sessionRuntime: runtime, sessionId });
            assertEquals(getCodeReviewMode(projectRoot), "none");
            assertEquals(getCustomSetting("guidedReview", "project", projectRoot), undefined);
            assertEquals(harness.messages, []);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

interface SettingsUiHarness {
    editor: SettingsEditor;
    messages: string[];
    selects: SettingsSelectRecord[];
    uiAPI: {
        appendSystemMessage(message: string): void;
        promptSelect(title: string, options: SelectItem[]): Promise<string | null>;
        promptText(title: string, options: TextOptions): Promise<string | null>;
        requestRender(): void;
    };
}

class SettingsEditor extends Editor {
    disableSubmit = true;
}

function makeUiHarness(
    selections: Array<string | null> = [],
    textInputs: Array<string | null> = [],
): SettingsUiHarness {
    const pendingSelections = [...selections];
    const pendingTextInputs = [...textInputs];
    const messages: string[] = [];
    const selects: SettingsSelectRecord[] = [];
    const editor = new SettingsEditor(
        new TuiAltScreen(new VirtualTerminal({ columns: 120, rows: 40 })),
        getEditorTheme(),
    );
    editor.setText("draft");
    return {
        editor,
        messages,
        selects,
        uiAPI: {
            appendSystemMessage: (message) => messages.push(message),
            promptSelect: (title, options) => {
                selects.push({ title, options });
                return Promise.resolve(pendingSelections.shift() ?? null);
            },
            promptText: () => Promise.resolve(pendingTextInputs.shift() ?? null),
            requestRender: () => {},
        },
    };
}

async function createPromptReadyRuntime(projectRoot: string): Promise<{ runtime: SessionRuntime; sessionId: string }> {
    const runtime = createSessionRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "router" });
    return { runtime, sessionId };
}

async function captureConsole(run: () => Promise<void>): Promise<{ logs: string[]; errors: string[] }> {
    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];
    console.log = (message = "") => logs.push(String(message));
    console.error = (message = "") => errors.push(String(message));
    try {
        await run();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    return { logs, errors };
}

test("runSettingsCommand exits a cancelled menu and restores the real editor surface", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const harness = makeUiHarness([null]);
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                editor: harness.editor,
                sessionRuntime: runtime,
                sessionId,
            });

            assertEquals(harness.messages, []);
            assertEquals(harness.editor.getText(), "");
            assertEquals(harness.editor.disableSubmit, false);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand persists numeric compaction settings in the fixture home", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async ({ projectRoot, settingsPath }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const harness = makeUiHarness(
            ["compaction", "reserve", "keep-recent", "summary", "back", "done"],
            ["12,000", "34000"],
        );
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                editor: harness.editor,
                sessionRuntime: runtime,
                sessionId,
            });

            const settings = getSettingsManager(projectRoot).getCompactionSettings();
            assertEquals(settings.reserveTokens, 12000);
            assertEquals(settings.keepRecentTokens, 34000);
            const summary = harness.messages.find((message) => message.includes("Compaction behavior"));
            assertStringIncludes(summary ?? "", "12,000");
            assertStringIncludes(summary ?? "", "34,000");
            assert(harness.messages.includes("Reserve tokens set to 12,000."));
            assert(harness.messages.includes("Keep recent tokens set to 34,000."));
            const persisted = await fsReadFile(settingsPath, "utf8");
            assertStringIncludes(persisted, '"reserveTokens": 12000');
            assertStringIncludes(persisted, '"keepRecentTokens": 34000');
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand toggles auto-compaction through the real Runtime session", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async ({ projectRoot, settingsPath }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const before = runtime.getSessionSnapshot(sessionId)?.autoCompactionEnabled;
        const harness = makeUiHarness(["compaction", "toggle", "back", "done"]);
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                editor: harness.editor,
                sessionRuntime: runtime,
                sessionId,
            });

            assertEquals(runtime.getSessionSnapshot(sessionId)?.autoCompactionEnabled, !before);
            assert(harness.messages.includes(`Auto-compact ${!before ? "enabled" : "disabled"}.`));
            assertStringIncludes(await fsReadFile(settingsPath, "utf8"), `"enabled": ${String(!before)}`);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand rejects invalid numeric input without changing persisted settings", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async ({ projectRoot, settingsPath }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const before = getSettingsManager(projectRoot).getCompactionSettings().reserveTokens;
        const persistedBefore = await fsReadFile(settingsPath, "utf8");
        const harness = makeUiHarness(["compaction", "reserve", "back", "done"], ["nope"]);
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                sessionRuntime: runtime,
                sessionId,
            });

            assertEquals(harness.messages, ["Reserve tokens must be a positive integer."]);
            assertEquals(getSettingsManager(projectRoot).getCompactionSettings().reserveTokens, before);
            assertEquals(await fsReadFile(settingsPath, "utf8"), persistedBefore);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand selects a model preset and persists activeModelPreset globally", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async ({ projectRoot, settingsPath }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        await setCustomSetting(
            "modelPresets",
            {
                fast: { agents: { router: { model: "openai/gpt-5-mini" } } },
                quality: {
                    agents: { router: { model: "anthropic/claude-opus-4-1" } },
                    visionFallback: { model: "openai/gpt-5" },
                },
            },
            "global",
            projectRoot,
        );
        await setCustomSetting("activeModelPreset", "fast", "global", projectRoot);

        const harness = makeUiHarness(["model-presets", "preset:quality", "back", "done"]);
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                editor: harness.editor,
                sessionRuntime: runtime,
                sessionId,
            });

            assertEquals(getCustomSetting("activeModelPreset", "global", projectRoot), "quality");
            assert(harness.messages.includes("Active model preset set to quality."));

            const settingsPrompt = harness.selects.find((record) => record.title === "Settings");
            const presetsItem = settingsPrompt?.options.find((option) => option.value === "model-presets");
            assertStringIncludes(presetsItem?.description ?? "", "Active: fast");

            const presetsPrompts = harness.selects.filter((record) => record.title === "Model Presets");
            assertEquals(presetsPrompts.length, 2);
            const qualityOption = presetsPrompts[1]?.options.find((option) => option.value === "preset:quality");
            assertEquals(qualityOption?.label, "quality (active)");
            assertStringIncludes(
                presetsPrompts[0]?.options.find((option) => option.value === "preset:fast")?.description ?? "",
                "1 agent model override",
            );

            const persisted = JSON.parse(await fsReadFile(settingsPath, "utf8")) as SettingsFileRecord;
            assertEquals(persisted.activeModelPreset, "quality");
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand applies a selected model preset to the active Session immediately", async () => {
    await withRuntimeCommandFixture(
        "runwield-settings-command-",
        async ({ projectRoot }) => {
            const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
            await setCustomSetting(
                "modelPresets",
                { fast: { agents: { router: { model: "runtime-command-fixture/preset-model" } } } },
                "global",
                projectRoot,
            );

            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel?.model, "fixture-model");
            const harness = makeUiHarness(["model-presets", "preset:fast", "back", "done"]);
            try {
                await runSettingsCommand([], {
                    uiAPI: harness.uiAPI,
                    editor: harness.editor,
                    sessionRuntime: runtime,
                    sessionId,
                });

                assertEquals(harness.messages, [
                    "Active model preset set to fast.",
                    "Agent context reloaded with the new model preset.",
                ]);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "preset-model",
                    provider: "runtime-command-fixture",
                });
            } finally {
                runtime.closeAllSessions();
            }
        },
        { additionalModels: [{ id: "preset-model", name: "Preset Model" }] },
    );
});

test("runSettingsCommand activates a bundled preset without persisting its definition", async () => {
    await withRuntimeCommandFixture("bundled-preset-selection-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        const harness = makeUiHarness(["model-presets", "preset:claude-opus", "back", "done"]);
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                sessionRuntime: runtime,
                sessionId,
            });
            assert(
                harness.selects
                    .find((select) => select.title === "Model Presets")
                    ?.options.some((option) => option.value === "preset:claude-opus"),
            );
            assertEquals(getCustomSetting("activeModelPreset", "global", projectRoot), "claude-opus");
            assertEquals(getCustomSetting("modelPresets", "global", projectRoot), undefined);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, { provider: "claude-cli", model: "opus" });
            assert(harness.messages.includes("Agent context reloaded with the new model preset."));
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand applies a model preset to a new in-memory Session", async () => {
    await withRuntimeCommandFixture(
        "runwield-settings-command-",
        async ({ projectRoot, setModelResponse }) => {
            setModelResponse("The preset model handled the first turn.");
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({
                cwd: projectRoot,
                agentName: "router",
                deferPersistenceUntilFirstMessage: true,
            });
            await setCustomSetting(
                "modelPresets",
                { fast: { agents: { router: { model: "runtime-command-fixture/fixture-model" } } } },
                "global",
                projectRoot,
            );
            const harness = makeUiHarness(["model-presets", "preset:fast", "back", "done"]);
            try {
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, { model: "", provider: "" });

                await runSettingsCommand([], {
                    uiAPI: harness.uiAPI,
                    editor: harness.editor,
                    sessionRuntime: runtime,
                    sessionId,
                });

                assertEquals(runtime.getSessionSnapshot(sessionId)?.sessionManagerId, null);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.managed, null);
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });
                assertEquals(harness.messages, [
                    "Active model preset set to fast.",
                    "The new model preset will be used for your first message.",
                ]);

                const firstTurn = await runtime.promptUserTurn(sessionId, { initialRequest: "Use this preset" });
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

test("runSettingsCommand clears activeModelPreset via None", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async ({ projectRoot, settingsPath }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        await setCustomSetting(
            "modelPresets",
            { fast: { agents: { router: { model: "openai/gpt-5-mini" } } } },
            "global",
            projectRoot,
        );
        await setCustomSetting("activeModelPreset", "fast", "global", projectRoot);

        const harness = makeUiHarness(["model-presets", "none", "back", "done"]);
        try {
            await runSettingsCommand([], {
                uiAPI: harness.uiAPI,
                editor: harness.editor,
                sessionRuntime: runtime,
                sessionId,
            });

            assertEquals(getCustomSetting("activeModelPreset", "global", projectRoot), null);
            assert(harness.messages.includes("Active model preset cleared; base agents config is used."));
            const persisted = JSON.parse(await fsReadFile(settingsPath, "utf8")) as SettingsFileRecord;
            assertEquals(persisted.activeModelPreset, null);
        } finally {
            runtime.closeAllSessions();
        }
    });
});

test("runSettingsCommand reports unavailable interactive state", async () => {
    await withRuntimeCommandFixture("runwield-settings-command-", async () => {
        const output = await captureConsole(() => runSettingsCommand([]));
        assertEquals(output.errors, ["The /settings command is only available inside an interactive session."]);

        const harness = makeUiHarness();
        await assertRejects(
            () => runSettingsCommand([], { uiAPI: harness.uiAPI }),
            Error,
            "Settings require an active runtime session.",
        );
    });
});

test("Mascot menu toggles global visibility and reports project overrides", async () => {
    await withRuntimeCommandFixture("settings-mascot-", async ({ projectRoot }) => {
        const { runtime, sessionId } = await createPromptReadyRuntime(projectRoot);
        try {
            const harness = makeUiHarness(["mascot", "done"]);
            await runSettingsCommand([], { sessionRuntime: runtime, sessionId, ...harness });
            assertEquals(getCustomSetting("mascot", "global", projectRoot), false);
            assertEquals(harness.selects[0].options.find((item) => item.value === "mascot")?.label, "Mascot: on");
            assertEquals(harness.selects[1].options.find((item) => item.value === "mascot")?.label, "Mascot: off");
            assertStringIncludes(harness.messages.join("\n"), "Mascot off");
            await setCustomSetting("mascot", false, "project", projectRoot);
            const override = makeUiHarness(["mascot", "done"]);
            await runSettingsCommand([], { sessionRuntime: runtime, sessionId, ...override });
            assertEquals(getCustomSetting("mascot", "global", projectRoot), true);
            const entry = override.selects[1].options.find((item) => item.value === "mascot");
            assertEquals(entry?.label, "Mascot: off");
            assertStringIncludes(entry?.description || "", "(project override active)");
        } finally {
            await runtime.closeAllSessions();
        }
    });
});
