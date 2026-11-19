import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.ts";

type GoldenResult = Parameters<typeof assertEventIncludes>[0];

function authScenario(name: string, slashCommand: string, command: string, expected: string) {
    return {
        name,
        slashCommands: [slashCommand],
        composedTui: true,
        initialAgentName: "guide",
        terminal: { columns: 100, rows: 30 },
        actions: [
            { type: "type", text: command },
            { type: "enter" },
            { type: "waitForIdle" },
        ],
        assertions: [
            (result: GoldenResult) => assertEventIncludes(result, `terminal:type:${command}`),
            (result: GoldenResult) => assertScreenIncludes(result, expected),
        ],
    };
}

export const slashLoginScenario = {
    name: "slash-command-login-cancel",
    slashCommands: ["login"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    scriptedInteractions: [{ type: "select", promptIncludes: "Select authentication method", value: null }],
    actions: [
        { type: "type", text: "/login" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/login"),
        (result: GoldenResult) => {
            const interactions = result.state.scriptedInteractions as Array<{
                interaction?: { value?: string | null };
                request?: { prompt?: string };
            }>;
            if (interactions.length !== 1 || interactions[0]?.interaction?.value !== null) {
                throw new Error(`Expected one canceled login interaction; got ${JSON.stringify(interactions)}`);
            }
        },
    ],
};

export const slashLogoutScenario = authScenario(
    "slash-command-logout-no-stored-credentials",
    "logout",
    "/logout",
    "No stored credentials to remove.",
);

export const slashStatusScenario = authScenario(
    "slash-command-status",
    "status",
    "/status",
    "Available models:",
);

export const slashCommandAuthScenarios = [slashLoginScenario, slashLogoutScenario, slashStatusScenario];
