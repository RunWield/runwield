import type {
    CatalogedTranscriptLocator,
    EnsureSessionCatalogOptions,
    FileSessionManifest,
    SessionTranscriptSegment,
} from "./file-session-store-types.ts";
import { FILE_SESSION_STORE_VERSION, isoNow } from "./file-session-storage.ts";

/** Initialize one cataloged transcript's segment, activation, and generation together. */
export function createInitialSessionManifest(
    projectId: string,
    safe: CatalogedTranscriptLocator,
    locator: EnsureSessionCatalogOptions,
    now?: () => string,
): FileSessionManifest {
    const timestamp = isoNow(locator.now || now);
    const runwieldSessionId = locator.idFactory ? locator.idFactory() : crypto.randomUUID();
    const segmentId = `${runwieldSessionId}-segment-0`;
    const segment: SessionTranscriptSegment = {
        segmentId,
        runwieldSessionId,
        projectId,
        piSessionId: safe.piSessionId,
        transcriptPath: safe.sessionPath,
        transcriptCwd: safe.headerCwd,
        ordinal: 0,
        kind: "planning",
        sealedAt: null,
        headerVersion: safe.headerVersion,
        headerTimestamp: safe.headerTimestamp,
        firstCatalogedAt: timestamp,
        lastCatalogedAt: timestamp,
        lineageParentSegmentId: null,
        lineageParentPiSessionId: null,
        lineageGroupKey: null,
        lineageRecordedAt: null,
        sealedByteLength: null,
        sealedDigestHex: null,
        sealedTerminalEntryId: null,
    };
    return {
        version: FILE_SESSION_STORE_VERSION,
        runwieldSessionId,
        projectId,
        transcriptCwd: safe.headerCwd,
        displayName: null,
        source: locator.source || "catalog",
        createdAt: timestamp,
        updatedAt: timestamp,
        currentSegmentId: segmentId,
        fence: 0,
        activation: {
            state: "uninitialized",
            phase: null,
            ownerInstanceId: null,
            ownerProcessKind: null,
            operationId: null,
            expectedGeneration: null,
            expectedCurrentSegmentId: null,
            acquiredAt: null,
            blockedReason: null,
            baselineByteLength: null,
            baselineDigestHex: null,
        },
        generation: null,
        segments: [segment],
        artifacts: [],
    };
}
