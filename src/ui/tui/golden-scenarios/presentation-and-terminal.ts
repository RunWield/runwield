/**
 * @module ui/tui/golden-scenarios/presentation-and-terminal
 * Focused composed Golden TUI presentation and terminal-behavior scenarios.
 */

import type { GoldenScenario, GoldenScenarioResult } from "../testing/scenario-runner.js";

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";
import { assertRuntimeEvent, assertsGoldenCoverage } from "../testing/portfolio-assertions.ts";

/**
 * Assert against the screen captured while the presentation blocks were up.
 *
 * The run's final screen cannot serve: every block this scenario exercises is torn
 * down before the run ends. Scrollback is included because a block appended to the
 * message list scrolls above the viewport as soon as anything follows it.
 *
 */
function assertPresentationScreenIncludes(result: GoldenScenarioResult, text: string): void {
    const screen = String(result.state.presentationScreen || "");
    const scrollback = String(result.state.presentationScrollback || "");
    assert(
        screen.includes(text) || scrollback.includes(text),
        `Expected the presentation screen to include ${JSON.stringify(text)}. Screen:\n${screen}`,
    );
}

export const managedSyncQueueImageScenario: GoldenScenario = {
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
                options: [
                    { value: "a", label: "A" },
                    { value: "b", label: "B" },
                ],
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

export const terminalControlsScenario: GoldenScenario = {
    name: "terminal-autocomplete-and-input-after-prompt-cancellation",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "guide-after-terminal-controls",
            agent: "guide",
            phase: "inquiry",
            text: "Input works after prompt cancellation.",
        },
    ],
    actions: [
        { type: "slashAutocomplete" },
        { type: "enter" },
        { type: "waitForScreen", text: "Global flags:" },
        { type: "waitForIdle", timeoutMs: 10000 },
        { type: "promptFocusRoundTrip" },
        { type: "resize", columns: 120, rows: 40 },
        { type: "assertTerminalSize", columns: 120, rows: 40 },
        { type: "type", text: "discard this draft" },
        { type: "ctrlC" },
        { type: "type", text: "continue after prompt cancellation" },
        { type: "enter" },
        { type: "waitForScreen", text: "Input works after prompt cancellation." },
        { type: "waitForIdle", timeoutMs: 10000 },
    ],
    assertions: [
        (result) => {
            assertScreenIncludes(result, "Global flags:");
            assertScreenIncludes(result, "  continue after prompt cancellation");
            assertScreenIncludes(result, "Input works after prompt cancellation.");
            assert(
                !result.screenText.includes("discard this draft"),
                "Ctrl-C must clear the draft before the next submission.",
            );
        },
    ],
};

export const replayHydrationScenario: GoldenScenario = {
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
    script: [
        {
            id: "guide-hydrated-answer",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            text: "Hydrated Session accepted a follow-up.",
        },
    ],
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
                result.state.priorSession &&
                    typeof result.state.priorSession === "object" &&
                    "sessionId" in result.state.priorSession,
                "Expected a persisted prior Session to be seeded before continue-mode hydration.",
            );
            assertScreenIncludes(result, "Prior persisted Session answer available for replay.");
            assertScreenIncludes(result, "Hydrated Session accepted a follow-up.");
        }),
    ],
};

export const toolFailureRecoveryScenario: GoldenScenario = {
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
    actions: [
        { type: "type", text: "run a bounded failing command and recover" },
        { type: "enter" },
        {
            type: "waitForIdle",
            timeoutMs: 10000,
        },
    ],
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

export const presentationAndTerminalScenarios: GoldenScenario[] = [
    managedSyncQueueImageScenario,
    terminalControlsScenario,
    replayHydrationScenario,
    toolFailureRecoveryScenario,
];
