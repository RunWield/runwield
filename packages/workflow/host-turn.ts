import {
    readPlanPublicationReference,
    readPublishedDeliverySources,
    requiresPlanWorkflow,
    resolveWorkflowPlanLocation,
    withLocalPlanWorkflow,
} from "../../src/plan-store/index.ts";
import { createGitPort } from "../../src/shared/git-port.ts";
import { isCommitPublishedToTarget } from "../../src/shared/isolated-publication.ts";
import { completeInPlaceWorkRecord } from "../../src/shared/work-records/in-place-completion.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../../src/shared/work-records/mnemoteca-port.ts";
import { findActiveByPlanName as findWorktreeByPlanName } from "../../src/shared/worktree-registry.ts";
import { createHostTurnPort } from "../../src/shared/workflow/validation-host-composition.ts";
import {
    sameHostIdentity,
    ValidationHostRejected,
    type HostTurnValidationResult,
    type ValidationHostResume,
} from "./host-contract.ts";
import { assertHostReviewerCandidate } from "../../src/shared/workflow/validation-host-state.ts";
import { buildVerifiedResult } from "../../src/shared/workflow/validation-publication.ts";
import { runValidationAttempt } from "../../src/shared/workflow/validation-supervisor.ts";
import type { ValidationLoopArgs } from "../../src/shared/workflow/validation-types.ts";
import { cleanupStoredPublication } from "./publication-machine.ts";

type ContinueHostTurnValidationArgs = {
    projectRoot: string;
    planName: string;
    expectedPlanId?: string;
    resume?: ValidationHostResume;
    signal?: AbortSignal;
};

export async function continueHostTurnValidation(
    args: ContinueHostTurnValidationArgs,
): Promise<HostTurnValidationResult> {
    if (requiresPlanWorkflow(args.projectRoot))
        return await withLocalPlanWorkflow(
            args.projectRoot,
            args.planName,
            () => continueHostTurnValidation(args),
            args.expectedPlanId,
        );
    const source = await resolveWorkflowPlanLocation(args.projectRoot, args.planName, {
        readOnly: true,
    });
    if (args.expectedPlanId && source.plan && source.plan.attrs.planId !== args.expectedPlanId)
        throw new ValidationHostRejected("Plan selection does not match the requested Plan.");

    if (source.plan?.attrs.status === "verified" && source.plan.attrs.deliveryEvidence?.mode === "non_git_in_place") {
        await completeInPlaceWorkRecord(source.documentRoot, args.planName, SYSTEM_WORK_RECORD_MNEMOTECA_PORT);
        return {
            kind: "verified",
            planName: args.planName,
            completionMode: "in_place",
            workRecord: source.plan.attrs.workRecord,
        };
    }
    const registered = await findWorktreeByPlanName(args.projectRoot, args.planName);
    const publication = registered?.publication;
    if (args.expectedPlanId && publication && publication.planId !== args.expectedPlanId)
        throw new ValidationHostRejected("Publication does not match the requested Plan.");

    if (
        publication &&
        (publication.phase === "publication_verified" || publication.phase === "cleanup_complete") &&
        publication.publishedCommit &&
        (await isCommitPublishedToTarget({
            projectRoot: args.projectRoot,
            targetBranch: publication.targetBranch,
            commit: publication.publishedCommit,
        }))
    ) {
        // Cleanup can remove the execution document before saving its final receipt.
        // Resume through the shared machine, using its sealed delivery artifacts.
        const cleanup = await cleanupStoredPublication(
            args.projectRoot,
            publication,
            SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        );
        const sealed = await readPublishedDeliverySources(args.projectRoot, cleanup.attempt);
        const engineArgs: ValidationLoopArgs = {
            planName: args.planName,
            planContent: sealed.delivered.markdown,
            triageMeta: sealed.delivered.attrs,
            session: createHostTurnPort(args.projectRoot, args.signal),
            git: createGitPort(),
            localCI: {
                run() {
                    throw new Error("Proven publication does not rerun CI.");
                },
            },
            workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        };
        await buildVerifiedResult(engineArgs, args.projectRoot, undefined, publication.targetBranch, cleanup.attempt);
        return {
            kind: "verified",
            planName: args.planName,
            completionMode: "publication",
            workRecord: sealed.workRecordOwner?.attrs.workRecord,
        };
    }
    const receipt = source.plan?.attrs.publicationReceipt;
    if (receipt && !(await findWorktreeByPlanName(args.projectRoot, args.planName))) {
        const proven = await isCommitPublishedToTarget({
            projectRoot: args.projectRoot,
            targetBranch: receipt.targetBranch,
            commit: receipt.publishedCommit,
        });
        if (proven) {
            return {
                kind: "verified",
                planName: args.planName,
                completionMode: "publication",
                workRecord: (
                    await readPublishedDeliverySources(args.projectRoot, {
                        artifactCommit: receipt.publishedCommit,
                        planName: args.planName,
                        planId: source.plan!.attrs.planId!,
                        phase: "publication_verified",
                        packageInput: await readPlanPublicationReference(args.projectRoot, args.planName),
                    })
                ).workRecordOwner?.attrs.workRecord,
            };
        }
    }
    const result = await runValidationAttempt({
        projectRoot: args.projectRoot,
        planName: args.planName,
        hostResume: args.resume,
        runtime: { kind: "host", signal: args.signal },
    });
    if (result.kind === "host_request" && result.hostRequest) {
        return { kind: "host_request", request: result.hostRequest };
    }
    if (result.kind === "verified") {
        const delivered = await resolveWorkflowPlanLocation(args.projectRoot, args.planName, {
            readOnly: true,
        });
        return {
            kind: "verified",
            planName: args.planName,
            completionMode:
                delivered.plan?.attrs.deliveryEvidence?.mode === "non_git_in_place" ? "in_place" : "publication",
            workRecord: result.workRecord,
        };
    }
    return {
        kind: result.kind === "failed" ? "failed" : "paused",
        reason: result.reason || "Validation paused.",
        recovery: result.recovery,
    };
}

/** Reconcile a durable host claim after Core ran but the carrier lost its final write.
 * Only checkpoint evidence of consumption permits dropping the old outcome.
 */
export async function reconcileConsumedHostResume(
    projectRoot: string,
    planName: string,
    resume: ValidationHostResume,
    expectedPlanId?: string,
): Promise<ValidationHostResume | undefined> {
    if (requiresPlanWorkflow(projectRoot))
        return await withLocalPlanWorkflow(
            projectRoot,
            planName,
            () => reconcileConsumedHostResume(projectRoot, planName, resume, expectedPlanId),
            expectedPlanId,
        );
    const source = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
    if (expectedPlanId && source.plan && source.plan.attrs.planId !== expectedPlanId)
        throw new ValidationHostRejected("Plan selection does not match the requested Plan.");
    const checkpoint = source.plan?.attrs.validationCheckpoint;
    if (resume.kind === "recorder" && checkpoint?.hostRecorder) {
        const recorder = checkpoint.hostRecorder;
        if (recorder.sections || recorder.failure || !sameHostIdentity(recorder.request.identity, resume.identity)) {
            return undefined;
        }
    }
    if (
        !checkpoint ||
        checkpoint.attemptId !== resume.identity.attemptId ||
        checkpoint.generation !== resume.identity.generation
    )
        return resume;
    if (resume.kind === "reviewer" && source.plan?.attrs.status === "reviewed") return undefined;
    if (resume.kind === "reviewer") {
        const round = checkpoint.reviewState?.semanticRound || 0;
        if (
            round >= resume.identity.semanticRound ||
            checkpoint.state === "awaiting_repair" ||
            (checkpoint.hostReview?.semanticRound === resume.identity.semanticRound &&
                checkpoint.hostReview.correctionCount > resume.identity.correctionCount)
        )
            return undefined;
    }
    if (
        resume.kind === "task_completed" &&
        checkpoint.lastSettledOperationId === resume.identity.repairGeneration &&
        !checkpoint.pendingHostDecision
    ) {
        return undefined;
    }
    if (
        resume.kind === "decision" &&
        (!checkpoint.pendingHostDecision || !sameHostIdentity(checkpoint.pendingHostDecision.identity, resume.identity))
    )
        return undefined;
    return resume;
}

/** Check the recorded review candidate before the caller persists a claim. */
export async function assertCurrentHostReviewerCandidate(
    projectRoot: string,
    planName: string,
    resume: Extract<ValidationHostResume, { kind: "reviewer" }>,
    expectedPlanId?: string,
): Promise<void> {
    if (requiresPlanWorkflow(projectRoot))
        return await withLocalPlanWorkflow(
            projectRoot,
            planName,
            () => assertCurrentHostReviewerCandidate(projectRoot, planName, resume, expectedPlanId),
            expectedPlanId,
        );
    const source = await resolveWorkflowPlanLocation(projectRoot, planName, { readOnly: true });
    const attrs = source.plan?.attrs;
    if (!attrs?.validationCheckpoint) throw new Error("The validation checkpoint is missing.");
    if (expectedPlanId && attrs.planId !== expectedPlanId)
        throw new ValidationHostRejected("Plan selection does not match the requested Plan.");
    const entry = await findWorktreeByPlanName(projectRoot, planName);
    await assertHostReviewerCandidate({
        cwd: attrs.worktreePath || source.documentRoot,
        baseBranch: attrs.worktreeBaseBranch || "",
        baseRef: entry?.baseRef,
        checkpoint: attrs.validationCheckpoint,
        triageMeta: attrs,
        resume,
    });
}
