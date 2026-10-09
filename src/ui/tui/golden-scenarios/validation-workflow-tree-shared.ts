// @ts-nocheck: scenario objects come from JavaScript Golden fixtures with structural fields Deno cannot infer.
import {
    EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS,
    VALIDATION_WORKFLOW_BRANCHES,
    validationEvidenceAssertion,
    type ValidationWorkflowBranchId,
} from "../testing/validation-workflow-coverage.ts";

export function branchesForOwner(owner: string): ValidationWorkflowBranchId[] {
    return EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS.filter((id) =>
        VALIDATION_WORKFLOW_BRANCHES.find((branch) => branch.id === id)?.owner === owner
    );
}

function capturePlanStateAction(planNames: string[]) {
    return { type: "captureProjectState", planNames };
}

export function withValidationBranches(
    base,
    name: string,
    planNames: string[],
    branches: ValidationWorkflowBranchId[] = branchesForOwner(name),
) {
    return {
        ...base,
        // Automated phase journeys choose their review policy. Human-review journeys
        // override it in project settings and assert the real offer/decision branch.
        globalSettings: {
            defaultProvider: "golden",
            defaultModel: "faux",
            codereview: "none",
            ...base.globalSettings,
        },
        name,
        coverage: [],
        validationBranches: branches,
        timeoutMs: Math.max(base.timeoutMs || 120000, 180000),
        actions: [...(base.actions || []), capturePlanStateAction(planNames)],
        assertions: [
            ...(base.assertions || []),
            ...branches.map((id) => validationEvidenceAssertion(id)),
        ],
    };
}
