/**
 * @module ui/tui/golden-scenarios/presentation-and-terminal
 * Focused composed Golden TUI presentation and terminal-behavior scenarios.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";
import { assertRuntimeEvent, assertsGoldenCoverage } from "../testing/portfolio-assertions.js";

/** @typedef {import('../testing/scenario-runner.js').GoldenScenario} GoldenScenario */

/** @typedef {import('../testing/scenario-runner.js').GoldenScenarioResult} GoldenScenarioResult */

/**
 * Assert against the screen captured while the presentation blocks were up.
 *
 * The run's final screen cannot serve: every block this scenario exercises is torn
 * down before the run ends. Scrollback is included because a block appended to the
 * message list scrolls above the viewport as soon as anything follows it.
 *
 * @param {GoldenScenarioResult} result
 * @param {string} text
 */
function assertPresentationScreenIncludes(result, text) {
    const screen = String(result.state.presentationScreen || "");
    const scrollback = String(result.state.presentationScrollback || "");
    assert(
        screen.includes(text) || scrollback.includes(text),
        `Expected the presentation screen to include ${JSON.stringify(text)}. Screen:\n${screen}`,
    );
}

/** @type {GoldenScenario} */
export const managedSyncQueueImageScenario = {
    name: "presentation-runtime-prompts-and-queued-state",
    composedTui: true,
    terminal: { columns: 100, rows: 60 },
    coverage: [
        "block:spinner",
        "block:managed-sync",
        "block:queued-steering",
        "block:image",
        "block:select",
        "block:text",
        "terminal:queueing",
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "Choose a path", value: "b" },
        { type: "text", promptIncludes: "Describe image", value: "image attached" },
    ],
    actions: [
        {
            type: "runtimeInteraction",
            expectedOutcome: "selected",
            request: {
                type: "select",
                prompt: "Choose a path",
                options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
            },
        },
        {
            type: "runtimeInteraction",
            expectedOutcome: "text",
            request: { type: "text", prompt: "Describe image", allowEmpty: false },
        },
        { type: "uiPresentationState" },
    ],
    assertions: [
        // Each of these renders something; asserting the render is the point of
        // running a terminal at all. They were previously claimed by `ui:*` events,
        // which only proved the UI method was called — the blocks could stop
        // reaching the screen entirely without a single scenario noticing.
        assertsGoldenCoverage("block:spinner", (result) => {
            const screen = String(result.state.presentationScreen || "");
            assert(
                /Routing\.\.\.|Figuring out what you need\.\.\./.test(screen),
                `Expected the Router busy status on the presentation screen. Screen:\n${screen}`,
            );
        }),
        assertsGoldenCoverage("block:managed-sync", (result) => {
            assertPresentationScreenIncludes(result, "Sync degraded — refresh required");
        }),
        assertsGoldenCoverage("block:queued-steering", (result) => {
            assertPresentationScreenIncludes(result, "Steering: Queued steering message");
        }),
        assertsGoldenCoverage("block:image", (result) => {
            assert(
                result.state.presentationImageRendered === true,
                "Expected the image block to render image bytes or its terminal fallback.",
            );
        }),
        assertsGoldenCoverage("block:select", (result) => {
            assertEventIncludes(result, "interaction:select:selected");
        }),
        assertsGoldenCoverage("block:text", (result) => {
            assertEventIncludes(result, "interaction:text:text");
        }),
        assertRuntimeEvent("terminal:queueing", "ui:queued-steering:remove"),
    ],
};

/** @type {GoldenScenario} */
export const terminalControlsScenario = {
    name: "terminal-controls-autocomplete-resize-ctrlc-focus",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    coverage: [
        "terminal:ctrl-c",
        "terminal:slash-command",
        "terminal:autocomplete",
        "terminal:resize",
        "terminal:prompt-focus-restoration",
        "block:keyboard-help",
    ],
    actions: [
        { type: "type", text: "/help" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 5000 },
        { type: "slashAutocomplete" },
        { type: "promptFocusRoundTrip" },
        { type: "resize", columns: 120, rows: 40 },
        { type: "assertTerminalSize", columns: 120, rows: 40 },
        { type: "ctrlC" },
        { type: "waitForIdle", timeoutMs: 5000 },
    ],
    assertions: [
        assertRuntimeEvent("terminal:ctrl-c", "terminal:ctrl-c"),
        assertsGoldenCoverage("terminal:slash-command", (result) => {
            assertEventIncludes(result, "terminal:type:/help");
            assertScreenIncludes(result, "Global flags:");
        }),
        assertRuntimeEvent("terminal:autocomplete", "terminal:autocomplete:/he"),
        assertRuntimeEvent("terminal:resize", "terminal:resize:120x40"),
        assertRuntimeEvent("terminal:prompt-focus-restoration", "ui:prompt-focus:restored"),
        assertsGoldenCoverage("block:keyboard-help", (result) => assertScreenIncludes(result, "Global flags:")),
    ],
};

/** @type {GoldenScenario} */
export const replayHydrationScenario = {
    name: "terminal-session-replay-hydration",
    composedTui: true,
    sessionStartMode: "continue",
    initialAgentName: "guide",
    priorSession: {
        agentName: "guide",
        userText: "seed prior session before hydration",
        assistantText: "Prior persisted Session answer available for replay.",
    },
    terminal: { columns: 100, rows: 30 },
    coverage: ["terminal:replay-hydration"],
    script: [{
        id: "guide-hydrated-answer",
        agent: "guide",
        phase: "inquiry",
        ordinal: 1,
        text: "Hydrated Session accepted a follow-up.",
    }],
    actions: [
        { type: "type", text: "follow up after hydration" },
        { type: "enter" },
        // An idle snapshot can precede asynchronous submit startup. Observe the
        // actual reply before checking that the resumed turn has settled.
        { type: "waitForScreen", text: "Hydrated Session accepted a follow-up.", timeoutMs: 20000 },
        { type: "waitForIdle", timeoutMs: 20000 },
    ],
    assertions: [
        assertsGoldenCoverage("terminal:replay-hydration", (result) => {
            assertEventIncludes(result, "runtime:assistant:text");
            assert(
                result.state.priorSession && typeof result.state.priorSession === "object" &&
                    "sessionId" in result.state.priorSession,
                "Expected a persisted prior Session to be seeded before continue-mode hydration.",
            );
            assertScreenIncludes(result, "Prior persisted Session answer available for replay.");
            assertScreenIncludes(result, "Hydrated Session accepted a follow-up.");
        }),
    ],
};

/** @type {GoldenScenario} */
export const toolFailureRecoveryScenario = {
    name: "presentation-tool-failure-and-recovery",
    composedTui: true,
    initialAgentName: "operator",
    terminal: { columns: 100, rows: 30 },
    coverage: ["recovery:tool-failure", "block:system-error", "block:tool"],
    script: [
        {
            id: "operator-failing-tool",
            agent: "operator",
            phase: "operator",
            ordinal: 1,
            requiredTools: ["bash"],
            thinking: "Run a bounded failing command inside the isolated fixture.",
            toolCalls: [{ name: "bash", arguments: { command: "false" } }],
        },
        {
            id: "operator-recovery",
            agent: "operator",
            phase: "operator",
            ordinal: 2,
            text: "Recovered after bounded tool failure.",
        },
    ],
    actions: [{ type: "type", text: "run a bounded failing command and recover" }, { type: "enter" }, {
        type: "waitForIdle",
        timeoutMs: 10000,
    }],
    assertions: [
        assertsGoldenCoverage("recovery:tool-failure", (result) => {
            assertEventIncludes(result, "runtime:tool:end:bash");
            assertScreenIncludes(result, "Recovered after bounded tool failure.");
        }),
        // The failed tool block and recovery response both render; asserting the events
        // that preceded them proved only that the runtime got that far.
        assertsGoldenCoverage("block:system-error", (result) => {
            assertScreenIncludes(result, "Recovered after bounded tool failure.");
        }),
        assertsGoldenCoverage("block:tool", (result) => {
            assertScreenIncludes(result, "$ false");
        }),
    ],
};

/** @type {GoldenScenario[]} */
export const presentationAndTerminalScenarios = [
    managedSyncQueueImageScenario,
    terminalControlsScenario,
    replayHydrationScenario,
    toolFailureRecoveryScenario,
];
