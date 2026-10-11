import { RuntimeEventTypes } from ".././session-runtime-events.js";
import { captureTranscriptEvidence, toProjectionFailure } from ".././session-transcript-projection.js";
import { projectAggregateTranscript } from ".././session-transcript-manifest.ts";
import { dirname } from "@std/path";
import { normalizeTutorialContext } from "../tutorial-context-session.ts";
import { normalizeWorkflowContext, type WorkflowContext } from "../workflow-context-session.js";
import { loadPlanActionEvidence } from "../../workflow/plan-actions.ts";

import { isSameManagedSyncState, restorePublishedSessionProjectRoot } from "./support.ts";
import type { ManagedSyncOptions } from "./types.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";

type RuntimeEventsDependency = Pick<RuntimeEvents, "emitSessionEvent">;

// Legacy transcripts lack accepted progress. Reconcile only confirmed same-Plan delivery,
// including after a metadata-only activation; neither Plan nor transcript is rewritten.
async function reconcileLegacyCompletion(
    cwd: string,
    context: WorkflowContext | null,
): Promise<WorkflowContext | null> {
    if (!context?.planId || context.validationProgress || context.status === "verified") return context;
    const result = await loadPlanActionEvidence(cwd, context.planId);
    return result.kind === "success" && result.evidence.status === "verified"
        ? { ...context, status: "verified", planName: result.evidence.planName }
        : context;
}

export class RuntimeManagedSync {
    private events!: RuntimeEventsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
    ) {
        this.events = events;
    }
    async synchronizeManagedSession(sessionId: string, options: ManagedSyncOptions = {}) {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) throw new Error("SessionRuntime.synchronizeManagedSession: session not found");
        const initialManaged = hostedSession.getManagedMetadata?.() || null;
        if (!initialManaged) return { ok: true, managed: false, events: [] };
        let managed = initialManaged;
        if (hostedSession.getRootSessionManager()) return { ok: true, managed: true, dormant: false, events: [] };
        if (!this.services.sessionStore) throw new Error("Session coordination is unavailable");
        await restorePublishedSessionProjectRoot(hostedSession, this.services.sessionStore);
        const emitEvents = options.emitEvents !== false;
        const emitSyncState = (
            state: NonNullable<import("../hosted-session.js").ManagedSessionMetadata["syncState"]>,
        ) => {
            const previousState = managed.syncState;
            hostedSession.setManagedMetadata({ ...managed, syncState: state });
            managed = hostedSession.getManagedMetadata?.() || managed;
            if (!isSameManagedSyncState(previousState, state)) {
                this.events.emitSessionEvent(sessionId, state);
            }
        };
        const sanitizedSurface = (processKind: string | null) => {
            if (processKind === "workspace" || processKind === "tui" || processKind === "acp") return processKind;
            return "unknown";
        };
        let activationState = this.services.sessionStore.inspectSessionActivation(managed.runwieldSessionId);
        if (
            ["uncertain", "reconcile_required"].includes(activationState.activation?.state || "") ||
            (!activationState.generation && activationState.activation?.state === "uninitialized")
        ) {
            await this.ensureInitialSessionGeneration(managed.runwieldSessionId);
            activationState = this.services.sessionStore.inspectSessionActivation(managed.runwieldSessionId);
        }
        const latestGeneration = activationState.generation?.generation ?? null;
        const currentLocalGeneration = managed.acknowledgedGeneration ?? managed.generation ?? null;
        const managedAlreadyCurrent = !options.replayFromStart && latestGeneration === currentLocalGeneration &&
            !managed.acknowledgedEventId && !Number.isInteger(managed.acknowledgedEventOrdinal) &&
            managed.syncState?.status === "current" && managed.syncState.localGeneration === currentLocalGeneration &&
            managed.syncState.latestGeneration === latestGeneration;
        const activeOwnerKind = activationState.activation?.ownerProcessKind || null;
        const activeOwnerInstanceId = activationState.activation?.ownerInstanceId || null;
        const activeElsewhere = Boolean(
            activationState.activation?.state === "active" && activeOwnerInstanceId &&
                activeOwnerInstanceId !== this.services.ownerInstanceId,
        );
        const owningSurfaceKind = activeElsewhere ? sanitizedSurface(activeOwnerKind) : undefined;
        if (!activeElsewhere && latestGeneration === currentLocalGeneration) {
            const savedContext = managed.workflowContext ?? null;
            const workflowContext = await reconcileLegacyCompletion(hostedSession.cwd, savedContext);
            if (workflowContext !== savedContext) {
                managed = { ...managed, workflowContext };
                hostedSession.setManagedMetadata(managed);
                hostedSession.replaceWorkflowContext(workflowContext, { persist: false });
            }
        }
        if (
            activationState.activation?.state === "uncertain" ||
            activationState.activation?.state === "reconcile_required"
        ) {
            const state: NonNullable<import("../hosted-session.js").ManagedSessionMetadata["syncState"]> = {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: "blocked",
                localGeneration: currentLocalGeneration,
                latestGeneration,
                message: activationState.activation.blockedReason || activationState.activation.state,
            };
            emitSyncState(state);
            return { ok: false, error: activationState.activation.state, state };
        }
        if (!activationState.generation) {
            const state: NonNullable<import("../hosted-session.js").ManagedSessionMetadata["syncState"]> = {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: activeElsewhere ? "active_elsewhere" : "current",
                localGeneration: currentLocalGeneration,
                latestGeneration,
                ...(owningSurfaceKind ? { owningSurfaceKind } : {}),
            };
            emitSyncState(state);
            return { ok: true, events: [], state };
        }
        if (
            !options.replayFromStart && latestGeneration === currentLocalGeneration &&
            (managed.acknowledgedEventId || Number.isInteger(managed.acknowledgedEventOrdinal) ||
                latestGeneration === null)
        ) {
            const state: NonNullable<import("../hosted-session.js").ManagedSessionMetadata["syncState"]> = {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: activeElsewhere ? "active_elsewhere" : "current",
                localGeneration: currentLocalGeneration,
                latestGeneration,
                ...(owningSurfaceKind ? { owningSurfaceKind } : {}),
            };
            emitSyncState(state);
            return { ok: true, events: [], state };
        }
        if (!managedAlreadyCurrent) {
            emitSyncState(
                {
                    type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                    status: "syncing",
                    localGeneration: currentLocalGeneration,
                    latestGeneration,
                    ...(owningSurfaceKind ? { owningSurfaceKind } : {}),
                },
            );
        }
        try {
            const events = [];
            let projected;
            let cursorEventId = options.replayFromStart ? null : managed.acknowledgedEventId || null;
            let cursorEventOrdinal = options.replayFromStart
                ? null
                : Number.isInteger(managed.acknowledgedEventOrdinal)
                ? managed.acknowledgedEventOrdinal
                : null;
            do {
                projected = await projectAggregateTranscript({
                    cwd: hostedSession.cwd,
                    sessionDir: dirname(managed.transcriptPath),
                    runwieldSessionId: managed.runwieldSessionId,
                    runtimeSessionId: sessionId,
                    generation: activationState.generation,
                    segments: this.services.sessionStore.listSessionTranscriptSegments(managed.runwieldSessionId),
                    cursorEventId,
                    cursorEventOrdinal,
                    limit: options.limit,
                });
                if (!projected.ok) throw new Error(projected.message);
                events.push(...(projected.events || []));
                cursorEventId = projected.nextCursor || cursorEventId;
                cursorEventOrdinal = Number.isInteger(projected.nextCursorOrdinal)
                    ? projected.nextCursorOrdinal
                    : cursorEventOrdinal;
            } while (!projected.complete);
            const summary = projected.snapshot || {};
            const savedContext = normalizeWorkflowContext(summary.workflowContext) ?? managed.workflowContext ?? null;
            const workflowContext = activeElsewhere
                ? savedContext
                : await reconcileLegacyCompletion(hostedSession.cwd, savedContext);
            hostedSession.replaceWorkflowContext(workflowContext, { persist: false });
            const previousSyncState = managed.syncState;
            const nextMetadata: import("../hosted-session.js").ManagedSessionMetadata = {
                ...managed,
                generation: projected.generation,
                acknowledgedGeneration: projected.generation,
                acknowledgedEventId: projected.nextCursor,
                acknowledgedEventOrdinal: projected.nextCursorOrdinal,
                committedSummary: summary,
                name: typeof summary.name === "string" ? summary.name : managed.name ?? null,
                activeAgent: typeof summary.activeAgent === "string"
                    ? summary.activeAgent
                    : managed.activeAgent ?? null,
                model: typeof summary.model === "string" ? summary.model : managed.model ?? null,
                provider: typeof summary.provider === "string" ? summary.provider : managed.provider ?? null,
                thinkingLevel: typeof summary.thinkingLevel === "string"
                    ? summary.thinkingLevel
                    : managed.thinkingLevel ?? null,
                workflowContext,
                tutorialContext: normalizeTutorialContext(summary.tutorialContext) ?? managed.tutorialContext ?? null,
                syncState: {
                    type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                    status: activeElsewhere ? "active_elsewhere" : "current",
                    localGeneration: projected.generation,
                    latestGeneration,
                    ...(owningSurfaceKind ? { owningSurfaceKind } : {}),
                },
            };
            hostedSession.setManagedMetadata(nextMetadata);
            managed = hostedSession.getManagedMetadata?.() || nextMetadata;
            if (emitEvents) {
                for (const event of events) this.events.emitSessionEvent(sessionId, event);
                if (summary.name) {
                    this.events.emitSessionEvent(sessionId, {
                        type: RuntimeEventTypes.SESSION_RENAMED,
                        name: summary.name,
                    });
                }
            }
            if (managed.syncState && !isSameManagedSyncState(previousSyncState, managed.syncState)) {
                this.events.emitSessionEvent(sessionId, managed.syncState);
            }
            return { ok: true, events, state: managed.syncState || null, snapshot: summary };
        } catch (error) {
            const failure = toProjectionFailure(error);
            const state: NonNullable<import("../hosted-session.js").ManagedSessionMetadata["syncState"]> = {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: "degraded",
                localGeneration: currentLocalGeneration,
                latestGeneration,
                message: failure.message,
            };
            emitSyncState(state);
            return { ok: false, error: failure.code, state };
        }
    }

    async ensureInitialSessionGeneration(runwieldSessionId: string) {
        if (!this.services.sessionStore) throw new Error("Session coordination is unavailable");
        const session = this.services.sessionStore.getSessionById(runwieldSessionId);
        if (!session) throw new Error("Session identity is unavailable");
        const state = this.services.sessionStore.inspectSessionActivation(runwieldSessionId);
        const needsRecovery = ["uncertain", "reconcile_required"].includes(state.activation?.state || "");
        if (state.generation && !needsRecovery) return state;
        const segment = this.services.sessionStore.getCurrentSessionSegment(runwieldSessionId);
        if (!segment) throw new Error("The Session transcript is unavailable");
        const evidence = await captureTranscriptEvidence({
            transcriptPath: segment.transcriptPath,
            transcriptCwd: segment.transcriptCwd,
        });
        if (needsRecovery) {
            return this.services.sessionStore.recoverSessionControl({
                runwieldSessionId,
                projectId: session.projectId,
                expectedFence: state.activation?.fence ?? 0,
                expectedGeneration: state.generation?.generation ?? null,
                expectedCurrentSegmentId: segment.segmentId,
                ownerInstanceId: this.services.ownerInstanceId,
                ownerProcessKind: this.services.ownerProcessKind,
                transcriptEvidence: {
                    byteLength: evidence.byteLength,
                    terminalEntryId: evidence.terminalEntryId,
                    digestHex: evidence.digestHex,
                    currentSegmentId: segment.segmentId,
                },
            });
        }
        if (state.activation?.state !== "uninitialized") {
            throw new Error("The Session's initial transcript state is unavailable");
        }
        let proof = this.services.sessionStore.acquireSessionActivation({
            runwieldSessionId,
            projectId: session.projectId,
            ownerInstanceId: this.services.ownerInstanceId,
            ownerProcessKind: this.services.ownerProcessKind,
            expectedGeneration: null,
            expectedCurrentSegmentId: segment.segmentId,
            phase: "bootstrap",
        });
        try {
            proof = this.services.sessionStore.changeSessionActivationPhase(proof, "checkpointing");
            return this.services.sessionStore.publishGenerationAndRelease(proof, {
                generation: 0,
                byteLength: evidence.byteLength,
                terminalEntryId: evidence.terminalEntryId,
                digestHex: evidence.digestHex,
                currentSegmentId: segment.segmentId,
            });
        } catch (error) {
            this.services.sessionStore.markSessionReconcileRequiredWithProof(proof, {
                reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
