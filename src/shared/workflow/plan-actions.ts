import { withProjectRuntimeReadScope } from "../project-runtime-layout.ts";
/** Shared Plan action evidence and lifecycle executor. */

import { findPlanEvidenceById, getPlanRevisionForText, loadPlan, type PlanFrontMatter } from "../../plan-store.js";
import { readPlanActionWorktreeEvidence } from "../worktree-registry.js";
import { getPlanLifecycleActionMetadata, recordPlanEvent } from "./plan-lifecycle.js";
import type { PlanEvent, PlanStatus } from "./plan-lifecycle.js";
import { PlanningNotStartedError } from "./plan-location.ts";

export type PlanActionName =
    | "move_status"
    | "user_verify"
    | "close_without_verification"
    | "put_on_hold"
    | "resume_from_hold"
    | "reset_to_draft";

export type PlanWorktreeExpectation =
    | { kind: "none" }
    | {
          kind: "attempt";
          id: string;
          planId: string;
          status: string;
          branch: string;
          baseBranch: string;
          baseRef: string;
          baseCommit: string;
      };

export type PlanActionRequest = {
    planId: string;
    expectedRevision: string;
    expectedStatus: string;
    expectedWorktree: PlanWorktreeExpectation;
    action: PlanActionName;
    targetStatus?: string;
    holdReason?: string;
    acceptResumeWarnings?: boolean;
    userVerificationNote?: string;
    closedWithoutVerificationReason?: string;
};

export type PlanActionEvidence = {
    planId: string;
    planName: string;
    revision: string;
    status: string;
    worktree: PlanWorktreeExpectation;
};

export type PlanActionResult =
    | { kind: "success"; message: string; evidence: PlanActionEvidence }
    | { kind: "refresh_required"; message: string; evidence: PlanActionEvidence }
    | { kind: "recovery_required"; message: string; entryIds: string[] }
    | { kind: "invalid_action"; message: string }
    | { kind: "activation_unavailable"; message: string };

type WorktreeEntry = {
    id: string;
    planId?: string;
    status: string;
    branch: string;
    baseBranch: string;
    baseRef: string;
    baseCommit: string;
};

const SETTLED_WORKTREE_STATUSES = new Set(["abandoned", "none"]);
type WorktreeEvidenceResult = Awaited<ReturnType<typeof readPlanActionWorktreeEvidence>>;
type WorktreeEvidenceOk = Extract<WorktreeEvidenceResult, { kind: "ok" }>;

type PlanActionAuthority = {
    cwd: string;
    planId: string;
    planName: string;
    attrs: PlanFrontMatter;
    markdown: string;
    revision?: string;
};

type PlanActionAuthorityResult =
    | { kind: "ok"; plan: PlanActionAuthority; registry: WorktreeEvidenceOk }
    | Extract<PlanActionResult, { kind: "recovery_required" | "invalid_action" }>;

function sanitizeMessage(message: string): string {
    if (message.includes("remote-canonical") || message.includes("wld plans pull")) return message;
    if (/[/\\]|[A-Za-z]:/.test(message)) return "Plan action evidence check failed.";
    return message;
}

function toAttemptExpectation(entry: WorktreeEntry): PlanWorktreeExpectation {
    return {
        kind: "attempt",
        id: entry.id,
        planId: entry.planId || "",
        status: entry.status,
        branch: entry.branch,
        baseBranch: entry.baseBranch,
        baseRef: entry.baseRef,
        baseCommit: entry.baseCommit,
    };
}

function sameAttempt(expected: Extract<PlanWorktreeExpectation, { kind: "attempt" }>, current: WorktreeEntry): boolean {
    return (
        expected.id === current.id &&
        expected.planId === (current.planId || "") &&
        expected.status === current.status &&
        expected.branch === current.branch &&
        expected.baseBranch === current.baseBranch &&
        expected.baseRef === current.baseRef &&
        expected.baseCommit === current.baseCommit
    );
}

function currentStatus(attrs: PlanFrontMatter): PlanStatus {
    return String(attrs.status || "draft") as PlanStatus;
}

async function resolvePlanActionAuthority(projectRoot: string, planId: string): Promise<PlanActionAuthorityResult> {
    return await withProjectRuntimeReadScope<PlanActionAuthorityResult>(async () => {
        try {
            const registry = await readPlanActionWorktreeEvidence(projectRoot, planId);
            if (registry.kind !== "ok") {
                return {
                    kind: "recovery_required",
                    message: sanitizeMessage(registry.message),
                    entryIds: registry.entryIds,
                };
            }
            const primaryPlan = await findPlanEvidenceById(projectRoot, planId).catch((error) => {
                if (registry.live) return null;
                throw error;
            });
            if (!primaryPlan) {
                return {
                    kind: "recovery_required",
                    message:
                        "The execution Plan could not be read. Restore its file from Git history or a backup, then try again. Your files are unchanged.",
                    entryIds: registry.live ? [registry.live.id] : [],
                };
            }
            const executionPlan = registry.live?.path
                ? await loadPlan(registry.live.path, primaryPlan.planName).catch(() => null)
                : null;
            if (registry.live && (!executionPlan || executionPlan.attrs.planId !== primaryPlan.planId)) {
                return {
                    kind: "recovery_required",
                    message: "RunWield could not confirm the saved implementation. Your work is unchanged.",
                    entryIds: [registry.live.id],
                };
            }
            const plan: PlanActionAuthority = executionPlan
                ? {
                      cwd: registry.live?.path || projectRoot,
                      planId: primaryPlan.planId,
                      planName: primaryPlan.planName,
                      attrs: executionPlan.attrs,
                      markdown: executionPlan.markdown,
                      revision: executionPlan.revision,
                  }
                : {
                      cwd: projectRoot,
                      planId: primaryPlan.planId,
                      planName: primaryPlan.planName,
                      attrs: primaryPlan.attrs,
                      markdown: primaryPlan.markdown,
                      revision: primaryPlan.revision,
                  };
            return { kind: "ok", plan, registry };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: "invalid_action", message: sanitizeMessage(message) };
        }
    });
}

export async function loadPlanActionEvidence(projectRoot: string, planId: string): Promise<PlanActionResult> {
    const resolved = await resolvePlanActionAuthority(projectRoot, planId);
    if (resolved.kind !== "ok") return resolved;
    const { plan, registry } = resolved;
    const revision = plan.revision || (await getPlanRevisionForText(plan.markdown));
    return {
        kind: "success",
        message: "Plan action evidence loaded.",
        evidence: {
            planId: plan.planId,
            planName: plan.planName,
            revision,
            status: currentStatus(plan.attrs),
            worktree: registry.live ? toAttemptExpectation(registry.live) : { kind: "none" },
        },
    };
}

function validateRequest(request: PlanActionRequest): string | null {
    if (!request.planId || !request.expectedRevision || !request.expectedStatus) {
        return "Plan action requires current Plan evidence.";
    }
    if (!request.expectedWorktree) return "Plan action requires explicit worktree evidence.";
    if (request.action === "move_status" && !request.targetStatus) return "Manual status move requires targetStatus.";
    if (request.action === "user_verify" && !request.userVerificationNote?.trim()) {
        return "A User Verification note is required.";
    }
    if (request.action === "close_without_verification" && !request.closedWithoutVerificationReason?.trim()) {
        return "A close-without-verification reason is required.";
    }
    return null;
}

function eventForRequest(
    request: PlanActionRequest,
    attrs: PlanFrontMatter,
):
    | { event: PlanEvent; details: Record<string, string | PlanFrontMatter | undefined>; message: string }
    | {
          error: string;
      } {
    const status = currentStatus(attrs);
    const metadata = getPlanLifecycleActionMetadata(status, attrs);
    const details: Record<string, string | PlanFrontMatter | undefined> = { triageMeta: attrs };
    if (request.action === "move_status") {
        const targetStatus = String(request.targetStatus || "");
        if (!metadata.allowedManualTargetStatuses.includes(targetStatus as PlanStatus)) {
            return { error: metadata.blockedReasons.move_status || `Manual move to ${targetStatus} is blocked.` };
        }
        details.manualTargetStatus = targetStatus;
        return { event: "manual_status_change", details, message: `Plan moved to ${targetStatus}.` };
    }
    if (request.action === "user_verify") {
        if (!metadata.canUserVerify) return { error: metadata.blockedReasons.user_verify };
        details.userVerificationNote = request.userVerificationNote?.trim();
        return {
            event: "manual_user_verified",
            details,
            message: "Plan marked User Verified. RunWield Workflow Validation was not claimed.",
        };
    }
    if (request.action === "close_without_verification") {
        if (!metadata.canCloseWithoutVerification) return { error: metadata.blockedReasons.close_without_verification };
        details.closedWithoutVerificationReason = request.closedWithoutVerificationReason?.trim();
        return {
            event: "manual_closed_without_verification",
            details,
            message: "Plan closed without Workflow Validation.",
        };
    }
    if (request.action === "put_on_hold") {
        if (!metadata.canPutOnHold) return { error: metadata.blockedReasons.put_on_hold };
        details.holdReason = request.holdReason;
        details.heldFromStatus = status;
        details.holdStalenessBaseline =
            typeof attrs.executionBaselineTree === "string" ? attrs.executionBaselineTree : undefined;
        return {
            event: "plan_held",
            details,
            message:
                attrs.classification === "PROJECT"
                    ? "Epic put on hold. Child Plan statuses were not changed."
                    : "Plan put on hold.",
        };
    }
    if (request.action === "resume_from_hold") {
        if (!metadata.canResumeFromHold) return { error: metadata.blockedReasons.resume_from_hold };
        details.heldFromStatus = typeof attrs.heldFromStatus === "string" ? attrs.heldFromStatus : undefined;
        return { event: "hold_resumed", details, message: `Plan resumed to ${details.heldFromStatus}.` };
    }
    if (request.action === "reset_to_draft") {
        if (!metadata.canResetToDraft) return { error: metadata.blockedReasons.reset_to_draft };
        const worktreeStatus = typeof attrs.worktreeStatus === "string" ? attrs.worktreeStatus : "none";
        if (!SETTLED_WORKTREE_STATUSES.has(worktreeStatus)) {
            return { error: "Reset to draft is blocked until the recorded worktree attempt is abandoned or settled." };
        }
        return {
            event: "hold_reset_to_draft",
            details,
            message: "Held Plan reset to draft after worktree attempt resolution.",
        };
    }
    return { error: "Unknown lifecycle action." };
}

export async function executePlanAction(projectRoot: string, request: PlanActionRequest): Promise<PlanActionResult> {
    const invalid = validateRequest(request);
    if (invalid) return { kind: "invalid_action", message: invalid };
    const resolved = await resolvePlanActionAuthority(projectRoot, request.planId);
    if (resolved.kind !== "ok") return resolved;
    const { plan, registry } = resolved;
    const revision = plan.revision || (await getPlanRevisionForText(plan.markdown));
    const status = currentStatus(plan.attrs);
    const currentEvidence: PlanActionEvidence = {
        planId: plan.planId,
        planName: plan.planName,
        revision,
        status,
        worktree: { kind: "none" },
    };
    if (revision !== request.expectedRevision || status !== request.expectedStatus) {
        return {
            kind: "refresh_required",
            message: "Plan changed after this action loaded. Refresh the Plan and retry.",
            evidence: currentEvidence,
        };
    }
    const live = registry.live;
    currentEvidence.worktree = live ? toAttemptExpectation(live) : { kind: "none" };
    if (request.expectedWorktree.kind === "none" && live) {
        return {
            kind: "recovery_required",
            message: "A worktree attempt appeared after this action loaded. Review recovery before mutating the Plan.",
            entryIds: [live.id],
        };
    }
    if (request.expectedWorktree.kind === "attempt") {
        if (!live) {
            return {
                kind: "recovery_required",
                message: "The expected worktree attempt is no longer active. Review recovery before mutating the Plan.",
                entryIds: [request.expectedWorktree.id],
            };
        }
        if (!sameAttempt(request.expectedWorktree, live)) {
            return {
                kind: "recovery_required",
                message:
                    "The worktree attempt changed after this action loaded. Review recovery before mutating the Plan.",
                entryIds: [live.id, request.expectedWorktree.id],
            };
        }
    }
    const dispatch = eventForRequest(request, plan.attrs);
    if ("error" in dispatch) return { kind: "invalid_action", message: dispatch.error };
    try {
        await recordPlanEvent({
            cwd: plan.cwd,
            planName: plan.planName,
            event: dispatch.event,
            currentStatus: status,
            details: dispatch.details,
            expectedRevision: revision,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("changed on disk")) {
            return {
                kind: "refresh_required",
                message: "Plan changed before the lifecycle mutation committed. Refresh the Plan and retry.",
                evidence: currentEvidence,
            };
        }
        return {
            kind: "invalid_action",
            message: error instanceof PlanningNotStartedError ? error.message : sanitizeMessage(message),
        };
    }
    const next = await loadPlanActionEvidence(projectRoot, plan.planId);
    if (next.kind !== "success") return next;
    return { kind: "success", message: dispatch.message, evidence: next.evidence };
}
