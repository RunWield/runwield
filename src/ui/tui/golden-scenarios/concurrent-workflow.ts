/**
 * Golden concurrent Plan workflow coverage.
 */

import { assert } from "@std/assert";
import { assertEventIncludes } from "../testing/scenario-runner.js";
import { assertsGoldenCoverage } from "../testing/portfolio-assertions.js";

interface CapturedPlan {
    name?: string;
    attrs?: { status?: string; planId?: string } | null;
}

interface RegistryEntry {
    status?: string;
    planName?: string;
    planId?: string;
    createdAt?: string;
}

interface CapturedProjectState {
    plans?: CapturedPlan[];
    registryEntries?: RegistryEntry[];
    nonTerminalRegistryEntries?: RegistryEntry[];
}

interface GitState {
    trackedFiles?: string;
    status?: string;
}

interface GoldenScenarioResult {
    name: string;
    state: Record<string, unknown> & {
        projectState?: CapturedProjectState;
        concurrentActiveProjectState?: CapturedProjectState;
        concurrentScreens?: Record<string, unknown>;
        gitState?: GitState;
        publication?: { remoteTree?: string };
    };
    screenText: string;
    events: string[];
    actor: { consumed: string[]; remaining: string[] };
    artifactDir: string | null;
}

function plans(result: GoldenScenarioResult): CapturedPlan[] {
    return result.state.projectState?.plans || [];
}

export const concurrentPlansIdentityScenario = {
    // This scenario isolates automated delivery; human policy gates have dedicated journeys.
    globalSettings: { defaultProvider: "golden", defaultModel: "faux", codereview: "none" },
    name: "project-two-plans-preserve-identity-and-drain-registry",
    composedTui: true,
    initialAgentName: "engineer",
    terminal: { columns: 100, rows: 30 },
    timeoutMs: 240000,
    coverage: ["workflow:concurrent-plans"],
    committedProjectFiles: [
        { path: ".wld/settings.json", text: `${JSON.stringify({ verification_command: "true" }, null, 4)}\n` },
    ],
    initialProjectFiles: [
        {
            path: "docs/plans/concurrent-a.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Concurrent A\naffectedPaths: []\nstatus: ready_for_work\nplanId: concurrent-plan-a\n---\n# Concurrent A\n",
        },
        {
            path: "docs/plans/concurrent-b.md",
            text:
                "---\nclassification: PLANNED_CHANGE\ncomplexity: LOW\nsummary: Concurrent B\naffectedPaths: []\nstatus: ready_for_work\nplanId: concurrent-plan-b\n---\n# Concurrent B\n",
        },
    ],
    scriptedInteractions: [
        { type: "select", promptIncludes: "What would you like to do", value: "proceed" },
        { type: "select", promptIncludes: "What would you like to do", value: "proceed" },
    ],
    script: [
        {
            id: "engineer-starts-concurrent-a",
            agent: "engineer",
            phase: "engineer",
            planName: "concurrent-a",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            thinking: "Implement Plan A in its own execution worktree while Plan B starts in another TUI session.",
            toolCalls: [
                { name: "bash", arguments: { command: "printf alpha > golden-concurrent-a.txt; sleep 10" } },
                { name: "task_completed", arguments: { message: "- Implemented concurrent Plan A." } },
            ],
        },
        {
            id: "engineer-starts-concurrent-b",
            agent: "engineer",
            phase: "engineer",
            planName: "concurrent-b",
            ordinal: 1,
            requiredTools: ["bash", "task_completed"],
            thinking: "Implement Plan B in its own execution worktree while Plan A is still running.",
            toolCalls: [
                { name: "bash", arguments: { command: "printf beta > golden-concurrent-b.txt; sleep 1" } },
                { name: "task_completed", arguments: { message: "- Implemented concurrent Plan B." } },
            ],
        },
        {
            id: "engineer-closes-concurrent-b",
            agent: "engineer",
            phase: "engineer",
            planName: "concurrent-b",
            ordinal: 2,
            text: "Plan B awaits validation.",
        },
        {
            id: "engineer-closes-concurrent-a",
            agent: "engineer",
            phase: "engineer",
            planName: "concurrent-a",
            ordinal: 2,
            text: "Plan A awaits validation.",
        },
        {
            id: "recorder-documents-concurrent-b",
            agent: "recorder",
            phase: "work_record",
            ordinal: 1,
            toolCalls: [{
                name: "work_record_completed",
                arguments: {
                    title: "Concurrent B Work Record",
                    summary: "Recorded the completed concurrent Plan B fixture.",
                    deviationsFromPlan: "None.",
                },
            }],
        },
        {
            id: "reviewer-approves-concurrent-b-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "concurrent-b",
            ordinal: 1,
            requiredTools: ["review_diff"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: "golden-concurrent-b.txt" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "docs/plans/concurrent-b.md" },
                },
            ],
        },
        {
            id: "reviewer-approves-concurrent-b",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "concurrent-b",
            ordinal: 2,
            requiredTools: ["review_complete"],
            toolCalls: [
                { name: "review_complete", arguments: { approved: true, feedback: "Concurrent B approved." } },
            ],
        },
        {
            id: "reviewer-approves-concurrent-a-inspects-diff",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "concurrent-a",
            ordinal: 1,
            requiredTools: ["review_diff"],
            toolCalls: [
                { name: "review_diff", arguments: { command: "list", scope: "full" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: ".gitignore" } },
                { name: "review_diff", arguments: { command: "show", scope: "full", path: "golden-concurrent-a.txt" } },
                {
                    name: "review_diff",
                    arguments: { command: "show", scope: "full", path: "docs/plans/concurrent-a.md" },
                },
            ],
        },
        {
            id: "reviewer-approves-concurrent-a",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "concurrent-a",
            ordinal: 2,
            requiredTools: ["review_complete"],
            toolCalls: [
                { name: "review_complete", arguments: { approved: true, feedback: "Concurrent A approved." } },
            ],
        },
    ],
    actions: [
        { type: "type", text: "/load-plan concurrent-a" },
        { type: "enter" },
        { type: "enter" },
        { type: "waitForEvent", event: "runtime:tool:start:bash", timeoutMs: 30000 },
        { type: "startConcurrentSession", name: "plan-b", initialAgentName: "engineer" },
        { type: "sleep", ms: 500 },
        { type: "concurrentType", name: "plan-b", text: "/load-plan concurrent-b" },
        { type: "concurrentEnter", name: "plan-b" },
        { type: "concurrentEnter", name: "plan-b" },
        { type: "waitForEvent", event: "concurrent:plan-b:runtime:tool:start:bash", timeoutMs: 30000 },
        { type: "sleep", ms: 1000 },
        {
            type: "captureProjectState",
            planNames: ["concurrent-a", "concurrent-b"],
            key: "concurrentActiveProjectState",
        },
        { type: "waitForPlanStatus", planName: "concurrent-a", statuses: ["verified"], timeoutMs: 120000 },
        { type: "waitForPlanStatus", planName: "concurrent-b", statuses: ["verified"], timeoutMs: 120000 },
        { type: "waitForConcurrentIdle", name: "plan-b", timeoutMs: 120000 },
        { type: "waitForIdle", timeoutMs: 120000 },
        { type: "captureConcurrentScreens" },
        { type: "captureGitState", paths: ["golden-concurrent-a.txt", "golden-concurrent-b.txt"] },
        { type: "capturePublicationState", planName: "concurrent-a", deliveredPath: "golden-concurrent-a.txt" },
        { type: "captureProjectState", planNames: ["concurrent-a", "concurrent-b"] },
    ],
    assertions: [
        assertsGoldenCoverage("workflow:concurrent-plans", (result: GoldenScenarioResult) => {
            assertEventIncludes(result, "terminal:type:/load-plan concurrent-a");
            assertEventIncludes(result, "concurrent:plan-b:terminal:type:/load-plan concurrent-b");
            assertEventIncludes(result, "runtime:tool:start:bash");
            assertEventIncludes(result, "concurrent:plan-b:runtime:tool:start:bash");
            const registryEntries = result.state.concurrentActiveProjectState?.registryEntries || [];
            assert(
                registryEntries.length >= 1,
                `Expected auditable registry attempt for Plan A; got ${JSON.stringify(registryEntries)}`,
            );
            const registryPlanNames = registryEntries.map((entry) => entry.planName);
            assert(
                registryPlanNames.includes("concurrent-a") && registryPlanNames.includes("concurrent-b"),
                `Expected active registry attempts for both Plans; got ${registryPlanNames.join(", ")}`,
            );
            for (const entry of registryEntries) {
                if (entry.planName === "concurrent-a") {
                    assert(entry.planId === "concurrent-plan-a", `Plan A registry identity drifted: ${entry.planId}`);
                }
                if (entry.planName === "concurrent-b") {
                    assert(entry.planId === "concurrent-plan-b", `Plan B registry identity drifted: ${entry.planId}`);
                }
            }
            const orderedNames = [...registryEntries].sort((left, right) =>
                String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
            ).map((entry) => entry.planName);
            if (orderedNames.includes("concurrent-b")) {
                assert(
                    orderedNames.indexOf("concurrent-a") <= orderedNames.indexOf("concurrent-b"),
                    `Expected registry creation order A before B; got ${orderedNames.join(", ")}`,
                );
            }
            const captured = plans(result);
            const first = captured.find((entry) => entry.name === "concurrent-a")?.attrs;
            const second = captured.find((entry) => entry.name === "concurrent-b")?.attrs;
            assert(first?.status === "verified", `Expected concurrent-a delivery to verify; got ${first?.status}`);
            assert(second?.status === "verified", `Expected concurrent-b delivery to verify; got ${second?.status}`);
            assert(first?.planId === "concurrent-plan-a", `Unexpected concurrent-a planId ${first?.planId}`);
            assert(second?.planId === "concurrent-plan-b", `Unexpected concurrent-b planId ${second?.planId}`);
            const remoteTree = String(result.state.publication?.remoteTree || "");
            assert(
                remoteTree.includes("golden-concurrent-a.txt") && remoteTree.includes("golden-concurrent-b.txt"),
                `Expected both delivery artifacts upstream; got ${remoteTree}`,
            );
            assert(
                !String(result.state.gitState?.trackedFiles || "").trim(),
                "Expected publication to leave the primary checkout untouched.",
            );
            assert(
                (result.state.projectState?.registryEntries || []).length === 0,
                `Expected fully drained registry; got ${
                    JSON.stringify(result.state.projectState?.registryEntries || [])
                }`,
            );
        }),
    ],
};

export const concurrentWorkflowScenarios = [concurrentPlansIdentityScenario];
