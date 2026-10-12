/** Content-free observations of actual workflow operations, never delivery authority. */
import { createHash } from "node:crypto";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { planAssociationAtTime } from "../session/plan-association.ts";
import { findById } from "../worktree-registry.js";
import { recordWorkflowMetric } from "./metrics.js";

export interface OutcomeSession {
    runwieldSessionId: string;
    currentSegmentId?: string;
}

export interface WorkflowOutcome {
    event: string;
    category: "validation" | "recovery" | "execution";
    operationId: string;
    outcome: string;
    planId?: string;
    planKind?: string;
    historyEpoch?: string;
    attemptId?: string;
    transitionId?: string;
    roundId?: string;
    attempt?: number;
    round?: number;
    phase?: string;
    initialFindingCount?: number;
    missedOriginalCount?: number;
    repairRegressionCount?: number;
    unclassifiedNewCount?: number;
    existingStillOpenCount?: number;
    fixConfirmedCount?: number;
    findingCount?: number;
    advisoryCount?: number;
    elapsedMs?: number;
    planName?: string;
    session?: OutcomeSession | null;
    ts?: string;
    persistenceDeadline?: number;
}

/** Same committed operation has the same identity after restart. */
export function workflowOutcomeEventId(event: string, operationId: string): string {
    const identity = `${event}:${operationId}`;
    return identity.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(identity)
        ? identity
        : `${event}:${createHash("sha256").update(operationId).digest("hex")}`;
}

export async function recordWorkflowOutcome(cwd: string, observation: WorkflowOutcome) {
    const ts = observation.ts || new Date().toISOString();
    const { session, planName, ...fields } = observation;
    let planId: string | undefined = observation.planId;
    try {
        if (!planId && session?.currentSegmentId) {
            const store = openFileSessionStore();
            try {
                planId = planAssociationAtTime(
                    store.listSessionPlanAssociations(session.runwieldSessionId),
                    store.listSessionTranscriptSegments(session.runwieldSessionId),
                    { segmentId: session.currentSegmentId, ts, planName },
                )?.planId;
            } finally {
                store.close();
            }
        } else if (!planId && observation.attemptId) {
            const entry = await findById(cwd, observation.attemptId, { migrate: false });
            if (entry && Date.parse(entry.createdAt) <= Date.parse(ts) && (!planName || entry.planName === planName)) {
                planId = entry.planId;
            }
        }
    } catch { /* Missing attribution does not invent a Plan relationship. */ }
    if (observation.persistenceDeadline && Date.now() >= observation.persistenceDeadline) {
        return { persisted: false, reason: "lock_timeout" };
    }
    return await recordWorkflowMetric({
        ...fields,
        ts,
        v: 2,
        eventId: workflowOutcomeEventId(observation.event, observation.operationId),
        recorderId: createHash("sha256").update(workflowOutcomeEventId(observation.event, observation.operationId))
            .digest("hex"),
        seq: 0,
        ...(planId ? { planId } : {}),
        ...(session ? { managedSessionId: session.runwieldSessionId, segmentId: session.currentSegmentId } : {}),
    }, cwd);
}
