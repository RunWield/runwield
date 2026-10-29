/** Adapter-neutral, lossless export of one committed Session. */
import type { SessionArtifactReference, ManifestPlanAssociation } from "./file-session-store-types.ts";
import type { SessionRuntimeEvent } from "./session-runtime-events.js";
import type { TranscriptEntry, VerifiedTranscriptSegment } from "./session-transcript-manifest.ts";

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
