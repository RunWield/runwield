/** Laptop-only, read-only project projection. No native path or activation proof crosses the bridge. */
import { readCommittedRemoteLineage } from "./committed-session.ts";
import { findProject, listManifests, sessionDirForProject } from "../session/file-session-storage.ts";
import type { FileSessionStore } from "../session/file-session-store-types.ts";
import { reasonForCandidate } from "../session/plan-session-lookup.ts";
import { summarizeResumableTranscript, buildProjectedSessionInfo } from "../session/session-transcript-projection.js";
import { type RemotePlanSessionQuery, type RemoteSessionRecords } from "./session-protocol.ts";

export function projectRemoteSessionRecords(
    store: FileSessionStore,
    sessionId: string,
    projectId: string,
    query?: RemotePlanSessionQuery,
): RemoteSessionRecords {
    const project = findProject(store.path, projectId);
    if (!project?.remote) throw new Error("Remote Session project is unavailable");
    const planSessions: RemoteSessionRecords["planSessions"] = [];
    for (const { manifest } of query ? listManifests(sessionDirForProject(store.path, project), false) : []) {
        if (query?.sessionId && manifest.runwieldSessionId !== query.sessionId) continue;
        const associations = store
            .listSessionPlanAssociations(manifest.runwieldSessionId, projectId)
            .filter(
                (association) =>
                    Number.isInteger(association.committedGeneration) && association.planId === query?.planId,
            );
        if (!associations.length) continue;
        const activation = store.inspectSessionActivation(manifest.runwieldSessionId);
        const currentSegment = store.getCurrentSessionSegment(manifest.runwieldSessionId);
        const currentSegmentKind = currentSegment?.kind || "session";
        const activationState = activation.activation?.state || "unknown";
        let displayName = manifest.displayName?.trim() || null;
        let verified = false;
        try {
            const { entries } = readCommittedRemoteLineage(manifest);
            const info = buildProjectedSessionInfo(entries, {
                sessionId: manifest.runwieldSessionId,
                cwd: manifest.transcriptCwd,
                transcriptPath: "",
            });
            displayName = info.name?.trim() || summarizeResumableTranscript(entries).firstMessage?.trim() || null;
            verified = true;
        } catch {
            // A damaged candidate remains visible, but cannot pass verification.
        }
        for (const planId of new Set(associations.map((association) => association.planId))) {
            const matching = associations.filter((association) => association.planId === planId);
            const latestPurpose = matching.at(-1)!.purpose;
            const reason = reasonForCandidate(activationState, currentSegmentKind, latestPurpose);
            planSessions.push({
                runwieldSessionId: manifest.runwieldSessionId,
                displayName,
                archivedAt: manifest.archivedAt || null,
                piSessionId: currentSegment?.piSessionId || "",
                transcriptPath: "",
                associations: matching,
                latestPurpose,
                currentSegmentKind,
                activationState,
                activeSurface: activation.activation?.ownerProcessKind || null,
                safePlanningResume: reason === null,
                reason,
                verified,
            });
        }
    }
    return {
        lastPlanReview: store.getLastPlanReview(sessionId, projectId),
        planAssociations: store.listSessionPlanAssociations(sessionId, projectId),
        planSessions,
    };
}
