import { stat as fsStat } from "node:fs/promises";
import { captureForegroundProcess } from "../captured-process.ts";
import {
    createExecutionStartPorts,
    reconcileExecutionPreparationLocation,
    startActiveExecutionWorkflow,
} from "../workflow/execution-start.ts";
import { finalizePlanImplementation } from "../workflow/implementation-checkpoint.ts";
import { probeGitRepository } from "../git.ts";
import { hasNonGitExecutionConsent, rememberNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import { findById, listEntries } from "../worktree-registry.js";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import {
    canonicalizeStoredPlanName,
    ensurePlanIdentity,
    getPlanRevisionForText,
    isHiddenPlanName,
    loadArchivedPlan,
    loadPlan,
    resolvePlanExecutionPolicy,
    updatePlanFrontMatter,
    type PlanFrontMatter,
} from "../../plan-store.js";
import { assertNotReservedEpicArtifactPlanName } from "../epic-artifacts.ts";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { runWieldGitignoreNeedsUpdate } from "../runwield-owned-paths.ts";
import { VERSION } from "../version.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";
import { isAnsweredPlanReview } from "../workflow/plan-review-recovery.js";
import { applySharedPlanReviewDecision } from "../workflow/plan-review-actions.ts";
import { loadReviewFeedbackImagePaths } from "../workflow/review-feedback-images.ts";
import { type ReviewDecision } from "../../ui/workspace/routes/api/review-handlers.js";
import { resolveWorkflowPlanLocation } from "../workflow/plan-location.ts";
import { normalizeTriageOutcome, type TriageOutcome } from "../workflow/triage-outcome.ts";
import {
    type ActivateEnvelope,
    ATTACHED_IMPLEMENTER_CONTRACT_VERSION,
    ATTACHED_PLANNER_CONTRACT_VERSION,
    ATTACHED_TRIAGE_CONTRACT_VERSION,
    type AttachedExecution,
    type AttachedJsonValue,
    type AttachedNextAction,
    type AttachedOperationName,
    type AttachedOperationResult,
    type AttachedPlanReference,
    type AttachedRejection,
    type AttachedRejectionCode,
    type AttachedReviewOutcome,
    type AttachedWorkflowView,
    MAX_ATTACHED_INPUT_BYTES,
    parseActivateInput,
    parsePlanWrittenInput,
    parseStartExecutionInput,
    parseStatusInput,
    parseTaskCompletedInput,
    parseTriageReportInput,
    type PlanWrittenEnvelope,
    type PlanWrittenPayload,
    type ProjectMovedRecovery,
    type StartExecutionEnvelope,
    type StatusEnvelope,
    type TaskCompletedEnvelope,
    type TriageReportEnvelope,
    type WorkflowOperationEnvelope,
    type AttachedValidationEnvelope,
    parseValidationInput,
} from "./operations.ts";
import {
    attachedValidationHolderSettled,
    type AttachedWorkflowLocation,
    type AttachedWorkflowRecord,
    loadAttachedWorkflowRecord,
    loadLatestAttachedWorkflowRecord,
    locateAttachedWorkflows,
    settleAttachedValidationHolder,
    transactAttachedWorkflowRecord,
    writeAttachedWorkflowRecord,
} from "./record-store.ts";
import { getLockHostname, isLockHolderGone } from "../process-liveness.ts";
import { assertHostReviewerCandidate } from "../workflow/validation-host-state.ts";
import { continueHostTurnValidation, reconcileConsumedHostResume } from "../workflow/validation-host-turn.ts";
import { sameHostIdentity, ValidationHostRejected } from "../workflow/validation-host-contract.ts";
import { readReviewDiff } from "../workflow/review-diff.ts";
import { resolveAttachedRoleInstructions } from "./role-instructions.ts";

import process from "node:process";
/**
 * @module shared/attached/coordinator
 * The Attached Workflow Coordinator: a sibling runtime to `SessionRuntime` (ADR-014).
 *
 * Each operation is one short step: load the Attached Workflow Record, check it, make
 * at most one change, save, return. Nothing lives in process memory, so a fresh Core
 * process continues where the last one stopped. The coordinator never starts a model
 * turn and never stores a host transcript.
 *
 * Operations cover activation, Triage, Plan submission, execution handoff, and completion.
 * A PLANNED_CHANGE outcome hands the host the Planner role; other Routing Intents
 * close the workflow as unsupported in this Preview.
 */

type Decision = { result: AttachedOperationResult; next?: AttachedWorkflowRecord };
type Decide = (current: AttachedWorkflowRecord) => Promise<Decision>;
type RecordChanges = Pick<AttachedWorkflowRecord, "state" | "pendingAction"> & Partial<AttachedWorkflowRecord>;

/** Repository paths that `plan_written` creates when it first enters the project runtime. */
async function projectSetupFor(projectRoot: string): Promise<string[]> {
    const internalPath = relative(projectRoot, resolveProjectRuntimeLayout(projectRoot).primary.internalRoot);
    const setup: string[] = [];
    const insideRepository = !internalPath.startsWith("..") && !isAbsolute(internalPath);
    if (
        insideRepository &&
        !(await fsStat(join(projectRoot, internalPath)).then(
            () => true,
            () => false,
        ))
    ) {
        setup.push(`${internalPath}/`);
    }
    if (await runWieldGitignoreNeedsUpdate(projectRoot)) setup.push(".gitignore");
    return setup;
}

async function nextActionFor(record: AttachedWorkflowRecord): Promise<AttachedNextAction> {
    const pending = record.pendingAction;
    if (record.state === "validating") {
        if (record.validation?.request && record.validation.actionId && !record.validation.resume) {
            return { kind: "validation", actionId: record.validation.actionId, request: record.validation.request };
        }
        return {
            kind: "validation_recovery",
            guidance: record.validation?.reason || "Call start_validation to resume Core validation.",
            resultKind: record.validation?.resultKind,
            recovery: record.validation?.recovery,
        };
    }
    if (record.state === "reviewed" && record.plan) {
        return {
            kind: "awaiting_delivery",
            planName: record.plan.planName,
            guidance:
                "Core validation passed. Optional code review and publication are the next Preview step. Publication remains pending; this is not Verified.",
        };
    }
    if (record.state === "triaging" && pending) return { kind: "triage", ...pending };
    if (record.state === "awaiting_planning" && pending) {
        return { kind: "plan", ...pending, projectSetup: await projectSetupFor(record.projectRoot) };
    }
    if (record.state === "awaiting_review" && record.plan && record.review) {
        return { kind: "review", round: record.review.round, planName: record.plan.planName };
    }
    if (record.state === "plan_ready" && record.plan) {
        return {
            kind: "plan_ready",
            planName: record.plan.planName,
            guidance: "The Plan is ready for work. Call start_execution now, then dispatch a fresh host worker.",
        };
    }
    if (record.state === "awaiting_consent" && record.pendingConsent) {
        return {
            kind: "consent",
            actionId: record.pendingConsent.actionId,
            consentKind: record.pendingConsent.kind,
            disclosure: record.pendingConsent.disclosure,
        };
    }
    if (record.state === "implementing" && record.execution && record.plan && pending) {
        const executionCwd = record.execution.executionCwd || record.projectRoot;
        return {
            kind: "implementation",
            ...pending,
            planName: record.plan.planName,
            planPath: join(executionCwd, "docs/plans", `${record.plan.planName}.md`),
            executionCwd,
            executionMode: record.execution.executionMode || "worktree",
            worktreeBranch: record.execution.worktreeBranch,
            disclosure:
                record.execution.executionMode === "worktree"
                    ? "RunWield prepared this isolated worktree and branch. The invoking checkout is preserved except the RunWield-owned .gitignore block."
                    : "With recorded consent, implementation edits current files directly without Git isolation/recovery.",
        };
    }
    if (record.state === "implemented" && record.plan) {
        return {
            kind: "implemented",
            planName: record.plan.planName,
            guidance:
                (record.execution?.executionMode === "worktree"
                    ? "Core saved the implementation Git checkpoint and completed the registry entry. "
                    : "Implementation is recorded in the consented current directory. ") +
                "Call start_validation now. Publication remains pending. This is not Verified.",
        };
    }
    return record.closure?.reason === "plan_advanced_in_core"
        ? { kind: "return_to_host", ...record.closure }
        : { kind: "return_to_host", reason: "unsupported_in_preview" };
}

/** Project the canonical Plan position without writing an Attached record. */
async function reconcilePlanPosition(record: AttachedWorkflowRecord): Promise<AttachedWorkflowRecord> {
    if (
        !record.plan ||
        ![
            "awaiting_review",
            "plan_ready",
            "awaiting_consent",
            "implementing",
            "implemented",
            "validating",
            "reviewed",
        ].includes(record.state)
    )
        return record;
    // Execution evidence selects the document; the invoking Plan may still be ready_for_work.
    const executionRoot = record.execution?.executionCwd;
    const location = executionRoot
        ? { plan: await loadPlan(executionRoot, record.plan.planName).catch(() => null), archived: false }
        : await resolveWorkflowPlanLocation(record.projectRoot, record.plan.planName, {
              migrateRegistry: false,
              readOnly: true,
          });
    const { plan, archived } = location;
    const archivedPlan =
        !plan && !archived ? await loadArchivedPlan(executionRoot || record.projectRoot, record.plan.planId) : null;
    // Missing execution documents are restored by the completion authority, not this projection.
    if (!plan && !archived && !archivedPlan) {
        if (record.execution) return record;
        throw new Error(`Plan not found: ${record.plan.planName}`);
    }
    const status = archived || archivedPlan ? "archived" : plan?.attrs.status;
    if (record.state === "validating" && ["implemented", "validated_ci", "reviewed"].includes(status || "")) {
        return record;
    }
    if (record.state === "reviewed" && status === "reviewed") return record;
    if (
        status === "in_progress" &&
        (record.execution || record.state === "plan_ready" || record.state === "awaiting_consent")
    )
        return record;
    // Core's validation phase reads back as status "implemented" plus a
    // validationPhase marker; a semantic or delivery phase means Core already
    // accepted the implementation, so it advances past this preview's scope.
    const advancedIntoValidation =
        plan?.attrs.validationPhase === "semantic" || plan?.attrs.validationPhase === "delivery";
    if (status === "implemented" && record.execution && !advancedIntoValidation) {
        // A lifecycle event alone is not acceptance: Core may still owe the Git
        // checkpoint and registry settlement. Keep the issued action for retry.
        if (record.execution.executionMode === "worktree") {
            const entry = record.execution.worktreeId
                ? await findById(record.projectRoot, record.execution.worktreeId, { migrate: false })
                : null;
            if (entry?.status !== "completed") return record;
        }
        return record.state === "implemented" ? record : { ...record, state: "implemented", pendingAction: null };
    }
    if (status === "approved" || status === "ready_for_work" || status === "ready_for_decomposition") {
        if (record.state === "awaiting_consent" || record.state === "implementing") return record;
        return record.state === "plan_ready" ? record : { ...record, state: "plan_ready", pendingAction: null };
    }
    if (status === "draft" || status === "feedback") {
        if (
            record.state === "awaiting_review" &&
            (status === "draft" || plan?.controllerRevision === record.review?.controllerRevision)
        )
            return record;
        return {
            ...record,
            state: "awaiting_planning",
            pendingAction: {
                actionId: `${record.review?.actionId ?? record.workflowId}:core-feedback`,
                role: "planner",
                contractVersion: ATTACHED_PLANNER_CONTRACT_VERSION,
                note: "The Plan changed in Core. Read the Plan Events before revising and submitting it again.",
            },
        };
    }
    if (
        record.state === "implementing" &&
        !advancedIntoValidation &&
        ![
            // "reviewed" is the current vocabulary for completed code review;
            // the validated_* names are retained for records written before it.
            "reviewed",
            "validated_ci",
            "reviewed",
            "validated",
            "verified",
            "user_verified",
            "closed_without_verification",
            "archived",
        ].includes(status || "")
    )
        return record;
    return {
        ...record,
        state: "closed",
        pendingAction: null,
        closure: {
            reason: "plan_advanced_in_core",
            message: `The Plan advanced in Core to ${status}. No Attached browser review is pending.`,
        },
    };
}

async function viewOf(
    record: AttachedWorkflowRecord,
    recovery: ProjectMovedRecovery | null = null,
): Promise<AttachedWorkflowView> {
    if (!recovery) record = await reconcilePlanPosition(record);
    return {
        workflowId: record.workflowId,
        revision: record.revision,
        state: record.state,
        nextAction: await nextActionFor(record),
        triageOutcome: record.triageOutcome,
        plan: record.plan,
        review: record.review,
        execution: record.execution,
        pendingConsent: record.pendingConsent,
        closure: record.closure,
        recovery,
    };
}

async function rejected(
    operation: AttachedOperationName,
    rejection: AttachedRejection,
    record?: AttachedWorkflowRecord,
): Promise<AttachedOperationResult> {
    return { ok: false, operation, rejection, ...(record ? { workflow: await viewOf(record) } : {}) };
}

function rejection(code: AttachedRejectionCode, message: string): AttachedRejection {
    return { code, message };
}

function movedRecovery(location: AttachedWorkflowLocation, record: AttachedWorkflowRecord): ProjectMovedRecovery {
    return { case: "project_moved", recordedProjectRoot: record.projectRoot, currentProjectRoot: location.projectRoot };
}

/** One workflow per activation operation, so a retried activation finds its own record. */
function workflowIdFor(projectRoot: string, operationId: string): string {
    const hex = createHash("sha256").update(`${projectRoot}\n${operationId}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Save `decision.next`; on a lost race, decide again against the record that won. */
async function commit(
    location: AttachedWorkflowLocation,
    operation: AttachedOperationName,
    expectedRevision: number | null,
    decision: Decision,
    decide: Decide,
): Promise<AttachedOperationResult> {
    if (!decision.next) return decision.result;
    const written = await writeAttachedWorkflowRecord(location, decision.next, expectedRevision);
    if (written.status === "written") return decision.result;
    if (written.status === "busy") {
        return await rejected(
            operation,
            rejection("workflow_busy", "Another RunWield process holds this workflow. Retry."),
        );
    }
    if (!written.current) {
        return await rejected(operation, rejection("workflow_not_found", "The workflow no longer exists."));
    }
    return (await decide(written.current)).result;
}

/**
 * The checks every operation on an existing workflow makes before it changes anything:
 * a saved result replays, then the revision and the pending action must match.
 */
async function checkWorkflowOperation(
    operation: AttachedOperationName,
    envelope: WorkflowOperationEnvelope<{ actionId: string }>,
    current: AttachedWorkflowRecord,
    pendingState: AttachedWorkflowRecord["state"],
): Promise<Decision | null> {
    const saved = Object.hasOwn(current.acceptedOperations, envelope.operationId)
        ? current.acceptedOperations[envelope.operationId]
        : undefined;
    if (saved) return { result: saved.result };
    if (current.revision !== envelope.expectedRevision) {
        return {
            result: await rejected(
                operation,
                rejection("revision_conflict", `The workflow is at revision ${current.revision}.`),
                current,
            ),
        };
    }
    if (current.state !== pendingState || current.pendingAction?.actionId !== envelope.payload.actionId) {
        return {
            result: await rejected(
                operation,
                rejection(
                    "action_superseded",
                    current.state === "awaiting_review"
                        ? "A browser review is pending. Wait for its decision before submitting another Plan."
                        : "This action is not the workflow's pending action.",
                ),
                current,
            ),
        };
    }
    return null;
}

/** The next revision with `changes` applied and this operation's result saved for replay. */
async function accept(
    operation: AttachedOperationName,
    envelope: WorkflowOperationEnvelope<{ actionId?: string }>,
    current: AttachedWorkflowRecord,
    changes: RecordChanges,
): Promise<Decision> {
    const now = new Date().toISOString();
    const next: AttachedWorkflowRecord = { ...current, ...changes, revision: current.revision + 1, updatedAt: now };
    const result: AttachedOperationResult = { ok: true, operation, workflow: await viewOf(next) };
    next.acceptedOperations = {
        ...current.acceptedOperations,
        [envelope.operationId]: { result, evidence: { ...envelope.evidence, coreVersion: VERSION }, acceptedAt: now },
    };
    return { result, next };
}

/** Load the record an operation names, or the rejection that ends the operation. */
async function loadForOperation(
    operation: AttachedOperationName,
    location: AttachedWorkflowLocation,
    workflowId: string,
): Promise<{ record: AttachedWorkflowRecord } | { result: AttachedOperationResult }> {
    const loaded = await loadAttachedWorkflowRecord(location, workflowId);
    if (loaded.status === "missing") {
        return {
            result: await rejected(
                operation,
                rejection("workflow_not_found", "No Attached Workflow has this workflowId."),
            ),
        };
    }
    if (loaded.status === "moved") {
        return {
            result: await rejected(
                operation,
                rejection("project_moved", `This workflow belongs to ${loaded.record.projectRoot}.`),
            ),
        };
    }
    return { record: loaded.record };
}

export async function activate(envelope: ActivateEnvelope): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const workflowId = workflowIdFor(location.projectRoot, envelope.operationId);
    const replay = async (current: AttachedWorkflowRecord): Promise<Decision> => {
        const saved = Object.hasOwn(current.acceptedOperations, envelope.operationId)
            ? current.acceptedOperations[envelope.operationId]
            : undefined;
        return {
            result:
                saved?.result ??
                (await rejected("activate", rejection("revision_conflict", "This workflow already exists."), current)),
        };
    };

    const loaded = await loadAttachedWorkflowRecord(location, workflowId);
    if (loaded.status !== "missing") return (await replay(loaded.record)).result;

    const now = new Date().toISOString();
    const evidence = { ...envelope.evidence, coreVersion: VERSION };
    const record: AttachedWorkflowRecord = {
        validation: null,
        schemaVersion: 1,
        workflowId,
        revision: 1,
        projectRoot: location.projectRoot,
        request: { text: envelope.payload.requestText, hostRequestId: envelope.payload.hostRequestId },
        evidence,
        state: "triaging",
        pendingAction: {
            actionId: crypto.randomUUID(),
            role: "router",
            contractVersion: ATTACHED_TRIAGE_CONTRACT_VERSION,
        },
        acceptedOperations: {},
        triageOutcome: null,
        plan: null,
        review: null,
        execution: null,
        pendingConsent: null,
        closure: null,
        createdAt: now,
        updatedAt: now,
    };
    const result: AttachedOperationResult = { ok: true, operation: "activate", workflow: await viewOf(record) };
    record.acceptedOperations[envelope.operationId] = { result, evidence, acceptedAt: now };
    return await commit(location, "activate", null, { result, next: record }, replay);
}

export async function triageReport(envelope: TriageReportEnvelope): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const decide = async (current: AttachedWorkflowRecord): Promise<Decision> => {
        const checked = await checkWorkflowOperation("triage_report", envelope, current, "triaging");
        if (checked) return checked;
        const outcome = normalizeTriageOutcome(envelope.payload.outcome);
        if (!outcome) {
            return {
                result: await rejected(
                    "triage_report",
                    rejection(
                        "invalid_outcome",
                        "The Triage outcome needs a valid routingIntent, complexity, and summary.",
                    ),
                    current,
                ),
            };
        }
        if (outcome.routingIntent !== "PLANNED_CHANGE") {
            return await accept("triage_report", envelope, current, {
                state: "closed",
                pendingAction: null,
                triageOutcome: outcome,
                closure: { reason: "unsupported_in_preview", routingIntent: outcome.routingIntent },
            });
        }
        return await accept("triage_report", envelope, current, {
            state: "awaiting_planning",
            pendingAction: {
                actionId: crypto.randomUUID(),
                role: "planner",
                contractVersion: ATTACHED_PLANNER_CONTRACT_VERSION,
            },
            triageOutcome: outcome,
        });
    };

    const loaded = await loadForOperation("triage_report", location, envelope.workflowId);
    if ("result" in loaded) return loaded.result;
    return await commit(location, "triage_report", loaded.record.revision, await decide(loaded.record), decide);
}

type PlanSubmission =
    | { ok: true; plan: AttachedPlanReference; revision: string; controllerRevision: number }
    | { ok: false; message: string };

/**
 * Make the written Plan a RunWield Plan: the Plan file steps of Core's `plan_written`
 * without its Hosted Session or review. Every check runs before the first write, so a
 * rejected submission leaves the Plan file as it was. The Plan stays `draft`.
 */
async function submitPlanDocument(
    projectRoot: string,
    payload: PlanWrittenPayload,
    triage: TriageOutcome,
): Promise<PlanSubmission> {
    let planName;
    let location;
    try {
        planName = canonicalizeStoredPlanName(payload.planName).name;
        assertNotReservedEpicArtifactPlanName(planName);
        if (isHiddenPlanName(planName)) throw new Error(`Plan is archived or hidden: ${planName}`);
        location = await resolveWorkflowPlanLocation(projectRoot, planName, { migrateRegistry: false, readOnly: true });
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!location.plan) {
        return {
            ok: false,
            message: `docs/plans/${planName}.md not found. Write the Plan first, then call plan_written again.`,
        };
    }

    const updates: Partial<PlanFrontMatter> = { classification: triage.classification, complexity: triage.complexity };
    if (triage.workKind) updates.workKind = triage.workKind;
    if (payload.executionAgent !== undefined) updates.executionAgent = payload.executionAgent;
    if (payload.collaborationRecommendation !== undefined) {
        updates.collaborationRecommendation = payload.collaborationRecommendation;
    }
    const policy = resolvePlanExecutionPolicy({ ...location.plan.attrs, ...updates });
    if (!policy.ok) {
        return {
            ok: false,
            message:
                `${policy.error} Correct executionAgent or collaborationRecommendation in the call or in ` +
                `docs/plans/${planName}.md, then call plan_written again.`,
        };
    }

    await enterProjectRuntime(projectRoot);
    await updatePlanFrontMatter(
        location.documentRoot,
        planName,
        updates,
        {},
        {
            expectedRevision: location.plan.revision,
        },
    );
    const identified = await ensurePlanIdentity(location.documentRoot, planName);
    const submittedPlan = await loadPlan(location.documentRoot, planName);
    if (!submittedPlan) throw new Error(`Plan not found: ${planName}`);
    return {
        ok: true,
        plan: { planId: identified.planId, planName },
        revision: identified.revision,
        controllerRevision: submittedPlan.controllerRevision,
    };
}

export async function planWritten(envelope: PlanWrittenEnvelope): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const loaded = await loadForOperation("plan_written", location, envelope.workflowId);
    if ("result" in loaded) return loaded.result;
    const transaction = await transactAttachedWorkflowRecord<AttachedOperationResult>(
        location,
        envelope.workflowId,
        async (current): Promise<Decision> => {
            if (!current) {
                return {
                    result: await rejected(
                        "plan_written",
                        rejection("workflow_not_found", "The workflow no longer exists."),
                    ),
                };
            }
            current = await reconcilePlanPosition(current);
            const checked = await checkWorkflowOperation("plan_written", envelope, current, "awaiting_planning");
            if (checked) return checked;
            if (!current.triageOutcome) {
                return {
                    result: await rejected(
                        "plan_written",
                        rejection("invalid_outcome", "This workflow has no Triage outcome."),
                        current,
                    ),
                };
            }
            const submitted = await submitPlanDocument(envelope.projectRoot, envelope.payload, current.triageOutcome);
            if (!submitted.ok) {
                return {
                    result: await rejected("plan_written", rejection("invalid_outcome", submitted.message), current),
                };
            }
            return await accept("plan_written", envelope, current, {
                state: "awaiting_review",
                pendingAction: null,
                plan: submitted.plan,
                review: {
                    round: (current.review?.round ?? 0) + 1,
                    actionId: crypto.randomUUID(),
                    planRevision: submitted.revision,
                    controllerRevision: submitted.controllerRevision,
                    waitingReason: "user_decision",
                    status: "pending",
                },
            });
        },
    );
    return transaction.status === "busy"
        ? await rejected(
              "plan_written",
              rejection("workflow_busy", "Another RunWield process holds this workflow. Retry."),
          )
        : transaction.result;
}

const NON_GIT_DISCLOSURE =
    "Git is not available for this project. RunWield recommends Git for isolated worktree execution and diff-based review and merge-back. Proceeding edits current files directly and skips Git-only isolation/recovery. Proceed and remember consent for planned Plan work, or decline?";

/** Prepare through the same Core authority as Session execution; no host model turn. */
export async function startExecution(envelope: StartExecutionEnvelope): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const loaded = await loadForOperation("start_execution", location, envelope.workflowId);
    if ("result" in loaded) return loaded.result;
    const transaction = await transactAttachedWorkflowRecord<AttachedOperationResult>(
        location,
        envelope.workflowId,
        async (current): Promise<Decision> => {
            if (!current) {
                return {
                    result: await rejected(
                        "start_execution",
                        rejection("workflow_not_found", "The workflow no longer exists."),
                    ),
                };
            }
            const saved = Object.hasOwn(current.acceptedOperations, envelope.operationId)
                ? current.acceptedOperations[envelope.operationId]
                : undefined;
            if (saved) return { result: saved.result };
            if (current.revision !== envelope.expectedRevision) {
                return {
                    result: await rejected(
                        "start_execution",
                        rejection("revision_conflict", `The workflow is at revision ${current.revision}.`),
                        current,
                    ),
                };
            }
            let preparationSource: Awaited<ReturnType<typeof reconcileExecutionPreparationLocation>> | undefined;
            try {
                if (current.plan) {
                    preparationSource = await reconcileExecutionPreparationLocation(
                        location.projectRoot,
                        current.plan.planName,
                        { migrateRegistry: false, readOnly: true },
                    );
                }
                if (preparationSource?.plan?.attrs.status !== "ready_for_work") {
                    current = await reconcilePlanPosition(current);
                }
            } catch (error) {
                return {
                    result: await rejected(
                        "start_execution",
                        rejection("invalid_outcome", error instanceof Error ? error.message : String(error)),
                        current,
                    ),
                };
            }
            if (current.state !== "plan_ready" && current.state !== "awaiting_consent") {
                return {
                    result: await rejected(
                        "start_execution",
                        rejection(
                            "action_superseded",
                            "Execution requires a ready Plan. Use status to restore an implementing handoff.",
                        ),
                        current,
                    ),
                };
            }
            if (current.state === "awaiting_consent") {
                if (current.pendingConsent?.actionId !== envelope.payload.actionId || !envelope.payload.consent) {
                    return {
                        result: await rejected(
                            "start_execution",
                            rejection("action_superseded", "This consent action is no longer pending."),
                            current,
                        ),
                    };
                }
                if (envelope.payload.consent === "decline") {
                    return await accept("start_execution", envelope, current, {
                        state: "plan_ready",
                        pendingAction: null,
                        pendingConsent: null,
                    });
                }
            } else if (envelope.payload.actionId || envelope.payload.consent) {
                return {
                    result: await rejected(
                        "start_execution",
                        rejection("action_superseded", "No consent action is pending."),
                        current,
                    ),
                };
            }
            try {
                if (!current.plan) throw new Error("This workflow has no Plan.");
                const source =
                    preparationSource ||
                    (await reconcileExecutionPreparationLocation(location.projectRoot, current.plan.planName, {
                        migrateRegistry: false,
                        readOnly: true,
                    }));
                if (!source.plan || source.plan.attrs.planId !== current.plan.planId) {
                    throw new Error("The Plan identity no longer matches this workflow.");
                }
                const status = source.plan.attrs.status;
                // If preparation committed before the Attached write, Core can adopt its existing live attempt.
                const recoveredAttempt =
                    status === "in_progress" &&
                    (await listEntries(location.projectRoot, { migrate: false })).some(
                        (entry) =>
                            entry.planId === current.plan?.planId &&
                            entry.path === source.documentRoot &&
                            entry.status === "active",
                    );
                const recoveredInPlace =
                    status === "in_progress" &&
                    source.plan.attrs.executionMode === "non_git_in_place" &&
                    hasNonGitExecutionConsent("featurePlan", location.projectRoot);
                if (status !== "ready_for_work" && !recoveredAttempt && !recoveredInPlace) {
                    throw new Error("Execution requires ready_for_work approval/readiness.");
                }
                const git = await probeGitRepository(location.projectRoot);
                if (!["work_tree", "not_git", "git_missing"].includes(git.state)) {
                    throw new Error(git.message || "Git execution is not available.");
                }
                if (git.state !== "work_tree" && !hasNonGitExecutionConsent("featurePlan", location.projectRoot)) {
                    if (current.state === "awaiting_consent" && envelope.payload.consent === "proceed") {
                        await rememberNonGitExecutionConsent("featurePlan", location.projectRoot);
                    } else {
                        return await accept("start_execution", envelope, current, {
                            state: "awaiting_consent",
                            pendingAction: null,
                            pendingConsent: {
                                actionId: crypto.randomUUID(),
                                kind: "non_git_in_place",
                                disclosure: NON_GIT_DISCLOSURE,
                            },
                        });
                    }
                }
                const ports = createExecutionStartPorts();
                const prepared = await startActiveExecutionWorkflow({
                    cwd: location.projectRoot,
                    planName: current.plan.planName,
                    triageMeta: source.plan.attrs,
                    currentStatus: status,
                    existingExecution: current.execution,
                    ports,
                });
                const issuedPlan = await loadPlan(prepared.executionCwd || location.projectRoot, current.plan.planName);
                if (!issuedPlan || issuedPlan.attrs.planId !== current.plan.planId) {
                    throw new Error("The prepared execution Plan identity is missing or changed.");
                }
                const actionId = crypto.randomUUID();
                const execution: AttachedExecution = {
                    ...prepared,
                    actionId,
                    planRevision: issuedPlan.revision,
                    planBodyRevision: await getPlanRevisionForText(issuedPlan.body),
                };
                return await accept("start_execution", envelope, current, {
                    state: "implementing",
                    execution,
                    pendingConsent: null,
                    pendingAction: {
                        actionId,
                        role: prepared.executionAgent,
                        contractVersion: ATTACHED_IMPLEMENTER_CONTRACT_VERSION,
                    },
                });
            } catch (error) {
                return {
                    result: await rejected(
                        "start_execution",
                        rejection("invalid_outcome", error instanceof Error ? error.message : String(error)),
                        current,
                    ),
                };
            }
        },
    );
    return transaction.status === "busy"
        ? await rejected("start_execution", rejection("workflow_busy", "Another process holds this workflow. Retry."))
        : transaction.result;
}

/** Accept only the issued action and live execution evidence, then call Core completion. */
export async function taskCompleted(envelope: TaskCompletedEnvelope): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const loaded = await loadForOperation("task_completed", location, envelope.workflowId);
    if ("result" in loaded) return loaded.result;
    if (
        loaded.record.state === "validating" ||
        (Object.hasOwn(loaded.record.acceptedOperations, envelope.operationId) &&
            loaded.record.acceptedOperations[envelope.operationId].result.operation === "task_completed")
    ) {
        return await runValidationOperation("task_completed", envelope);
    }

    const transaction = await transactAttachedWorkflowRecord<AttachedOperationResult>(
        location,
        envelope.workflowId,
        async (current): Promise<Decision> => {
            if (!current) {
                return {
                    result: await rejected(
                        "task_completed",
                        rejection("workflow_not_found", "The workflow no longer exists."),
                    ),
                };
            }
            const checked = await checkWorkflowOperation("task_completed", envelope, current, "implementing");
            if (checked) return checked;
            try {
                const execution = current.execution;
                if (!execution || !current.plan || execution.actionId !== envelope.payload.actionId) {
                    throw new Error("Durable execution authority is missing or superseded.");
                }
                if (execution.executionMode === "worktree") {
                    if (!execution.worktreeId || !execution.executionCwd || !execution.worktreeBranch) {
                        throw new Error("Execution worktree authority is incomplete.");
                    }
                    const entry = await findById(location.projectRoot, execution.worktreeId, { migrate: false });
                    if (
                        !entry ||
                        entry.planId !== current.plan.planId ||
                        entry.path !== execution.executionCwd ||
                        entry.branch !== execution.worktreeBranch ||
                        !["active", "completed"].includes(entry.status)
                    )
                        throw new Error("The live execution registry no longer matches the issued worktree.");
                    if (!(await fsStat(execution.executionCwd)).isDirectory()) {
                        throw new Error("The execution worktree is missing.");
                    }
                    const liveGit = await probeGitRepository(execution.executionCwd);
                    if (liveGit.state !== "work_tree") {
                        throw new Error("The execution worktree is no longer a Git checkout.");
                    }
                    const branch = await captureForegroundProcess("git", {
                        args: ["symbolic-ref", "--short", "HEAD"],
                        cwd: execution.executionCwd,
                    });
                    if (!branch.success || new TextDecoder().decode(branch.stdout).trim() !== execution.worktreeBranch)
                        throw new Error("The live execution branch no longer matches the issued worktree.");
                }
                await finalizePlanImplementation({
                    projectRoot: location.projectRoot,
                    planName: current.plan.planName,
                    triageMeta: { ...execution.triageMeta, planId: current.plan.planId },
                    executionContext: execution,
                    executionReport: envelope.payload.message,
                    expectedPlanRevision: execution.planRevision,
                    expectedPlanBodyRevision: execution.planBodyRevision,
                });
                return await accept("task_completed", envelope, current, { state: "implemented", pendingAction: null });
            } catch (error) {
                return {
                    result: await rejected(
                        "task_completed",
                        rejection("invalid_outcome", error instanceof Error ? error.message : String(error)),
                        current,
                    ),
                };
            }
        },
    );
    return transaction.status === "busy"
        ? await rejected("task_completed", rejection("workflow_busy", "Another process holds this workflow. Retry."))
        : transaction.result;
}

/** The reviewed document and durable round identity a carrier must present together. */
export interface AttachedReviewPayloadBasis {
    review: NonNullable<AttachedWorkflowRecord["review"]>;
    planName: string;
    planPath: string;
    documentRoot: string;
    markdown: string;
    attrs: PlanFrontMatter;
    triageMeta: TriageOutcome | null;
}

export type AttachedReviewOpenResult =
    { kind: "opened"; basis: AttachedReviewPayloadBasis } | { kind: "not_pending"; workflow: AttachedWorkflowView };

/** Pin the actual document revision before any carrier opens or restores a review. */
export async function openAttachedReviewRound(
    projectRoot: string,
    workflowId: string,
): Promise<AttachedReviewOpenResult> {
    const location = locateAttachedWorkflows(projectRoot);
    const transaction = await transactAttachedWorkflowRecord<AttachedReviewOpenResult>(
        location,
        workflowId,
        async (current) => {
            if (!current) throw new Error("workflow_not_found: No Attached Workflow has this workflowId.");
            if (current.projectRoot !== location.projectRoot) {
                throw new Error("project_moved: This workflow belongs elsewhere.");
            }
            const reconciled = await reconcilePlanPosition(current);
            const now = new Date().toISOString();
            if (reconciled !== current) {
                const next = { ...reconciled, revision: current.revision + 1, updatedAt: now };
                return { result: { kind: "not_pending", workflow: await viewOf(next) }, next };
            }
            if (current.state !== "awaiting_review" || current.review?.status !== "pending" || !current.plan) {
                return { result: { kind: "not_pending", workflow: await viewOf(current) } };
            }
            const { plan, documentRoot } = await resolveWorkflowPlanLocation(projectRoot, current.plan.planName, {
                migrateRegistry: false,
                readOnly: true,
            });
            if (!plan) throw new Error(`Plan not found: ${current.plan.planName}`);
            const review = {
                ...current.review,
                planRevision: plan.revision,
                controllerRevision: plan.controllerRevision,
            };
            const changed =
                review.planRevision !== current.review.planRevision ||
                review.controllerRevision !== current.review.controllerRevision;
            const next = changed ? { ...current, review, revision: current.revision + 1, updatedAt: now } : undefined;
            return {
                result: {
                    kind: "opened",
                    basis: {
                        review,
                        planName: current.plan.planName,
                        planPath: plan.path,
                        documentRoot,
                        markdown: plan.markdown,
                        attrs: plan.attrs,
                        triageMeta: current.triageOutcome,
                    },
                },
                ...(next && { next }),
            };
        },
    );
    if (transaction.status === "busy") {
        throw new Error("workflow_busy: Another RunWield process holds this workflow. Retry.");
    }
    return transaction.result;
}

type AttachedReviewDecisionResult = { outcome: AttachedReviewOutcome } | { rejection: string };

/** Apply a browser decision against its pinned payload, then commit before acknowledgment. */
export async function applyAttachedReviewDecision(
    projectRoot: string,
    workflowId: string,
    round: AttachedReviewPayloadBasis,
    decision: ReviewDecision,
): Promise<AttachedReviewOutcome> {
    const location = locateAttachedWorkflows(projectRoot);
    const transaction = await transactAttachedWorkflowRecord<AttachedReviewDecisionResult>(
        location,
        workflowId,
        async (current) => {
            if (!current) throw new Error("workflow_not_found: No Attached Workflow has this workflowId.");
            if (current.projectRoot !== location.projectRoot) {
                throw new Error("project_moved: This workflow belongs elsewhere.");
            }
            const saved = current.review;
            if (saved?.round !== round.review.round || saved.actionId !== round.review.actionId) {
                throw new Error("action_superseded: This review round is no longer pending.");
            }
            if (saved.status === "applied" && saved.outcome) return { result: { outcome: saved.outcome } };
            if (current.state !== "awaiting_review" || saved.planRevision !== round.review.planRevision) {
                throw new Error("action_superseded: This reviewed document is no longer pending. Reopen the review.");
            }
            const reconciled = await reconcilePlanPosition(current);
            if (reconciled !== current) {
                return {
                    result: {
                        rejection:
                            "action_superseded: The Plan advanced in Core. Read status for its current position.",
                    },
                    next: { ...reconciled, revision: current.revision + 1, updatedAt: new Date().toISOString() },
                };
            }
            const canceled = decision.canceled === true || decision.exit === true;
            if (!canceled && !isAnsweredPlanReview(decision)) {
                throw new Error("invalid_outcome: Review has no decision.");
            }
            let outcome: AttachedReviewOutcome;
            if (canceled) {
                outcome = { kind: "canceled" };
            } else {
                const applied = await applySharedPlanReviewDecision({
                    cwd: round.documentRoot,
                    planName: round.planName,
                    planPath: round.planPath,
                    planWithFrontMatter: round.markdown,
                    planRevision: saved.planRevision,
                    originalAttrs: round.attrs,
                    trustedClassification: current.triageOutcome?.classification,
                    trustedWorkKind: current.triageOutcome?.workKind,
                    decision,
                });
                if (applied.cancellationReason || applied.recoveryRequired) {
                    throw new Error(applied.feedback || "The Plan changed. Reload this review.");
                }
                if (applied.approved) {
                    await recordPlanEvent({
                        cwd: round.documentRoot,
                        planName: round.planName,
                        event: "readiness_passed",
                        currentStatus: "approved",
                        expectedRevision: applied.revision,
                    });
                    outcome = {
                        kind: "approved",
                        ...(applied.approvalAction && { approvalAction: applied.approvalAction }),
                    };
                } else {
                    outcome = {
                        kind: "feedback",
                        feedback: applied.feedback ?? "",
                        imagePaths: await loadReviewFeedbackImagePaths(decision, round.documentRoot),
                    };
                }
            }
            const pendingAction =
                outcome.kind === "approved"
                    ? null
                    : {
                          actionId: crypto.randomUUID(),
                          role: "planner" as const,
                          contractVersion: ATTACHED_PLANNER_CONTRACT_VERSION,
                          ...(outcome.kind === "canceled"
                              ? {
                                    note: "The user canceled the browser review. Return to the user in Claude; this workflow remains open.",
                                }
                              : {
                                    feedback: outcome.feedback,
                                    imagePaths: outcome.imagePaths,
                                    note: "Read the feedback before revising. Browser edits are already in the Plan; do not apply them twice.",
                                }),
                      };
            const next: AttachedWorkflowRecord = {
                ...current,
                state: outcome.kind === "approved" ? "plan_ready" : "awaiting_planning",
                pendingAction,
                review: { ...saved, status: "applied", outcome },
                revision: current.revision + 1,
                updatedAt: new Date().toISOString(),
            };
            return { result: { outcome }, next };
        },
    );
    if (transaction.status === "busy") throw new Error("workflow_busy: Another process holds this workflow. Retry.");
    if ("rejection" in transaction.result) throw new Error(transaction.result.rejection);
    return transaction.result.outcome;
}

export async function readStatus(envelope: StatusEnvelope): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const latest = envelope.workflowId ? null : await loadLatestAttachedWorkflowRecord(location);
    const loaded = envelope.workflowId
        ? await loadAttachedWorkflowRecord(location, envelope.workflowId)
        : latest
          ? { status: "found" as const, record: latest }
          : { status: "missing" as const };
    if (loaded.status === "missing") {
        return await rejected("status", rejection("workflow_not_found", "No Attached Workflow has this workflowId."));
    }
    const recovery = loaded.status === "moved" ? movedRecovery(location, loaded.record) : null;
    return { ok: true, operation: "status", workflow: await viewOf(loaded.record, recovery) };
}

async function runParsedOperation(
    name: AttachedOperationName,
    projectRoot: string,
    input: AttachedJsonValue | undefined,
): Promise<AttachedOperationResult> {
    if (name === "activate") {
        const parsed = parseActivateInput(projectRoot, input);
        return parsed.ok ? await activate(parsed.envelope) : await rejected(name, parsed.rejection);
    }
    if (name === "triage_report") {
        const parsed = parseTriageReportInput(projectRoot, input);
        return parsed.ok ? await triageReport(parsed.envelope) : await rejected(name, parsed.rejection);
    }
    if (name === "plan_written") {
        const parsed = parsePlanWrittenInput(projectRoot, input);
        return parsed.ok ? await planWritten(parsed.envelope) : await rejected(name, parsed.rejection);
    }
    if (name === "start_execution") {
        const parsed = parseStartExecutionInput(projectRoot, input);
        return parsed.ok ? await startExecution(parsed.envelope) : await rejected(name, parsed.rejection);
    }
    if (name === "task_completed") {
        const parsed = parseTaskCompletedInput(projectRoot, input);
        return parsed.ok ? await taskCompleted(parsed.envelope) : await rejected(name, parsed.rejection);
    }
    if (["start_validation", "review_diff", "review_complete", "validation_decision"].includes(name)) {
        const parsed = parseValidationInput(projectRoot, input, name);
        return parsed.ok ? await runValidationOperation(name, parsed.envelope) : await rejected(name, parsed.rejection);
    }
    const parsed = parseStatusInput(projectRoot, input);
    return parsed.ok ? await readStatus(parsed.envelope) : await rejected(name, parsed.rejection);
}

/**
 * Attach the current role instructions when the workflow waits on the host. They are
 * resolved for this response only and never saved, so a replayed result carries the
 * instructions in effect now.
 */
async function withRoleInstructions(
    projectRoot: string,
    result: AttachedOperationResult,
): Promise<AttachedOperationResult> {
    const action = result.workflow?.nextAction;
    if (action?.kind === "validation" && action.request.kind !== "decision") {
        const role = action.request.kind === "reviewer" ? "reviewer" : "reviewer-feedback-engineer";
        const cwd = action.request.cwd;
        const text = await resolveAttachedRoleInstructions(cwd, role);
        return {
            ...result,
            instructions: {
                role,
                contractVersion: "runwield.attached.validation/1",
                text: `${text}\n\n${action.request.prompt}\n\nAttached worker override: Return your report or structured review outcome to the coordinating conversation. Do not call completion or lifecycle tools. Only the reviewer may call MCP review_diff directly.`,
            },
        };
    }
    if (action?.kind !== "triage" && action?.kind !== "plan" && action?.kind !== "implementation") return result;
    const text = await resolveAttachedRoleInstructions(projectRoot, action.role);
    return { ...result, instructions: { role: action.role, contractVersion: action.contractVersion, text } };
}

/**
 * The single entry both carriers use: JSON text in, one result object out. Because the
 * CLI and MCP carriers both pass text here, the same input gives the same result.
 */
export async function runAttachedOperation(
    name: AttachedOperationName,
    projectRoot: string,
    inputText: string,
): Promise<AttachedOperationResult> {
    if (new TextEncoder().encode(inputText).length > MAX_ATTACHED_INPUT_BYTES) {
        return await rejected(name, rejection("payload_too_large", `Input exceeds ${MAX_ATTACHED_INPUT_BYTES} bytes.`));
    }
    let input: AttachedJsonValue | undefined;
    try {
        input = JSON.parse(inputText);
    } catch {
        input = undefined;
    }
    return await withRoleInstructions(projectRoot, await runParsedOperation(name, projectRoot, input));
}

/** Persist the host claim before CI, then run Core outside the Attached record lock.
 * The shared supervisor owns attempt exclusivity and candidate checks. A lost process
 * resumes the durable claim; the carrier never invents a second validation policy.
 */
export async function runValidationOperation(
    operation: AttachedOperationName,
    envelope: AttachedValidationEnvelope | TaskCompletedEnvelope,
): Promise<AttachedOperationResult> {
    const location = locateAttachedWorkflows(envelope.projectRoot);
    const loaded = await loadForOperation(operation, location, envelope.workflowId);
    if ("result" in loaded) return loaded.result;
    const current = loaded.record;
    const saved = Object.hasOwn(current.acceptedOperations, envelope.operationId)
        ? current.acceptedOperations[envelope.operationId]
        : undefined;
    if (saved) return saved.result;
    if (current.revision !== envelope.expectedRevision) {
        return await rejected(
            operation,
            rejection("revision_conflict", `The workflow is at revision ${current.revision}.`),
            current,
        );
    }
    if (!current.plan || !["implemented", "validating"].includes(current.state)) {
        return await rejected(operation, rejection("action_superseded", "No validation action is pending."), current);
    }
    const checkpoint = current.validation ?? { coverage: [] };
    if (
        checkpoint.holder &&
        !(await attachedValidationHolderSettled(location, checkpoint.holder)) &&
        !(await isLockHolderGone(JSON.stringify(checkpoint.holder)))
    ) {
        return await rejected(
            operation,
            rejection("workflow_busy", "Core validation is running. Retry after the active call returns."),
            current,
        );
    }
    let resume = checkpoint.resume;
    if (operation === "start_validation" && checkpoint.request && !resume && !checkpoint.operationId) {
        let fresh = true;
        if (checkpoint.request.kind === "reviewer") {
            try {
                await validateAttachedReviewerCandidate(current, {
                    kind: "reviewer",
                    identity: checkpoint.request.identity,
                    outcome: null,
                    coverage: [],
                });
            } catch {
                fresh = false;
            }
        }
        if (fresh) return { ok: true, operation, workflow: await viewOf(current) };
    }
    if (operation !== "start_validation") {
        if (resume || !checkpoint.request || checkpoint.actionId !== envelope.payload.actionId) {
            return await rejected(
                operation,
                rejection("action_superseded", "This validation action is no longer pending."),
                current,
            );
        }
        const request = checkpoint.request;
        if (operation === "review_diff" && request.kind === "reviewer" && "command" in envelope.payload) {
            try {
                await validateAttachedReviewerCandidate(current, {
                    kind: "reviewer",
                    identity: request.identity,
                    outcome: null,
                    coverage: [],
                });
            } catch (error) {
                return await rejected(
                    operation,
                    rejection("action_superseded", error instanceof Error ? error.message : String(error)),
                    current,
                );
            }
            const diff = readReviewDiff(
                { full: request.fullDiff, repair: request.repairDiff },
                {
                    command: envelope.payload.command || "list",
                    scope: envelope.payload.scope,
                    path: envelope.payload.path,
                    offsetBytes: envelope.payload.offsetBytes,
                    maxBytes: envelope.payload.maxBytes,
                },
            );
            if (diff.isError) return await rejected(operation, rejection("invalid_input", diff.text), current);
            const decision = await accept(operation, envelope, current, {
                state: "validating",
                pendingAction: null,
                validation: {
                    ...checkpoint,
                    coverage: diff.coverage ? [...checkpoint.coverage, diff.coverage] : checkpoint.coverage,
                },
            });
            if (decision.result.ok) decision.result.diff = diff;
            return await commit(location, operation, current.revision, decision, async (winner) => ({
                result:
                    winner.acceptedOperations[envelope.operationId]?.result ??
                    (await rejected(
                        operation,
                        rejection(
                            "revision_conflict",
                            "Another call changed the validation receipts. Read status and retry.",
                        ),
                        winner,
                    )),
            }));
        }
        if (
            operation === "review_complete" &&
            request.kind === "reviewer" &&
            "outcome" in envelope.payload &&
            envelope.payload.outcome
        ) {
            resume = {
                kind: "reviewer",
                identity: request.identity,
                outcome: envelope.payload.outcome,
                coverage: checkpoint.coverage.filter((span) => span.scope === request.requiredScope),
            };
        } else if (
            operation === "validation_decision" &&
            request.kind === "decision" &&
            "answer" in envelope.payload &&
            envelope.payload.answer
        ) {
            resume = { kind: "decision", identity: request.identity, answer: envelope.payload.answer };
        } else if (operation === "task_completed" && request.kind === "repair" && "message" in envelope.payload) {
            resume = { kind: "task_completed", identity: request.identity, report: envelope.payload.message };
        } else {
            return await rejected(
                operation,
                rejection("action_superseded", "The supplied outcome does not match the pending worker."),
                current,
            );
        }
    }
    if (operation === "start_validation" && resume) {
        resume = await reconcileConsumedHostResume(current.projectRoot, current.plan.planName, resume);
    }
    if (resume?.kind === "reviewer") {
        try {
            await validateAttachedReviewerCandidate(current, resume);
        } catch (error) {
            return await rejected(
                operation,
                rejection("action_superseded", error instanceof Error ? error.message : String(error)),
                current,
            );
        }
    }
    const claimed: AttachedWorkflowRecord = {
        ...current,
        state: "validating",
        pendingAction: null,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        validation: {
            ...checkpoint,
            resume,
            // A consumed resume can disappear before its original receipt is durable.
            operationId: checkpoint.operationId ?? envelope.operationId,
            operation: checkpoint.operationId ? checkpoint.operation : operation,
            evidence: checkpoint.operationId ? checkpoint.evidence : { ...envelope.evidence, coreVersion: VERSION },
            holder: { pid: process.pid, hostname: getLockHostname(), token: crypto.randomUUID() },
        },
    };
    const claim = await writeAttachedWorkflowRecord(location, claimed, current.revision);
    if (claim.status !== "written") {
        return await rejected(
            operation,
            rejection(
                claim.status === "busy" ? "workflow_busy" : "revision_conflict",
                "Another call changed validation. Read status and retry.",
            ),
        );
    }
    try {
        const result = await continueHostTurnValidation({
            projectRoot: claimed.projectRoot,
            planName: current.plan.planName,
            resume,
        });
        if (result.kind === "failed") {
            const recovered: AttachedWorkflowRecord = {
                ...claimed,
                revision: claimed.revision + 1,
                updatedAt: new Date().toISOString(),
                validation: { coverage: [], resultKind: "failed", reason: result.reason, recovery: result.recovery },
            };
            const written = await writeAttachedWorkflowRecord(location, recovered, claimed.revision);
            return await rejected(
                operation,
                rejection(written.status === "written" ? "invalid_outcome" : "revision_conflict", result.reason),
                recovered,
            );
        }
        const changes: RecordChanges =
            result.kind === "awaiting_delivery"
                ? { state: "reviewed", pendingAction: null, validation: { coverage: [] } }
                : result.kind === "host_request"
                  ? {
                        state: "validating",
                        pendingAction: null,
                        validation: {
                            actionId: createHash("sha256")
                                .update(JSON.stringify(result.request.identity))
                                .digest("hex"),
                            request: result.request,
                            coverage:
                                checkpoint.request &&
                                sameHostIdentity(checkpoint.request.identity, result.request.identity)
                                    ? checkpoint.coverage
                                    : [],
                        },
                    }
                  : {
                        state: "validating",
                        pendingAction: null,
                        validation: {
                            coverage: [],
                            resultKind: result.kind,
                            reason: result.reason,
                            recovery: result.recovery,
                        },
                    };
        const decision = await accept(operation, envelope, claimed, changes);
        // Preserve the original outcome operation's receipt on recovery as well.
        if (decision.next && claimed.validation?.operationId) {
            const receipt = decision.next.acceptedOperations[envelope.operationId];
            decision.next.acceptedOperations[claimed.validation.operationId] = {
                ...receipt,
                result: { ...receipt.result, operation: claimed.validation.operation || operation },
                evidence: claimed.validation.evidence || receipt.evidence,
            };
        }
        return await commit(location, operation, claimed.revision, decision, async (winner) => ({
            result:
                winner.acceptedOperations[envelope.operationId]?.result ??
                (await rejected(
                    operation,
                    rejection("revision_conflict", "Validation changed. Read status to recover."),
                    winner,
                )),
        }));
    } catch (error) {
        const restored: AttachedWorkflowRecord = {
            ...claimed,
            revision: claimed.revision + 1,
            validation:
                error instanceof ValidationHostRejected
                    ? { coverage: [] }
                    : { ...claimed.validation!, holder: undefined },
            updatedAt: new Date().toISOString(),
        };
        await writeAttachedWorkflowRecord(location, restored, claimed.revision);
        return await rejected(
            operation,
            rejection("invalid_outcome", error instanceof Error ? error.message : String(error)),
            restored,
        );
    } finally {
        const token = claimed.validation!.holder!.token!;
        await settleAttachedValidationHolder(location, token);
        await transactAttachedWorkflowRecord(location, claimed.workflowId, (record) => {
            if (record?.validation?.holder?.token !== token) return Promise.resolve({ result: null });
            return Promise.resolve({
                result: null,
                next: {
                    ...record,
                    revision: record.revision + 1,
                    updatedAt: new Date().toISOString(),
                    validation: { ...record.validation, holder: undefined },
                },
            });
        });
    }
}

async function validateAttachedReviewerCandidate(
    record: AttachedWorkflowRecord,
    resume: Extract<import("../workflow/validation-host-contract.ts").ValidationHostResume, { kind: "reviewer" }>,
): Promise<void> {
    if (!record.plan) throw new Error("The Plan is missing.");
    const source = await resolveWorkflowPlanLocation(record.projectRoot, record.plan.planName, {
        migrateRegistry: false,
        readOnly: true,
    });
    if (!source.plan?.attrs.validationCheckpoint) throw new Error("The validation checkpoint is missing.");
    await assertHostReviewerCandidate({
        cwd: source.documentRoot,
        baseBranch: source.plan.attrs.worktreeBaseBranch || "",
        checkpoint: source.plan.attrs.validationCheckpoint,
        triageMeta: source.plan.attrs,
        resume,
    });
}
