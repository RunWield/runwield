/**
 * Composed Golden /load-plan journeys specific to PROJECT Epics.
 */

import { assert } from "@std/assert";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";

interface InteractionRecord {
    interaction?: { value?: string | null };
    request?: { prompt?: string; options?: Array<{ value?: string }> };
}

interface CapturedPlan {
    name?: string;
    attrs?: { status?: string; classification?: string; parentPlan?: string; epicCompletionMode?: string } | null;
}

type EpicGoldenResult = Parameters<typeof assertEventIncludes>[0] & {
    state: Parameters<typeof assertEventIncludes>[0]["state"] & {
        scriptedInteractions?: InteractionRecord[];
        projectState?: { plans?: CapturedPlan[] };
    };
};

function optionValues(interaction: InteractionRecord | undefined): Set<string | undefined> {
    return new Set((interaction?.request?.options || []).map((option) => option.value));
}

function selectedInteraction(result: EpicGoldenResult, prompt: string, selected: string): InteractionRecord {
    const interaction = (result.state.scriptedInteractions || []).find((entry) =>
        String(entry.request?.prompt || "").includes(prompt) && entry.interaction?.value === selected
    );
    assert(interaction, `Expected ${prompt} interaction selecting ${selected}.`);
    return interaction;
}

function assertExactOptions(interaction: InteractionRecord, expected: string[]) {
    const actual = [...optionValues(interaction)].filter((value): value is string => Boolean(value)).sort();
    assert(
        JSON.stringify(actual) === JSON.stringify([...expected].sort()),
        `Expected options ${expected.sort().join(", ")}; got ${actual.join(", ")}`,
    );
}

function planStatus(result: EpicGoldenResult, name: string): string {
    return result.state.projectState?.plans?.find((entry) => entry.name === name)?.attrs?.status || "";
}

const draftEpic = {
    path: "docs/plans/draft-epic.md",
    text:
        "---\nclassification: PROJECT\ncomplexity: HIGH\nsummary: Draft Epic menu\naffectedPaths: []\nstatus: draft\n---\n# Draft Epic\n",
};

const decompositionEpic = {
    path: "docs/plans/decomposition-epic.md",
    text:
        "---\nclassification: PROJECT\ncomplexity: HIGH\nsummary: Decomposition Epic menu\naffectedPaths: []\nstatus: ready_for_decomposition\n---\n# Decomposition Epic\n",
};

const readyEpic = {
    path: "docs/plans/ready-epic.md",
    text:
        "---\nclassification: PROJECT\ncomplexity: HIGH\nsummary: Ready Epic menu\naffectedPaths: []\nstatus: ready_for_work\n---\n# Ready Epic\n",
};

const readyChild = {
    path: "docs/plans/ready-epic/01-child.md",
    text:
        "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Ready child\naffectedPaths: []\nstatus: draft\nparentPlan: ready-epic\norder: 1\n---\n# Ready child\n",
};

const terminalEpic = {
    path: "docs/plans/terminal-epic.md",
    text:
        "---\nclassification: PROJECT\ncomplexity: HIGH\nsummary: Terminal Epic menu\naffectedPaths: []\nstatus: verified\nepicCompletionMode: done_enough\nepicDoneEnoughSummary: Golden terminal summary.\n---\n# Terminal Epic\n",
};

const terminalChild = {
    path: "docs/plans/terminal-epic/01-child.md",
    text:
        "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Remaining terminal child\naffectedPaths: []\nstatus: draft\nparentPlan: terminal-epic\norder: 1\n---\n# Remaining child\n",
};

export const loadPlanEpicMenuOptionsScenario = {
    name: "load-plan-epic-menu-options-by-status",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    initialProjectFiles: [draftEpic, decompositionEpic, readyEpic, readyChild, terminalEpic, terminalChild],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "view" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "cancel" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "view" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "cancel" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "view" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "cancel" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "view" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "cancel" },
    ],
    actions: [
        { type: "type", text: "/load-plan draft-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Plan loaded: draft-epic", timeoutMs: 15000 },
        { type: "waitForScriptedInteractions", remaining: 6, timeoutMs: 15000 },
        { type: "waitForIdle", timeoutMs: 15000 },
        { type: "type", text: "/load-plan decomposition-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Plan loaded: decomposition-epic", timeoutMs: 15000 },
        { type: "waitForScriptedInteractions", remaining: 4, timeoutMs: 15000 },
        { type: "waitForIdle", timeoutMs: 15000 },
        { type: "type", text: "/load-plan ready-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Plan loaded: ready-epic", timeoutMs: 15000 },
        { type: "waitForScriptedInteractions", remaining: 2, timeoutMs: 15000 },
        { type: "waitForIdle", timeoutMs: 15000 },
        { type: "type", text: "/load-plan terminal-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Plan loaded: terminal-epic", timeoutMs: 15000 },
        { type: "waitForScriptedInteractions", timeoutMs: 15000 },
        { type: "waitForIdle", timeoutMs: 15000 },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertExactOptions(selectedInteraction(result, "this Epic", "view"), [
                "direct_review",
                "review",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            const viewed = (result.state.scriptedInteractions || []).filter((entry) =>
                String(entry.request?.prompt || "").includes("this Epic") && entry.interaction?.value === "view"
            );
            assert(viewed.length === 4, `Expected four Epic menu states; got ${viewed.length}`);
            assertExactOptions(viewed[1], ["slicer", "user_verify", "hold", "view", "cancel"]);
            assertExactOptions(viewed[2], [
                "pick_child",
                "direct_review",
                "slicer",
                "done_enough",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            assertExactOptions(viewed[3], ["pick_child", "archive_epic", "view", "cancel"]);
        },
    ],
};

export const loadPlanEpicSlicerScenario = {
    name: "load-plan-epic-opens-slicer",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    initialProjectFiles: [decompositionEpic],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "slicer" },
    ],
    script: [
        {
            id: "loaded-epic-slicer-materializes-child",
            agent: "slicer",
            phase: "slicer",
            ordinal: 1,
            requiredTools: ["slicer_finalize_decomposition"],
            toolCalls: [{
                name: "slicer_finalize_decomposition",
                arguments: {
                    confirmation: "User chose Slicer from the loaded Epic menu.",
                    children: [{
                        title: "Loaded Epic child",
                        order: 1,
                        summary: "Child created from /load-plan",
                        dependencies: [],
                        affectedPaths: [],
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                        content: "# Loaded Epic child\n",
                    }],
                },
            }],
        },
        {
            id: "loaded-epic-slicer-closes",
            agent: "slicer",
            phase: "slicer",
            ordinal: 2,
            text: "Loaded Epic decomposition completed.",
        },
    ],
    actions: [
        { type: "type", text: "/load-plan decomposition-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForPlanStatus", planName: "decomposition-epic", statuses: ["ready_for_work"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        {
            type: "captureProjectState",
            planNames: ["decomposition-epic", "decomposition-epic/01-loaded-epic-child"],
        },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertEventIncludes(result, "runtime:agent:slicer");
            assertEventIncludes(result, "runtime:tool:start:slicer_finalize_decomposition");
            assertScreenIncludes(result, "Loaded Epic decomposition completed.");
            assert(planStatus(result, "decomposition-epic") === "ready_for_work", "Expected decomposed loaded Epic.");
            const child = result.state.projectState?.plans?.find((entry) =>
                entry.name === "decomposition-epic/01-loaded-epic-child"
            );
            assert(child?.attrs?.parentPlan === "decomposition-epic", "Expected loaded Epic child parent metadata.");
        },
    ],
};

export const loadPlanEpicChildMenusScenario = {
    name: "load-plan-epic-child-list-view-back-and-next",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 60000,
    initialProjectFiles: [
        readyEpic,
        {
            path: "docs/plans/ready-epic/01-complete.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Completed child\naffectedPaths: []\nstatus: verified\nparentPlan: ready-epic\norder: 1\n---\n# Complete child\n",
        },
        {
            path: "docs/plans/ready-epic/02-next.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Next child\naffectedPaths: []\nstatus: draft\nparentPlan: ready-epic\norder: 2\n---\n# Next child\n",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "pick_child" },
        { type: "select", promptIncludes: "Load child Plan", value: "ready-epic/02-next" },
        { type: "select", promptIncludes: "this Planned Change", value: "view" },
        { type: "select", promptIncludes: "this Planned Change", value: "back" },
        { type: "select", promptIncludes: "Load child Plan", value: "__next_child__" },
    ],
    actions: [
        { type: "type", text: "/load-plan ready-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForScreen", text: "Plan loaded: ready-epic/02-next", timeoutMs: 30000 },
        { type: "waitForIdle", timeoutMs: 30000 },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertExactOptions(selectedInteraction(result, "this Epic", "pick_child"), [
                "pick_child",
                "direct_review",
                "slicer",
                "done_enough",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            assertExactOptions(selectedInteraction(result, "Load child Plan", "ready-epic/02-next"), [
                "__next_child__",
                "ready-epic/01-complete",
                "ready-epic/02-next",
            ]);
            assertExactOptions(selectedInteraction(result, "this Planned Change", "view"), ["load", "view", "back"]);
            assertScreenIncludes(result, "Planned Change: ready-epic/02-next");
            assertScreenIncludes(result, "Plan loaded: ready-epic/02-next");
        },
    ],
};

export const loadPlanEpicDoneEnoughArchiveScenario = {
    name: "load-plan-epic-done-enough-and-archive",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    initialProjectFiles: [readyEpic, readyChild],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "done_enough" },
        { type: "select", promptIncludes: "Mark this Epic done enough", value: "confirm" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "cancel" },
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "archive_epic" },
        { type: "select", promptIncludes: "Archive this Epic and its child Plans", value: "confirm" },
    ],
    actions: [
        { type: "type", text: "/load-plan ready-epic" },
        { type: "enter" },
        { type: "enter" },
        {
            type: "waitForPlanStatus",
            planName: "ready-epic",
            statuses: ["closed_without_verification"],
            timeoutMs: 30000,
        },
        { type: "waitForIdle", timeoutMs: 20000 },
        { type: "type", text: "/load-plan ready-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForPlanAbsent", planName: "ready-epic", timeoutMs: 30000 },
        { type: "waitForScreen", text: "Archived Epic and child Plans:", timeoutMs: 30000 },
        { type: "waitForIdle", timeoutMs: 20000 },
        { type: "captureProjectState", planNames: ["ready-epic", "ready-epic/01-child"] },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertScreenIncludes(result, "Epic marked done enough for now.");
            assertScreenIncludes(result, "Archived Epic and child Plans:");
            for (const name of ["ready-epic", "ready-epic/01-child"]) {
                const plan = result.state.projectState?.plans?.find((entry) => entry.name === name);
                assert(plan?.attrs === null, `Expected ${name} to be absent after Epic archive.`);
            }
        },
    ],
};

export const loadPlanEpicDirectReviewScenario = {
    name: "load-plan-epic-direct-review-approves-and-slices",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    reviewDecisions: [{ approved: true, feedback: "Direct Epic review approved.", approvalAction: "decompose" }],
    initialProjectFiles: [draftEpic],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "direct_review" },
    ],
    script: [
        {
            id: "direct-review-epic-slicer-materializes-child",
            agent: "slicer",
            phase: "slicer",
            ordinal: 1,
            requiredTools: ["slicer_finalize_decomposition"],
            toolCalls: [{
                name: "slicer_finalize_decomposition",
                arguments: {
                    confirmation: "User approved direct Epic review and slice.",
                    children: [{
                        title: "Direct review child",
                        order: 1,
                        summary: "Child created after direct Epic review",
                        dependencies: [],
                        affectedPaths: [],
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                        content: "# Direct review child\n",
                    }],
                },
            }],
        },
    ],
    actions: [
        { type: "type", text: "/load-plan draft-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForPlanStatus", planName: "draft-epic", statuses: ["ready_for_work"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["draft-epic", "draft-epic/01-direct-review-child"] },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertExactOptions(selectedInteraction(result, "this Epic", "direct_review"), [
                "direct_review",
                "review",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            assertEventIncludes(result, "runtime:agent:slicer");
            assertEventIncludes(result, "runtime:tool:start:slicer_finalize_decomposition");
            assert(
                planStatus(result, "draft-epic") === "ready_for_work",
                "Expected direct reviewed Epic to be decomposed.",
            );
        },
    ],
};

export const loadPlanEpicDirectReviewFeedbackScenario = {
    name: "load-plan-epic-direct-review-feedback-to-architect",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    reviewDecisions: [
        { approved: false, feedback: "Revise the Epic architecture before decomposition." },
        { approved: true, feedback: "Revised Epic approved for later.", approvalAction: "later" },
    ],
    initialProjectFiles: [draftEpic],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "direct_review" },
    ],
    script: [
        {
            id: "direct-review-feedback-architect-revises-epic",
            agent: "architect",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{ name: "plan_written", arguments: { planName: "draft-epic" } }],
        },
    ],
    actions: [
        { type: "type", text: "/load-plan draft-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:agent:architect", timeoutMs: 60000 },
        { type: "waitForPlanStatus", planName: "draft-epic", statuses: ["ready_for_decomposition"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["draft-epic"] },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertExactOptions(selectedInteraction(result, "this Epic", "direct_review"), [
                "direct_review",
                "review",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            assertEventIncludes(result, "runtime:agent:architect");
            assertEventIncludes(result, "runtime:tool:start:plan_written");
            assert(
                planStatus(result, "draft-epic") === "ready_for_decomposition",
                "Expected direct review feedback to return through Architect and approve for later.",
            );
        },
    ],
};

export const loadPlanEpicDirectReviewLaterScenario = {
    name: "load-plan-epic-direct-review-approves-for-later",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    reviewDecisions: [{ approved: true, feedback: "Direct Epic review approved for later.", approvalAction: "later" }],
    initialProjectFiles: [draftEpic],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "direct_review" },
    ],
    actions: [
        { type: "type", text: "/load-plan draft-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForPlanStatus", planName: "draft-epic", statuses: ["ready_for_decomposition"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["draft-epic"] },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertExactOptions(selectedInteraction(result, "this Epic", "direct_review"), [
                "direct_review",
                "review",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            assertScreenIncludes(result, "Plan saved. Resume later with: wld load-plan draft-epic");
            assert(
                !result.events.some((event) => event.includes("runtime:agent:slicer")),
                "Approve for Later must not open Slicer.",
            );
            assert(planStatus(result, "draft-epic") === "ready_for_decomposition", "Expected Epic approved for later.");
        },
    ],
};

export const loadPlanEpicArchitectReviewScenario = {
    name: "load-plan-epic-architect-review-stays-separate",
    composedTui: true,
    initialAgentName: "guide",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 120000,
    reviewDecisions: [{ approved: true, feedback: "Architect review approved for later.", approvalAction: "later" }],
    initialProjectFiles: [draftEpic],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do with this Epic", value: "review" },
    ],
    script: [
        {
            id: "load-plan-architect-review-writes-epic",
            agent: "architect",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["plan_written"],
            toolCalls: [{ name: "plan_written", arguments: { planName: "draft-epic" } }],
        },
    ],
    actions: [
        { type: "type", text: "/load-plan draft-epic" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:agent:architect", timeoutMs: 60000 },
        { type: "waitForPlanStatus", planName: "draft-epic", statuses: ["ready_for_decomposition"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["draft-epic"] },
    ],
    assertions: [
        (result: EpicGoldenResult) => {
            assertExactOptions(selectedInteraction(result, "this Epic", "review"), [
                "direct_review",
                "review",
                "user_verify",
                "hold",
                "view",
                "cancel",
            ]);
            assertEventIncludes(result, "runtime:agent:architect");
            assertEventIncludes(result, "runtime:tool:start:plan_written");
            assert(
                planStatus(result, "draft-epic") === "ready_for_decomposition",
                "Expected Architect review approval.",
            );
        },
    ],
};

export const loadPlanEpicWorkflowScenarios = [
    loadPlanEpicMenuOptionsScenario,
    loadPlanEpicDirectReviewScenario,
    loadPlanEpicDirectReviewFeedbackScenario,
    loadPlanEpicDirectReviewLaterScenario,
    loadPlanEpicArchitectReviewScenario,
    loadPlanEpicSlicerScenario,
    loadPlanEpicChildMenusScenario,
    loadPlanEpicDoneEnoughArchiveScenario,
];
