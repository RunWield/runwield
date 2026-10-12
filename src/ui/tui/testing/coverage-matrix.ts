/**
 * @module ui/tui/testing/coverage-matrix
 * Golden TUI scenario coverage inventory and meta-test helpers.
 */

import { ok as assert } from "node:assert/strict";
import { VALIDATION_WORKFLOW_BRANCHES } from "./validation-workflow-coverage.ts";

import type { GoldenScenario } from "./scenario-runner.js";

export interface GoldenAssertionSource {
    goldenAssertionSource?: string;
}

export type GoldenCoverageAssertion = NonNullable<GoldenScenario["assertions"]>[number] & GoldenAssertionSource;

export interface GoldenCoverageScenario extends GoldenScenario {
    assertions?: GoldenCoverageAssertion[];
    validationBranches?: string[];
}

const VALIDATION_WORKFLOW_REQUIRED_CAPABILITIES = Object.freeze(
    VALIDATION_WORKFLOW_BRANCHES.map((branch) => `validation:${branch.id}`),
);

export const GOLDEN_TUI_REQUIRED_CAPABILITIES = Object.freeze({
    roles: ["role:guide", "role:ideator", "role:operator", "role:engineer"],
    routingIntents: ["intent:INQUIRY", "intent:IDEATION", "intent:OPERATION", "intent:QUICK_FIX"],
    workflows: [
        "workflow:PLANNED_CHANGE",
        "workflow:PROJECT",
        "workflow:load-plan",
        "workflow:follow-up-validation",
        "workflow:concurrent-plans",
    ],
    presentation: [
        "block:user",
        "block:thinking",
        "block:assistant",
        "block:tool",
        "block:system-error",
        "block:review-result",
        "block:validation-handoff",
        "block:select",
        "block:text",
        "block:spinner",
        "block:keyboard-help",
        "block:managed-sync",
        "block:queued-steering",
        "block:image",
        "block:abandon-progress",
    ],
    terminal: [
        "terminal:ctrl-c",
        "terminal:slash-command",
        "terminal:autocomplete",
        "terminal:resize",
        "terminal:prompt-focus-restoration",
        "terminal:queueing",
        "terminal:replay-hydration",
        "terminal:post-publication-input",
    ],
    recovery: [
        "recovery:tool-failure",
        "recovery:steered-task-completion",
        "recovery:reviewer-rejection",
        // The Engineer reports success and the check disagrees. Everything after that
        // point — repair rounds, the round limit, the menu — only matters if it reaches
        // a person, so the guarantee is end-to-end or it is nothing.
        // CI actually failing, and the loop finding its way back to CI after the repair.
        // Every other scenario commits a CI command that cannot fail, so this path had
        // no end-to-end coverage at all.
        "recovery:ci-repair",
        "recovery:child-ci-failure",
        "recovery:interrupted-execution",
        "recovery:load-plan-worktree",
        "recovery:malformed-plan-front-matter",
    ],
    validationWorkflow: VALIDATION_WORKFLOW_REQUIRED_CAPABILITIES,
    contextIdentity: [
        "context:plan-engineer-identity",
        "context:frontend-engineer-identity",
    ],
    tutorial: ["tutorial:onboarding"],
    durableOutcomes: [
        "durable:plan-lifecycle",
        "durable:worktree-publication",
        "durable:registry-cleanup",
        "durable:session-replaced",
        "durable:epic-evidence",
        "durable:work-record",
        "durable:mutation-policy",
        // A Project has the most to lose when one child fails, because every child
        // behind it waits. Continuing past an unverified child is worse than stopping.
        "durable:epic-child-halted",
        "durable:epic-completion",
        "durable:quick-fix-delivery",
        "durable:non-git-in-place",
    ],
});

export const GOLDEN_TUI_REQUIRED_CAPABILITY_IDS = Object.freeze(
    Object.values(GOLDEN_TUI_REQUIRED_CAPABILITIES).flat().sort(),
);

const GOLDEN_TUI_LEGACY_VALIDATION_CAPABILITY_IDS = Object.freeze([
    "recovery:workflow-validation",
    "recovery:validation-failure-retry",
    "recovery:validation-exhausted",
]);

export function collectGoldenScenarioCoverage(scenarios: GoldenCoverageScenario[]): Map<string, string[]> {
    const owners = new Map<string, string[]>();
    for (const scenario of scenarios) {
        for (const capability of scenario.coverage || []) {
            const list = owners.get(capability) || [];
            list.push(scenario.name);
            owners.set(capability, list);
        }
        for (const branchId of scenario.validationBranches || []) {
            const capability = `validation:${branchId}`;
            const list = owners.get(capability) || [];
            list.push(scenario.name);
            owners.set(capability, list);
        }
    }
    return owners;
}

export function assertGoldenScenarioCoverage(scenarios: GoldenCoverageScenario[]): void {
    const known = new Set([...GOLDEN_TUI_REQUIRED_CAPABILITY_IDS, ...GOLDEN_TUI_LEGACY_VALIDATION_CAPABILITY_IDS]);
    const owners = collectGoldenScenarioCoverage(scenarios);
    const missing = GOLDEN_TUI_REQUIRED_CAPABILITY_IDS.filter((capability) => !owners.has(capability));
    assert(missing.length === 0, `Missing Golden TUI coverage: ${missing.join(", ")}`);

    const unasserted = [];
    const unknown = [];
    for (const scenario of scenarios) {
        for (const assertion of scenario.assertions || []) {
            const assertedCapabilities = assertion.goldenCoverage || [];
            assert(
                assertedCapabilities.length <= 1,
                `Golden TUI coverage assertions must prove one capability each: ${scenario.name}`,
            );
        }
        const declared = scenario.coverage || [];
        const asserted = new Set((scenario.assertions || []).flatMap((assertion) => assertion.goldenCoverage || []));
        const assertionSources = new Map<string, Set<string>>();
        for (const assertion of scenario.assertions || []) {
            const source = assertion.goldenAssertionSource;
            if (typeof source !== "string") continue;
            const capabilities = assertionSources.get(source) || new Set<string>();
            for (const capability of assertion.goldenCoverage || []) capabilities.add(capability);
            assertionSources.set(source, capabilities);
        }
        const decorative = [];
        for (const capabilities of assertionSources.values()) {
            if (capabilities.size > 1) decorative.push(`${scenario.name}:${[...capabilities].join("+")}`);
        }
        assert(
            decorative.length === 0,
            `Golden TUI coverage assertions must not reuse one broad assertion body for multiple capabilities: ${
                decorative.join(", ")
            }`,
        );
        for (const capability of declared) {
            if (!known.has(capability)) unknown.push(`${scenario.name}:${capability}`);
            if (!asserted.has(capability)) unasserted.push(`${scenario.name}:${capability}`);
        }
        for (const capability of asserted) {
            if (!known.has(capability)) unknown.push(`${scenario.name}:${capability}`);
        }
    }
    assert(unknown.length === 0, `Unknown Golden TUI coverage capabilities: ${unknown.join(", ")}`);
    assert(unasserted.length === 0, `Golden TUI coverage lacks concrete assertion wrappers: ${unasserted.join(", ")}`);
}
