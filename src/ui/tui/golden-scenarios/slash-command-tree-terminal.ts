import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.ts";

type GoldenResult = Parameters<typeof assertEventIncludes>[0];

export const slashHelpScenario = {
    name: "slash-command-help",
    slashCommands: ["help"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/help" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/help"),
        (result: GoldenResult) => assertScreenIncludes(result, "Global flags:"),
    ],
};

export const slashLoadPlanScenario = {
    name: "slash-command-load-plan-empty",
    slashCommands: ["load-plan"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "waitForScreen", text: "? help" },
        { type: "type", text: "/load-plan" },
        { type: "enter" },
        { type: "waitForScreen", text: "No plans available" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/load-plan"),
        (result: GoldenResult) => assertScreenIncludes(result, "No plans available"),
    ],
};

export const slashPlanReviewScenario = {
    name: "slash-command-plan-review-empty",
    slashCommands: ["plan-review"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "waitForScreen", text: "? help" },
        { type: "type", text: "/plan-review" },
        { type: "enter" },
        { type: "waitForScreen", text: "no previous Plan review" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/plan-review"),
        (result: GoldenResult) => assertScreenIncludes(result, "no previous Plan review"),
    ],
};

export const slashShareScenario = {
    name: "slash-command-share-gh-unavailable",
    slashCommands: ["share"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "waitForScreen", text: "? help" },
        { type: "type", text: "/share" },
        { type: "waitForScreen", text: "→ share" },
        { type: "enter" },
        // `/share` spawns the fixture `gh` binary, and nothing marks the session
        // busy while that subprocess runs. `waitForIdle` alone can call the run
        // finished during that gap, so wait for the rendered failure first.
        { type: "waitForScreen", text: "GitHub CLI ('gh') is not installed", timeoutMs: 30000 },
        { type: "waitForIdle" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "GitHub CLI ('gh') is not installed" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/share"),
        (result: GoldenResult) => assertScreenIncludes(result, "GitHub CLI ('gh') is not installed"),
    ],
};

function cleanExitScenario(name: string, command: string) {
    return {
        name,
        slashCommands: [command.slice(1)],
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        startupInput: [{ marker: "? help", keys: `${command}\r` }],
        expectedCleanExit: true,
        actions: [],
        assertions: [],
        timeoutMs: 5000,
    };
}

export const slashQuitScenario = cleanExitScenario("slash-command-quit", "/quit");
export const slashExitScenario = cleanExitScenario("slash-command-exit", "/exit");

export const slashCommandTerminalScenarios = [
    slashHelpScenario,
    slashLoadPlanScenario,
    slashPlanReviewScenario,
    slashShareScenario,
    slashQuitScenario,
    slashExitScenario,
];
