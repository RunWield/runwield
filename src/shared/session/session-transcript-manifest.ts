import { stat as fsStat } from "node:fs/promises";
/*
 * @module shared/session/session-transcript-manifest
 * Aggregate non-mutating reader for segmented Session transcripts.
 */

import { dirname, resolve } from "node:path";
import { readCatalogSafeRootSessionLocator } from "./root-session.js";
import type { TutorialContextCandidate } from "./tutorial-context-session.ts";
import {
    buildProjectedSessionInfo,
    captureTranscriptEvidence,
    createReplayEvents,
    selectProjectedEventsAfterCursor,
    summarizeProjectedEntries,
    summarizeResumableTranscript,
    toProjectionFailure,
} from "./session-transcript-projection.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ProjectedRuntimeEvent = {
    type: string;
    eventId: string;
    segmentOrdinal?: number;
    segmentKind?: string;
    [key: string]: JsonValue | undefined;
};

type TranscriptSegment = {
    segmentId: string;
    runwieldSessionId: string;
    projectId: string;
    piSessionId: string;
    transcriptPath: string;
    transcriptCwd: string;
    ordinal: number;
    kind: string;
    sealedAt: string | null;
    sealedByteLength: number | null;
    sealedDigestHex: string | null;
    sealedTerminalEntryId: string | null;
};

export type TranscriptEntry =
    import("@earendil-works/pi-coding-agent").SessionEntry | import("@earendil-works/pi-coding-agent").SessionHeader;

export type VerifiedTranscriptSegment = {
    segmentId: string;
    ordinal: number;
    kind: "planning" | "execution" | "semantic_repair" | "session";
    label: string;
    piSessionId: string;
    sealed: boolean;
    current: boolean;
    transcriptCwd: string;
    entries: TranscriptEntry[];
};

type SegmentReplayOptions = {
    runwieldSessionId: string;
    runtimeSessionId?: string;
    cwd: string;
};

type CommittedGeneration = {
    generation: number;
    byteLength: number;
    terminalEntryId: string | null;
    digestHex: string;
    currentSegmentId: string | null;
};

type ProjectAggregateTranscriptOptions = {
    runwieldSessionId: string;
    cwd: string;
    sessionDir?: string;
    runtimeSessionId?: string;
    generation: CommittedGeneration;
    segments: TranscriptSegment[];
    cursorEventId?: string | null;
    cursorEventOrdinal?: number | null;
    limit?: number;
    latest?: boolean;
    beforeEventId?: string;
};

type VerifiedSegmentMetadata = {
    ordinal: number;
    kind: string;
    label: string;
    sealed: boolean;
    current: boolean;
};

type AggregateProjectionFailure = {
    ok: false;
    state: "degraded";
    code: string;
    message: string;
    events: [];
};

type ProjectedSessionSnapshot = {
    activeAgent?: string | null;
    tutorialContext?: TutorialContextCandidate | null;
    [key: string]: unknown;
};

type AggregateProjectionResult = {
    ok: true;
    generation: number;
    events: ProjectedRuntimeEvent[];
    nextCursor: string | null;
    nextCursorOrdinal: number | null;
    complete: boolean;
    snapshot: ProjectedSessionSnapshot;
    segments: VerifiedSegmentMetadata[];
    cursorReset: boolean;
    previousCursor?: string | null;
};

function requireOrderedManifest(options: ProjectAggregateTranscriptOptions) {
    const segments = [...options.segments].sort((left, right) => left.ordinal - right.ordinal);
    if (segments.length === 0) throw new Error("Segment manifest is empty");
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.runwieldSessionId !== options.runwieldSessionId) {
            throw new Error("Segment manifest lineage is ambiguous");
        }
        if (segment.ordinal !== index) throw new Error("Segment manifest ordinal continuity is invalid");
    }
    const current = segments.find((segment) => segment.segmentId === options.generation.currentSegmentId);
    if (!current) throw new Error("Committed generation current segment is absent from manifest");
    for (const segment of segments) {
        if (segment.ordinal < current.ordinal && !segment.sealedAt) throw new Error("Predecessor segment is unsealed");
        if (segment.ordinal > current.ordinal) {
            throw new Error("Committed generation references an ambiguous segment lineage");
        }
    }
    return { segments: segments.slice(0, current.ordinal + 1), current };
}

async function verifyPath(segment: TranscriptSegment) {
    const transcriptPath = resolve(segment.transcriptPath);
    await readCatalogSafeRootSessionLocator({
        cwd: segment.transcriptCwd,
        sessionDir: dirname(transcriptPath),
        sessionPath: transcriptPath,
    });
    return transcriptPath;
}

async function verifySealedSegment(segment: TranscriptSegment) {
    if (!Number.isInteger(segment.sealedByteLength) || !segment.sealedDigestHex) {
        throw new Error("Sealed segment evidence is missing");
    }
    const transcriptPath = await verifyPath(segment);
    const stat = await fsStat(transcriptPath);
    if (stat.size !== segment.sealedByteLength) throw new Error("Sealed segment byte length does not match evidence");
    const evidence = await captureTranscriptEvidence({
        transcriptPath,
        transcriptCwd: segment.transcriptCwd,
        byteLength: segment.sealedByteLength,
    });
    if (evidence.digestHex !== segment.sealedDigestHex) {
        throw new Error("Sealed segment digest does not match evidence");
    }
    if (evidence.terminalEntryId !== segment.sealedTerminalEntryId) {
        throw new Error("Sealed segment terminal entry does not match evidence");
    }
    return evidence;
}

function normalizeSegmentKind(kind: string) {
    if (kind === "planning" || kind === "execution" || kind === "semantic_repair") return kind;
    return "session";
}

function segmentLabel(kind: string, ordinal: number) {
    if (kind === "planning") return `Planning segment ${ordinal + 1}`;
    if (kind === "execution") return `Execution segment ${ordinal + 1}`;
    if (kind === "semantic_repair") return `Semantic Repair segment ${ordinal + 1}`;
    return `Session segment ${ordinal + 1}`;
}

async function verifyCurrentSegment(segment: TranscriptSegment, generation: CommittedGeneration) {
    const transcriptPath = await verifyPath(segment);
    const evidence = await captureTranscriptEvidence({
        transcriptPath,
        transcriptCwd: segment.transcriptCwd,
        byteLength: generation.byteLength,
    });
    if (evidence.digestHex !== generation.digestHex) {
        throw new Error("Committed transcript digest does not match published evidence");
    }
    if (evidence.terminalEntryId !== generation.terminalEntryId) {
        throw new Error("Committed transcript terminal entry does not match published evidence");
    }
    return evidence;
}

/** Read each committed segment once. Reject invalid evidence before returning any history. */
export async function readVerifiedTranscriptSegments(
    options: ProjectAggregateTranscriptOptions,
): Promise<VerifiedTranscriptSegment[]> {
    const { segments, current } = requireOrderedManifest(options);
    const verified: VerifiedTranscriptSegment[] = [];
    for (const segment of segments) {
        const isCurrent = segment.segmentId === current.segmentId;
        const evidence = isCurrent
            ? await verifyCurrentSegment(segment, options.generation)
            : await verifySealedSegment(segment);
        const kind = normalizeSegmentKind(segment.kind);
        verified.push({
            segmentId: segment.segmentId,
            ordinal: segment.ordinal,
            kind,
            label: segmentLabel(kind, segment.ordinal),
            piSessionId: segment.piSessionId,
            sealed: !isCurrent,
            current: isCurrent,
            transcriptCwd: segment.transcriptCwd,
            entries: evidence.entries,
        });
    }
    return verified;
}

/** Project one pinned read, retaining Agent context across segment boundaries. */
export function projectSegmentReplayEvents(
    verified: VerifiedTranscriptSegment[],
    options: SegmentReplayOptions,
): ProjectedRuntimeEvent[] {
    const agentProjectionState = { agentName: null, displayName: null, hasBaseline: false };
    return verified.flatMap((segment) =>
        createReplayEvents(options.runtimeSessionId || options.runwieldSessionId, segment.entries, {
            segmentId: segment.segmentId,
            projectRoot: segment.transcriptCwd || options.cwd,
            agentProjectionState,
        }).map((event) => ({ ...event, segmentOrdinal: segment.ordinal, segmentKind: segment.kind })),
    );
}

export async function projectAggregateTranscript(
    options: ProjectAggregateTranscriptOptions,
): Promise<AggregateProjectionResult | AggregateProjectionFailure> {
    try {
        const verified = await readVerifiedTranscriptSegments(options);
        const aggregateEntries = verified.flatMap((segment) => segment.entries);
        const replayEvents = projectSegmentReplayEvents(verified, options);
        const segmentMetadata = verified.map(({ ordinal, kind, label, sealed, current }) => ({
            ordinal,
            kind,
            label,
            sealed,
            current,
        }));
        const info = buildProjectedSessionInfo(aggregateEntries, {
            sessionId: options.runwieldSessionId,
            cwd: options.cwd,
        });
        const snapshot = {
            ...summarizeProjectedEntries(aggregateEntries),
            ...summarizeResumableTranscript(aggregateEntries),
            sessionStats: {
                userMessages: info.userMessages,
                assistantMessages: info.assistantMessages,
                toolCalls: info.toolCalls,
                compactionCount: info.compactionCount,
            },
        };
        let cursorReset = false;
        let selected;
        try {
            selected = selectProjectedEventsAfterCursor({
                events: replayEvents,
                cursorEventId: options.cursorEventId,
                cursorEventOrdinal: options.cursorEventOrdinal,
                limit: options.limit,
            });
        } catch (error) {
            if (!(error instanceof Error) || error.name !== "ProjectionContinuityError") throw error;
            cursorReset = true;
            selected = selectProjectedEventsAfterCursor({
                events: replayEvents,
                cursorEventId: null,
                limit: options.limit,
            });
        }
        // All segments above are verified regardless of how much history the reader displays.
        if (options.latest || options.beforeEventId) {
            const end = options.beforeEventId
                ? replayEvents.findIndex((event) => event.eventId === options.beforeEventId)
                : replayEvents.length;
            if (end < 0) throw new Error("Earlier history cursor is no longer available. Reload the conversation.");
            const start = Math.max(0, end - Math.max(1, Math.min(500, options.limit || 200)));
            return {
                ok: true,
                generation: options.generation.generation,
                events: replayEvents.slice(start, end),
                nextCursor: replayEvents[end - 1]?.eventId || null,
                nextCursorOrdinal: end > 0 ? end - 1 : null,
                previousCursor: start > 0 ? replayEvents[start]?.eventId || null : null,
                complete: start === 0,
                snapshot,
                segments: segmentMetadata,
                cursorReset: false,
            };
        }
        return {
            ok: true,
            generation: options.generation.generation,
            events: selected.events as ProjectedRuntimeEvent[],
            nextCursor: selected.nextCursor,
            nextCursorOrdinal: selected.nextCursorOrdinal,
            complete: selected.complete,
            snapshot,
            segments: segmentMetadata,
            cursorReset,
        };
    } catch (error) {
        return { ...toProjectionFailure(error), events: [] } as AggregateProjectionFailure;
    }
}
