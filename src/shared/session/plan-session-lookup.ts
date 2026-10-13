/**
 * @module shared/session/plan-session-lookup
 * Reverse lookup from a durable Plan ID to Sessions that recorded that Plan.
 */

import { dirname } from "node:path";
import type { FileSessionStore, ManifestPlanAssociation } from "./file-session-store-types.ts";
import { projectAggregateTranscript } from "./session-transcript-manifest.ts";

export interface PlanAssociatedSession {
    runwieldSessionId: string;
    displayName: string | null;
    archivedAt: string | null;
    piSessionId: string;
    transcriptPath: string;
    associations: ManifestPlanAssociation[];
    latestPurpose: ManifestPlanAssociation["purpose"];
    currentSegmentKind: string;
    activationState: string;
    activeSurface: string | null;
    safePlanningResume: boolean;
    reason: string | null;
}

function reasonForCandidate(activationState: string, currentSegmentKind: string, latestPurpose: string): string | null {
    if (activationState !== "idle") {
        if (activationState === "active") return "active_elsewhere";
        if (activationState === "uncertain" || activationState === "reconcile_required") return activationState;
        return "non_idle";
    }
    if (currentSegmentKind === "execution") return "execution_segment";
    if (currentSegmentKind === "semantic_repair") return "semantic_repair_segment";
    if (currentSegmentKind !== "planning") return "non_planning_segment";
    if (latestPurpose !== "planning" && latestPurpose !== "review") return "non_planning_purpose";
    return null;
}

export async function findPlanAssociatedSessions(
    sessionStore: FileSessionStore,
    { cwd, planId }: { cwd: string; planId: string },
): Promise<PlanAssociatedSession[]> {
    const project = sessionStore.ensureRuntimeProject({ root: cwd });
    const listedSessions: Awaited<ReturnType<FileSessionStore["listProjectSessions"]>>["sessions"] = [];
    for (let page = 0;; page += 1) {
        const listed = await sessionStore.listProjectSessions(project.projectId, {
            catalog: false,
            archiveState: "all",
            page,
            pageSize: 100,
        });
        listedSessions.push(...listed.sessions);
        if (!listed.hasNext) break;
    }
    const candidates: PlanAssociatedSession[] = [];
    for (const session of listedSessions) {
        const associations = (session.planAssociations || sessionStore.listSessionPlanAssociations(
            session.runwieldSessionId,
            project.projectId,
        )).filter((association) => association.planId === planId && association.committedGeneration !== null);
        const latest = associations.at(-1);
        if (!latest) continue;
        const currentSegment = sessionStore.getCurrentSessionSegment(session.runwieldSessionId);
        const activation = sessionStore.inspectSessionActivation(session.runwieldSessionId);
        const activationState = activation.activation?.state || "unknown";
        const currentSegmentKind = currentSegment?.kind || "session";
        const reason = reasonForCandidate(activationState, currentSegmentKind, latest.purpose);
        let displayName = session.displayName?.trim() || null;
        if (activation.generation) {
            const projection = await projectAggregateTranscript({
                runwieldSessionId: session.runwieldSessionId,
                cwd: session.transcriptCwd,
                sessionDir: dirname(session.transcriptPath),
                generation: activation.generation,
                segments: sessionStore.listSessionTranscriptSegments(session.runwieldSessionId),
            });
            if (projection.ok) {
                const { name, firstMessage } = projection.snapshot;
                displayName = (typeof name === "string" ? name.trim() : "") ||
                    (typeof firstMessage === "string" ? firstMessage.trim() : "") || null;
            }
        }
        candidates.push({
            runwieldSessionId: session.runwieldSessionId,
            displayName,
            archivedAt: session.archivedAt,
            piSessionId: session.piSessionId,
            transcriptPath: session.transcriptPath,
            associations: associations.map((association) => ({ ...association })),
            latestPurpose: latest.purpose,
            currentSegmentKind,
            activationState,
            activeSurface: activation.activation?.ownerProcessKind || null,
            safePlanningResume: reason === null,
            reason,
        });
    }
    return candidates;
}

export async function verifyPlanAssociatedSession(
    sessionStore: FileSessionStore,
    candidate: PlanAssociatedSession,
): Promise<{ ok: true } | { ok: false; reason: "degraded" }> {
    const session = sessionStore.getSessionById(candidate.runwieldSessionId);
    const generation = sessionStore.inspectSessionActivation(candidate.runwieldSessionId).generation;
    if (!session || !generation) return { ok: false, reason: "degraded" };
    const segments = sessionStore.listSessionTranscriptSegments(candidate.runwieldSessionId);
    const result = await projectAggregateTranscript({
        runwieldSessionId: candidate.runwieldSessionId,
        cwd: session.transcriptCwd,
        sessionDir: dirname(candidate.transcriptPath),
        generation,
        segments,
    });
    return result.ok ? { ok: true } : { ok: false, reason: "degraded" };
}
