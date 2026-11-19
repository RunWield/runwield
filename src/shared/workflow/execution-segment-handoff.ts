import type { PlanActionEvidence } from "./plan-actions.ts";
import { loadPlanActionEvidence } from "./plan-actions.ts";

export type HandoffRejectionKind = "refresh_required" | "recovery_required";

export type HandoffRejection = {
    kind: HandoffRejectionKind;
    message: string;
};

export type HandoffImage = { base64: string; mimeType: string };

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
type SegmentExecutionState = { executionCwd?: string; baselineTree?: string };
type SegmentReviewLedger = import("./review-ledger.ts").ReviewLedger;

/**
 * Who resumes a handed-off segment. New markers name a runtime Plan executor;
 * `engineer` is accepted so a marker written before the split still resumes.
 */
export type HandoffExecutionOwner = "engineer" | "plan-engineer" | "frontend-engineer";

const HANDOFF_EXECUTION_OWNERS: ReadonlySet<string> = new Set<HandoffExecutionOwner>([
    "engineer",
    "plan-engineer",
    "frontend-engineer",
]);

export type ExecutionSegmentContinuation = {
    version: 1;
    kind: "execution";
    session: { runwieldSessionId: string; stableSessionId?: string };
    plan: { planId: string; planName: string; approvedRevision: string; approvedStatus: string; markdown: string };
    approval: { feedback?: string; images: HandoffImage[] };
    preparedEvidence: PlanActionEvidence;
    activeWorkflow: import("../session/execution-workflow-session.ts").ActiveExecutionWorkflow;
    /** Runtime Agent that resumes the segment. `engineer` only appears in markers written before the Plan Engineer split. */
    executionOwner: HandoffExecutionOwner;
    collaboration: { style: "autonomous" | "pair"; recommendation: "autonomous" | "pair" };
};

export type SemanticRepairSegmentContinuation = {
    version: 1;
    kind: "semantic_repair";
    session: { runwieldSessionId: string; stableSessionId?: string };
    plan: { planId: string; planName: string; approvedRevision: string; approvedStatus: string; markdown: string };
    preparedEvidence: PlanActionEvidence;
    activeWorkflow: import("../session/execution-workflow-session.ts").ActiveExecutionWorkflow;
    /** Runtime Agent that resumes the segment. `engineer` only appears in markers written before the Plan Engineer split. */
    executionOwner: HandoffExecutionOwner;
    repair: {
        semanticRound: number;
        repairGeneration: string;
        reviewLedger: JsonValue | SegmentReviewLedger;
        repairBaselineTree?: string;
        lastRepairReport?: string;
        executionState: JsonValue | SegmentExecutionState;
        ciState: JsonValue;
        priorRepairClaims: string[];
        diffText: string;
        findingsSection: string;
    };
};

export type SegmentHandoffContinuation = ExecutionSegmentContinuation | SemanticRepairSegmentContinuation;

export type SegmentHandoffPayload = JsonValue | SegmentHandoffContinuation;

export type PendingSegmentMarker = {
    payload: SegmentHandoffPayload;
    entryIndex: number;
    entries: Array<{ type?: string; role?: string; customType?: string }>;
};

export type ResolvedPendingSegmentHandoff =
    | { kind: "pending"; continuation: SegmentHandoffContinuation }
    | { kind: "consumed" }
    | { kind: "absent" }
    | { kind: "refresh_required"; message: string }
    | { kind: "recovery_required"; message: string };

export type BuildExecutionContinuationArgs = {
    runwieldSessionId: string;
    stableSessionId?: string;
    planId: string;
    planName: string;
    approvedRevision: string;
    approvedStatus: string;
    approvedMarkdown: string;
    approvalFeedback?: string;
    approvalImages?: HandoffImage[];
    preparedEvidence: PlanActionEvidence;
    activeWorkflow: import("../session/execution-workflow-session.ts").ActiveExecutionWorkflow;
    executionOwner: "plan-engineer" | "frontend-engineer";
    collaborationStyle: "autonomous" | "pair";
    collaborationRecommendation: "autonomous" | "pair";
};

export type BuildSemanticRepairContinuationArgs = {
    runwieldSessionId: string;
    stableSessionId?: string;
    planId: string;
    planName: string;
    approvedRevision: string;
    approvedStatus: string;
    approvedMarkdown: string;
    preparedEvidence: PlanActionEvidence;
    activeWorkflow: import("../session/execution-workflow-session.ts").ActiveExecutionWorkflow;
    executionOwner: "plan-engineer" | "frontend-engineer";
    semanticRound: number;
    repairGeneration: string;
    reviewLedger: JsonValue | SegmentReviewLedger;
    repairBaselineTree?: string;
    lastRepairReport?: string;
    executionState?: JsonValue;
    ciState?: JsonValue;
    priorRepairClaims?: string[];
    diffText: string;
    findingsSection: string;
};

export function buildExecutionSegmentContinuation(args: BuildExecutionContinuationArgs): ExecutionSegmentContinuation {
    return {
        version: 1,
        kind: "execution",
        session: sessionIdentity(args),
        plan: planIdentity(args),
        approval: { feedback: args.approvalFeedback, images: normalizeImages(args.approvalImages || []) },
        preparedEvidence: args.preparedEvidence,
        activeWorkflow: args.activeWorkflow,
        executionOwner: args.executionOwner,
        collaboration: { style: args.collaborationStyle, recommendation: args.collaborationRecommendation },
    };
}

export function buildSemanticRepairSegmentContinuation(
    args: BuildSemanticRepairContinuationArgs,
): SemanticRepairSegmentContinuation {
    if (!Number.isInteger(args.semanticRound) || args.semanticRound < 1) {
        throw new Error("semantic repair handoff requires a positive semantic round");
    }
    if (!args.repairGeneration.trim()) {
        throw new Error("semantic repair handoff requires a repair generation");
    }
    return {
        version: 1,
        kind: "semantic_repair",
        session: sessionIdentity(args),
        plan: planIdentity(args),
        preparedEvidence: args.preparedEvidence,
        activeWorkflow: args.activeWorkflow,
        executionOwner: args.executionOwner,
        repair: {
            semanticRound: args.semanticRound,
            repairGeneration: args.repairGeneration,
            reviewLedger: args.reviewLedger,
            repairBaselineTree: args.repairBaselineTree,
            lastRepairReport: args.lastRepairReport,
            executionState: args.executionState ?? null,
            ciState: args.ciState ?? null,
            priorRepairClaims: args.priorRepairClaims || [],
            diffText: args.diffText,
            findingsSection: args.findingsSection,
        },
    };
}

export async function resolvePendingSegmentHandoff(args: {
    marker: PendingSegmentMarker | null;
    projectRoot: string;
    runwieldSessionId: string;
}): Promise<ResolvedPendingSegmentHandoff> {
    if (!args.marker) return { kind: "absent" };
    if (hasLaterTurnEntry(args.marker.entries, args.marker.entryIndex)) return { kind: "consumed" };
    const parsed = parseContinuation(args.marker.payload);
    if (parsed.kind !== "ok") return parsed.result;
    const continuation = parsed.continuation;
    if (continuation.session.runwieldSessionId !== args.runwieldSessionId) {
        return { kind: "recovery_required", message: "Segment handoff belongs to a different Session." };
    }
    const evidence = await loadPlanActionEvidence(args.projectRoot, continuation.plan.planId);
    if (evidence.kind === "refresh_required" || evidence.kind === "invalid_action") {
        return { kind: "refresh_required", message: evidence.message };
    }
    if (evidence.kind === "recovery_required" || evidence.kind === "activation_unavailable") {
        return { kind: "recovery_required", message: evidence.message };
    }
    if (!sameEvidence(evidence.evidence, continuation.preparedEvidence)) {
        return {
            kind: "refresh_required",
            message: "Plan or worktree evidence changed after the handoff was prepared.",
        };
    }
    return { kind: "pending", continuation };
}

function sessionIdentity(args: { runwieldSessionId: string; stableSessionId?: string }) {
    if (!args.runwieldSessionId.trim()) throw new Error("handoff requires a Session identity");
    return { runwieldSessionId: args.runwieldSessionId, stableSessionId: args.stableSessionId };
}

function planIdentity(args: {
    planId: string;
    planName: string;
    approvedRevision: string;
    approvedStatus: string;
    approvedMarkdown: string;
}) {
    if (!args.planId.trim() || !args.planName.trim() || !args.approvedRevision.trim() || !args.approvedStatus.trim()) {
        throw new Error("handoff requires complete Plan identity");
    }
    return {
        planId: args.planId,
        planName: args.planName,
        approvedRevision: args.approvedRevision,
        approvedStatus: args.approvedStatus,
        markdown: args.approvedMarkdown,
    };
}

function normalizeImages(images: HandoffImage[]): HandoffImage[] {
    return images.map((image) => {
        if (!image.base64.trim() || !image.mimeType.trim()) throw new Error("handoff image payload is malformed");
        return { base64: image.base64, mimeType: image.mimeType };
    });
}

function parseContinuation(payload: SegmentHandoffPayload):
    | { kind: "ok"; continuation: SegmentHandoffContinuation }
    | { kind: "refresh_required" | "recovery_required"; result: HandoffRejection } {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
            kind: "recovery_required",
            result: { kind: "recovery_required", message: "Segment handoff marker is malformed." },
        };
    }
    const candidate = payload as {
        version?: number;
        kind?: string;
        session?: { runwieldSessionId?: string };
        plan?: { planId?: string; planName?: string; approvedRevision?: string; approvedStatus?: string };
        preparedEvidence?: PlanActionEvidence;
        executionOwner?: string;
    };
    if (candidate.version !== 1) {
        return {
            kind: "recovery_required",
            result: { kind: "recovery_required", message: "Segment handoff marker version is unsupported." },
        };
    }
    if (candidate.kind !== "execution" && candidate.kind !== "semantic_repair") {
        return {
            kind: "recovery_required",
            result: { kind: "recovery_required", message: "Segment handoff marker kind is unsupported." },
        };
    }
    if (
        !candidate.session?.runwieldSessionId || !candidate.plan?.planId || !candidate.plan?.planName ||
        !candidate.plan?.approvedRevision || !candidate.plan?.approvedStatus || !candidate.preparedEvidence
    ) {
        return {
            kind: "recovery_required",
            result: { kind: "recovery_required", message: "Segment handoff marker is missing identity or evidence." },
        };
    }
    // A marker carries the runtime Agent that will resume the segment. `engineer`
    // stays valid because a marker written before the Plan Engineer split says
    // that; the resumer resolves it to Plan Engineer.
    if (!HANDOFF_EXECUTION_OWNERS.has(candidate.executionOwner ?? "")) {
        return {
            kind: "recovery_required",
            result: { kind: "recovery_required", message: "Segment handoff marker has an invalid execution owner." },
        };
    }
    return { kind: "ok", continuation: candidate as SegmentHandoffContinuation };
}

function hasLaterTurnEntry(entries: PendingSegmentMarker["entries"], markerIndex: number): boolean {
    for (let index = markerIndex + 1; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.type === "message") return true;
        if (entry.type === "user" || entry.type === "assistant" || entry.type === "tool_result") return true;
        if (entry.role === "user" || entry.role === "assistant" || entry.role === "tool") return true;
    }
    return false;
}

function sameEvidence(left: PlanActionEvidence, right: PlanActionEvidence): boolean {
    return left.planId === right.planId && left.planName === right.planName && left.revision === right.revision &&
        left.status === right.status && JSON.stringify(left.worktree) === JSON.stringify(right.worktree);
}
