import {
    PUBLICATION_ATTEMPT_VERSION,
    assertPublicationAttempt,
    assertPublicationPhaseEvidence,
    publicationPhaseIndex,
    type PublicationAttempt,
    type PublicationFailure,
    type PublicationPhase,
} from "@runwield/project-runtime/publication-evidence";

export {
    PUBLICATION_ATTEMPT_VERSION,
    PUBLICATION_PHASES,
    assertPublicationAttempt,
    publicationPhaseAtLeast,
    type PublicationAttempt,
    type PublicationFailure,
    type PublicationPhase,
    type PublicationRevalidation,
} from "@runwield/project-runtime/publication-evidence";

/** Published attempts retain cleanup evidence, not ownership of an execution document. */
export function isPublicationCleanupPending(attempt: PublicationAttempt | undefined): boolean {
    return attempt?.phase === "publication_verified" || attempt?.phase === "cleanup_complete";
}

export type PublicationFailureInput = Omit<PublicationFailure, "phase" | "recordedAt"> & {
    phase?: PublicationPhase;
    recordedAt?: string;
};

export type PublicationPhaseEvidence = {
    copiesPrepared?: boolean;
    artifactCommit?: string;
    planPaths?: string[];
    targetBaseCommit?: string;
    integrationCommit?: string;
    publicationMode?: "local" | "remote";
    publishedCommit?: string;
    upstreamRemote?: string;
    upstreamBranch?: string;
    verifiedAt?: string;
    cleanedAt?: string;
};

/** Check for completed cleanup with no repair checkout left on record. */
export function isPublicationAttemptCleanupComplete(attempt: PublicationAttempt): boolean {
    assertPublicationAttempt(attempt);
    return attempt.phase === "cleanup_complete" && !attempt.failure?.repairRoot;
}

export type CreatePublicationAttemptInput = {
    attemptId: string;
    planId: string;
    planName: string;
    targetBranch: string;
    executionBranch: string;
    executionCwd: string;
    publicationRoot: string;
    validatedCommit: string;
    targetHeadAtSeal: string;
    now?: string;
};

/** Build the initial record for a validated commit and its intended Git target. */
export function createPublicationAttempt(args: CreatePublicationAttemptInput): PublicationAttempt {
    const now = args.now || new Date().toISOString();
    for (const [name, value] of Object.entries(args)) {
        if (name === "now") continue;
        if (typeof value !== "string" || !value) throw new Error(`Publication attempt requires ${name}.`);
    }
    return {
        version: PUBLICATION_ATTEMPT_VERSION,
        revision: 1,
        phase: "candidate_sealed",
        attemptId: args.attemptId,
        planId: args.planId,
        planName: args.planName,
        targetBranch: args.targetBranch,
        executionBranch: args.executionBranch,
        executionCwd: args.executionCwd,
        publicationRoot: args.publicationRoot,
        validatedCommit: args.validatedCommit,
        targetHeadAtSeal: args.targetHeadAtSeal,
        createdAt: now,
        updatedAt: now,
    };
}

/** Build the next revision, validating evidence for the current or immediately following phase. */
export function advancePublicationAttempt(
    current: PublicationAttempt,
    phase: PublicationPhase,
    evidence: PublicationPhaseEvidence,
    now = new Date().toISOString(),
): PublicationAttempt {
    const currentIndex = publicationPhaseIndex(current.phase);
    const nextIndex = publicationPhaseIndex(phase);
    if (nextIndex < currentIndex) {
        throw new Error(`Publication cannot move backward from ${current.phase} to ${phase}.`);
    }
    if (nextIndex > currentIndex + 1) {
        throw new Error(`Publication cannot skip from ${current.phase} to ${phase}.`);
    }
    const next: PublicationAttempt = {
        ...current,
        ...evidence,
        phase,
        revision: current.revision + 1,
        updatedAt: now,
    };
    delete next.failure;
    assertPublicationPhaseEvidence(phase, next);
    return next;
}

/** Build a new revision with the failure details and any checkout retained for repair. */
export function recordPublicationFailure(
    current: PublicationAttempt,
    failure: PublicationFailureInput,
    now = new Date().toISOString(),
): PublicationAttempt {
    return {
        ...current,
        revision: current.revision + 1,
        failure: {
            phase: failure.phase || current.phase,
            kind: failure.kind,
            message: failure.message,
            recordedAt: failure.recordedAt || now,
            ...(failure.repairRoot ? { repairRoot: failure.repairRoot } : {}),
        },
        updatedAt: now,
    };
}
