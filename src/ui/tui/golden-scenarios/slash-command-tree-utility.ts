import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";
import { VERSION } from "../../../shared/version.js";

function typed(command: string) {
    return (result: Parameters<typeof assertEventIncludes>[0]) =>
        assertEventIncludes(result, `terminal:type:${command}`);
}

export const slashVersionScenario = {
    name: "slash-command-version",
    slashCommands: ["version"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [{ type: "type", text: "/version" }, { type: "enter" }, { type: "waitForIdle" }],
    assertions: [
        typed("/version"),
        (result: Parameters<typeof assertScreenIncludes>[0]) => assertScreenIncludes(result, `runwield ${VERSION}`),
    ],
};

export const slashExportScenario = {
    name: "slash-command-export",
    slashCommands: ["export"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "guide-persists-export-session",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            text: "Export fixture session persisted.",
        },
    ],
    actions: [
        { type: "type", text: "persist this session before export" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "type", text: "/export golden-slash-session.json" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "assertProjectFile", path: "golden-slash-session.json", exists: true },
    ],
    assertions: [
        typed("/export golden-slash-session.json"),
        (result: Parameters<typeof assertScreenIncludes>[0]) => assertScreenIncludes(result, "Session exported to:"),
    ],
};

export const slashCopyScenario = {
    name: "slash-command-copy-empty",
    slashCommands: ["copy"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [{ type: "type", text: "/copy" }, { type: "enter" }, { type: "waitForIdle" }],
    assertions: [
        typed("/copy"),
        (result: Parameters<typeof assertScreenIncludes>[0]) =>
            assertScreenIncludes(result, "Nothing to copy — no assistant message found."),
    ],
};

export const slashReloadScenario = {
    name: "slash-command-reload",
    slashCommands: ["reload"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "guide-persists-reload-session",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            text: "Reload fixture session persisted.",
        },
    ],
    actions: [
        { type: "type", text: "persist this session before reload" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "type", text: "/reload" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        typed("/reload"),
        (result: Parameters<typeof assertScreenIncludes>[0]) => assertScreenIncludes(result, "Successfully reloaded"),
    ],
};

export const slashCommandUtilityScenarios = [
    slashVersionScenario,
    slashExportScenario,
    slashCopyScenario,
    slashReloadScenario,
];
