import {
    assertExecutionPublicationPolicy,
    assertPackagePublicationReference,
    type ExecutionPublicationPolicy,
    type PackagePublicationReference,
} from "@runwield/plan-storage-format";

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

export type PublicationFailure = {
    phase: PublicationPhase;
    kind: string;
    message: string;
    recordedAt: string;
    repairRoot?: string;
};

export type PublicationAttempt = {
    deliveryMetadataVersion?: 1;
    retainedPublicationPolicy?: ExecutionPublicationPolicy;
    packageInput?: PackagePublicationReference;
    copiesPrepared?: boolean;
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

const PHASE_INDEX = new Map(PUBLICATION_PHASES.map((phase, index) => [phase, index]));

export function publicationPhaseIndex(phase: PublicationPhase): number {
    return Number(PHASE_INDEX.get(phase));
}

/** Check whether the current phase has reached or passed the expected phase. */
export function publicationPhaseAtLeast(current: PublicationPhase, expected: PublicationPhase): boolean {
    return publicationPhaseIndex(current) >= publicationPhaseIndex(expected);
}

export function assertPublicationPhaseEvidence(phase: PublicationPhase, attempt: PublicationAttempt): void {
    if (
        publicationPhaseAtLeast(phase, "artifacts_committed") &&
        (attempt.packageInput
            ? attempt.copiesPrepared !== true || !Array.isArray(attempt.planPaths)
            : !attempt.artifactCommit || !attempt.planPaths?.length)
    ) {
        throw new Error("Publication phase artifacts_committed requires artifactCommit and planPaths.");
    }
    if (
        publicationPhaseAtLeast(phase, "target_integrated") &&
        (!attempt.targetBaseCommit || !attempt.integrationCommit)
    ) {
        throw new Error("Publication phase target_integrated requires targetBaseCommit and integrationCommit.");
    }
    if (publicationPhaseAtLeast(phase, "target_published") && (!attempt.publicationMode || !attempt.publishedCommit)) {
        throw new Error("Publication phase target_published requires publicationMode and publishedCommit.");
    }
    if (publicationPhaseAtLeast(phase, "publication_verified") && !attempt.verifiedAt) {
        throw new Error("Publication phase publication_verified requires verifiedAt.");
    }
    if (phase === "cleanup_complete" && !attempt.cleanedAt) {
        throw new Error("Publication phase cleanup_complete requires cleanedAt.");
    }
}

/** Throw if a publication record is malformed or lacks the evidence required for its phase. */
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
    for (const field of [
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
    ] as const) {
        if (!value[field]) throw new Error(`Publication attempt requires ${field}.`);
    }
    if (value.retainedPublicationPolicy !== undefined)
        assertExecutionPublicationPolicy(value.retainedPublicationPolicy);
    if (value.packageInput !== undefined) {
        assertPackagePublicationReference(value.packageInput);
        if (
            value.deliveryMetadataVersion !== undefined ||
            value.packageInput.planId !== value.planId ||
            value.packageInput.attemptId !== value.attemptId
        )
            throw new Error("Mixed or mismatched package publication evidence.");
    } else if (
        value.copiesPrepared !== undefined ||
        (value.deliveryMetadataVersion !== undefined && value.deliveryMetadataVersion !== 1)
    ) {
        throw new Error("Unknown publication input format.");
    }
    assertPublicationPhaseEvidence(value.phase, value);
    if (value.revalidation) {
        if (
            !["candidate_sealed", "artifacts_committed"].includes(value.phase) ||
            !value.revalidation.sourceHead ||
            !value.revalidation.archiveRoot
        )
            throw new Error("Publication revalidation requires an unpublished snapshot and recovery location.");
    }
}
