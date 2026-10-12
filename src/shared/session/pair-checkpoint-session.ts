import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "./hosted-session.js";
import { readRequestAttemptEntries, type RequestAttemptEntry } from "./request-dispatch.ts";
import { workflowAttemptKey } from "./task-completion-session.ts";
import { readExecutionWorkflowSnapshot } from "./execution-workflow-session.ts";
import { readPersistedActiveAgentName } from "./active-agent-session.js";

export const PAIR_CHECKPOINT_CUSTOM_TYPE = "runwield.pair_checkpoint";

export type PairCheckpointDecision = "continue" | "revise" | "switch_to_autonomous" | "stop";

export type PairCheckpointReport = {
    summary: string;
    route?: string;
    state?: string;
    viewport?: string;
    evidence?: string[];
    diagnostics?: string;
    nextIncrement?: string;
    final: boolean;
    browserPreflightOutcome?: "succeeded" | "failed" | "externally_blocked";
};

type PairRequestProvenance = {
    runtimeTurnId: string;
    requestId: string;
    attemptId: string;
    dispatchKind: RequestAttemptEntry["dispatchKind"];
    promptMode: RequestAttemptEntry["promptMode"];
};

type PairReportedEvent = {
    version: 1;
    state: "reported";
    checkpointId: string;
    checkpointNumber: number;
    timestampMs: number;
    workflowAttemptKey: string;
    workflow: import("./hosted-session.js").ActiveExecutionWorkflow;
    report: PairCheckpointReport;
    source: PairRequestProvenance;
};

type PairResolvedEvent = {
    version: 1;
    state: "resolved";
    checkpointId: string;
    timestampMs: number;
    workflowAttemptKey: string;
    workflow: import("./hosted-session.js").ActiveExecutionWorkflow;
    decision: PairCheckpointDecision;
    revisionDirection?: string;
    userTurn: PairRequestProvenance;
};

type PairClearedEvent = {
    version: 1;
    state: "cleared";
    checkpointId: string;
    timestampMs: number;
    reason: "superseded" | "task_completion_accepted" | "workflow_cleared";
};

type PairCheckpointJournalEvent = PairReportedEvent | PairResolvedEvent | PairClearedEvent;

interface PairLifecycleEntry {
    type?: string;
    customType?: string;
    data?: { state?: string; checkpointId?: string };
}

type PairCheckpointSessionEntry = {
    type?: string;
    customType?: string;
    data?: PairCheckpointJournalEvent | null;
};

export type CurrentPairCheckpoint = {
    report: PairReportedEvent;
    resolution: PairResolvedEvent | null;
};

type RecordPairCheckpointReportArgs = {
    hostedSession: HostedSession;
    toolCallId: string;
    report: PairCheckpointReport;
    timestampMs?: number;
};

type ResolvePairCheckpointArgs = {
    hostedSession: HostedSession;
    checkpointId: string;
    decision: PairCheckpointDecision;
    workflow: import("./hosted-session.js").ActiveExecutionWorkflow;
    revisionDirection?: string;
    timestampMs?: number;
};

export type ResolvePairCheckpointResult =
    | { ok: true; checkpoint: CurrentPairCheckpoint }
    | {
        ok: false;
        reason:
            | "checkpoint_missing"
            | "checkpoint_stale"
            | "workflow_mismatch"
            | "user_turn_required"
            | "later_user_turn_required"
            | "checkpoint_already_resolved";
    };

function getSessionManager(hostedSession: HostedSession): SessionManager | null {
    return hostedSession.getRootSessionManager?.() as SessionManager | null;
}

function getEntries(sessionManager: SessionManager | null): PairCheckpointSessionEntry[] {
    if (!sessionManager) return [];
    const entries = sessionManager.getBranch?.() || sessionManager.getEntries?.() || [];
    return Array.isArray(entries) ? entries as PairCheckpointSessionEntry[] : [];
}

function isReportedEvent(event: PairCheckpointJournalEvent | null | undefined): event is PairReportedEvent {
    return event?.version === 1 && event.state === "reported" && typeof event.checkpointId === "string" &&
        Number.isInteger(event.checkpointNumber) && event.checkpointNumber > 0 &&
        typeof event.workflowAttemptKey === "string" && typeof event.workflow?.planName === "string" &&
        typeof event.report?.summary === "string" && typeof event.report.final === "boolean" &&
        typeof event.source?.runtimeTurnId === "string" && typeof event.source.requestId === "string" &&
        typeof event.source.attemptId === "string";
}

function isResolvedEvent(event: PairCheckpointJournalEvent | null | undefined): event is PairResolvedEvent {
    return event?.version === 1 && event.state === "resolved" && typeof event.checkpointId === "string" &&
        typeof event.workflowAttemptKey === "string" && typeof event.workflow?.planName === "string" &&
        ["continue", "revise", "switch_to_autonomous", "stop"].includes(event.decision) &&
        typeof event.userTurn?.runtimeTurnId === "string" && typeof event.userTurn.requestId === "string" &&
        typeof event.userTurn.attemptId === "string";
}

function isClearedEvent(event: PairCheckpointJournalEvent | null | undefined): event is PairClearedEvent {
    return event?.version === 1 && event.state === "cleared" && typeof event.checkpointId === "string";
}

function currentRequestProvenance(
    hostedSession: HostedSession,
    requireActiveTurn = true,
): PairRequestProvenance | null {
    const sessionManager = getSessionManager(hostedSession);
    const attempt = sessionManager ? readRequestAttemptEntries(sessionManager).at(-1) : null;
    if (!attempt || attempt.phase !== "started") return null;
    const runtimeTurnId = hostedSession.getActiveTurnId?.() ||
        (requireActiveTurn ? "" : `generated:${attempt.requestId}`);
    if (!runtimeTurnId) return null;
    return {
        runtimeTurnId,
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
        dispatchKind: attempt.dispatchKind,
        promptMode: attempt.promptMode,
    };
}

export function readCurrentPairCheckpoint(
    sessionManagerOrHostedSession: SessionManager | HostedSession | null,
): CurrentPairCheckpoint | null {
    const sessionManager = sessionManagerOrHostedSession && "getRootSessionManager" in sessionManagerOrHostedSession
        ? getSessionManager(sessionManagerOrHostedSession)
        : sessionManagerOrHostedSession as SessionManager | null;
    let current: CurrentPairCheckpoint | null = null;
    for (const entry of getEntries(sessionManager)) {
        if (entry.type !== "custom" || entry.customType !== PAIR_CHECKPOINT_CUSTOM_TYPE) continue;
        const event = entry.data;
        if (isReportedEvent(event)) {
            current = { report: event, resolution: null };
            continue;
        }
        if (isResolvedEvent(event) && current?.report.checkpointId === event.checkpointId) {
            current = { ...current, resolution: event };
            continue;
        }
        if (isClearedEvent(event) && current?.report.checkpointId === event.checkpointId) current = null;
    }
    return current;
}

export function recordPairCheckpointReport(args: RecordPairCheckpointReportArgs): CurrentPairCheckpoint {
    const { hostedSession } = args;
    const sessionManager = getSessionManager(hostedSession);
    const workflow = hostedSession.getActiveExecutionWorkflow?.();
    const source = currentRequestProvenance(hostedSession, false);
    if (!sessionManager?.appendCustomEntry || !workflow || !source) {
        throw new Error("pair_checkpoint_report_context_unavailable");
    }
    const previous = readCurrentPairCheckpoint(sessionManager);
    if (previous) {
        sessionManager.appendCustomEntry(
            PAIR_CHECKPOINT_CUSTOM_TYPE,
            {
                version: 1,
                state: "cleared",
                checkpointId: previous.report.checkpointId,
                timestampMs: args.timestampMs ?? Date.now(),
                reason: "superseded",
            } satisfies PairClearedEvent,
        );
    }
    const checkpointNumber = (workflow.pairCheckpointCount || 0) + 1;
    const checkpointWorkflow = { ...workflow, pairCheckpointCount: checkpointNumber };
    delete checkpointWorkflow.pairPauseReason;
    delete checkpointWorkflow.pairStopRequested;
    hostedSession.setActiveExecutionWorkflow(checkpointWorkflow);
    const event: PairReportedEvent = {
        version: 1,
        state: "reported",
        checkpointId: `${args.toolCallId || "pair-checkpoint"}:${crypto.randomUUID()}`,
        checkpointNumber,
        timestampMs: args.timestampMs ?? Date.now(),
        workflowAttemptKey: workflowAttemptKey(checkpointWorkflow),
        workflow: checkpointWorkflow,
        report: { ...args.report, evidence: args.report.evidence ? [...args.report.evidence] : undefined },
        source,
    };
    sessionManager.appendCustomEntry(PAIR_CHECKPOINT_CUSTOM_TYPE, event);
    return { report: event, resolution: null };
}

export function resolvePairCheckpoint(args: ResolvePairCheckpointArgs): ResolvePairCheckpointResult {
    const { hostedSession } = args;
    const sessionManager = getSessionManager(hostedSession);
    const current = readCurrentPairCheckpoint(sessionManager);
    if (!current) return { ok: false, reason: "checkpoint_missing" };
    if (current.report.checkpointId !== args.checkpointId) return { ok: false, reason: "checkpoint_stale" };
    const activeAttempt = workflowAttemptKey(args.workflow);
    if (
        current.report.workflow.planName !== args.workflow.planName ||
        current.report.workflowAttemptKey !== activeAttempt
    ) {
        return { ok: false, reason: "workflow_mismatch" };
    }
    const userTurn = currentRequestProvenance(hostedSession);
    if (!userTurn || userTurn.dispatchKind !== "interactive" || userTurn.promptMode !== "original") {
        return { ok: false, reason: "user_turn_required" };
    }
    if (
        userTurn.runtimeTurnId === current.report.source.runtimeTurnId ||
        userTurn.requestId === current.report.source.requestId
    ) {
        return { ok: false, reason: "later_user_turn_required" };
    }
    if (
        current.resolution?.userTurn.requestId === userTurn.requestId ||
        current.resolution && current.resolution.decision !== "stop" && args.decision !== "revise"
    ) {
        return { ok: false, reason: "checkpoint_already_resolved" };
    }
    const event: PairResolvedEvent = {
        version: 1,
        state: "resolved",
        checkpointId: current.report.checkpointId,
        timestampMs: args.timestampMs ?? Date.now(),
        workflowAttemptKey: activeAttempt,
        workflow: { ...args.workflow },
        decision: args.decision,
        ...(args.revisionDirection ? { revisionDirection: args.revisionDirection } : {}),
        userTurn,
    };
    sessionManager?.appendCustomEntry(PAIR_CHECKPOINT_CUSTOM_TYPE, event);
    return { ok: true, checkpoint: { report: current.report, resolution: event } };
}

export function recordPairCheckpointSnapshot(
    hostedSession: HostedSession,
    checkpoint: CurrentPairCheckpoint,
): void {
    const sessionManager = getSessionManager(hostedSession);
    if (!sessionManager?.appendCustomEntry) return;
    sessionManager.appendCustomEntry(PAIR_CHECKPOINT_CUSTOM_TYPE, checkpoint.report);
    if (checkpoint.resolution) {
        sessionManager.appendCustomEntry(PAIR_CHECKPOINT_CUSTOM_TYPE, checkpoint.resolution);
    }
}

export function clearPairCheckpoint(
    hostedSession: HostedSession,
    reason: PairClearedEvent["reason"],
    timestampMs = Date.now(),
): void {
    const sessionManager = getSessionManager(hostedSession);
    const current = readCurrentPairCheckpoint(sessionManager);
    if (!current || !sessionManager?.appendCustomEntry) return;
    sessionManager.appendCustomEntry(
        PAIR_CHECKPOINT_CUSTOM_TYPE,
        {
            version: 1,
            state: "cleared",
            checkpointId: current.report.checkpointId,
            timestampMs,
            reason,
        } satisfies PairClearedEvent,
    );
}

export function pairCheckpointMatchesWorkflow(
    checkpoint: CurrentPairCheckpoint,
    workflow: import("./hosted-session.js").ActiveExecutionWorkflow,
): boolean {
    return checkpoint.report.workflow.planName === workflow.planName &&
        checkpoint.report.workflowAttemptKey === workflowAttemptKey(workflow);
}

export function restorePairExecutionState(hostedSession: HostedSession): CurrentPairCheckpoint | null {
    const current = readCurrentPairCheckpoint(hostedSession);
    if (!current) return null;
    const snapshot = readExecutionWorkflowSnapshot(hostedSession.getRootSessionManager());
    if (snapshot && !snapshot.workflow) return null;
    if (!snapshot) {
        const owner = readPersistedActiveAgentName(hostedSession.getRootSessionManager() || undefined);
        if (owner && !["engineer", "plan-engineer", "frontend-engineer"].includes(owner)) return null;
        let afterReport = false;
        for (const entry of getEntries(getSessionManager(hostedSession)) as PairLifecycleEntry[]) {
            if (entry.type !== "custom") continue;
            if (
                entry.customType === PAIR_CHECKPOINT_CUSTOM_TYPE &&
                entry.data?.state === "reported" && entry.data.checkpointId === current.report.checkpointId
            ) {
                afterReport = true;
            }
            if (afterReport && entry.customType === "runwield.task_completion" && entry.data?.state === "accepted") {
                return null;
            }
        }
    }
    const activeWorkflow = hostedSession.getActiveExecutionWorkflow?.();
    if (activeWorkflow && !pairCheckpointMatchesWorkflow(current, activeWorkflow)) return null;
    if (!snapshot) {
        hostedSession.setActiveExecutionWorkflow({ ...current.resolution?.workflow || current.report.workflow });
    }
    return current;
}

export function hasFinalPairAssent(
    hostedSession: HostedSession,
    workflow: import("./hosted-session.js").ActiveExecutionWorkflow,
): boolean {
    const current = readCurrentPairCheckpoint(hostedSession);
    return Boolean(
        current && pairCheckpointMatchesWorkflow(current, workflow) &&
            current.report.report.final === true && current.resolution?.decision === "continue",
    );
}

export function formatPairCheckpointContext(current: CurrentPairCheckpoint): string {
    const report = current.report.report;
    const lines = [
        "### Active Pair checkpoint",
        "",
        `Checkpoint ID: ${current.report.checkpointId}`,
        `Checkpoint number: ${current.report.checkpointNumber}`,
        `Final checkpoint: ${report.final ? "yes" : "no"}`,
        `Report: ${report.summary}`,
    ];
    if (report.nextIncrement) lines.push(`Next increment: ${report.nextIncrement}`);
    if (!current.resolution) {
        lines.push(
            "Decision: pending",
            "",
            "Answer questions without changing files. For a clear direction, call pair_checkpoint with action resolve and this checkpoint ID. Do not infer approval from discussion.",
        );
        return lines.join("\n");
    }
    lines.push(`Recorded decision: ${current.resolution.decision}`);
    if (current.resolution.revisionDirection) {
        lines.push(`Revision direction: ${current.resolution.revisionDirection}`);
    }
    const instruction = current.resolution.decision === "stop"
        ? "Pair Execution is stopped. A later user request to resume can resolve this same checkpoint again."
        : current.resolution.decision === "switch_to_autonomous"
        ? "Continue autonomously. Do not report more Pair checkpoints; typed task completion is still required."
        : current.resolution.decision === "revise"
        ? "Apply the recorded revision direction, then report a fresh Pair checkpoint."
        : report.final
        ? "The final checkpoint is accepted. Submit typed task completion."
        : "Continue the approved work, then report a fresh Pair checkpoint.";
    lines.push("", instruction);
    return lines.join("\n");
}
