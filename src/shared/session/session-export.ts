/** Adapter-neutral, lossless export of one committed Session. */
import type {
    SessionArtifactReference,
    ManifestPlanAssociation,
    FileSessionManifest,
} from "./file-session-store-types.ts";
import type { SessionRuntimeEvent } from "./session-runtime-events.js";
import {
    readVerifiedTranscriptSegments,
    projectSegmentReplayEvents,
    type TranscriptEntry,
    type VerifiedTranscriptSegment,
} from "./session-transcript-manifest.ts";
import { summarizeProjectedEntries } from "./session-transcript-projection.js";

export type SessionExportSegment = {
    ordinal: number;
    kind: VerifiedTranscriptSegment["kind"];
    label: string;
    piSessionId: string;
    sealed: boolean;
    current: boolean;
    entries: TranscriptEntry[];
};

export type SessionExportIdentity = {
    runwieldSessionId: string | null;
    name: string | null;
    cwd: string;
    createdAt: string | null;
    updatedAt: string | null;
};

export type SessionExportDocument = {
    format: "runwield.session-export";
    version: 1;
    exportedAt: string;
    session: SessionExportIdentity;
    artifacts: SessionArtifactReference[];
    planAssociations: ManifestPlanAssociation[];
    segments: SessionExportSegment[];
};

export type SessionExportTimelineEvent = SessionRuntimeEvent & {
    segmentOrdinal: number;
    segmentKind: SessionExportSegment["kind"];
};

export type SessionExport = {
    document: SessionExportDocument;
    timeline: SessionExportTimelineEvent[];
};

type BuildSessionExportDocumentOptions = {
    session: SessionExportIdentity;
    segments: VerifiedTranscriptSegment[];
    artifacts: SessionArtifactReference[];
    planAssociations: ManifestPlanAssociation[];
};

export function buildSessionExportDocument(options: BuildSessionExportDocumentOptions): SessionExportDocument {
    return {
        format: "runwield.session-export",
        version: 1,
        exportedAt: new Date().toISOString(),
        session: options.session,
        artifacts: options.artifacts,
        planAssociations: options.planAssociations,
        segments: options.segments.map(({ ordinal, kind, label, piSessionId, sealed, current, entries }) => ({
            ordinal,
            kind,
            label,
            piSessionId,
            sealed,
            current,
            entries,
        })),
    };
}

/** Pin all committed evidence before returning a file-free complete snapshot. */
export async function readCommittedSessionExport(
    manifest: FileSessionManifest,
    sessionId: string,
): Promise<SessionExport> {
    if (!manifest.generation) throw new Error("Committed generation is unavailable.");
    const options = {
        cwd: manifest.transcriptCwd,
        runwieldSessionId: manifest.runwieldSessionId,
        runtimeSessionId: sessionId,
        generation: manifest.generation,
        segments: manifest.segments,
    };
    const verified = await readVerifiedTranscriptSegments(options);
    // Older manifests keep the Session Name only in committed Pi session_info entries.
    const committedName = summarizeProjectedEntries(verified.flatMap((segment) => segment.entries)).name;
    return {
        document: buildSessionExportDocument({
            session: {
                runwieldSessionId: manifest.runwieldSessionId,
                name: manifest.displayName || committedName || null,
                cwd: manifest.transcriptCwd,
                createdAt: manifest.createdAt,
                updatedAt: manifest.updatedAt,
            },
            segments: verified,
            artifacts: manifest.artifacts || [],
            planAssociations: (manifest.planAssociations || []).filter(
                (association) => association.committedGeneration !== null,
            ),
        }),
        timeline: projectSegmentReplayEvents(verified, options).map(
            (event) => ({ ...event, sessionId }) as SessionExportTimelineEvent,
        ),
    };
}
