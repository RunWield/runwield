import { findLatestSavedSession, getRunWieldSessionsBaseDir } from "../../src/shared/session/root-session.ts";
import {
    listManifests,
    listProjectsFromDisk,
    sessionDirForProject,
} from "../../src/shared/session/file-session-storage.ts";

/** Discover the selected transcript segment without opening a writer or repairing storage. */
export async function resolveSessionContinuation(cwd: string, sessionId?: string) {
    const latest = sessionId === undefined ? await findLatestSavedSession(cwd) : null;
    const manifest = sessionId !== undefined ? findExplicitSessionManifest(sessionId) : latest?.manifest;
    if (manifest) {
        const segment = manifest.segments.find((candidate) => candidate.segmentId === manifest.currentSegmentId);
        if (!segment) throw new Error("The selected Session has no current transcript segment.");
        return { sessionId: manifest.runwieldSessionId, cwd: segment.transcriptCwd, managed: true };
    }
    if (latest) {
        return {
            sessionId: latest.locator.piSessionId,
            sessionPath: latest.locator.sessionPath,
            cwd: latest.locator.headerCwd,
            managed: false,
        };
    }
    return null;
}

function findExplicitSessionManifest(sessionId: string) {
    const baseDir = getRunWieldSessionsBaseDir();
    for (const project of listProjectsFromDisk(baseDir)) {
        if (project.remote) continue;
        const found = listManifests(sessionDirForProject(baseDir, project), true, project).find(
            ({ manifest }) =>
                manifest.runwieldSessionId === sessionId ||
                manifest.segments.some((segment) => segment.piSessionId === sessionId),
        );
        if (found) return found.manifest;
    }
    return undefined;
}
