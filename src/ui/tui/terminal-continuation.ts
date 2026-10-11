import { getRunWieldSessionsBaseDir, listCatalogSafeRootSessionLocators } from "../../shared/session/root-session.js";
import { listManifests, listProjectsFromDisk, sessionDirForRoot } from "../../shared/session/file-session-storage.ts";

/** Discover the selected transcript segment without opening a writer or repairing storage. */
export async function resolveTerminalContinuation(cwd: string, sessionId?: string) {
    const baseDir = getRunWieldSessionsBaseDir();
    const manifests = listProjectsFromDisk(baseDir).flatMap((project) =>
        listManifests(sessionDirForRoot(baseDir, project.currentRoot), true).map((item) => item.manifest)
    );
    const locator = sessionId ? null : (await listCatalogSafeRootSessionLocators(cwd)).locators[0];
    const manifest = manifests.find((candidate) =>
        sessionId
            ? candidate.runwieldSessionId === sessionId ||
                candidate.segments.some((segment) => segment.piSessionId === sessionId)
            : candidate.segments.some((segment) => segment.transcriptPath === locator?.sessionPath)
    );
    if (manifest) {
        const segment = manifest.segments.find((candidate) => candidate.segmentId === manifest.currentSegmentId);
        if (!segment) throw new Error("The selected Session has no current transcript segment.");
        return { sessionId: manifest.runwieldSessionId, cwd: segment.transcriptCwd };
    }
    if (locator) return { sessionId: locator.piSessionId, cwd: locator.headerCwd };
    return null;
}
