import { cleanupStoredPublication } from "./publication-machine.ts";
import { buildVerifiedResult } from "./validation-publication.ts";
import { readPublishedDeliverySources } from "../work-records/published-source.ts";
import type { ValidationLoopArgs } from "./validation-types.ts";
import { completeInPlaceWorkRecord } from "../work-records/in-place-completion.ts";
import { isCommitPublishedToTarget } from "../isolated-publication.ts";
import { resolveWorkflowPlanLocation } from "./plan-location.ts";
import { findActiveByPlanName as findWorktreeByPlanName } from "../worktree-registry.js";
/** Session-free composition. Validation policy remains in the shared attempt owner and engine. */
import { runValidationAttempt } from "./validation-supervisor.ts";
import type { ValidationProgressRecord, ValidationSessionPort, ValidationWorkflowState } from "./validation-ports.ts";
import type { HostTurnValidationResult, ValidationHostResume } from "./validation-host-contract.ts";
import { createGitPort } from "../git-port.ts";
import { getAgentDisplayName } from "./validation-prompts.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";

export type ContinueHostTurnValidationArgs = {
    projectRoot: string;
    planName: string;
    resume?: ValidationHostResume;
};
export type {
    HostTurnValidationResult,
    ValidationHostRequest,
    ValidationHostResume,
} from "./validation-host-contract.ts";

function createHostTurnPort(cwd: string): ValidationSessionPort {
    let workflow: ValidationWorkflowState | null = null;
    let progress: ValidationProgressRecord | undefined;
    const unexpected = () => {
        throw new Error("The engine reached an unsupported host-turn wait.");
    };
    return {
        cwd,
        getActiveWorkflow: () => workflow,
        setActiveWorkflow: (value) => {
            workflow = value;
        },
        rememberPosition() {},
        clearPosition() {},
        getCurrentProgress: () => progress,
        setCurrentProgress: (value) => {
            progress = value;
        },
        emitStatus() {},
        emitAssistantMessage() {},
        requestInteraction: unexpected,
        registerActiveInteraction() {},
        unregisterActiveInteraction() {},
        runIndependentRepairTurn: unexpected,
        continueLastRepairTurn: unexpected,
        runIsolatedAgentSession: unexpected,
        getAgentDisplayName,
        async handoffVerifiedPublication() {},
        runPostVerificationHandoffs: unexpected,
    };
}

export async function continueHostTurnValidation(
    args: ContinueHostTurnValidationArgs,
): Promise<HostTurnValidationResult> {
    const source = await resolveWorkflowPlanLocation(args.projectRoot, args.planName, {
        migrateRegistry: false,
        readOnly: true,
    });
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
    if (
        publication && (publication.phase === "publication_verified" || publication.phase === "cleanup_complete") &&
        publication.publishedCommit &&
        await isCommitPublishedToTarget({
            projectRoot: args.projectRoot,
            targetBranch: publication.targetBranch,
            commit: publication.publishedCommit,
        })
    ) {
        // Cleanup can remove the execution document before saving its final receipt.
        // Resume through the shared machine, using its sealed delivery artifacts.
        const sealed = await readPublishedDeliverySources(args.projectRoot, publication);
        const cleanup = await cleanupStoredPublication(
            args.projectRoot,
            publication,
            SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        );
        const engineArgs: ValidationLoopArgs = {
            planName: args.planName,
            planContent: sealed.delivered.markdown,
            triageMeta: sealed.delivered.attrs,
            session: createHostTurnPort(args.projectRoot),
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
    if (receipt && !await findWorktreeByPlanName(args.projectRoot, args.planName)) {
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
                workRecord: source.plan?.attrs.workRecord,
            };
        }
    }
    const result = await runValidationAttempt({
        projectRoot: args.projectRoot,
        planName: args.planName,
        hostResume: args.resume,
        buildEngineArgs: (claim) => ({
            planName: args.planName,
            planContent: claim.planContent,
            triageMeta: claim.triageMeta,
            session: createHostTurnPort(args.projectRoot),
            git: createGitPort(),
            localCI: {
                run() {
                    throw new Error("Host-turn CI is owned by the engine.");
                },
            },
            workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
            supportsSemanticRepairHandoff: true,
            hostTurn: { resume: args.resume },
        }),
    });
    if (result.kind === "host_request" && result.hostRequest) {
        return { kind: "host_request", request: result.hostRequest };
    }
    if (result.kind === "verified") {
        const delivered = await resolveWorkflowPlanLocation(args.projectRoot, args.planName, {
            migrateRegistry: false,
            readOnly: true,
        });
        return {
            kind: "verified",
            planName: args.planName,
            completionMode: delivered.plan?.attrs.deliveryEvidence?.mode === "non_git_in_place"
                ? "in_place"
                : "publication",
            workRecord: delivered.plan?.attrs.workRecord,
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
export async function reconcileConsumedHostResume(projectRoot: string, planName: string, resume: ValidationHostResume) {
    const { resolveWorkflowPlanLocation } = await import("./plan-location.ts");
    const { sameHostIdentity } = await import("./validation-host-contract.ts");
    const source = await resolveWorkflowPlanLocation(projectRoot, planName, { migrateRegistry: false, readOnly: true });
    const checkpoint = source.plan?.attrs.validationCheckpoint;
    if (resume.kind === "recorder" && checkpoint?.hostRecorder) {
        const recorder = checkpoint.hostRecorder;
        if (recorder.sections || recorder.failure || !sameHostIdentity(recorder.request.identity, resume.identity)) {
            return undefined;
        }
    }
    if (
        !checkpoint || checkpoint.attemptId !== resume.identity.attemptId ||
        checkpoint.generation !== resume.identity.generation
    ) return resume;
    if (resume.kind === "reviewer" && source.plan?.attrs.status === "reviewed") return undefined;
    if (resume.kind === "reviewer") {
        const round = checkpoint.reviewState?.semanticRound || 0;
        if (
            round >= resume.identity.semanticRound || checkpoint.state === "awaiting_repair" ||
            (checkpoint.hostReview?.semanticRound === resume.identity.semanticRound &&
                checkpoint.hostReview.correctionCount > resume.identity.correctionCount)
        ) return undefined;
    }
    if (resume.kind === "task_completed" && checkpoint.lastSettledOperationId === resume.identity.repairGeneration) {
        return undefined;
    }
    if (
        resume.kind === "decision" &&
        (!checkpoint.pendingHostDecision || !sameHostIdentity(checkpoint.pendingHostDecision.identity, resume.identity))
    ) return undefined;
    return resume;
}
