import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { assertEventIncludes } from "../testing/scenario-runner.js";

const GOLDEN_PROVIDER = "golden";
const FRONTMATTER_MODEL = "frontmatter";
const DEFAULT_MODEL = "default";
const BASE_AGENT_MODEL = "base-agent";
const PRESET_MODEL = "preset";
const MANUAL_MODEL = "manual";
const PLANNER_PROMPT_MARKER = "GOLDEN_PLANNER_MODEL_PRECEDENCE_PROMPT";

const goldenModels = [
    { id: "faux", name: "Golden Startup Model" },
    { id: FRONTMATTER_MODEL, name: "Golden Frontmatter Model" },
    { id: DEFAULT_MODEL, name: "Golden Default Model" },
    { id: BASE_AGENT_MODEL, name: "Golden Base Agent Model" },
    { id: PRESET_MODEL, name: "Golden Preset Model" },
    { id: MANUAL_MODEL, name: "Golden Manual Model" },
];

const plannerFrontmatterFixture = `---
model: "${GOLDEN_PROVIDER}/${FRONTMATTER_MODEL}"
---

${PLANNER_PROMPT_MARKER}
`;

const plannerFixture = [{ path: ".wld/agents/planner.md", text: plannerFrontmatterFixture }];

type ModelTurn = {
    agent?: string;
    model?: string;
    provider?: string;
    systemPrompt?: string;
};

type SystemMessage = {
    text?: string;
    isError?: boolean;
    header?: string;
};

type ConfigurationScenarioResult = Parameters<typeof assertEventIncludes>[0] & {
    state: {
        modelTurns?: ModelTurn[];
        globalSettings?: { defaultModel?: string; defaultProvider?: string };
        scriptedInteractions?: Array<{ interaction?: { value?: string } }>;
        systemMessages?: SystemMessage[];
        snapshot?: { activeAgent?: string | null; activeModel?: { model?: string; provider?: string } };
    };
};

function configuredSettings(options: { preset?: boolean; baseAgent?: boolean; defaultModel?: boolean } = {}) {
    return {
        ...(options.defaultModel === false ? {} : { defaultProvider: GOLDEN_PROVIDER, defaultModel: DEFAULT_MODEL }),
        ...(options.baseAgent === false
            ? {}
            : { agents: { planner: { model: `${GOLDEN_PROVIDER}/${BASE_AGENT_MODEL}` } } }),
        ...(options.preset === false ? {} : {
            activeModelPreset: "golden-preset",
            modelPresets: {
                "golden-preset": {
                    agents: { planner: { model: `${GOLDEN_PROVIDER}/${PRESET_MODEL}` } },
                },
            },
        }),
    };
}

function plannerScript(id: string) {
    return [{
        id,
        agent: "planner",
        phase: "plan_review",
        ordinal: 1,
        text: "Golden precedence response.",
    }];
}

function switchToPlannerAndSend(message: string) {
    return [
        { type: "type", text: "/agent planner" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:agent:planner" },
        { type: "waitForIdle" },
        { type: "type", text: message },
        { type: "enter" },
        { type: "waitForEvent", event: "model:faux-provider:planner:plan_review" },
        { type: "waitForIdle" },
    ];
}

function assertFooter(result: ConfigurationScenarioResult, agent: string, model: string) {
    const footer = result.screenText.split("\n").slice(-6).join("\n");
    assertStringIncludes(footer, agent);
    assertStringIncludes(footer, `${GOLDEN_PROVIDER}/${model}`);
}

function assertTurn(
    result: ConfigurationScenarioResult,
    index: number,
    expected: { agent: string; model: string; promptIncludes: string[] },
) {
    const turns = result.state.modelTurns || [];
    const turn = turns[index];
    assert(turn, `Expected captured model turn ${index + 1}; captured ${turns.length}`);
    assertEquals(turn.agent, expected.agent);
    assertEquals(turn.provider, GOLDEN_PROVIDER);
    assertEquals(turn.model, expected.model);
    for (const marker of expected.promptIncludes) assertStringIncludes(turn.systemPrompt || "", marker);
}

function assertPlannerPrecedence(result: ConfigurationScenarioResult, model: string) {
    assertEquals(result.state.modelTurns?.length, 1);
    assertTurn(result, 0, {
        agent: "planner",
        model,
        promptIncludes: [
            "You are the Planner — the Planned Change planning specialist in the RunWield system.",
            PLANNER_PROMPT_MARKER,
        ],
    });
    assertFooter(result, "Planner", model);
}

function assertSystemError(result: ConfigurationScenarioResult, marker: string) {
    const message = result.state.systemMessages?.find((entry) => entry.text?.includes(marker));
    assert(message, `Expected system message containing ${marker}`);
    assertEquals(message.isError, true);
}

function assertPlannerEventAfterLastAgentCommand(result: ConfigurationScenarioResult) {
    const lastAgentCommand = result.events.lastIndexOf("terminal:type:/agent planner");
    const firstPlannerEvent = result.events.indexOf("runtime:agent:planner");
    assert(firstPlannerEvent > lastAgentCommand, "Expected Planner activation only after the recovery /agent command");
}

function assertPlannerSwitchNoticeBeforeUserMessage(result: ConfigurationScenarioResult, userMessage: string) {
    const notice = result.state.systemMessages?.find((entry) =>
        entry.header === "RunWield" && entry.text === "Agent switched to Planner" && entry.isError === false
    );
    assert(notice, "Expected a RunWield Agent switch notice");
    const noticeIndex = result.screenText.indexOf("Agent switched to Planner");
    const userIndex = result.screenText.indexOf(userMessage);
    assert(
        noticeIndex >= 0 && userIndex >= 0 && noticeIndex < userIndex,
        "Expected Agent switch notice before next user message",
    );
}

export const slashAgentScenario = {
    name: "slash-command-agent-preset-model-precedence",
    slashCommands: ["agent"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: configuredSettings(),
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    captureSystemMessages: true,
    script: plannerScript("agent-preset-precedence"),
    actions: switchToPlannerAndSend("Use the preset model."),
    assertions: [
        (result: ConfigurationScenarioResult) => assertEventIncludes(result, "terminal:type:/agent planner"),
        (result: ConfigurationScenarioResult) => assertEventIncludes(result, "runtime:agent:planner"),
        (result: ConfigurationScenarioResult) =>
            assertPlannerSwitchNoticeBeforeUserMessage(result, "Use the preset model."),
        (result: ConfigurationScenarioResult) => assertPlannerPrecedence(result, PRESET_MODEL),
    ],
};

export const agentModelsAfterSavedTurnsScenario = {
    name: "agent-models-after-saved-turns",
    composedTui: true,
    initialAgentName: "router",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: {
        ...configuredSettings(),
        modelPresets: {
            "golden-preset": {
                agents: {
                    router: { model: `${GOLDEN_PROVIDER}/${DEFAULT_MODEL}` },
                    guide: { model: `${GOLDEN_PROVIDER}/${BASE_AGENT_MODEL}` },
                    planner: { model: `${GOLDEN_PROVIDER}/${PRESET_MODEL}` },
                },
            },
        },
    },
    captureModelTurns: true,
    script: [
        {
            id: "saved-router-route",
            agent: "router",
            phase: "triage",
            requiredTools: ["triage_report"],
            toolCalls: [{
                name: "triage_report",
                arguments: {
                    routingIntent: "INQUIRY",
                    complexity: "LOW",
                    summary: "Explain model selection.",
                    sessionName: "model selection",
                },
            }],
        },
        { id: "saved-guide-first", agent: "guide", phase: "inquiry", ordinal: 1, text: "Guide first answer." },
        { id: "saved-guide-next", agent: "guide", phase: "inquiry", ordinal: 2, text: "Guide next answer." },
        ...plannerScript("saved-planner-first"),
        {
            id: "saved-planner-next",
            agent: "planner",
            phase: "plan_review",
            ordinal: 2,
            text: "Planner next answer.",
        },
    ],
    actions: [
        { type: "type", text: "Explain model selection." },
        { type: "enter" },
        { type: "waitForScreen", text: "Guide first answer." },
        { type: "waitForIdle" },
        { type: "type", text: "Explain a little more." },
        { type: "enter" },
        { type: "waitForScreen", text: "Guide next answer." },
        { type: "waitForIdle" },
        ...switchToPlannerAndSend("Plan a change."),
        { type: "type", text: "Continue planning." },
        { type: "enter" },
        { type: "waitForScreen", text: "Planner next answer." },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: ConfigurationScenarioResult) => {
            assertEquals(
                result.state.modelTurns?.map(({ agent, provider, model }) => ({ agent, provider, model })),
                [
                    { agent: "router", provider: GOLDEN_PROVIDER, model: DEFAULT_MODEL },
                    { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                    { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                    { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
                    { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
                ],
            );
            assertFooter(result, "Planner", PRESET_MODEL);
        },
    ],
};

export const routerManualModelHandoffScenario = {
    ...agentModelsAfterSavedTurnsScenario,
    name: "router-manual-model-does-not-pin-workflow-agents",
    actions: [
        { type: "type", text: `/model ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: `Switched model to ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "waitForIdle" },
        ...agentModelsAfterSavedTurnsScenario.actions,
    ],
    assertions: [(result: ConfigurationScenarioResult) => {
        assertEquals(
            result.state.modelTurns?.map(({ agent, provider, model }) => ({ agent, provider, model })),
            [
                { agent: "router", provider: GOLDEN_PROVIDER, model: MANUAL_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
            ],
        );
        assertFooter(result, "Planner", PRESET_MODEL);
    }],
};

export const agentModelsAfterRestartScenario = {
    ...agentModelsAfterSavedTurnsScenario,
    name: "agent-models-after-restart-and-resume",
    actions: [
        ...agentModelsAfterSavedTurnsScenario.actions.slice(0, 4),
        { type: "restartTui", sessionStartMode: "continue" },
        { type: "waitForIdle" },
        ...agentModelsAfterSavedTurnsScenario.actions.slice(4),
    ],
};

export const agentModelsAfterPresetReloadScenario = {
    ...agentModelsAfterSavedTurnsScenario,
    name: "agent-models-after-preset-reload",
    globalSettings: {
        ...agentModelsAfterSavedTurnsScenario.globalSettings,
        modelPresets: {
            ...agentModelsAfterSavedTurnsScenario.globalSettings.modelPresets,
            alternate: {
                agents: {
                    guide: { model: `${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
                    planner: { model: `${GOLDEN_PROVIDER}/${PRESET_MODEL}` },
                },
            },
        },
    },
    scriptedInteractions: [
        { type: "select", promptIncludes: "Settings", value: "model-presets" },
        { type: "select", promptIncludes: "Model Presets", value: "preset:alternate" },
        { type: "select", promptIncludes: "Model Presets", value: "back" },
        { type: "select", promptIncludes: "Settings", value: "done" },
    ],
    actions: [
        ...agentModelsAfterSavedTurnsScenario.actions.slice(0, 4),
        { type: "type", text: "/settings" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Active model preset set to alternate." },
        { type: "waitForIdle" },
        ...agentModelsAfterSavedTurnsScenario.actions.slice(4),
    ],
    assertions: [(result: ConfigurationScenarioResult) => {
        assertEquals(
            result.state.modelTurns?.map(({ agent, provider, model }) => ({ agent, provider, model })),
            [
                { agent: "router", provider: GOLDEN_PROVIDER, model: DEFAULT_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: MANUAL_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
            ],
        );
        assertFooter(result, "Planner", PRESET_MODEL);
    }],
};

export const namedAgentModelsAfterSavedTurnsScenario = {
    ...agentModelsAfterSavedTurnsScenario,
    name: "named-agent-models-after-saved-turns",
    initialAgentName: "guide",
    script: agentModelsAfterSavedTurnsScenario.script.slice(1),
    assertions: [(result: ConfigurationScenarioResult) => {
        assertEquals(
            result.state.modelTurns?.map(({ agent, provider, model }) => ({ agent, provider, model })),
            [
                { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
            ],
        );
        assertFooter(result, "Planner", PRESET_MODEL);
    }],
};

export const agentModelsAfterManualSelectionScenario = {
    ...agentModelsAfterSavedTurnsScenario,
    name: "agent-models-after-manual-selection-in-saved-session",
    actions: [
        ...agentModelsAfterSavedTurnsScenario.actions.slice(0, 4),
        { type: "type", text: `/model ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: `Switched model to ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "waitForIdle" },
        ...agentModelsAfterSavedTurnsScenario.actions.slice(4),
    ],
    assertions: [(result: ConfigurationScenarioResult) => {
        assertEquals(
            result.state.modelTurns?.map(({ agent, provider, model }) => ({ agent, provider, model })),
            [
                { agent: "router", provider: GOLDEN_PROVIDER, model: DEFAULT_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: BASE_AGENT_MODEL },
                { agent: "guide", provider: GOLDEN_PROVIDER, model: MANUAL_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
                { agent: "planner", provider: GOLDEN_PROVIDER, model: PRESET_MODEL },
            ],
        );
        assertFooter(result, "Planner", PRESET_MODEL);
    }],
};

export const slashAgentUnavailablePresetRecoveryScenario = {
    name: "slash-command-agent-unavailable-preset-model-recovery",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: {
        ...configuredSettings(),
        activeModelPreset: "broken-model",
        modelPresets: {
            "broken-model": {
                agents: { planner: { model: `${GOLDEN_PROVIDER}/missing-preset-model` } },
            },
            "broken-provider": {
                agents: { planner: { model: "missing-provider/missing-model" } },
            },
            "golden-preset": {
                agents: { planner: { model: `${GOLDEN_PROVIDER}/${PRESET_MODEL}` } },
            },
        },
    },
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    captureSystemMessages: true,
    scriptedInteractions: [
        { type: "select", promptIncludes: "Settings", value: "model-presets" },
        { type: "select", promptIncludes: "Model Presets", value: "preset:broken-provider" },
        { type: "select", promptIncludes: "Model Presets", value: "back" },
        { type: "select", promptIncludes: "Settings", value: "done" },
        { type: "select", promptIncludes: "Settings", value: "model-presets" },
        { type: "select", promptIncludes: "Model Presets", value: "preset:golden-preset" },
        { type: "select", promptIncludes: "Model Presets", value: "back" },
        { type: "select", promptIncludes: "Settings", value: "done" },
    ],
    script: plannerScript("agent-unavailable-preset-recovery"),
    actions: [
        { type: "type", text: "/agent planner" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: 'Could not switch to Agent "planner"' },
        { type: "waitForScreen", text: `${GOLDEN_PROVIDER}/missing-preset-model` },
        { type: "waitForIdle" },
        { type: "type", text: "/settings" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Active model preset set to broken-provider." },
        { type: "waitForIdle" },
        { type: "type", text: "/agent planner" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "missing-provider/missing-model" },
        { type: "waitForIdle" },
        { type: "type", text: "/settings" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Active model preset set to golden-preset." },
        { type: "waitForIdle" },
        ...switchToPlannerAndSend("Recover with the valid preset model."),
    ],
    assertions: [
        (result: ConfigurationScenarioResult) => assertSystemError(result, `${GOLDEN_PROVIDER}/missing-preset-model`),
        (result: ConfigurationScenarioResult) => assertSystemError(result, "missing-provider/missing-model"),
        (result: ConfigurationScenarioResult) => assertPlannerEventAfterLastAgentCommand(result),
        (result: ConfigurationScenarioResult) => assertPlannerPrecedence(result, PRESET_MODEL),
    ],
};

export const slashAgentBaseSettingScenario = {
    name: "slash-command-agent-base-setting-model-precedence",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: configuredSettings({ preset: false }),
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    script: plannerScript("agent-base-setting-precedence"),
    actions: switchToPlannerAndSend("Use the base Agent setting."),
    assertions: [(result: ConfigurationScenarioResult) => assertPlannerPrecedence(result, BASE_AGENT_MODEL)],
};

export const slashAgentDefaultModelScenario = {
    name: "slash-command-agent-default-model-precedence",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: configuredSettings({ preset: false, baseAgent: false }),
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    script: plannerScript("agent-default-model-precedence"),
    actions: switchToPlannerAndSend("Use the settings default."),
    assertions: [(result: ConfigurationScenarioResult) => assertPlannerPrecedence(result, DEFAULT_MODEL)],
};

export const slashAgentFrontmatterModelScenario = {
    name: "slash-command-agent-frontmatter-model-fallback",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: configuredSettings({ preset: false, baseAgent: false, defaultModel: false }),
    skipModelWelcome: true,
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    script: plannerScript("agent-frontmatter-model-fallback"),
    actions: switchToPlannerAndSend("Use the Agent frontmatter model."),
    assertions: [(result: ConfigurationScenarioResult) => assertPlannerPrecedence(result, FRONTMATTER_MODEL)],
};

export const slashModelScenario = {
    name: "slash-command-model-manual-override-is-scoped-to-active-agent",
    slashCommands: ["model"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: configuredSettings(),
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    captureGlobalSettings: true,
    script: [
        {
            id: "manual-model-guide-turn",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            text: "Manual model handled the Guide turn.",
        },
        {
            id: "manual-model-guide-follow-up",
            agent: "guide",
            phase: "inquiry",
            ordinal: 2,
            text: "Manual model handled the Guide follow-up.",
        },
        ...plannerScript("manual-model-planner-turn"),
    ],
    actions: [
        { type: "type", text: `/model ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: `Switched model to ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "waitForIdle" },
        { type: "type", text: "Keep the manual model for this message." },
        { type: "enter" },
        { type: "waitForEvent", event: "model:faux-provider:guide:inquiry" },
        { type: "waitForIdle" },
        { type: "restartTui", sessionStartMode: "continue" },
        { type: "waitForIdle" },
        { type: "type", text: "Keep my model for the follow-up." },
        { type: "enter" },
        { type: "waitForScreen", text: "Manual model handled the Guide follow-up." },
        { type: "waitForIdle" },
        ...switchToPlannerAndSend("Use Planner's configured model after switching Agents."),
    ],
    assertions: [
        (result: ConfigurationScenarioResult) =>
            assertEventIncludes(result, `terminal:type:/model ${GOLDEN_PROVIDER}/${MANUAL_MODEL}`),
        (result: ConfigurationScenarioResult) => assertEquals(result.state.modelTurns?.length, 3),
        (result: ConfigurationScenarioResult) =>
            assertTurn(result, 0, {
                agent: "guide",
                model: MANUAL_MODEL,
                promptIncludes: ["You are the Guide — the read-mostly answer and orientation specialist in RunWield."],
            }),
        (result: ConfigurationScenarioResult) =>
            assertTurn(result, 1, {
                agent: "guide",
                model: MANUAL_MODEL,
                promptIncludes: ["You are the Guide — the read-mostly answer and orientation specialist in RunWield."],
            }),
        (result: ConfigurationScenarioResult) =>
            assertTurn(result, 2, {
                agent: "planner",
                model: PRESET_MODEL,
                promptIncludes: [
                    "You are the Planner — the Planned Change planning specialist in the RunWield system.",
                    PLANNER_PROMPT_MARKER,
                ],
            }),
        (result: ConfigurationScenarioResult) => assertFooter(result, "Planner", PRESET_MODEL),
        (result: ConfigurationScenarioResult) => {
            assertEquals(result.state.globalSettings?.defaultProvider, GOLDEN_PROVIDER);
            assertEquals(result.state.globalSettings?.defaultModel, DEFAULT_MODEL);
        },
    ],
};

export const slashModelUnavailableOverrideRecoveryScenario = {
    name: "slash-command-model-unavailable-override-recovery",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    models: goldenModels,
    globalSettings: configuredSettings(),
    initialProjectFiles: plannerFixture,
    captureModelTurns: true,
    captureGlobalSettings: true,
    captureSystemMessages: true,
    script: plannerScript("manual-model-unavailable-recovery"),
    actions: [
        { type: "type", text: `/model ${GOLDEN_PROVIDER}/missing-manual` },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: `Unknown model: ${GOLDEN_PROVIDER}/missing-manual` },
        { type: "waitForScreen", text: `${GOLDEN_PROVIDER}/faux` },
        { type: "waitForIdle" },
        { type: "type", text: "/model missing-provider/missing-model" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Unknown model: missing-provider/missing-model" },
        { type: "waitForScreen", text: `${GOLDEN_PROVIDER}/faux` },
        { type: "waitForIdle" },
        { type: "type", text: `/model ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: `Switched model to ${GOLDEN_PROVIDER}/${MANUAL_MODEL}` },
        { type: "waitForIdle" },
        ...switchToPlannerAndSend("Recover with Planner's configured model."),
    ],
    assertions: [
        (result: ConfigurationScenarioResult) => assertSystemError(result, `${GOLDEN_PROVIDER}/missing-manual`),
        (result: ConfigurationScenarioResult) => assertSystemError(result, "missing-provider/missing-model"),
        (result: ConfigurationScenarioResult) => assertPlannerEventAfterLastAgentCommand(result),
        (result: ConfigurationScenarioResult) => assertEquals(result.state.modelTurns?.length, 1),
        (result: ConfigurationScenarioResult) =>
            assertTurn(result, 0, {
                agent: "planner",
                model: PRESET_MODEL,
                promptIncludes: [
                    "You are the Planner — the Planned Change planning specialist in the RunWield system.",
                    PLANNER_PROMPT_MARKER,
                ],
            }),
        (result: ConfigurationScenarioResult) => assertFooter(result, "Planner", PRESET_MODEL),
        (result: ConfigurationScenarioResult) => {
            assertEquals(result.state.globalSettings?.defaultProvider, GOLDEN_PROVIDER);
            assertEquals(result.state.globalSettings?.defaultModel, DEFAULT_MODEL);
        },
    ],
};

export const slashThemeScenario = {
    name: "slash-command-theme",
    slashCommands: ["theme"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    scriptedInteractions: [{ type: "select", promptIncludes: "Select Theme", value: "catppuccin-mocha" }],
    actions: [
        { type: "type", text: "/theme" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: ConfigurationScenarioResult) => assertEventIncludes(result, "terminal:type:/theme"),
        (result: ConfigurationScenarioResult) => {
            assertEquals(result.state.scriptedInteractions?.[0]?.interaction?.value, "catppuccin-mocha");
        },
    ],
};

export const slashSettingsScenario = {
    name: "slash-command-settings",
    slashCommands: ["settings"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    scriptedInteractions: [{ type: "select", promptIncludes: "Settings", value: "done" }],
    actions: [
        { type: "type", text: "/settings" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: ConfigurationScenarioResult) => assertEventIncludes(result, "terminal:type:/settings"),
        (result: ConfigurationScenarioResult) => {
            const value = result.state.scriptedInteractions?.[0]?.interaction?.value;
            assert(value === "done", `Expected Settings Done selection, got ${value}`);
        },
    ],
};

export const slashMcpScenario = {
    name: "slash-command-mcp-status",
    slashCommands: ["mcp"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/mcp" },
        { type: "enter" },
        { type: "waitForScreen", text: "No MCP servers configured." },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: ConfigurationScenarioResult) => assertEventIncludes(result, "terminal:type:/mcp"),
        (result: ConfigurationScenarioResult) => assertEquals(result.state.modelTurns?.length || 0, 0),
    ],
};

export const slashCommandConfigurationScenarios = [
    slashMcpScenario,
    slashAgentScenario,
    slashAgentUnavailablePresetRecoveryScenario,
    slashAgentBaseSettingScenario,
    slashAgentDefaultModelScenario,
    slashAgentFrontmatterModelScenario,
    slashModelScenario,
    slashModelUnavailableOverrideRecoveryScenario,
    slashThemeScenario,
    slashSettingsScenario,
];
