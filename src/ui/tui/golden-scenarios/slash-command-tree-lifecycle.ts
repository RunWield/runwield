import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";

type GoldenResult = Parameters<typeof assertEventIncludes>[0];

export const slashNewScenario = {
    name: "slash-command-new",
    slashCommands: ["new"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/new golden replacement" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "type", text: "/name" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/new golden replacement"),
        (result: GoldenResult) => assertScreenIncludes(result, "Session name: golden replacement"),
    ],
};

export const slashResumeScenario = {
    name: "slash-command-resume-empty",
    slashCommands: ["resume"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/resume" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/resume"),
        (result: GoldenResult) => assertScreenIncludes(result, "No recent sessions found to resume."),
    ],
};

export const slashCompactScenario = {
    name: "slash-command-compact-empty",
    slashCommands: ["compact"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/compact" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/compact"),
        (result: GoldenResult) => assertScreenIncludes(result, "Nothing to compact"),
    ],
};

export const slashInitScenario = {
    name: "slash-command-init-hidden-after-initialization",
    slashCommands: ["init"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/init" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/init"),
        (result: GoldenResult) => assertScreenIncludes(result, "already initialized"),
    ],
};

export const startupInitScenario = {
    name: "startup-init-offer-runs-agent",
    composedTui: true,
    initDone: true,
    initArtifact: false,
    initialAgentName: "router",
    terminal: { columns: 100, rows: 30 },
    scriptedInteractions: [
        { type: "select", promptIncludes: "Would you like to run /init", value: "yes" },
        { type: "select", promptIncludes: "Init will create or update these project files", value: "yes" },
    ],
    script: [
        {
            id: "init-writes-domain-language",
            agent: "init",
            phase: "init",
            ordinal: 1,
            requiredTools: ["init_save_verification_command", "write"],
            toolCalls: [
                {
                    name: "init_save_verification_command",
                    arguments: { command: "deno task ci" },
                },
                {
                    name: "write",
                    arguments: {
                        path: "docs/domain-language.md",
                        content: "# Domain Language\n\n## Golden Fixture\n\nCurrent Golden project terminology.\n",
                    },
                },
            ],
        },
        {
            id: "init-confirms-completion",
            agent: "init",
            phase: "init",
            ordinal: 2,
            text: "Initialization completed after verifying the domain language artifact.",
        },
    ],
    actions: [
        { type: "waitForIdle" },
        { type: "assertProjectFile", path: "docs/domain-language.md", exists: true },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "model:faux-provider:init:init"),
        (result: GoldenResult) => assertScreenIncludes(result, "Init complete"),
    ],
    timeoutMs: 60000,
};
export const slashSleepScenario = {
    name: "slash-command-sleep",
    slashCommands: ["sleep"],
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "sleep-engineer-maintenance",
            agent: "engineer",
            phase: "engineer",
            text: "Golden memory maintenance complete.",
        },
    ],
    actions: [
        { type: "type", text: "/sleep" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:agent:engineer" },
        { type: "waitForScreen", text: "Golden memory maintenance complete.", timeoutMs: 30000 },
        { type: "waitForIdle" },
    ],
    assertions: [
        (result: GoldenResult) => assertEventIncludes(result, "terminal:type:/sleep"),
        (result: GoldenResult) => assertEventIncludes(result, "runtime:agent:engineer"),
        (result: GoldenResult) => assertScreenIncludes(result, "Memory backup created before sleep mode"),
        (result: GoldenResult) => assertScreenIncludes(result, "Golden memory maintenance complete."),
    ],
};

export const slashCommandLifecycleScenarios = [
    slashNewScenario,
    slashResumeScenario,
    slashCompactScenario,
    slashInitScenario,
    startupInitScenario,
    slashSleepScenario,
];
