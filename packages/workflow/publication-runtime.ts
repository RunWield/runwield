import type { PackagePublicationManifest } from "@runwield/plans/store";
import type { PublicationCopyEvidence } from "@runwield/plans/publication-copies";
import {
    selectedPublicationCopies,
    withPlanPublication,
    type RetainedManagedExecution,
} from "../../src/plan-store/index.ts";
import type { WorkRecordMnemotecaPort } from "../../src/shared/work-records/mnemoteca-port.ts";
import { withWorktreeRegistryLock } from "../../src/shared/worktree-registry.ts";
import type {
    PublicationAttempt,
    PublicationFailureInput,
    PublicationPhase,
    PublicationPhaseEvidence,
} from "./publication-attempt.ts";
import { preparePublicationCopies } from "./publication-copy-commit.ts";
import {
    advanceStoredPublication,
    assertPublicationSourceCheckout,
    cleanupStoredPublication,
    failStoredPublication,
    loadPublicationAttempt,
    proveManagedPublication,
    proveRetainedManagedPublication,
    publicationRootForAttempt,
    publishedWorkRecordFailed,
    readPublicationForResume,
    reconcileStoredPublication,
    startPublicationAttempt,
    type PublicationCleanupResult,
    type PublicationReconcileOptions,
    type StartPublicationAttemptInput,
} from "./publication-machine.ts";
import { preparePublicationRevalidation, prepareReviewedCandidateRevalidation } from "./publication-revalidation.ts";

export type { PublicationCleanupResult, PublicationReconcileOptions } from "./publication-machine.ts";
export { CANDIDATE_REVALIDATION_MESSAGE, PUBLICATION_REVALIDATION_MESSAGE } from "./publication-revalidation.ts";

export type PublicationStart = Omit<StartPublicationAttemptInput, "projectRoot" | "attemptId">;

export type PublicationEffectPhase = Exclude<PublicationPhase, "publication_verified" | "cleanup_complete">;
export type PublicationEffectEvidence = Omit<PublicationPhaseEvidence, "verifiedAt" | "cleanedAt">;

const EFFECT_FIELDS: Record<PublicationEffectPhase, ReadonlySet<string>> = {
    candidate_sealed: new Set(),
    artifacts_committed: new Set(["artifactCommit", "planPaths", "copiesPrepared"]),
    target_integrated: new Set(["targetBaseCommit", "integrationCommit"]),
    target_published: new Set([
        "targetBaseCommit",
        "integrationCommit",
        "publicationMode",
        "publishedCommit",
        "upstreamRemote",
        "upstreamBranch",
    ]),
};

/** Locates a publication by execution attempt ID, including before its first record exists. */
export interface PublicationAttemptReference {
    /** Read the attempt's publication record, or return null if none exists. */
    load(): Promise<PublicationAttempt | null>;
    /** Seal the validated candidate for delivery or reopen its matching publication record. */
    start(input: PublicationStart): Promise<PublicationAttempt>;
    /** Return the path reserved for this attempt's publication checkout. */
    stagingRoot(): string;
}

/** Actions on a recorded revision. Mutations return the recorded attempt for the next action. */
export interface RecordedPublicationAttempt {
    /** Record the Git evidence for a publication phase against this revision. */
    advance(phase: PublicationEffectPhase, evidence: PublicationEffectEvidence): Promise<PublicationAttempt>;
    /** Check the recorded delivery against its Git target and return the verified attempt, or throw. */
    verify(): Promise<PublicationAttempt>;
    /** Recover missed phase updates from Git evidence. Pass `apply: false` to preview them. */
    reconcile(options?: PublicationReconcileOptions): Promise<PublicationAttempt>;
    /** Save failure details for this revision, or return the newer record if the attempt has advanced. */
    recordFailure(failure: Omit<PublicationFailureInput, "recordedAt">): Promise<PublicationAttempt>;
    /** Materialize and verify the frozen repository copies, reusing their commit when available. */
    prepareCopies(): Promise<PublicationCopyEvidence>;
    /** Prepare the frozen copies and record their evidence in the artifacts-committed phase. */
    commitCopies(): Promise<PublicationAttempt>;
    /** Clean up a verified delivery and report any worktree, branch, or files that were kept. */
    cleanup(workRecordMnemotecaPort?: WorkRecordMnemotecaPort): Promise<PublicationCleanupResult>;
    /** Read the sealed delivery to check whether Work Record generation failed. */
    workRecordFailed(): Promise<boolean>;
}

/** Selects the evidence to check for a retained execution and any prior confirmation to use after pruning. */
export interface RetainedPublicationProofOptions {
    confirmed?: PublicationAttempt;
    candidateOnly?: boolean;
    requireCleanup?: boolean;
}

/** Manages delivery attempts and checks their Git evidence within one project. */
export interface Publication {
    /** Look up a publication by execution attempt ID to load or start it. */
    attempt(attemptId: string): PublicationAttemptReference;
    /** Bind publication operations to the revision in a previously read attempt. */
    resume(record: PublicationAttempt): RecordedPublicationAttempt;
    /** Restart validation for a changed candidate before integration. Return its archive path, or null if no reset ran. */
    revalidate(planName: string): Promise<string | null>;
    /** Restart validation if the reviewed candidate changed before publication. Return true when validation restarts. */
    revalidateReviewedCandidate(planName: string): Promise<boolean>;
    /** Verify Git delivery against the managed execution's frozen publication manifest. */
    verifyManaged(manifest: PackagePublicationManifest, retained?: PublicationAttempt): Promise<PublicationAttempt>;
    /** Check a retained execution's candidate or published target, with optional cleanup verification. */
    verifyRetained(
        execution: RetainedManagedExecution,
        options: RetainedPublicationProofOptions,
    ): Promise<PublicationAttempt>;
}

/** Open publication operations for a project's checkout. */
export function openPublication(projectRoot: string): Publication {
    return {
        attempt(attemptId) {
            return {
                load: () => loadPublicationAttempt(projectRoot, attemptId),
                start: (input) => startPublicationAttempt({ ...input, projectRoot, attemptId }),
                stagingRoot: () => publicationRootForAttempt(projectRoot, attemptId),
            };
        },
        resume(snapshot) {
            const current = (allowRetained = false) => readPublicationForResume(projectRoot, snapshot, allowRetained);
            const prepareCopies = async () => {
                await current();
                return await withWorktreeRegistryLock(projectRoot, async () => {
                    const { record } = await current();
                    if (record.revision !== snapshot.revision) {
                        throw new Error("Publication changed before its copies were prepared.");
                    }
                    if (record.phase !== "candidate_sealed" || record.revalidation || !record.packageInput) {
                        throw new Error("Publication copies require a current sealed candidate.");
                    }
                    await selectedPublicationCopies.assertOwner(record);
                    await assertPublicationSourceCheckout(projectRoot, record);
                    return { record, evidence: await preparePublicationCopies(projectRoot, record) };
                });
            };
            return {
                async advance(phase, evidence) {
                    if (!Object.hasOwn(EFFECT_FIELDS, phase))
                        throw new Error(`Publication phase ${phase} must be recorded by verification or cleanup.`);
                    if (Object.keys(evidence).some((key) => !EFFECT_FIELDS[phase].has(key)))
                        throw new Error(`Unexpected evidence for publication phase ${phase}.`);
                    return await advanceStoredPublication(
                        projectRoot,
                        (await current()).record,
                        phase,
                        evidence,
                        snapshot.revision,
                    );
                },
                async verify() {
                    const { record } = await current(true);
                    const verified = await reconcileStoredPublication(projectRoot, record);
                    if (verified.phase !== "publication_verified" && verified.phase !== "cleanup_complete")
                        throw new Error("Publication could not be verified on its target.");
                    return verified;
                },
                async reconcile(options) {
                    return await reconcileStoredPublication(projectRoot, (await current(true)).record, options);
                },
                async recordFailure(failure) {
                    const { record } = await current();
                    return record.revision === snapshot.revision
                        ? await failStoredPublication(projectRoot, record, failure)
                        : record;
                },
                async prepareCopies() {
                    return (await prepareCopies()).evidence;
                },
                async commitCopies() {
                    const { record } = await current();
                    return await withPlanPublication(projectRoot, record.planName, async () => {
                        const { record: sealed, evidence } = await prepareCopies();
                        return await advanceStoredPublication(projectRoot, sealed, "artifacts_committed", evidence);
                    });
                },
                async cleanup(workRecordMnemotecaPort) {
                    const { record, registered } = await current(true);
                    return await cleanupStoredPublication(projectRoot, record, workRecordMnemotecaPort, registered);
                },
                async workRecordFailed() {
                    return await publishedWorkRecordFailed(projectRoot, (await current(true)).record);
                },
            };
        },
        revalidate: (planName) => preparePublicationRevalidation(projectRoot, planName),
        revalidateReviewedCandidate: (planName) => prepareReviewedCandidateRevalidation(projectRoot, planName),
        verifyManaged: (manifest, retained) => proveManagedPublication(projectRoot, manifest, retained),
        verifyRetained: (execution, options) =>
            proveRetainedManagedPublication(
                projectRoot,
                execution,
                options.confirmed,
                options.candidateOnly,
                options.requireCleanup,
            ),
    };
}
