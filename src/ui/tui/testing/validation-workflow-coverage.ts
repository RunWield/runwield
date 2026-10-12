import { assert, assertEquals } from "@std/assert";

export type ValidationWorkflowBranchId =
    | "mechanical:ci:pass"
    | "mechanical:ci:repair-completed"
    | "mechanical:ci:repair-incomplete"
    | "mechanical:ci:cancel-retry"
    | "mechanical:ci:cancel-follow-up"
    | "mechanical:ci:cancel-stop"
    | "mechanical:ci:exhausted-retry"
    | "mechanical:ci:exhausted-follow-up"
    | "mechanical:ci:exhausted-stop"
    | "semantic:approval:first-round"
    | "semantic:findings:repair-completed"
    | "semantic:repair-incomplete"
    | "semantic:nudge:missing-review-complete"
    | "semantic:nudge:missing-diff-inspection"
    | "semantic:nudge:omitted-prior-finding"
    | "semantic:reviewer-incomplete-pause"
    | "semantic:provider-error-retry"
    | "semantic:round-mode:discovery-to-verify"
    | "semantic:round-limit:continue"
    | "semantic:round-limit:human-review"
    | "semantic:round-limit:stop"
    | "semantic:round-limit:stop-after-execution"
    | "semantic:resume:validated-ci"
    | "semantic:entry:non-git-skip"
    | "semantic:entry:empty-diff-skip"
    | "semantic:entry:plan-only-diff-fails"
    | "human-review:none"
    | "human-review:ask-skip"
    | "human-review:ask-close"
    | "human-review:ask-open-approve"
    | "human-review:always-approve"
    | "human-review:no-answer-retry"
    | "human-review:no-answer-stop"
    | "human-review:feedback-repair-approve"
    | "publication:non-git-success"
    | "publication:isolated-dirty-primary"
    | "publication:dirty-primary-retry"
    | "publication:remote-target-advance"
    | "publication:primary-plan-restored"
    | "publication:missing-target-branch"
    | "lifecycle:resume-implemented"
    | "lifecycle:resume-validated-ci"
    | "lifecycle:resume-validated-reviewer"
    | "lifecycle:ahead-status-keeps-canonical-progress"
    | "lifecycle:missing-plan-fails-closed"
    | "lifecycle:unsupported-status-fails-closed"
    | "lifecycle:malformed-front-matter-fails-closed"
    | "lifecycle:missing-execution-context-fails-closed"
    | "lifecycle:registry-authority-ignores-stale-worktree-metadata";

export interface ValidationEvidenceRequirement {
    transcriptIncludes: string[];
    transcriptExcludes: string[];
    eventIncludes: string[];
    turnIncludes: string[];
    statePaths: string[];
    stateEquals: Record<string, ValidationStateValue>;
    stateAbsent: string[];
    interactionValues: string[];
    interactionAbsentValues: string[];
}

export interface ValidationWorkflowBranch {
    id: ValidationWorkflowBranchId;
    phase: "mechanical" | "semantic" | "human-review" | "publication" | "lifecycle";
    owner: string;
    trigger: string;
    userVisibleResult: string;
    durableResult: string;
    evidence: ValidationEvidenceRequirement;
}

export interface ValidationWorkflowScenarioLike {
    name: string;
    validationBranches?: ValidationWorkflowBranchId[];
    assertions?: Array<{ validationCoverage?: ValidationWorkflowBranchId[] }>;
}

export interface ValidationWorkflowResultLike {
    name: string;
    screenText?: string;
    scrollbackText?: string;
    events?: string[];
    state?: Record<string, ValidationStateValue>;
    actor?: { consumed?: string[]; remaining?: string[] };
}

type ValidationStateValue = string | number | boolean | null | ValidationStateValue[] | {
    [key: string]: ValidationStateValue;
};

export const EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS: readonly ValidationWorkflowBranchId[] = Object.freeze([
    "mechanical:ci:pass",
    "mechanical:ci:repair-completed",
    "mechanical:ci:repair-incomplete",
    "mechanical:ci:cancel-retry",
    "mechanical:ci:cancel-follow-up",
    "mechanical:ci:cancel-stop",
    "mechanical:ci:exhausted-retry",
    "mechanical:ci:exhausted-follow-up",
    "mechanical:ci:exhausted-stop",
    "semantic:approval:first-round",
    "semantic:findings:repair-completed",
    "semantic:repair-incomplete",
    "semantic:nudge:missing-review-complete",
    "semantic:nudge:missing-diff-inspection",
    "semantic:nudge:omitted-prior-finding",
    "semantic:reviewer-incomplete-pause",
    "semantic:provider-error-retry",
    "semantic:round-mode:discovery-to-verify",
    "semantic:round-limit:continue",
    "semantic:round-limit:human-review",
    "semantic:round-limit:stop",
    "semantic:round-limit:stop-after-execution",
    "semantic:resume:validated-ci",
    "semantic:entry:non-git-skip",
    "semantic:entry:empty-diff-skip",
    "semantic:entry:plan-only-diff-fails",
    "human-review:none",
    "human-review:ask-skip",
    "human-review:ask-close",
    "human-review:ask-open-approve",
    "human-review:always-approve",
    "human-review:no-answer-retry",
    "human-review:no-answer-stop",
    "human-review:feedback-repair-approve",
    "publication:non-git-success",
    "publication:isolated-dirty-primary",
    "publication:dirty-primary-retry",
    "publication:remote-target-advance",
    "publication:primary-plan-restored",
    "publication:missing-target-branch",
    "lifecycle:resume-implemented",
    "lifecycle:resume-validated-ci",
    "lifecycle:resume-validated-reviewer",
    "lifecycle:ahead-status-keeps-canonical-progress",
    "lifecycle:missing-plan-fails-closed",
    "lifecycle:unsupported-status-fails-closed",
    "lifecycle:malformed-front-matter-fails-closed",
    "lifecycle:missing-execution-context-fails-closed",
    "lifecycle:registry-authority-ignores-stale-worktree-metadata",
]);

function phaseFor(id: ValidationWorkflowBranchId): ValidationWorkflowBranch["phase"] {
    if (id.startsWith("semantic:")) return "semantic";
    if (id.startsWith("human-review:")) return "human-review";
    if (id.startsWith("publication:")) return "publication";
    if (id.startsWith("lifecycle:")) return "lifecycle";
    return "mechanical";
}

const VALIDATION_BRANCH_OWNERS: Record<ValidationWorkflowBranchId, string> = {
    "mechanical:ci:pass": "validation-tree-ci-loop",
    "mechanical:ci:repair-completed": "validation-tree-ci-loop",
    "mechanical:ci:repair-incomplete": "validation-tree-ci-repair-incomplete",
    "mechanical:ci:cancel-retry": "validation-tree-ci-cancel-retry",
    "mechanical:ci:cancel-follow-up": "validation-tree-ci-cancel-follow-up",
    "mechanical:ci:cancel-stop": "validation-tree-ci-cancel-stop",
    "mechanical:ci:exhausted-retry": "validation-tree-validation-exhausted-retry",
    "mechanical:ci:exhausted-follow-up": "validation-tree-validation-exhausted-follow-up",
    "mechanical:ci:exhausted-stop": "validation-tree-validation-exhausted-stop",
    "semantic:approval:first-round": "validation-tree-ci-retry-success",
    "semantic:findings:repair-completed": "validation-tree-semantic-review-loop",
    "semantic:repair-incomplete": "validation-tree-semantic-repair-incomplete",
    "semantic:nudge:missing-review-complete": "validation-tree-semantic-nudge-missing-review-complete",
    "semantic:nudge:missing-diff-inspection": "validation-tree-semantic-nudge-missing-diff-inspection",
    "semantic:nudge:omitted-prior-finding": "validation-tree-semantic-nudge-omitted-prior-finding",
    "semantic:reviewer-incomplete-pause": "validation-tree-semantic-reviewer-incomplete-pause",
    "semantic:provider-error-retry": "validation-tree-semantic-provider-error-retry",
    "semantic:round-mode:discovery-to-verify": "validation-tree-semantic-round-mode-discovery-to-verify",
    "semantic:round-limit:continue": "validation-tree-semantic-round-limit-continue",
    "semantic:round-limit:human-review": "validation-tree-semantic-round-limit-human-review",
    "semantic:round-limit:stop": "validation-tree-semantic-round-limit-stop",
    "semantic:round-limit:stop-after-execution": "validation-tree-semantic-round-limit-stop-direct",
    "semantic:resume:validated-ci": "validation-tree-resume-validated-ci",
    "semantic:entry:non-git-skip": "validation-tree-non-git-delivery",
    "semantic:entry:empty-diff-skip": "validation-tree-empty-diff-skip",
    "semantic:entry:plan-only-diff-fails": "validation-tree-plan-only-diff-fails",
    "human-review:none": "validation-tree-human-review-none",
    "human-review:ask-skip": "validation-tree-human-review-ask-skip",
    "human-review:ask-close": "validation-tree-human-review-ask-close",
    "human-review:ask-open-approve": "validation-tree-human-review-ask-open-approve",
    "human-review:always-approve": "validation-tree-human-review-always-approve",
    "human-review:no-answer-retry": "validation-tree-human-review-no-answer-retry",
    "human-review:no-answer-stop": "validation-tree-human-review-no-answer-stop",
    "human-review:feedback-repair-approve": "validation-tree-human-review-feedback-repair-approve",
    "publication:non-git-success": "validation-tree-non-git-delivery",
    "publication:isolated-dirty-primary": "validation-tree-publication-isolated-dirty-primary",
    "publication:dirty-primary-retry": "validation-tree-publication-dirty-checkout",
    "publication:remote-target-advance": "validation-tree-publication-remote-target-advance",
    "publication:primary-plan-restored": "validation-tree-publication-primary-plan-restored",
    "publication:missing-target-branch": "validation-tree-publication-missing-target-branch",
    "lifecycle:resume-implemented": "validation-tree-resume-implemented",
    "lifecycle:resume-validated-ci": "validation-tree-resume-validated-ci",
    "lifecycle:resume-validated-reviewer": "validation-tree-resume-validated-reviewer",
    "lifecycle:ahead-status-keeps-canonical-progress": "validation-tree-ahead-status",
    "lifecycle:missing-plan-fails-closed": "validation-tree-missing-plan",
    "lifecycle:unsupported-status-fails-closed": "validation-tree-unsupported-status",
    "lifecycle:malformed-front-matter-fails-closed": "validation-tree-malformed-front-matter",
    "lifecycle:missing-execution-context-fails-closed": "validation-tree-missing-execution-context",
    "lifecycle:registry-authority-ignores-stale-worktree-metadata": "validation-tree-mismatched-worktree-identity",
};

function ownerFor(id: ValidationWorkflowBranchId): string {
    return VALIDATION_BRANCH_OWNERS[id];
}

function transcriptRequirementFor(id: ValidationWorkflowBranchId): string[] {
    if (id === "lifecycle:missing-plan-fails-closed") return ["Plan not found: missing-plan"];
    if (id === "lifecycle:malformed-front-matter-fails-closed") return ["Plan Front Matter could not be parsed"];
    if (
        id === "lifecycle:resume-implemented" || id === "lifecycle:resume-validated-ci" ||
        id === "lifecycle:resume-validated-reviewer" || id === "lifecycle:ahead-status-keeps-canonical-progress"
    ) return ["Published commit confirmed on main."];
    if (id === "lifecycle:missing-execution-context-fails-closed") {
        return ["Validation blocked: RunWield cannot tell where"];
    }
    if (id === "lifecycle:registry-authority-ignores-stale-worktree-metadata") {
        return ["Published commit confirmed on main."];
    }
    if (id === "lifecycle:unsupported-status-fails-closed") return ["Plan has unknown status: sideways"];
    if (id.includes("plan-amendment")) return ["Plan amendment"];
    if (id.includes(":ci:")) return ["CI"];
    if (id.startsWith("semantic:round-limit:")) return ["Look once more, read it, or stop."];
    if (id === "semantic:provider-error-retry") return ["The model provider could not complete AI review"];
    if (id.startsWith("semantic:nudge:")) return ["Semantic review approved"];
    if (id === "semantic:entry:non-git-skip") return ["AI review skipped"];
    if (id === "semantic:entry:empty-diff-skip") return ["AI review skipped"];
    if (id === "semantic:entry:plan-only-diff-fails") return ["No implementation changes detected"];
    if (id.startsWith("semantic:")) return ["AI review"];
    if (id === "human-review:none") return ["Published commit confirmed on main."];
    if (id === "human-review:ask-skip") return ["Published commit confirmed on main."];
    if (id === "human-review:no-answer-retry" || id === "human-review:no-answer-stop") {
        return ["Pick Retry to open it again"];
    }
    if (id === "human-review:ask-close") return ["Code Review is still pending."];
    if (id.startsWith("human-review:")) return ["Need your review:"];
    if (id === "publication:non-git-success") return ["Plan: non-git-plan", "Merge: Not applicable"];
    const successfulPublicationProgress = [
        "The commits are ready",
        "Checking main for new commits",
        "Merging work into main",
        "Sending the new commits to main",
        "Checking the new commits on main",
        "Cleaning up the worktree",
    ];
    if (id === "publication:isolated-dirty-primary") {
        return [...successfulPublicationProgress, "Published commit confirmed on main"];
    }
    if (id === "publication:dirty-primary-retry") {
        return [
            "have not saved to git yet",
            "No remote is configured. Adding the commits to the local main",
            "Cleaning up the worktree",
            "Published commit confirmed on main",
        ];
    }
    if (id === "publication:remote-target-advance") {
        return [
            ...successfulPublicationProgress,
            "Adding new commits from main",
            "Published commit confirmed on main",
        ];
    }
    if (id === "publication:primary-plan-restored") {
        return [
            "Plan loaded: validation-tree-publication-primary-plan-restored",
            ...successfulPublicationProgress,
            "Published commit confirmed on main",
        ];
    }
    if (id === "publication:missing-target-branch") return ["Target branch main is missing"];
    if (id.startsWith("publication:")) return ["Publication"];
    return ["Plan recovery"];
}

function turnRequirementFor(id: ValidationWorkflowBranchId): string[] {
    if (id.startsWith("publication:")) return [];
    if (id.includes("follow-up") || id.includes("repair") || id.includes("feedback")) return ["engineer"];
    if (id.startsWith("semantic:entry:")) return [];
    if (id.startsWith("semantic:")) return ["reviewer"];
    return [];
}

function statePathsFor(id: ValidationWorkflowBranchId): string[] {
    if (id === "lifecycle:missing-plan-fails-closed" || id === "lifecycle:malformed-front-matter-fails-closed") {
        return ["projectState.plans.0.name"];
    }
    if (
        id === "publication:isolated-dirty-primary" || id === "publication:remote-target-advance" ||
        id === "publication:primary-plan-restored"
    ) {
        return ["publication.remotePlanStatus", "publication.registryEntries"];
    }
    if (id === "publication:dirty-primary-retry") {
        return ["localPublication.planStatus", "localPublication.registryEntries"];
    }
    const paths = ["projectState.plans.0.attrs.status"];
    if (id.includes(":ci:")) paths.push("projectState.plans.0.controllerState.validationCiAttempts");
    if (id.startsWith("semantic:")) paths.push("projectState.plans.0.controllerState.validationSemanticRounds");
    if (id.startsWith("human-review:") && id !== "human-review:ask-close") {
        paths.push("projectState.plans.0.controllerState.humanReviewDecision");
    }
    return paths;
}

function stateEqualsFor(id: ValidationWorkflowBranchId): Record<string, ValidationStateValue> {
    if (id === "human-review:none") {
        return {
            "projectState.plans.0.controllerState.humanReviewMode": "none",
            "projectState.plans.0.controllerState.humanReviewDecision": "not_required",
        };
    }
    if (id === "human-review:ask-close") {
        return {
            "projectState.plans.0.attrs.status": "reviewed",
            "projectState.plans.0.controllerState.humanReviewMode": null,
            "projectState.plans.0.controllerState.humanReviewDecision": null,
        };
    }
    if (id === "human-review:ask-skip") {
        return {
            "projectState.plans.0.controllerState.humanReviewMode": "ask",
            "projectState.plans.0.controllerState.humanReviewDecision": "skipped",
        };
    }
    return {};
}

function stateAbsentFor(): string[] {
    return [];
}

function interactionValuesFor(id: ValidationWorkflowBranchId): string[] {
    if (id === "publication:dirty-primary-retry") return ["retry"];
    if (id === "human-review:ask-close") return ["close"];
    return id === "human-review:ask-skip" ? ["skip"] : [];
}

function transcriptExcludesFor(id: ValidationWorkflowBranchId): string[] {
    if (id === "human-review:none") return ["code review before merge"];
    if (id === "semantic:provider-error-retry") {
        return ["Semantic review rejected", "have not called review_complete"];
    }
    return [];
}

function interactionAbsentValuesFor(id: ValidationWorkflowBranchId): string[] {
    if (id === "human-review:none") return ["open", "skip"];
    return id === "human-review:ask-close" ? ["open", "skip"] : [];
}

function evidenceFor(id: ValidationWorkflowBranchId): ValidationEvidenceRequirement {
    return {
        transcriptIncludes: transcriptRequirementFor(id),
        transcriptExcludes: transcriptExcludesFor(id),
        eventIncludes: ["project:state:captured"],
        turnIncludes: turnRequirementFor(id),
        statePaths: statePathsFor(id),
        stateEquals: stateEqualsFor(id),
        stateAbsent: stateAbsentFor(),
        interactionValues: interactionValuesFor(id),
        interactionAbsentValues: interactionAbsentValuesFor(id),
    };
}

export const VALIDATION_INTERACTION_OPTION_BRANCHES: Readonly<Record<string, readonly ValidationWorkflowBranchId[]>> =
    Object.freeze({
        retry: [
            "mechanical:ci:cancel-retry",
            "human-review:no-answer-retry",
            "publication:dirty-primary-retry",
        ],
        stop: [
            "mechanical:ci:cancel-stop",
            "semantic:round-limit:stop",
            "human-review:no-answer-stop",
        ],
        engineer_follow_up: [
            "mechanical:ci:cancel-follow-up",
        ],
        reject: ["human-review:no-answer-stop"],
        open: ["human-review:ask-open-approve"],
        skip: ["human-review:ask-skip"],
        close: ["human-review:ask-close"],
        continue: ["semantic:round-limit:continue"],
        code_review: ["semantic:round-limit:human-review"],
        confirm: ["human-review:feedback-repair-approve"],
        later: ["human-review:no-answer-retry"],
    });

export const VALIDATION_WORKFLOW_BRANCHES: readonly ValidationWorkflowBranch[] = Object.freeze(
    EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS.map((id) => ({
        id,
        phase: phaseFor(id),
        owner: ownerFor(id),
        trigger: id,
        userVisibleResult: `${id} is visible in the TUI transcript.`,
        durableResult: `${id} is backed by captured Plan, registry, or Git state.`,
        evidence: evidenceFor(id),
    })),
);

export function assertValidationBranchInventory(scenarios: readonly ValidationWorkflowScenarioLike[]): void {
    const expected = [...EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS].sort();
    const actual = VALIDATION_WORKFLOW_BRANCHES.map((branch) => branch.id).sort();
    assertEquals(actual, expected, "Validation branch inventory must match the independent expected branch set.");

    const invented = actual.filter((id) => !EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS.includes(id));
    assertEquals(invented, [], "Validation branch inventory must not invent branch IDs.");

    const owners = new Map<ValidationWorkflowBranchId, string[]>();
    for (const scenario of scenarios) {
        for (const id of scenario.validationBranches || []) {
            owners.set(id, [...(owners.get(id) || []), scenario.name]);
        }
    }

    const ownerMismatches: string[] = [];
    for (const id of EXPECTED_VALIDATION_WORKFLOW_BRANCH_IDS) {
        const branch = VALIDATION_WORKFLOW_BRANCHES.find((entry) => entry.id === id);
        assert(branch, `Missing validation branch ${id}.`);
        const actualOwners = owners.get(id) || [];
        const expectedOwners = [branch.owner];
        if (JSON.stringify(actualOwners) !== JSON.stringify(expectedOwners)) {
            ownerMismatches.push(
                `${id}: expected ${expectedOwners.join(", ")}; got ${actualOwners.join(", ") || "none"}`,
            );
        }
    }
    assertEquals(ownerMismatches, [], "Each validation branch must have exactly one primary Golden owner.");

    for (const scenario of scenarios) {
        const asserted = new Set(
            (scenario.assertions || []).flatMap((assertion) => assertion.validationCoverage || []),
        );
        for (const id of scenario.validationBranches || []) {
            assert(asserted.has(id), `${scenario.name} declares ${id} but has no tagged validation assertion.`);
        }
    }
}

function transcript(result: ValidationWorkflowResultLike): string {
    return `${result.screenText || ""}\n${result.scrollbackText || ""}`;
}

function stateValue(result: ValidationWorkflowResultLike, path: string): ValidationStateValue | undefined {
    let current: ValidationStateValue | undefined = result.state;
    for (const part of path.split(".")) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) {
            const index = Number(part);
            if (!Number.isInteger(index)) return undefined;
            current = current[index];
            continue;
        }
        if (typeof current !== "object") return undefined;
        current = current[part];
    }
    return current;
}

export function assertValidationBranchEvidence(
    id: ValidationWorkflowBranchId,
    result: ValidationWorkflowResultLike,
): void {
    const branch = VALIDATION_WORKFLOW_BRANCHES.find((entry) => entry.id === id);
    assert(branch, `Unknown validation branch ${id}.`);
    assertEquals(result.name, branch.owner, `Branch ${id} evidence came from the wrong scenario.`);

    const text = transcript(result);
    for (const required of branch.evidence.transcriptIncludes) {
        assert(
            text.replaceAll(/\s+/g, " ").includes(required),
            `Branch ${id} missing visible transcript text: ${required}`,
        );
    }
    for (const forbidden of branch.evidence.transcriptExcludes) {
        assert(!text.includes(forbidden), `Branch ${id} unexpectedly showed transcript text: ${forbidden}`);
    }
    for (const required of branch.evidence.eventIncludes) {
        assert(
            (result.events || []).some((event) => event.includes(required)),
            `Branch ${id} missing event: ${required}`,
        );
    }
    for (const required of branch.evidence.turnIncludes) {
        const hasTurnEvidence = (result.state?.turnSequence as string[] | undefined || result.actor?.consumed || [])
            .some((turn) => String(turn).includes(required));
        assert(hasTurnEvidence, `Branch ${id} missing Agent or phase turn evidence: ${required}`);
    }
    for (const required of branch.evidence.statePaths) {
        assert(stateValue(result, required) !== undefined, `Branch ${id} missing durable state path: ${required}`);
    }
    for (const [path, expected] of Object.entries(branch.evidence.stateEquals)) {
        assertEquals(stateValue(result, path), expected, `Branch ${id} has the wrong durable state at ${path}.`);
    }
    for (const path of branch.evidence.stateAbsent) {
        assertEquals(stateValue(result, path), undefined, `Branch ${id} unexpectedly has durable state at ${path}.`);
    }
    const consumedInteractionValues = (stateValue(result, "scriptedInteractions") as ValidationStateValue[] || [])
        .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
            const interaction = entry.interaction;
            if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) return undefined;
            return interaction.value;
        });
    for (const value of branch.evidence.interactionValues) {
        assert(consumedInteractionValues.includes(value), `Branch ${id} did not consume interaction value ${value}.`);
    }
    for (const value of branch.evidence.interactionAbsentValues) {
        assert(
            !consumedInteractionValues.includes(value),
            `Branch ${id} unexpectedly consumed interaction value ${value}.`,
        );
    }
}

export function assertValidationEvidenceRejectsCounterfeits(
    id: ValidationWorkflowBranchId,
    result: ValidationWorkflowResultLike,
): void {
    assertValidationBranchEvidence(id, result);
    const withoutText: ValidationWorkflowResultLike = { ...result, screenText: "", scrollbackText: "" };
    assertThrowsForEvidence(id, withoutText, "transcript");
    const withoutRouting: ValidationWorkflowResultLike = {
        ...result,
        events: [],
        state: { ...(result.state || {}), turnSequence: [] },
        actor: { consumed: [], remaining: result.actor?.remaining || [] },
    };
    assertThrowsForEvidence(id, withoutRouting, "routing");
    const withoutState: ValidationWorkflowResultLike = { ...result, state: {} };
    assertThrowsForEvidence(id, withoutState, "state");
}

function assertThrowsForEvidence(
    id: ValidationWorkflowBranchId,
    result: ValidationWorkflowResultLike,
    label: string,
): void {
    let failed = false;
    try {
        assertValidationBranchEvidence(id, result);
    } catch {
        failed = true;
    }
    assert(failed, `Branch ${id} evidence check must reject ${label}-removed result.`);
}

export function validationEvidenceAssertion(id: ValidationWorkflowBranchId) {
    const assertion = (result: ValidationWorkflowResultLike): void => assertValidationBranchEvidence(id, result);
    assertion.validationCoverage = [id];
    return assertion;
}
