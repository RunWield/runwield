/**
 * @module ui/tui/golden-scenarios/initial-scenarios
 * Initial Golden TUI scenario definitions.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";

/** @typedef {import('../testing/scenario-runner.js').GoldenScenarioResult} GoldenScenarioResult */

/** @param {GoldenScenarioResult} result */
function assertRuntimeGuideSwitch(result) {
    assertEventIncludes(result, "runtime:agent:guide");
    assert(
        result.state.activeAgent === "guide",
        `Expected Runtime active Agent to be guide; got ${result.state.activeAgent}`,
    );
    assertEventIncludes(result, "runtime:tool:start:triage_report");
    assertEventIncludes(result, "runtime:tool:start:read");
    assertEventIncludes(result, "runtime:assistant:thinking");
    assertEventIncludes(result, "runtime:assistant:text");
}

/** @param {GoldenScenarioResult} result */
function assertTerminalInputVisible(result) {
    assertEventIncludes(result, "terminal:type:how does routing work?");
}

/** @param {GoldenScenarioResult} result */
function assertProjectClean(result) {
    assert(
        result.state.projectMutation === "clean",
        `Expected clean Project mutation state; got ${result.state.projectMutation}`,
    );
}

/** @param {GoldenScenarioResult} result */
function assertCancellationEvent(result) {
    assertEventIncludes(result, "runtime:cancellation");
}

/** @param {GoldenScenarioResult} result */
function assertEditorReady(result) {
    assert(result.state.editorUsable === true, "Expected editor to be usable after cancellation.");
    assertEventIncludes(result, "terminal:type:benign follow-up after cancel");
    assertEventIncludes(result, "runtime:assistant:text");
}

/** @param {GoldenScenarioResult} result */
function assertHelpSlashVisible(result) {
    assertEventIncludes(result, "terminal:type:/help");
}

/** @param {GoldenScenarioResult} result */
function assertKeyboardHelpVisible(result) {
    assertScreenIncludes(result, "Global flags:");
}

/** @param {GoldenScenarioResult} result */
function assertStartupLoginPromptOpened(result) {
    const startupScreen = String(result.state.startupScreen || "");
    assert(
        startupScreen.includes("Welcome to RunWield"),
        `Expected no-provider startup to show the real login prompt. Screen:\n${startupScreen}`,
    );
    assert(
        !startupScreen.includes("Only showing models from configured providers"),
        "Expected no-provider startup to open login before model selection.",
    );
}

/** @param {GoldenScenarioResult} result */
function assertStartupModelSelectorOpened(result) {
    const startupScreen = String(result.state.startupScreen || "");
    assert(
        startupScreen.includes("Only showing models from configured providers"),
        `Expected configured-provider startup to open the real model selector. Screen:\n${startupScreen}`,
    );
    assert(
        !startupScreen.includes("Welcome to RunWield"),
        "Expected configured-provider startup to open model selection without login onboarding.",
    );
}

/** @param {GoldenScenarioResult} result */
function assertReviewFeedbackEvent(result) {
    assertEventIncludes(result, "interaction:PLAN_REVIEW:feedback");
    assertEventIncludes(result, "review_feedback");
}

/** @param {GoldenScenarioResult} result */
function assertReviewApprovedEvent(result) {
    assertEventIncludes(result, "interaction:PLAN_REVIEW:approved");
    assertEventIncludes(result, "review_approved");
}

/** @param {GoldenScenarioResult} result */
function assertPlanReviewLifecyclePersisted(result) {
    const planReview =
        /** @type {{ lifecycleEvents?: Array<{ event: string, status?: unknown }>, attrs?: Record<string, unknown>, consumed?: unknown[] } | undefined} */ (result
            .state.planReview);
    assert(planReview, "Expected planReview state from production submitPlanForReview transaction.");
    assert(
        planReview.lifecycleEvents?.map((event) => `${event.event}:${event.status}`).join(",") ===
            "review_feedback:feedback,review_approved:approved",
        `Expected persisted feedback then approval lifecycle statuses; got ${
            JSON.stringify(planReview.lifecycleEvents)
        }`,
    );
    assert(planReview.consumed?.length === 2, "Expected scripted review surface to be consumed twice.");
    assert(
        String(/** @type {{ plan?: unknown }} */ (planReview).plan || "").includes("Reviewed content persisted."),
        "Expected reviewed Plan body to persist.",
    );
}

export const routerToGuideInquiryScenario = {
    name: "router-to-guide-inquiry",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "router-triage-inquiry",
            agent: "router",
            phase: "triage",
            requiredTools: ["triage_report"],
            thinking: "Classify this as an inquiry and hand it to Guide.",
            toolCalls: [{
                name: "triage_report",
                arguments: {
                    routingIntent: "INQUIRY",
                    complexity: "LOW",
                    summary: "User asks how RunWield routing works.",
                    sessionName: "routing guide",
                },
            }],
        },
        {
            id: "guide-read-fixture",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            requiredTools: ["read"],
            thinking: "Read the project fixture before answering.",
            toolCalls: [{ name: "read", arguments: { path: "README.md" } }],
        },
        {
            id: "guide-answer",
            agent: "guide",
            phase: "inquiry",
            ordinal: 2,
            thinking: "Summarize the answer from the read-only context.",
            text:
                "Guide answer: Router classifies the request, then RunWield hands the turn to Guide for read-only help.",
        },
    ],
    actions: [
        { type: "type", text: "how does routing work?" },
        { type: "enter" },
        { type: "waitForIdle" },
        { type: "assertProjectUnchanged" },
    ],
    assertions: [assertTerminalInputVisible, assertRuntimeGuideSwitch, assertProjectClean],
};

export const escapeCancellationScenario = {
    name: "escape-cancellation-restores-editor",
    // This journey must remain streaming while the terminal delivers Escape.
    modelTokensPerSecond: 80,
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "guide-slow-answer",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            thinking: "Start a long answer so Escape can interrupt active work.",
            text:
                "This answer is intentionally long enough for the Golden harness to press Escape while Runtime work is active. It should be canceled before it completes all rendering.",
        },
        {
            id: "guide-after-cancel",
            agent: "guide",
            phase: "inquiry",
            ordinal: 2,
            text: "Follow-up accepted after cancellation.",
        },
    ],
    actions: [
        { type: "type", text: "please start a cancellable answer" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:turn_start" },
        { type: "waitForEvent", event: "model:faux-provider:guide:inquiry" },
        { type: "escape" },
        { type: "waitForEvent", event: "runtime:cancellation" },
        { type: "waitForIdle" },
        { type: "clearEditor" },
        { type: "type", text: "benign follow-up after cancel" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [assertCancellationEvent, assertEditorReady],
};

export const helpSlashCommandScenario = {
    name: "help-slash-command",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    actions: [
        { type: "type", text: "/help" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [assertHelpSlashVisible, assertKeyboardHelpVisible],
};

export const startupNoProvidersOpensLoginScenario = {
    name: "startup-no-providers-opens-login",
    composedTui: true,
    modelSetup: "none",
    terminal: { columns: 100, rows: 30 },
    // The welcome login prompt blocks composition startup, so the cancel key is
    // fed in flight once the prompt is on screen. Cancelling follows the real
    // /quit path, which exits the child with code 0 — the child protocol treats
    // that clean exit as this scenario's terminal success signal.
    startupInput: [
        { marker: "Welcome to RunWield", keys: "\x1b" },
    ],
    expectedCleanExit: true,
    actions: [],
    assertions: [assertStartupLoginPromptOpened],
    timeoutMs: 5000,
};

export const startupProviderWithoutModelsOpensModelScenario = {
    name: "startup-provider-without-models-opens-model",
    composedTui: true,
    modelSetup: "provider-without-models",
    terminal: { columns: 100, rows: 30 },
    // The model selector blocks composition startup; Esc cancels it so the
    // scenario can resolve and assert the real screen it observed. CI can need a
    // few extra seconds before the selector paints while other golden children run.
    startupInput: [
        { marker: "Only showing models from configured providers", keys: "\x1b" },
    ],
    actions: [],
    assertions: [assertStartupModelSelectorOpened],
    timeoutMs: 15000,
};

export const planReviewTransactionContractScenario = {
    name: "plan-review-transaction-contract",
    composedTui: true,
    initialAgentName: "planner",
    terminal: { columns: 100, rows: 30 },
    reviewDecisions: [
        { approved: false, feedback: "Needs narrower scope." },
        { approved: true, feedback: "Approved.", approvalAction: "later" },
    ],
    reviewedPlan: "# Plan\n\nReviewed content persisted.\n",
    script: [
        {
            id: "planner-submit-feedback-round",
            agent: "planner",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            thinking: "Submit the Plan for browser review through Runtime interaction.",
            toolCalls: [{
                name: "plan_written",
                arguments: { planName: "plan" },
            }],
        },
        {
            id: "planner-submit-approval-round",
            agent: "planner",
            phase: "plan_review",
            ordinal: 2,
            requiredTools: ["plan_written"],
            thinking: "Resubmit the reviewed Plan for approval through the same interaction seam.",
            toolCalls: [{
                name: "plan_written",
                arguments: { planName: "plan" },
            }],
        },
    ],
    actions: [
        {
            type: "writeProjectFile",
            path: "docs/plans/plan.md",
            text: "---\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Plan\n\nDo the thing.\n",
        },
        { type: "type", text: "submit the plan for review" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [assertReviewFeedbackEvent, assertReviewApprovedEvent, assertPlanReviewLifecyclePersisted],
};

export const fauxProviderProtocolScenario = {
    name: "faux-provider-protocol-contract",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    script: [
        {
            id: "router-protocol-real-turn",
            agent: "router",
            phase: "triage",
            requiredTools: ["triage_report"],
            forbiddenTools: ["write", "edit"],
            thinking: "Validate actual Router identity and tool availability.",
            toolCalls: [{
                name: "triage_report",
                arguments: {
                    routingIntent: "INQUIRY",
                    complexity: "LOW",
                    summary: "Protocol check routes to Guide.",
                    sessionName: "protocol check",
                },
            }],
        },
        {
            id: "guide-protocol-real-turn",
            agent: "guide",
            phase: "inquiry",
            text: "Guide protocol response from the real faux provider loop.",
        },
    ],
    actions: [
        { type: "type", text: "protocol check" },
        { type: "enter" },
        { type: "waitForIdle" },
    ],
    assertions: [
        (/** @type {GoldenScenarioResult} */ result) =>
            assertEventIncludes(result, "model:faux-provider:router:triage"),
        (/** @type {GoldenScenarioResult} */ result) =>
            assertEventIncludes(result, "model:faux-provider:guide:inquiry"),
    ],
};

/** @param {GoldenScenarioResult} result */
function assertScriptedRuntimeInteractions(result) {
    assertEventIncludes(result, "interaction:select:selected");
    assertEventIncludes(result, "interaction:text:text");
    assertEventIncludes(result, "interaction:approval:accepted");
    const interactions = /** @type {unknown[]} */ (result.state.scriptedInteractions || []);
    assert(interactions.length === 3, `Expected three scripted Runtime interactions; got ${interactions.length}`);
}

export const runtimeInteractionContractScenario = {
    name: "runtime-interaction-contract",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    scriptedInteractions: [
        { type: "select", promptIncludes: "Choose a path", value: "b" },
        { type: "text", promptIncludes: "Enter validation command", value: "deno task ci" },
        { type: "approval", promptIncludes: "Approve this action", value: "approve" },
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
            request: { type: "text", prompt: "Enter validation command", allowEmpty: false },
        },
        {
            type: "runtimeInteraction",
            expectedOutcome: "accepted",
            request: {
                type: "approval",
                prompt: "Approve this action",
                options: [{ value: "approve", label: "Approve", _meta: { accepted: true } }],
            },
        },
    ],
    assertions: [assertScriptedRuntimeInteractions],
};

// Deliberately hangs so the parent's scenario timeout fires mid-sleep. The sleep
// is far longer than that timeout so the kill window cannot be outrun.
export const timeoutDiagnosticScenario = {
    name: "timeout-diagnostic-contract",
    composedTui: true,
    terminal: { columns: 80, rows: 20 },
    script: [{ id: "timeout-unused-turn", agent: "router", phase: "triage", text: "unused" }],
    actions: [{ type: "sleep", ms: 120_000 }],
};

export const diagnosticArtifactFailureScenario = {
    name: "diagnostic-artifact-failure",
    composedTui: true,
    terminal: { columns: 80, rows: 20 },
    script: [{ id: "unused-router-turn", agent: "router", phase: "triage", text: "unused" }],
    actions: [{ type: "unknown-composed-action" }],
};

export const initialGoldenScenarios = [
    routerToGuideInquiryScenario,
    escapeCancellationScenario,
    helpSlashCommandScenario,
    planReviewTransactionContractScenario,
    fauxProviderProtocolScenario,
    runtimeInteractionContractScenario,
    startupNoProvidersOpensLoginScenario,
    startupProviderWithoutModelsOpensModelScenario,
];
