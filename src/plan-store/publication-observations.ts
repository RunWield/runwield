import { readControllerRecord, writeControllerState } from "./controllers.ts";
import type { PublicationAttempt } from "@runwield/workflow/publication";
import type { WorkflowControllerState } from "@runwield/plans/controller-state";
import { resolveCollectionEpoch, type JournalResult } from "../shared/workflow/metrics-journal.ts";
import { getWorkflowMetricsCapturePath } from "../shared/workflow/metrics.ts";
import { workflowOutcomeEventId } from "../shared/workflow/outcome-observations.ts";
export type RetainedPublicationCompletion = {
    observation: WorkflowControllerState["publicationObservation"];
    shouldObserve: boolean;
};

/** Read the receipt for an attempt whose registry entry has already been pruned. */
export async function hasRetainedPublicationReceipt(
    projectRoot: string,
    attempt: PublicationAttempt,
): Promise<boolean> {
    const state = (await readControllerRecord(projectRoot, { planId: attempt.planId, planName: attempt.planName }))
        ?.state;
    const receipt = state?.publicationReceipt;
    return Boolean(
        receipt &&
        receipt.validatedCommit === attempt.validatedCommit &&
        receipt.publishedCommit === attempt.publishedCommit &&
        receipt.targetBranch === attempt.targetBranch &&
        state?.verifiedAt === attempt.verifiedAt &&
        (!state?.publicationObservation || state.publicationObservation.attemptId === attempt.attemptId),
    );
}

export async function retainPublicationCompletion(
    projectRoot: string,
    attempt: PublicationAttempt,
): Promise<RetainedPublicationCompletion | null> {
    if (!attempt.verifiedAt) return null;
    const identity = { planId: attempt.planId, planName: attempt.planName };
    const previous = await readControllerRecord(projectRoot, identity);
    const observed = previous?.state.publicationObservation;
    let historyEpoch = observed?.attemptId === attempt.attemptId ? observed.historyEpoch : undefined;
    if (!historyEpoch) {
        try {
            historyEpoch = resolveCollectionEpoch(getWorkflowMetricsCapturePath(projectRoot)).historyEpoch;
        } catch {
            historyEpoch = "unavailable";
        }
    }
    const record = await writeControllerState(projectRoot, identity, {
        verifiedAt: attempt.verifiedAt,
        publicationReceipt: attempt.publishedCommit
            ? {
                  validatedCommit: attempt.validatedCommit,
                  publishedCommit: attempt.publishedCommit,
                  targetBranch: attempt.targetBranch,
              }
            : null,
        updatedAt: attempt.verifiedAt,
        publicationObservation:
            observed?.attemptId === attempt.attemptId && observed.coverage !== "unverified"
                ? observed
                : {
                      attemptId: attempt.attemptId,
                      eventId: workflowOutcomeEventId("publication_confirmed", attempt.attemptId),
                      historyEpoch,
                      // Write the safe fallback before recording. An exception,
                      // deadline, or process death must not leave an apparently
                      // unattempted observation that restart could backfill.
                      coverage: "incomplete",
                      reason: "recording_unconfirmed",
                  },
    });
    return {
        observation: record.state.publicationObservation,
        shouldObserve: observed?.attemptId !== attempt.attemptId,
    };
}

/** Retain only the result for the still-current publication observation, under its revision. */
export async function recordPublicationObservation(
    projectRoot: string,
    attempt: PublicationAttempt,
    result: JournalResult,
    deadline: number,
    priorHistoryEpoch?: string,
): Promise<void> {
    const identity = { planId: attempt.planId, planName: attempt.planName };
    const retained = await readControllerRecord(projectRoot, identity);
    if (Date.now() >= deadline || retained?.state.publicationObservation?.attemptId !== attempt.attemptId) return;
    if (retained.state.publicationObservation.coverage === "complete") return;
    await writeControllerState(
        projectRoot,
        identity,
        {
            publicationObservation: {
                attemptId: attempt.attemptId,
                eventId: workflowOutcomeEventId("publication_confirmed", attempt.attemptId),
                historyEpoch: result.historyEpoch || priorHistoryEpoch,
                coverage: result.persisted ? "complete" : "incomplete",
                ...(result.persisted ? {} : { reason: result.reason || "recording_failed" }),
            },
        },
        { expectedRevision: retained.revision },
    );
}
