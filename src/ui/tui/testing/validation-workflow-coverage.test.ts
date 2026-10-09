import { assert, assertEquals } from "@std/assert";
import { validationWorkflowTreeScenarios } from "../golden-scenarios/validation-workflow-tree.ts";
import {
    assertValidationBranchInventory,
    assertValidationEvidenceRejectsCounterfeits,
    EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS,
    VALIDATION_INTERACTION_OPTION_BRANCHES,
    VALIDATION_WORKFLOW_BRANCHES,
    type ValidationWorkflowBranchId,
    type ValidationWorkflowResultLike,
} from "./validation-workflow-coverage.ts";

function fullEvidenceResult(id: ValidationWorkflowBranchId): ValidationWorkflowResultLike {
    const branch = VALIDATION_WORKFLOW_BRANCHES.find((entry) => entry.id === id);
    const owner = branch?.owner || "";
    const humanReviewMode = id === "human-review:ask-close"
        ? null
        : id === "human-review:none"
        ? "none"
        : id === "human-review:ask-skip"
        ? "ask"
        : "always";
    const humanReviewDecision = id === "human-review:ask-close"
        ? null
        : id === "human-review:none"
        ? "not_required"
        : id === "human-review:ask-skip"
        ? "skipped"
        : "approved";
    return {
        name: owner,
        screenText: branch?.evidence.transcriptIncludes.join("\n") || "",
        scrollbackText: [
            `validation branch ${id}`,
            "Tests and CI passed.",
            "Code Review approved.",
        ].join("\n"),
        events: ["project:state:captured", "human-review:captured", "runtime:tool:start:review_complete"],
        state: {
            turnSequence: [
                "engineer:engineer:plan:1",
                "reviewer:semantic_review:plan:1",
                "publication:publish:plan:1",
                "validation:mechanical:plan:1",
            ],
            projectState: {
                plans: [{
                    name: "plan",
                    attrs: {
                        status: id === "human-review:ask-close" ? "reviewed" : "verified",
                    },
                    controllerState: {
                        validationCiAttempts: 0,
                        validationSemanticRounds: 1,
                        humanReviewMode,
                        humanReviewDecision,
                        failureReason: null,
                    },
                }],
                registryEntries: [],
                nonTerminalRegistryEntries: [],
            },
            scriptedInteractions: [
                { interaction: { value: "validation-command" } },
                { interaction: { value: "retry" } },
                { interaction: { value: "validate" } },
                ...Object.keys(VALIDATION_INTERACTION_OPTION_BRANCHES)
                    .filter((value) =>
                        (id !== "human-review:none" && id !== "human-review:ask-close") ||
                        (value !== "open" && value !== "skip")
                    )
                    .map((value) => ({ interaction: { value } })),
            ],
            humanReviews: {
                decisions: [
                    { canceled: true },
                    { approved: true },
                ],
            },
            publication: {
                remotePlanStatus: "verified",
                remotePlanAttrs: {},
                registryEntries: [],
            },
            localPublication: {
                planStatus: "verified",
                registryEntries: [],
            },
            pendingPublication: {
                registryStatus: "publication_failed",
                executionPlanStatus: "reviewed",
            },
        },
        actor: { consumed: ["engineer:engineer", "reviewer:semantic_review"], remaining: [] },
    };
}

Deno.test("validation workflow inventory is independent, owned, and assertion-tagged", () => {
    assertValidationBranchInventory(validationWorkflowTreeScenarios);
    const declared = validationWorkflowTreeScenarios.flatMap((scenario) => scenario.validationBranches || []);
    assertEquals(new Set(declared).size, EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS.length);
});

Deno.test("every validation workflow scenario is registered in a concern test file", async () => {
    const scenarioIndex = await Deno.readTextFile("src/ui/tui/golden-scenarios/validation-workflow-tree.ts");
    const expected = [...scenarioIndex.matchAll(/\b(validationTree\w+Scenario),/g)]
        .map((match) => match[1])
        .sort();
    const registered: string[] = [];
    for await (const entry of Deno.readDir("src/ui/tui/golden-scenarios")) {
        if (!entry.isFile || !/^validation-workflow-.+\.test\.ts$/.test(entry.name)) continue;
        const source = await Deno.readTextFile(`src/ui/tui/golden-scenarios/${entry.name}`);
        for (const match of source.matchAll(/exportName:\s*"(validationTree\w+Scenario)"/g)) {
            registered.push(match[1]);
        }
    }
    assertEquals(registered.sort(), expected, "Every indexed scenario must be registered exactly once.");
});

Deno.test("validation workflow inventory represents production interaction option values", async () => {
    const sourceFiles = [
        "src/shared/workflow/validation-interactions.ts",
        "src/shared/workflow/validation-mechanical.ts",
        "src/shared/workflow/validation-semantic.ts",
        "src/shared/workflow/validation-human-review.ts",
        "src/shared/workflow/validation-helpers.ts",
    ];
    const found = new Set<string>();
    for (const path of sourceFiles) {
        const source = await Deno.readTextFile(path);
        for (const match of source.matchAll(/value:\s*["']([a-z_]+)["']/g)) found.add(match[1]);
    }
    const represented = Object.keys(VALIDATION_INTERACTION_OPTION_BRANCHES).sort();
    assertEquals([...found].sort(), represented, "Every production validation option value must be represented.");
    for (const [value, branchIds] of Object.entries(VALIDATION_INTERACTION_OPTION_BRANCHES)) {
        assert(branchIds.length > 0, `Validation option ${value} must point at at least one branch.`);
        for (const id of branchIds) {
            assert(
                EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS.includes(id),
                `Validation option ${value} points at unknown branch ${id}.`,
            );
        }
    }
});

Deno.test("validation workflow evidence checks reject metadata-only coverage", () => {
    for (const id of EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS) {
        assertValidationEvidenceRejectsCounterfeits(id, fullEvidenceResult(id));
    }
});
