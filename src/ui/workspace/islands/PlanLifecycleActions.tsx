import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { useState } from "react";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import {
    lifecycleActionApiPath,
    PLAN_LIFECYCLE_ACTIONS,
    PLAN_UI_TOKEN_HEADER,
    PLAN_UI_TOKEN_QUERY,
} from "../constants.ts";

import type { PlanFrontMatter, PlanResource } from "../../../plan-store.js";
import type { PlanActionRequest } from "../../../shared/workflow/plan-actions.ts";
import type { getPlanLifecycleActionMetadata } from "../../../shared/workflow/plan-lifecycle.js";
import type { ACTION_META, ResumeCheck } from "../server/plan-adapter.js";

export interface PlanLifecycleActionIntent
    extends
        Pick<PlanActionRequest, "planId" | "action">,
        Partial<
            Pick<
                PlanActionRequest,
                | "targetStatus"
                | "holdReason"
                | "closedWithoutVerificationReason"
                | "userVerificationNote"
                | "acceptResumeWarnings"
                | "expectedRevision"
            >
        > {
    fromStatus?: string;
}

export interface MoveStatusIntentOptions {
    planId: PlanLifecycleActionIntent["planId"];
    fromStatus: string;
    toStatus: string;
}

export interface PutOnHoldIntentOptions extends Pick<MoveStatusIntentOptions, "planId" | "fromStatus"> {
    holdReason: string | null;
}

export interface CloseWithoutVerificationIntentOptions extends Pick<MoveStatusIntentOptions, "planId" | "fromStatus"> {
    reason: string | null;
}

export interface UserVerifyIntentOptions extends Pick<MoveStatusIntentOptions, "planId" | "fromStatus"> {
    note: string | null;
}

export type LifecycleActionMeta = Pick<(typeof ACTION_META)[PlanLifecycleActionIntent["action"]], "label">;
type LifecycleActionAvailability = ReturnType<typeof getPlanLifecycleActionMetadata>;

export interface LifecycleTargetOption {
    status: string;
    label: string;
}

export interface LifecycleActions extends Partial<
    Pick<
        LifecycleActionAvailability,
        "canCloseWithoutVerification" | "canUserVerify" | "canPutOnHold" | "canResumeFromHold" | "canResetToDraft"
    >
> {
    metadata?: Record<string, LifecycleActionMeta>;
    manualTargetOptions?: LifecycleTargetOption[];
    terminalMessage?: string;
    holdMessage?: string;
}

export interface PlanLifecycleActionPlan
    extends
        Pick<PlanResource, "planId">,
        Partial<Pick<PlanResource, "revision">>,
        Pick<PlanFrontMatter, "holdReason" | "userVerificationNote" | "closedWithoutVerificationReason"> {
    status: string;
    actions?: LifecycleActions;
}

export interface PlanLifecycleActionsProps {
    plan: PlanLifecycleActionPlan;
    compact?: boolean;
    epic?: boolean;
    showStatusMoves?: boolean;
    showPutOnHold?: boolean;
    putOnHoldOnly?: boolean;
}

export interface PlanLifecycleActionResponse {
    error?: string;
    blockedReason?: string;
    message?: string;
    requiresConfirmation?: boolean;
    resumeCheck?: Partial<Pick<ResumeCheck, "warnings">>;
}

export interface PlanLifecycleDispatchResult {
    response: Response;
    payload: PlanLifecycleActionResponse;
}

export function createMoveStatusIntent({
    planId,
    fromStatus,
    toStatus,
}: MoveStatusIntentOptions): PlanLifecycleActionIntent {
    return { planId, fromStatus, action: PLAN_LIFECYCLE_ACTIONS.MOVE_STATUS, targetStatus: toStatus };
}

export function createPutOnHoldIntent({
    planId,
    fromStatus,
    holdReason,
}: PutOnHoldIntentOptions): PlanLifecycleActionIntent | null {
    if (holdReason === null) return null;
    return { planId, fromStatus, action: PLAN_LIFECYCLE_ACTIONS.PUT_ON_HOLD, holdReason };
}

export function createUserVerifyIntent({
    planId,
    fromStatus,
    note,
}: UserVerifyIntentOptions): PlanLifecycleActionIntent | null {
    if (note === null) return null;
    const userVerificationNote = String(note || "").trim();
    if (!userVerificationNote) return null;
    return {
        planId,
        fromStatus,
        action: PLAN_LIFECYCLE_ACTIONS.USER_VERIFY,
        userVerificationNote,
    };
}

export function createCloseWithoutVerificationIntent({
    planId,
    fromStatus,
    reason,
}: CloseWithoutVerificationIntentOptions): PlanLifecycleActionIntent | null {
    if (reason === null) return null;
    const closedWithoutVerificationReason = String(reason || "").trim();
    if (!closedWithoutVerificationReason) return null;
    return {
        planId,
        fromStatus,
        action: PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION,
        closedWithoutVerificationReason,
    };
}

export function lifecycleActionLabel(actions: LifecycleActions, action: string) {
    return String(actions.metadata?.[action]?.label || action.replaceAll("_", " "));
}

export async function dispatchPlanLifecycleAction(
    intent: PlanLifecycleActionIntent,
): Promise<PlanLifecycleDispatchResult> {
    const url = new URL(location.href);
    const token = url.searchParams.get(PLAN_UI_TOKEN_QUERY) || "";
    const response = await fetch(lifecycleActionApiPath(intent.planId), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { [PLAN_UI_TOKEN_HEADER]: token } : {}),
        },
        body: JSON.stringify(intent),
    });
    const payload: PlanLifecycleActionResponse = await response.json();
    return { response, payload };
}

export function PlanLifecycleActions({
    plan,
    compact = false,
    epic = false,
    showStatusMoves = true,
    showPutOnHold = true,
    putOnHoldOnly = false,
}: PlanLifecycleActionsProps) {
    const actions: LifecycleActions = plan.actions || {};
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState("");
    const [warningIntent, setWarningIntent] = useState<PlanLifecycleActionIntent | null>(null);
    const disabled = pending;

    async function submit(intent: PlanLifecycleActionIntent) {
        setPending(true);
        setMessage("");
        try {
            const { response, payload } = await dispatchPlanLifecycleAction({
                ...intent,
                expectedRevision: plan.revision || intent.expectedRevision,
            });
            if (response.status === 409 && payload.requiresConfirmation) {
                setWarningIntent({ ...intent, acceptResumeWarnings: true });
                setMessage(
                    `${payload.error || "Resume Check needs confirmation."} ${(
                        payload.resumeCheck?.warnings || []
                    ).join(" ")}`,
                );
                return;
            }
            if (!response.ok) {
                setMessage(payload.blockedReason || payload.error || "Lifecycle action was blocked.");
                return;
            }
            setMessage(payload.message || "Lifecycle action applied.");
            location.reload();
        } finally {
            setPending(false);
        }
    }

    function hold() {
        const promptText = epic
            ? "Optional hold reason for this Epic. Child Plan statuses will not be changed."
            : "Optional hold reason for this Plan.";
        const intent = createPutOnHoldIntent({
            planId: plan.planId,
            fromStatus: plan.status,
            holdReason: prompt(promptText, plan.holdReason || ""),
        });
        if (intent) submit(intent);
    }

    function userVerify() {
        const note = prompt(
            "Required user verification note. This records your attestation and does not claim RunWield Workflow Validation.",
            plan.userVerificationNote || "",
        );
        if (note === null) return;
        const intent = createUserVerifyIntent({
            planId: plan.planId,
            fromStatus: plan.status,
            note,
        });
        if (!intent) {
            setMessage("A User Verification note is required.");
            return;
        }
        submit(intent);
    }

    function closeWithoutVerification() {
        const reason = prompt(
            "Required reason for closing without RunWield Workflow Validation.",
            plan.closedWithoutVerificationReason || "",
        );
        if (reason === null) return;
        const intent = createCloseWithoutVerificationIntent({
            planId: plan.planId,
            fromStatus: plan.status,
            reason,
        });
        if (!intent) {
            setMessage("A close-without-verification reason is required.");
            return;
        }
        submit(intent);
    }

    const putOnHoldLabel = lifecycleActionLabel(actions, PLAN_LIFECYCLE_ACTIONS.PUT_ON_HOLD);
    const userVerifyLabel = lifecycleActionLabel(actions, PLAN_LIFECYCLE_ACTIONS.USER_VERIFY);
    const closeWithoutVerificationLabel = lifecycleActionLabel(
        actions,
        PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION,
    );
    const resumeFromHoldLabel = lifecycleActionLabel(actions, PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD);
    const resetToDraftLabel = lifecycleActionLabel(actions, PLAN_LIFECYCLE_ACTIONS.RESET_TO_DRAFT);

    const canShowPutOnHold = showPutOnHold && actions.canPutOnHold;
    const canShowUserVerify = !putOnHoldOnly && actions.canUserVerify;
    const canShowCloseWithoutVerification = !putOnHoldOnly && actions.canCloseWithoutVerification;
    const canShowResumeFromHold = !putOnHoldOnly && actions.canResumeFromHold;
    const canShowResetToDraft = !putOnHoldOnly && actions.canResetToDraft;
    const hasStatusMoveControls = !putOnHoldOnly && showStatusMoves && actions.manualTargetOptions?.length;
    const hasPrimaryControls =
        hasStatusMoveControls ||
        canShowUserVerify ||
        canShowCloseWithoutVerification ||
        canShowPutOnHold ||
        canShowResumeFromHold ||
        canShowResetToDraft;

    if (putOnHoldOnly && !canShowPutOnHold) return null;

    return (
        <section
            className={`${compact ? "lifecycle-actions compact" : "lifecycle-actions"}${
                putOnHoldOnly ? " hold-action-only" : ""
            }`}
            data-plan-id={plan.planId}
        >
            {actions.terminalMessage ? <p className="terminal-message">{actions.terminalMessage}</p> : null}
            {plan.status === "on_hold" ? <p className="hold-message">{actions.holdMessage}</p> : null}
            {hasPrimaryControls ? (
                <div className="lifecycle-action-list" aria-label="Plan lifecycle actions">
                    {showStatusMoves
                        ? actions.manualTargetOptions?.map((target) => (
                              <RunWieldButton
                                  key={target.status}
                                  type="button"
                                  className="lifecycle-action"
                                  disabled={disabled}
                                  data-action="move_status"
                                  data-action-target-status={target.status}
                                  onClick={() =>
                                      submit(
                                          createMoveStatusIntent({
                                              planId: plan.planId,
                                              fromStatus: plan.status,
                                              toStatus: target.status,
                                          }),
                                      )
                                  }
                              >
                                  Move to {target.label}
                              </RunWieldButton>
                          ))
                        : null}
                    {canShowPutOnHold ? (
                        <RunWieldButton
                            type="button"
                            className="lifecycle-action hold-action"
                            disabled={disabled}
                            onClick={hold}
                        >
                            {putOnHoldLabel}
                        </RunWieldButton>
                    ) : null}
                    {canShowUserVerify ? (
                        <RunWieldButton
                            type="button"
                            variant="primary"
                            className="lifecycle-action"
                            disabled={disabled}
                            onClick={userVerify}
                        >
                            {userVerifyLabel}
                        </RunWieldButton>
                    ) : null}
                    {canShowCloseWithoutVerification ? (
                        <RunWieldButton
                            type="button"
                            variant="danger"
                            className="lifecycle-action"
                            disabled={disabled}
                            onClick={closeWithoutVerification}
                        >
                            {closeWithoutVerificationLabel}
                        </RunWieldButton>
                    ) : null}
                    {canShowResumeFromHold ? (
                        <RunWieldButton
                            type="button"
                            disabled={disabled}
                            variant="primary"
                            onClick={() =>
                                submit({
                                    planId: plan.planId,
                                    action: PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD,
                                    fromStatus: plan.status,
                                })
                            }
                        >
                            {resumeFromHoldLabel}
                        </RunWieldButton>
                    ) : null}
                    {canShowResetToDraft ? (
                        <RunWieldButton
                            type="button"
                            className="lifecycle-action"
                            disabled={disabled}
                            onClick={() =>
                                confirm(`${resetToDraftLabel}?`) &&
                                submit({
                                    planId: plan.planId,
                                    action: PLAN_LIFECYCLE_ACTIONS.RESET_TO_DRAFT,
                                    fromStatus: plan.status,
                                })
                            }
                        >
                            {resetToDraftLabel}
                        </RunWieldButton>
                    ) : null}
                </div>
            ) : null}
            {warningIntent ? (
                <div className="notice warning resume-warning">
                    <RunWieldButton type="button" disabled={disabled} onClick={() => submit(warningIntent)}>
                        Accept Resume Check warnings and {resumeFromHoldLabel}
                    </RunWieldButton>
                </div>
            ) : null}
            {message ? <p className="notice lifecycle-message">{message}</p> : null}
            {pending ? (
                <p className="notice muted">
                    <RunWieldThinkingDots label="Applying lifecycle action" />
                </p>
            ) : null}
        </section>
    );
}

export default PlanLifecycleActions;
