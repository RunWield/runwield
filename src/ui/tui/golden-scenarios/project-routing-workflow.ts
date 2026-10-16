/**
 * @module ui/tui/golden-scenarios/project-routing-workflow
 * Fresh PROJECT requests routed through the real Router, Architect, and Slicer composition.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "../testing/scenario-runner.js";

type GoldenScenarioResult = Parameters<typeof assertEventIncludes>[0];
type RoutedGoldenResult = GoldenScenarioResult & {
    state: GoldenScenarioResult["state"] & {
        projectState?: {
            plans?: Array<{
                name?: string;
                attrs?: { status?: string; classification?: string; parentPlan?: string } | null;
            }>;
        };
    };
};

export const routerArchitectSlicerScenario = {
    name: "project-router-architect-slicer-journey",
    composedTui: true,
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 90000,
    reviewDecisions: [{
        approved: true,
        feedback: "The PROJECT architecture is ready to decompose.",
        approvalAction: "decompose",
    }],
    script: [
        {
            id: "router-classifies-project",
            agent: "router",
            phase: "triage",
            ordinal: 1,
            requiredTools: ["triage_report"],
            thinking: "This cross-cutting subsystem belongs with Architect.",
            toolCalls: [{
                name: "triage_report",
                arguments: {
                    routingIntent: "PROJECT",
                    complexity: "HIGH",
                    summary: "Golden PROJECT routing journey.",
                    sessionName: "golden routed project",
                },
            }],
        },
        {
            id: "architect-writes-epic",
            agent: "architect",
            phase: "plan_review",
            ordinal: 1,
            requiredTools: ["write"],
            thinking: "Write the agreed Epic architecture before requesting review.",
            toolCalls: [{
                name: "write",
                arguments: {
                    path: "docs/plans/routed-epic.md",
                    content:
                        "---\nclassification: PROJECT\ncomplexity: HIGH\nsummary: Golden routed Epic\naffectedPaths: []\nstatus: draft\n---\n# Golden Routed Epic\n\nArchitecture agreed with the user.\n",
                },
            }],
        },
        {
            id: "architect-submits-epic",
            agent: "architect",
            phase: "plan_review",
            ordinal: 2,
            requiredTools: ["plan_written"],
            thinking: "Submit the Epic for the real Plan Review interaction.",
            toolCalls: [{ name: "plan_written", arguments: { planName: "routed-epic" } }],
        },
        {
            id: "slicer-decomposes-routed-epic",
            agent: "slicer",
            phase: "slicer",
            ordinal: 1,
            requiredTools: ["slicer_finalize_decomposition"],
            thinking: "Turn the approved architecture into an executable child Plan.",
            toolCalls: [{
                name: "slicer_finalize_decomposition",
                arguments: {
                    confirmation: "User confirmed the routed PROJECT decomposition.",
                    children: [{
                        title: "Routed child",
                        order: 1,
                        summary: "First executable slice from the routed Epic",
                        dependencies: [],
                        affectedPaths: [],
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                        content: "# Routed child\n\nExecutable Golden child.\n",
                    }],
                },
            }],
        },
        {
            id: "slicer-closes-routed-decomposition",
            agent: "slicer",
            phase: "slicer",
            ordinal: 2,
            text: "The routed PROJECT is decomposed into one executable child Plan.",
        },
    ],
    actions: [
        { type: "type", text: "design and deliver a new cross-cutting subsystem" },
        { type: "enter" },
        { type: "waitForPlanStatus", planName: "routed-epic", statuses: ["ready_for_work"], timeoutMs: 60000 },
        { type: "waitForIdle", timeoutMs: 30000 },
        { type: "captureProjectState", planNames: ["routed-epic", "routed-epic/01-routed-child"] },
    ],
    assertions: [
        (result: RoutedGoldenResult) => {
            assertEventIncludes(result, "runtime:agent:architect");
            assertEventIncludes(result, "runtime:tool:start:plan_written");
            assertEventIncludes(result, "interaction:PLAN_REVIEW:approved");
            assertEventIncludes(result, "runtime:agent:slicer");
            assertEventIncludes(result, "runtime:tool:start:slicer_finalize_decomposition");
            assertScreenIncludes(result, "The routed PROJECT is decomposed into one executable child Plan.");
        },
        (result: RoutedGoldenResult) => {
            const plans = result.state.projectState?.plans || [];
            const epic = plans.find((entry) => entry.name === "routed-epic");
            const child = plans.find((entry) => entry.name === "routed-epic/01-routed-child");
            assert(epic?.attrs?.status === "ready_for_work", `Expected decomposed Epic; got ${epic?.attrs?.status}`);
            assert(child?.attrs?.classification === "PLANNED_CHANGE", "Expected Slicer to create a Planned Change.");
            assert(child?.attrs?.parentPlan === "routed-epic", "Expected child to retain its routed Epic parent.");
        },
    ],
};

export const projectRoutingWorkflowScenarios = [routerArchitectSlicerScenario];
