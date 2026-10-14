/*
 * @module shared/session/segment-rollover
 * Transactional Session Transcript Segment Rollover orchestration.
 */

import type { ManagedSessionMetadata } from "./hosted-session.js";
import { createRootSessionManager, resolveCreatedRootSessionPath } from "./root-session.js";
import { captureTranscriptEvidence, syncTranscriptFileAndParent } from "./session-transcript-projection.js";
import { recordPendingSegmentContinuation, recordSegmentLineageEvidence } from "./workflow-context-session.js";
import { appendExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import { recordTutorialContext } from "./tutorial-context-session.ts";
import type { SegmentHandoffPayload } from "../workflow/execution-segment-handoff.ts";

type RolloverKind = "execution" | "semantic_repair";

type RuntimeSessionManager = import("./hosted-session.js").MinimalSessionManagerLike;
type HostedManagedSession = {
    cwd: string;
    getManagedMetadata: () => ManagedSessionMetadata | null;
    getActiveExecutionWorkflow: () => import("../types.js").ActiveExecutionWorkflow | null;
    getTutorialContext: () => import("./tutorial-context-session.ts").TutorialContext | null;
    getRootSessionManager: () => RuntimeSessionManager | null;
    dehydrateManagedSession: () => void;
    replaceManagedTranscriptSegment: (segment: {
        piSessionId: string;
        transcriptPath: string;
        currentSegmentId: string;
        sessionManager: RuntimeSessionManager;
    }) => void;
    setManagedMetadata: (metadata: ManagedSessionMetadata) => void;
};

type RollSessionTranscriptSegmentOptions = {
    hostedSession: HostedManagedSession;
    ownerCoordinationStore: ReturnType<typeof import("./file-session-store.ts").openFileSessionStore>;
    ownerInstanceId: string;
    ownerProcessKind: "workspace" | "tui" | "acp" | "test";
    kind: RolloverKind;
    transcriptCwd?: string;
    continuation: SegmentHandoffPayload;
    expectedGeneration?: number | null;
    lineageGroupKey?: string | null;
    operationId?: string;
    now?: () => string;
};

export type SegmentRolloverResult = {
    runwieldSessionId: string;
    projectId: string;
    predecessorSegmentId: string;
    successorSegmentId: string;
    piSessionId: string;
    transcriptPath: string;
    generation: number;
    continuation: SegmentHandoffPayload;
};

export type OrphanRolloverCandidate = {
    runwieldSessionId: string;
    projectId: string;
    transcriptPath: string;
    transcriptCwd: string;
    piSessionId: string;
    parentSegmentId: string;
    parentPiSessionId: string | null;
    lineageGroupKey: string | null;
};

async function disposeManager(manager: { dispose?: () => void | Promise<void> } | null) {
    await Promise.resolve(manager?.dispose?.());
}

export async function rollSessionTranscriptSegment(
    options: RollSessionTranscriptSegmentOptions,
): Promise<SegmentRolloverResult> {
    const managed = options.hostedSession.getManagedMetadata();
    if (!managed) throw new Error("Session metadata is required for transcript rollover");
    const predecessor = options.ownerCoordinationStore.listSessionTranscriptSegments(managed.runwieldSessionId)
        .find((segment) => segment.segmentId === managed.currentSegmentId);
    if (!predecessor) throw new Error("The current Session transcript segment is unavailable");

    const transcriptCwd = options.transcriptCwd || options.hostedSession.cwd;
    const tutorialContext = options.hostedSession.getTutorialContext();
    const workflow = options.hostedSession.getActiveExecutionWorkflow();

    let proof = options.ownerCoordinationStore.acquireSessionActivation({
        runwieldSessionId: managed.runwieldSessionId,
        projectId: managed.projectId,
        ownerInstanceId: options.ownerInstanceId,
        ownerProcessKind: options.ownerProcessKind,
        operationId: options.operationId,
        expectedGeneration: options.expectedGeneration ?? managed.generation,
        expectedCurrentSegmentId: predecessor.segmentId,
        phase: "preparing",
    });
    try {
        await disposeManager(options.hostedSession.getRootSessionManager());
        options.hostedSession.dehydrateManagedSession();
        await syncTranscriptFileAndParent(predecessor.transcriptPath);
        const predecessorEvidence = await captureTranscriptEvidence({
            transcriptPath: predecessor.transcriptPath,
            transcriptCwd: predecessor.transcriptCwd,
        });

        proof = options.ownerCoordinationStore.changeSessionActivationPhase(proof, "hydrated");
        proof = options.ownerCoordinationStore.changeSessionActivationPhase(proof, "checkpointing");
        const successorManager = await createRootSessionManager("new", transcriptCwd);
        const successorPiSessionId = successorManager.getSessionId();
        const successorTranscriptPath = await resolveCreatedRootSessionPath(
            transcriptCwd,
            successorManager,
        );
        const successorSegmentId = crypto.randomUUID();
        recordSegmentLineageEvidence(successorManager, {
            segmentId: successorSegmentId,
            runwieldSessionId: managed.runwieldSessionId,
            parentSegmentId: predecessor.segmentId,
            parentPiSessionId: predecessor.piSessionId,
            lineageGroupKey: options.lineageGroupKey ?? predecessor.lineageGroupKey ?? predecessor.segmentId,
            kind: options.kind,
        });
        recordPendingSegmentContinuation(successorManager, options.continuation);
        appendExecutionWorkflowSnapshot(successorManager, workflow);
        recordTutorialContext(successorManager, tutorialContext);
        await disposeManager(successorManager as { dispose?: () => void | Promise<void> });
        await syncTranscriptFileAndParent(successorTranscriptPath);
        const successorEvidence = await captureTranscriptEvidence({
            transcriptPath: successorTranscriptPath,
            transcriptCwd,
        });
        const successorSafeLocator = await options.ownerCoordinationStore.validateSuccessorSegmentLocator({
            projectId: managed.projectId,
            piSessionId: successorPiSessionId,
            transcriptPath: successorTranscriptPath,
            transcriptCwd,
        });
        const generation = (managed.generation ?? -1) + 1;
        const committed = options.ownerCoordinationStore.commitSegmentRolloverAndPublish(proof, {
            predecessorSegmentId: predecessor.segmentId,
            predecessorEvidence,
            successor: {
                runwieldSessionId: managed.runwieldSessionId,
                projectId: managed.projectId,
                piSessionId: successorPiSessionId,
                transcriptPath: successorTranscriptPath,
                transcriptCwd,
                kind: options.kind,
                lineageParentSegmentId: predecessor.segmentId,
                lineageParentPiSessionId: predecessor.piSessionId,
                lineageGroupKey: options.lineageGroupKey ?? predecessor.lineageGroupKey ?? predecessor.segmentId,
                idFactory: () => successorSegmentId,
                now: options.now,
            },
            successorSafeLocator,
            generationEvidence: {
                generation,
                byteLength: successorEvidence.byteLength,
                terminalEntryId: successorEvidence.terminalEntryId,
                digestHex: successorEvidence.digestHex,
                currentSegmentId: successorSegmentId,
            },
            now: options.now,
        });
        const successor = committed.successor;
        const nextManaged = options.hostedSession.getManagedMetadata();
        if (nextManaged) {
            options.hostedSession.setManagedMetadata({
                ...nextManaged,
                piSessionId: successor.piSessionId,
                transcriptPath: successor.transcriptPath,
                currentSegmentId: successor.segmentId,
                generation,
                acknowledgedGeneration: generation,
                acknowledgedEventId: null,
                acknowledgedEventOrdinal: null,
            });
        }
        return {
            runwieldSessionId: managed.runwieldSessionId,
            projectId: managed.projectId,
            predecessorSegmentId: predecessor.segmentId,
            successorSegmentId: successor.segmentId,
            piSessionId: successor.piSessionId,
            transcriptPath: successor.transcriptPath,
            generation,
            continuation: options.continuation,
        };
    } catch (error) {
        try {
            options.ownerCoordinationStore.markSessionUncertain(proof, {
                reason: error instanceof Error ? error.message : String(error),
            });
        } catch {
            // If the activation was already released or never acquired, preserve the original failure.
        }
        throw error;
    }
}
