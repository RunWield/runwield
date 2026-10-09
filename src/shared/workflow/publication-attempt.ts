/**
 * Durable authority for publishing one validated execution attempt.
 *
 * Plan status answers whether validation succeeded. This record answers whether
 * the validated commits reached their target branch and whether RunWield cleaned
 * up the execution attempt. Every phase names a fact that Git can prove after a
 * process restart; transient verbs such as "merging" are deliberately absent.
 */

export const PUBLICATION_ATTEMPT_VERSION = 1;

export const PUBLICATION_PHASES = [
    "candidate_sealed",
    "artifacts_committed",
    "target_integrated",
    "target_published",
    "publication_verified",
    "cleanup_complete",
] as const;

export type PublicationPhase = (typeof PUBLICATION_PHASES)[number];

/** Published attempts retain cleanup evidence, not ownership of an execution document. */
export function isPublicationCleanupPending(attempt: PublicationAttempt | undefined): boolean {
    return attempt?.phase === "publication_verified" || attempt?.phase === "cleanup_complete";
}

export type PublicationFailure = {
    phase: PublicationPhase;
    kind: string;
    message: string;
    recordedAt: string;
    repairRoot?: string;
};

export type PublicationAttempt = {
    deliveryMetadataVersion?: 1;
    version: 1;
    revision: number;
    phase: PublicationPhase;
    attemptId: string;
    planId: string;
    planName: string;
    targetBranch: string;
    executionBranch: string;
    executionCwd: string;
    publicationRoot: string;
    validatedCommit: string;
    targetHeadAtSeal: string;
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
    failure?: PublicationFailure;
    /** Durable intent to retire an unpublished snapshot before checking current files. */
    revalidation?: PublicationRevalidation;
    createdAt: string;
    updatedAt: string;
};

export type PublicationRevalidation = {
    sourceHead: string;
    archiveRoot: string;
};

export type PublicationPhaseEvidence = {
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

const PHASE_INDEX = new Map(PUBLICATION_PHASES.map((phase, index) => [phase, index]));

export function publicationPhaseAtLeast(current: PublicationPhase, expected: PublicationPhase): boolean {
    return Number(PHASE_INDEX.get(current)) >= Number(PHASE_INDEX.get(expected));
}

export function isPublicationAttemptCleanupComplete(attempt: PublicationAttempt): boolean {
    assertPublicationAttempt(attempt);
    return attempt.phase === "cleanup_complete" && !attempt.failure?.repairRoot;
}

export function createPublicationAttempt(args: {
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
}): PublicationAttempt {
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

function assertPhaseEvidence(phase: PublicationPhase, attempt: PublicationAttempt): void {
    if (
        publicationPhaseAtLeast(phase, "artifacts_committed") &&
        (!attempt.artifactCommit || !attempt.planPaths?.length)
    ) {
        throw new Error("Publication phase artifacts_committed requires artifactCommit and planPaths.");
    }
    if (
        publicationPhaseAtLeast(phase, "target_integrated") &&
        (!attempt.targetBaseCommit || !attempt.integrationCommit)
    ) {
        throw new Error("Publication phase target_integrated requires targetBaseCommit and integrationCommit.");
    }
    if (
        publicationPhaseAtLeast(phase, "target_published") &&
        (!attempt.publicationMode || !attempt.publishedCommit)
    ) {
        throw new Error("Publication phase target_published requires publicationMode and publishedCommit.");
    }
    if (publicationPhaseAtLeast(phase, "publication_verified") && !attempt.verifiedAt) {
        throw new Error("Publication phase publication_verified requires verifiedAt.");
    }
    if (phase === "cleanup_complete" && !attempt.cleanedAt) {
        throw new Error("Publication phase cleanup_complete requires cleanedAt.");
    }
}

export function advancePublicationAttempt(
    current: PublicationAttempt,
    phase: PublicationPhase,
    evidence: PublicationPhaseEvidence,
    now = new Date().toISOString(),
): PublicationAttempt {
    const currentIndex = Number(PHASE_INDEX.get(current.phase));
    const nextIndex = Number(PHASE_INDEX.get(phase));
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
    assertPhaseEvidence(phase, next);
    return next;
}

export function recordPublicationFailure(
    current: PublicationAttempt,
    failure: Omit<PublicationFailure, "phase" | "recordedAt"> & { phase?: PublicationPhase; recordedAt?: string },
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

export function assertPublicationAttempt(value: PublicationAttempt): void {
    if (value.version !== PUBLICATION_ATTEMPT_VERSION) {
        throw new Error(`Unsupported publication attempt version: ${String(value.version)}.`);
    }
    if (!PUBLICATION_PHASES.includes(value.phase)) {
        throw new Error(`Unsupported publication phase: ${String(value.phase)}.`);
    }
    if (!Number.isInteger(value.revision) || value.revision < 1) {
        throw new Error("Publication attempt revision must be a positive integer.");
    }
    for (
        const field of [
            "attemptId",
            "planId",
            "planName",
            "targetBranch",
            "executionBranch",
            "executionCwd",
            "publicationRoot",
            "validatedCommit",
            "targetHeadAtSeal",
            "createdAt",
            "updatedAt",
        ] as const
    ) {
        if (!value[field]) throw new Error(`Publication attempt requires ${field}.`);
    }
    assertPhaseEvidence(value.phase, value);
    if (value.revalidation) {
        if (
            !["candidate_sealed", "artifacts_committed"].includes(value.phase) ||
            !value.revalidation.sourceHead || !value.revalidation.archiveRoot
        ) throw new Error("Publication revalidation requires an unpublished snapshot and recovery location.");
    }
}
