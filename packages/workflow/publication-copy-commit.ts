import type { PublicationCopyEvidence } from "@runwield/plans/publication-copies";
import { publicationCopiesForCheckout } from "../../src/plan-store/index.ts";
import { checkpointExecutionWorktree } from "../../src/shared/worktree.ts";
import type { PublicationAttempt } from "./publication-attempt.ts";

/** Commit only the repository copies retained by Plans. */
export async function preparePublicationCopies(
    root: string,
    attempt: PublicationAttempt,
): Promise<PublicationCopyEvidence> {
    const copies = publicationCopiesForCheckout(root);
    const materialized = await copies.materialize(attempt);
    if (materialized.kind === "committed") return materialized.evidence;
    const result = await checkpointExecutionWorktree({
        worktreePath: attempt.executionCwd,
        branch: attempt.executionBranch,
        planName: attempt.planName,
        mergeTargetRef: attempt.targetHeadAtSeal,
        publicationAttemptId: attempt.attemptId,
        publicationPlanPaths: materialized.paths,
    });
    const evidence = await publicationCopiesForCheckout(attempt.executionCwd).verifyCandidate(
        attempt,
        result.executionCommit,
    );
    if (!evidence) throw new Error("Delivery copies do not match the frozen input.");
    return evidence;
}
