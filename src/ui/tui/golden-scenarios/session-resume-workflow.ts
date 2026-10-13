/**
 * Composed Golden /resume journeys for persisted, corrupt, and interrupted Sessions.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";

type GoldenResult = Parameters<typeof assertEventIncludes>[0];

interface ResumeSnapshot {
    activeAgent?: string | null;
    activeModel?: { model?: string; provider?: string };
    workflowContext?: { routingIntent?: string; complexity?: string; planName?: string } | null;
    managed?: { generation?: number | null } | null;
}

type ResumeState = GoldenResult["state"] & {
    snapshot?: ResumeSnapshot | null;
    priorSession?: {
        interrupted?: boolean;
        managed?: { generation?: number | null } | null;
        workflowContext?: { planName?: string } | null;
    } | null;
    corruptSession?: { id?: string; path?: string } | null;
    scriptedInteractions?: Array<{
        request?: { prompt?: string; options?: Array<{ value?: string; label?: string }> };
    }>;
    projectState?: {
        plans?: Array<{ name?: string; attrs?: { status?: string } | null }>;
    };
    modelTurns?: Array<{
        agent?: string;
        phase?: string;
        runtimeAgent?: string;
        model?: string;
        provider?: string;
        systemPrompt?: string;
    }>;
};

function resumeState(result: GoldenResult): ResumeState {
    return result.state as ResumeState;
}

const persistedPlan = {
    path: "docs/plans/resumed-plan.md",
    text:
        "---\nclassification: PLANNED_CHANGE\ncomplexity: MEDIUM\nsummary: Persisted resume Plan\naffectedPaths: []\nstatus: ready_for_work\n---\n# Persisted Resume Plan\n\nThe resumed Session must retain this Plan pointer.\n",
};

export const resumePersistedSessionScenario = {
    name: "slash-resume-restores-history-agent-model-plan-and-continues",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 110, rows: 34 },
    timeoutMs: 90000,
    models: [
        { id: "faux", name: "Golden Faux Model" },
        { id: "resume-model", name: "Golden Resume Model" },
    ],
    initialProjectFiles: [persistedPlan],
    priorSession: {
        userText: "remember the persisted resume history",
        assistantText: "Persisted Operator answer before restart.",
        agentName: "operator",
        model: "resume-model",
        provider: "golden",
        planName: "resumed-plan",
        classification: "PLANNED_CHANGE",
        complexity: "MEDIUM",
    },
    captureModelTurns: true,
    scriptedInteractions: [{
        type: "select",
        promptIncludes: "Select a session to resume",
        value: "__first_option__",
    }],
    script: [{
        id: "operator-continues-after-resume",
        agent: "operator",
        phase: "operator",
        ordinal: 1,
        text: "Operator continued with the restored Agent, model, and Plan context.",
    }],
    actions: [
        { type: "type", text: "/resume" },
        { type: "enter" },
        { type: "waitForScreen", text: "Conversation restored.", timeoutMs: 30000 },
        { type: "waitForScreen", text: "Persisted Operator answer before restart.", timeoutMs: 30000 },
        { type: "type", text: "continue from the restored session" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["resumed-plan"] },
    ],
    assertions: [
        (result: GoldenResult) => {
            assertEventIncludes(result, "terminal:type:/resume");
            assertScreenIncludes(result, "remember the persisted resume history");
            assertScreenIncludes(result, "Persisted Operator answer before restart.");
            assertScreenIncludes(result, "Operator continued with the restored Agent, model, and Plan context.");
        },
        (result: GoldenResult) => {
            const state = resumeState(result);
            assert(state.snapshot?.activeAgent === "operator", `Expected Operator; got ${state.snapshot?.activeAgent}`);
            assert(
                state.snapshot?.activeModel?.provider === "golden" &&
                    state.snapshot?.activeModel?.model === "resume-model",
                `Expected golden/resume-model; got ${JSON.stringify(state.snapshot?.activeModel)}`,
            );
            assert(
                state.snapshot?.workflowContext?.planName === "resumed-plan",
                `Expected resumed Plan context; got ${JSON.stringify(state.snapshot?.workflowContext)}`,
            );
            const plan = state.projectState?.plans?.find((entry) => entry.name === "resumed-plan");
            assert(plan?.attrs?.status === "ready_for_work", `Expected durable Plan state; got ${plan?.attrs?.status}`);
            const continuedTurn = state.modelTurns?.at(-1);
            assert(
                continuedTurn?.agent === "operator" && continuedTurn.model === "resume-model" &&
                    continuedTurn.provider === "golden",
                `Expected continued Operator turn on restored model; got ${JSON.stringify(continuedTurn)}`,
            );
            assert(
                String(continuedTurn?.systemPrompt || "").includes("You are the Operator"),
                "Expected the continued turn to use the Operator system prompt.",
            );
        },
    ],
};

export const resumeQuickFixSessionScenario = {
    name: "slash-resume-retains-quick-fix-engineer-context",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 105, rows: 32 },
    timeoutMs: 90000,
    priorSession: {
        userText: "fix the small persisted issue",
        assistantText: "Engineer answer before restart.",
        agentName: "engineer",
    },
    captureModelTurns: true,
    scriptedInteractions: [{
        type: "select",
        promptIncludes: "Select a session to resume",
        value: "__first_option__",
    }],
    script: [{
        id: "engineer-continues-quick-fix-after-resume",
        agent: "engineer",
        phase: "engineer",
        ordinal: 1,
        text: "Engineer continued with the restored Quick Fix context.",
    }],
    actions: [
        { type: "type", text: "/resume" },
        { type: "enter" },
        { type: "waitForScreen", text: "Engineer answer before restart.", timeoutMs: 30000 },
        { type: "type", text: "continue the quick fix" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 30000 },
    ],
    assertions: [
        (result: GoldenResult) => {
            const state = resumeState(result);
            assertScreenIncludes(result, "Engineer continued with the restored Quick Fix context.");
            assert(state.snapshot?.activeAgent === "engineer", `Expected Engineer; got ${state.snapshot?.activeAgent}`);
            const continuedTurn = state.modelTurns?.at(-1);
            assert(
                continuedTurn?.runtimeAgent === "engineer",
                `Expected runtime Engineer turn; got ${JSON.stringify(continuedTurn)}`,
            );
            assert(
                String(continuedTurn?.systemPrompt || "").includes("Quick Fix Checklist"),
                "Expected resumed Quick Fix turn to use the Engineer system prompt.",
            );
            assert(
                !String(continuedTurn?.systemPrompt || "").includes("approved Planned Change Plan"),
                "Expected resumed Quick Fix turn not to use Plan execution context.",
            );
        },
    ],
};

export const resumeCorruptSessionScenario = {
    name: "slash-resume-ignores-corrupt-session-and-keeps-shell-usable",
    composedTui: true,
    corruptSession: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 60000,
    script: [{
        id: "guide-answers-after-corrupt-resume",
        agent: "guide",
        phase: "inquiry",
        ordinal: 1,
        text: "The live Session remains usable after skipping corrupt history.",
    }],
    actions: [
        { type: "type", text: "/resume" },
        { type: "enter" },
        { type: "waitForScreen", text: "No recent sessions found to resume.", timeoutMs: 20000 },
        { type: "type", text: "answer after corrupt resume data" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 30000 },
    ],
    assertions: [
        (result: GoldenResult) => {
            const state = resumeState(result);
            assert(Boolean(state.corruptSession?.path), "Expected a real corrupt transcript fixture.");
            assertScreenIncludes(result, "No recent sessions found to resume.");
            assertScreenIncludes(result, "The live Session remains usable after skipping corrupt history.");
            assert(state.snapshot?.activeAgent === "guide", `Expected Guide shell; got ${state.snapshot?.activeAgent}`);
        },
    ],
};

export const resumeInterruptedSessionScenario = {
    name: "slash-resume-recovers-interrupted-session-and-continues",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 105, rows: 32 },
    timeoutMs: 90000,
    priorSession: {
        userText: "restore committed history after interruption",
        assistantText: "Committed answer before the interrupted request.",
        agentName: "operator",
        interrupted: true,
    },
    scriptedInteractions: [{
        type: "select",
        promptIncludes: "Select a session to resume",
        value: "__first_option__",
    }],
    script: [{
        id: "operator-continues-after-interrupted-resume",
        agent: "operator",
        phase: "operator",
        ordinal: 1,
        text: "Operator continued after recovering the interrupted checkpoint.",
    }],
    actions: [
        { type: "type", text: "/resume" },
        { type: "enter" },
        { type: "waitForScreen", text: "Committed answer before the interrupted request.", timeoutMs: 30000 },
        { type: "type", text: "continue after interrupted recovery" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 30000 },
    ],
    assertions: [
        (result: GoldenResult) => {
            const state = resumeState(result);
            assert(state.priorSession?.interrupted === true, "Expected interrupted Session fixture state.");
            assertScreenIncludes(result, "restore committed history after interruption");
            assertScreenIncludes(result, "Committed answer before the interrupted request.");
            assertScreenIncludes(result, "Operator continued after recovering the interrupted checkpoint.");
            assert(state.snapshot?.activeAgent === "operator", `Expected Operator; got ${state.snapshot?.activeAgent}`);
            const previousGeneration = state.priorSession?.managed?.generation ?? 0;
            const resumedGeneration = state.snapshot?.managed?.generation ?? 0;
            assert(
                resumedGeneration > previousGeneration,
                `Expected interrupted recovery generation to advance; before=${previousGeneration}, after=${resumedGeneration}`,
            );
        },
    ],
};

export const sessionResumeWorkflowScenarios = [
    resumePersistedSessionScenario,
    resumeQuickFixSessionScenario,
    resumeCorruptSessionScenario,
    resumeInterruptedSessionScenario,
];
