/**
 * @module ui/tui/golden-scenarios/role-journeys
 * Composed Golden role journey scenarios.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";
import { assertRuntimeEvent, assertsGoldenCoverage } from "../testing/portfolio-assertions.js";

/** @typedef {import('../testing/scenario-runner.js').GoldenScenarioResult} GoldenScenarioResult */
/** @typedef {import('../testing/scenario-runner.js').GoldenScenario} GoldenScenario */

/** @param {string} routingIntent */
function triageTurn(routingIntent) {
    return {
        id: `router-${routingIntent.toLowerCase()}`,
        agent: "router",
        phase: "triage",
        requiredTools: ["triage_report"],
        thinking: `Route to ${routingIntent}.`,
        toolCalls: [{
            name: "triage_report",
            arguments: {
                routingIntent,
                complexity: "LOW",
                summary: `Golden ${routingIntent} role journey.`,
                sessionName: `golden ${routingIntent.toLowerCase()}`,
            },
        }],
    };
}

/** @type {GoldenScenario} */
export const guideInquiryRoleJourneyScenario = {
    name: "role-guide-inquiry-readonly",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    coverage: [
        "role:guide",
        "intent:INQUIRY",
        "durable:mutation-policy",
        "block:user",
        "block:thinking",
        "block:assistant",
        "block:tool",
    ],
    script: [
        triageTurn("INQUIRY"),
        {
            id: "guide-read",
            agent: "guide",
            phase: "inquiry",
            ordinal: 1,
            requiredTools: ["read"],
            thinking: "Read project context before answering.",
            toolCalls: [{ name: "read", arguments: { path: "README.md" } }],
        },
        {
            id: "guide-answer",
            agent: "guide",
            phase: "inquiry",
            ordinal: 2,
            text: "Guide answered from read-only project context.",
        },
    ],
    actions: [
        { type: "type", text: "explain the routing flow" },
        { type: "enter" },
        { type: "waitForIdle", timeoutMs: 8000 },
        { type: "assertProjectUnchanged" },
    ],
    assertions: [
        assertRuntimeEvent("role:guide", "runtime:agent:guide"),
        assertsGoldenCoverage("intent:INQUIRY", (result) => {
            assertEventIncludes(result, "runtime:agent:guide");
            assertScreenIncludes(result, "Guide answered from read-only project context.");
        }),
        assertsGoldenCoverage("durable:mutation-policy", (result) => {
            assert(result.state.projectMutation === "clean", "Guide scenario must leave project unchanged.");
        }),
        // Four rendered blocks, asserted on the render. These were claimed by
        // `runtime:*` events, which prove the runtime emitted something — not that
        // any of it reached a terminal. The leading indentation on the user prompt is
        // load-bearing: it is what the block's padding produces, and it distinguishes
        // the rendered block from the raw keystroke echo of the same words.
        assertsGoldenCoverage("block:user", (result) => {
            assertScreenIncludes(result, "  explain the routing flow");
        }),
        assertsGoldenCoverage("block:thinking", (result) => {
            assertScreenIncludes(result, "Read project context before answering.");
        }),
        assertsGoldenCoverage("block:assistant", (result) => {
            assertScreenIncludes(result, "Guide:");
        }),
        assertsGoldenCoverage("block:tool", (result) => {
            assertScreenIncludes(result, "read README.md");
        }),
    ],
};

/** @type {GoldenScenario} */
export const ideationInterviewPrdScenario = {
    name: "role-ideator-interview-prd-synthesis",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    coverage: ["role:ideator", "intent:IDEATION", "durable:mutation-policy", "block:text", "block:select"],
    scriptedInteractions: [
        { type: "text", promptIncludes: "What outcome", value: "A concise PRD" },
        { type: "select", promptIncludes: "Choose priority", value: "small" },
    ],
    script: [
        triageTurn("IDEATION"),
        {
            id: "ideator-interview",
            agent: "ideator",
            phase: "ideator",
            ordinal: 1,
            requiredTools: ["user_interview"],
            thinking: "Interview before synthesis.",
            toolCalls: [{
                name: "user_interview",
                arguments: {
                    questions: [
                        { type: "text", prompt: "What outcome matters?", id: "outcome" },
                        {
                            type: "multiple_choice",
                            prompt: "Choose priority",
                            id: "priority",
                            choices: [{ value: "small", label: "Small" }, { value: "broad", label: "Broad" }],
                        },
                    ],
                },
            }],
        },
        {
            id: "ideator-prd",
            agent: "ideator",
            phase: "ideator",
            ordinal: 2,
            requiredTools: ["write"],
            thinking: "Materialize only the requested concise PRD artifact.",
            text: "PRD synthesized after the interview.",
            toolCalls: [{
                name: "write",
                arguments: {
                    path: "docs/prd/golden-ideation-prd.md",
                    content: "# Golden Ideation PRD\n\nOutcome: A concise PRD.\nPriority: Small.\n",
                },
            }],
        },
    ],
    actions: [{ type: "type", text: "help me shape a PRD" }, { type: "enter" }, {
        type: "waitForIdle",
        timeoutMs: 10000,
    }, {
        type: "assertProjectFile",
        path: "docs/prd/golden-ideation-prd.md",
        exists: true,
    }, {
        type: "assertOnlyProjectChanges",
        paths: ["docs/prd", "docs/prd/golden-ideation-prd.md"],
    }],
    assertions: [
        assertRuntimeEvent("role:ideator", "runtime:agent:ideator"),
        assertsGoldenCoverage("intent:IDEATION", (result) => {
            assertEventIncludes(result, "runtime:tool:start:user_interview");
            assertScreenIncludes(result, "PRD synthesized after the interview.");
        }),
        assertsGoldenCoverage("durable:mutation-policy", (result) => {
            assert(
                result.state.projectMutation === "mutated" &&
                    Array.isArray(result.state.projectMutationChanges) &&
                    result.state.projectMutationChanges.includes("added:docs/prd/golden-ideation-prd.md"),
                "Ideator must materialize only the requested PRD artifact.",
            );
        }),
        assertsGoldenCoverage("block:text", (result) => {
            const interactions = /** @type {Array<{ interaction?: { type?: string } }> | undefined} */ (result.state
                .scriptedInteractions);
            assert(
                interactions?.some((entry) => entry.interaction?.type === "text"),
                "Expected text interview prompt.",
            );
        }),
        assertsGoldenCoverage("block:select", (result) => {
            const interactions = /** @type {Array<{ interaction?: { type?: string } }> | undefined} */ (result.state
                .scriptedInteractions);
            assert(
                interactions?.some((entry) => entry.interaction?.type === "select"),
                "Expected select interview prompt.",
            );
        }),
    ],
};

/** @type {GoldenScenario} */
export const operatorOperationScenario = {
    name: "role-operator-operation-self-verified",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    coverage: ["role:operator", "intent:OPERATION", "durable:mutation-policy"],
    script: [
        triageTurn("OPERATION"),
        {
            id: "operator-complete",
            agent: "operator",
            phase: "operator",
            ordinal: 1,
            requiredTools: ["task_completed"],
            text: "Operator completed the requested repository operation.",
            toolCalls: [{ name: "task_completed", arguments: { message: "- Self-verified operation complete." } }],
        },
    ],
    actions: [{ type: "type", text: "list current status only" }, { type: "enter" }, {
        type: "waitForIdle",
        timeoutMs: 10000,
    }, { type: "assertProjectUnchanged" }],
    assertions: [
        assertRuntimeEvent("role:operator", "runtime:agent:operator"),
        assertsGoldenCoverage("intent:OPERATION", (result) => {
            assertEventIncludes(result, "runtime:tool:start:task_completed");
            assertScreenIncludes(result, "Operator completed the requested repository operation.");
        }),
        assertsGoldenCoverage("durable:mutation-policy", (result) => {
            assert(
                result.state.projectMutation === "clean",
                "Operator read-only operation must leave project unchanged.",
            );
        }),
    ],
};

/** @type {GoldenScenario} */
export const engineerQuickFixMechanicalValidationScenario = {
    name: "role-engineer-quick-fix-mechanical-validation",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    coverage: [
        "role:engineer",
        "intent:QUICK_FIX",
        "recovery:workflow-validation",
        "recovery:steered-task-completion",
        "block:validation-handoff",
        "durable:quick-fix-delivery",
    ],
    scriptedInteractions: [
        { type: "text", promptIncludes: "Enter the command that runs this project's tests", value: "true" },
    ],
    script: [
        triageTurn("QUICK_FIX"),
        {
            id: "engineer-implements-quick-fix",
            agent: "engineer",
            phase: "engineer",
            ordinal: 1,
            requiredTools: ["bash"],
            text: "Tests and CI passed after QUICK_FIX.",
            toolCalls: [{ name: "bash", arguments: { command: "printf quick > golden-quick-fix.txt" } }],
        },
        {
            id: "engineer-reports-quick-fix-complete",
            agent: "engineer",
            phase: "engineer",
            ordinal: 2,
            requiredTools: ["task_completed"],
            text: "Task completed.",
            toolCalls: [{ name: "task_completed", arguments: { message: "- QUICK_FIX implemented and verified." } }],
        },
    ],
    actions: [
        { type: "type", text: "make a tiny quick fix" },
        { type: "enter" },
        {
            type: "waitForEvent",
            event: "runtime:agent:engineer",
            timeoutMs: 8000,
        },
        {
            type: "type",
            text: "while you are there, keep the fix minimal",
        },
        { type: "enter" },
        {
            type: "waitForIdle",
            timeoutMs: 15000,
        },
        {
            type: "assertProjectFile",
            path: "golden-quick-fix.txt",
            exists: true,
        },
        { type: "assertNoPlanFile", planName: "quick-fix" },
        { type: "captureGitState", paths: ["golden-quick-fix.txt"] },
        { type: "captureProjectState", planNames: [] },
    ],
    assertions: [
        assertRuntimeEvent("role:engineer", "runtime:agent:engineer"),
        assertsGoldenCoverage("intent:QUICK_FIX", (result) => {
            assertEventIncludes(result, "runtime:tool:start:task_completed");
            assertScreenIncludes(result, "The quick fix checks passed.");
        }),
        assertsGoldenCoverage("recovery:workflow-validation", (result) => {
            assertScreenIncludes(result, "Tests and CI passed");
        }),
        assertRuntimeEvent("recovery:steered-task-completion", "runtime:queue"),
        // QUICK_FIX drives the tests-and-CI panel. Asserting a `task_completed` tool
        // start here proved nothing about the panel; the heading does.
        assertsGoldenCoverage("block:validation-handoff", (result) => {
            assertScreenIncludes(result, "Tests and CI");
        }),
        assertsGoldenCoverage("durable:quick-fix-delivery", (result) => {
            assertEventIncludes(result, "project:file-checked");
            const projectState = /** @type {{ registryEntries?: unknown[] } | undefined} */ (result.state.projectState);
            const gitState =
                /** @type {{ branch?: string, status?: string, trackedFiles?: string } | undefined} */ (result.state
                    .gitState);
            assert(
                typeof gitState?.trackedFiles === "string",
                "Expected QUICK_FIX Git tracking evidence to be recorded.",
            );
            assert(
                ["main", "master"].includes(String(gitState?.branch || "")),
                `Expected QUICK_FIX to return to primary checkout branch; got ${gitState?.branch}`,
            );
            assert(
                String(gitState?.status || "").includes("golden-quick-fix.txt"),
                `Expected current QUICK_FIX product semantics to leave delivered file in Git status; got ${gitState?.status}`,
            );
            assert(result.state.editorUsable === true, "Expected TUI usable after QUICK_FIX completion.");
            assert(
                Array.isArray(result.state.planFiles) && result.state.planFiles.length === 0,
                `Expected QUICK_FIX to create no Plan files under docs/plans/; got ${
                    JSON.stringify(result.state.planFiles)
                }`,
            );
            assert(
                (projectState?.registryEntries || []).length === 0,
                `Expected QUICK_FIX to leave no worktree registry entries; got ${
                    JSON.stringify(projectState?.registryEntries)
                }`,
            );
        }),
    ],
};

/** @type {GoldenScenario[]} */
export const roleJourneyScenarios = [
    guideInquiryRoleJourneyScenario,
    ideationInterviewPrdScenario,
    operatorOperationScenario,
    engineerQuickFixMechanicalValidationScenario,
];
