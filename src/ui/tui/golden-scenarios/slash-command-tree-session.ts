import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.ts";

function typed(command: string) {
    return (result: Parameters<typeof assertEventIncludes>[0]) =>
        assertEventIncludes(result, `terminal:type:${command}`);
}

export const slashNameScenario = {
    name: "slash-command-name",
    slashCommands: ["name"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/name golden slash session" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "type", text: "/name" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        typed("/name golden slash session"),
        (result: Parameters<typeof assertScreenIncludes>[0]) =>
            assertScreenIncludes(result, "Session name: golden slash session"),
    ],
};

export const slashSessionScenario = {
    name: "slash-command-session",
    slashCommands: ["session"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/session" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        typed("/session"),
        (result: Parameters<typeof assertScreenIncludes>[0]) => assertScreenIncludes(result, "Session Info"),
    ],
};

export const slashContextScenario = {
    name: "slash-command-context",
    slashCommands: ["context"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    script: [{
        id: "guide-establishes-context",
        agent: "guide",
        phase: "inquiry",
        ordinal: 1,
        text: "Context fixture established.",
    }],
    actions: [
        { type: "type", text: "establish context for the slash command" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "type", text: "/context" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        typed("/context"),
        (result: Parameters<typeof assertScreenIncludes>[0]) => assertScreenIncludes(result, "Context Usage"),
    ],
};

export const slashCommandSessionScenarios = [slashNameScenario, slashSessionScenario, slashContextScenario];
