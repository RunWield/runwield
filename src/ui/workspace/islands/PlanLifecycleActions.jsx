import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { useState } from "react";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import {
    lifecycleActionApiPath,
    PLAN_LIFECYCLE_ACTIONS,
    PLAN_UI_TOKEN_HEADER,
    PLAN_UI_TOKEN_QUERY,
} from "../constants.ts";

/**
 * @typedef {Object} PlanLifecycleActionIntent
 * @property {string} planId
 * @property {"move_status"|"user_verify"|"close_without_verification"|"put_on_hold"|"resume_from_hold"|"reset_to_draft"} action
 * @property {string} [fromStatus]
 * @property {string} [targetStatus]
 * @property {string} [holdReason]
 * @property {string} [closedWithoutVerificationReason]
 * @property {string} [userVerificationNote]
 * @property {boolean} [acceptResumeWarnings]
 * @property {string} [expectedRevision]
 */

/**
 * @typedef {Object} MoveStatusIntentOptions
 * @property {string} planId
 * @property {string} fromStatus
 * @property {string} toStatus
 */

/**
 * @typedef {Object} PutOnHoldIntentOptions
 * @property {string} planId
 * @property {string} fromStatus
 * @property {?string} holdReason
 */

/**
 * @typedef {Object} CloseWithoutVerificationIntentOptions
 * @property {string} planId
 * @property {string} fromStatus
 * @property {?string} reason
 */

/**
 * @typedef {Object} UserVerifyIntentOptions
 * @property {string} planId
 * @property {string} fromStatus
 * @property {?string} note
 */

/**
 * @typedef {Object} LifecycleActionMeta
 * @property {string} label
 */

/**
 * @typedef {Object} LifecycleActions
 * @property {Record<string, LifecycleActionMeta>} [metadata]
 */

/**
 * @param {MoveStatusIntentOptions} opts
 * @returns {PlanLifecycleActionIntent}
 */
export function createMoveStatusIntent({ planId, fromStatus, toStatus }) {
    return { planId, fromStatus, action: PLAN_LIFECYCLE_ACTIONS.MOVE_STATUS, targetStatus: toStatus };
}

/**
 * @param {PutOnHoldIntentOptions} opts
 * @returns {?PlanLifecycleActionIntent}
 */
export function createPutOnHoldIntent({ planId, fromStatus, holdReason }) {
    if (holdReason === null) return null;
    return { planId, fromStatus, action: PLAN_LIFECYCLE_ACTIONS.PUT_ON_HOLD, holdReason };
}

/**
 * @param {UserVerifyIntentOptions} opts
 * @returns {?PlanLifecycleActionIntent}
 */
export function createUserVerifyIntent({ planId, fromStatus, note }) {
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

/**
 * @param {CloseWithoutVerificationIntentOptions} opts
 * @returns {?PlanLifecycleActionIntent}
 */
export function createCloseWithoutVerificationIntent({ planId, fromStatus, reason }) {
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

/**
 * @param {LifecycleActions} actions
 * @param {string} action
 * @returns {string}
 */
export function lifecycleActionLabel(actions, action) {
    return String(actions.metadata?.[action]?.label || action.replaceAll("_", " "));
}

/**
 * @param {PlanLifecycleActionIntent} intent
 */
export async function dispatchPlanLifecycleAction(intent) {
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
    const payload = await response.json();
    return { response, payload };
}

/**
 * @param {{
 *   plan: any,
 *   compact?: boolean,
 *   epic?: boolean,
 *   showStatusMoves?: boolean,
 *   showPutOnHold?: boolean,
 *   putOnHoldOnly?: boolean,
 * }} props
 */
export function PlanLifecycleActions({
    plan,
    compact = false,
    epic = false,
    showStatusMoves = true,
    showPutOnHold = true,
    putOnHoldOnly = false,
}) {
    const actions = plan.actions || {};
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState("");
    const [warningIntent, setWarningIntent] = useState(/** @type {PlanLifecycleActionIntent | null} */ (null));
    const disabled = pending;

    /** @param {PlanLifecycleActionIntent} intent */
    async function submit(intent) {
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
                    `${payload.error || "Resume Check needs confirmation."} ${
                        (payload.resumeCheck?.warnings || []).join(" ")
                    }`,
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
    const hasPrimaryControls = hasStatusMoveControls || canShowUserVerify || canShowCloseWithoutVerification ||
        canShowPutOnHold || canShowResumeFromHold || canShowResetToDraft;

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
            {hasPrimaryControls
                ? (
                    <div className="lifecycle-action-list" aria-label="Plan lifecycle actions">
                        {showStatusMoves
                            ? actions.manualTargetOptions?.map(/** @param {any} target */ (target) => (
                                <RunWieldButton
                                    key={target.status}
                                    type="button"
                                    className="lifecycle-action"
                                    disabled={disabled}
                                    data-action="move_status"
                                    data-action-target-status={target.status}
                                    onClick={() =>
                                        submit(createMoveStatusIntent({
                                            planId: plan.planId,
                                            fromStatus: plan.status,
                                            toStatus: target.status,
                                        }))}
                                >
                                    Move to {target.label}
                                </RunWieldButton>
                            ))
                            : null}
                        {canShowPutOnHold
                            ? (
                                <RunWieldButton
                                    type="button"
                                    className="lifecycle-action hold-action"
                                    disabled={disabled}
                                    onClick={hold}
                                >
                                    {putOnHoldLabel}
                                </RunWieldButton>
                            )
                            : null}
                        {canShowUserVerify
                            ? (
                                <RunWieldButton
                                    type="button"
                                    variant="primary"
                                    className="lifecycle-action"
                                    disabled={disabled}
                                    onClick={userVerify}
                                >
                                    {userVerifyLabel}
                                </RunWieldButton>
                            )
                            : null}
                        {canShowCloseWithoutVerification
                            ? (
                                <RunWieldButton
                                    type="button"
                                    variant="danger"
                                    className="lifecycle-action"
                                    disabled={disabled}
                                    onClick={closeWithoutVerification}
                                >
                                    {closeWithoutVerificationLabel}
                                </RunWieldButton>
                            )
                            : null}
                        {canShowResumeFromHold
                            ? (
                                <RunWieldButton
                                    type="button"
                                    disabled={disabled}
                                    variant="primary"
                                    onClick={() =>
                                        submit({
                                            planId: plan.planId,
                                            action: PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD,
                                            fromStatus: plan.status,
                                        })}
                                >
                                    {resumeFromHoldLabel}
                                </RunWieldButton>
                            )
                            : null}
                        {canShowResetToDraft
                            ? (
                                <RunWieldButton
                                    type="button"
                                    className="lifecycle-action"
                                    disabled={disabled}
                                    onClick={() =>
                                        confirm(`${resetToDraftLabel}?`) && submit({
                                            planId: plan.planId,
                                            action: PLAN_LIFECYCLE_ACTIONS.RESET_TO_DRAFT,
                                            fromStatus: plan.status,
                                        })}
                                >
                                    {resetToDraftLabel}
                                </RunWieldButton>
                            )
                            : null}
                    </div>
                )
                : null}
            {warningIntent
                ? (
                    <div className="notice warning resume-warning">
                        <RunWieldButton type="button" disabled={disabled} onClick={() => submit(warningIntent)}>
                            Accept Resume Check warnings and {resumeFromHoldLabel}
                        </RunWieldButton>
                    </div>
                )
                : null}
            {message ? <p className="notice lifecycle-message">{message}</p> : null}
            {pending
                ? (
                    <p className="notice muted">
                        <RunWieldThinkingDots label="Applying lifecycle action" />
                    </p>
                )
                : null}
        </section>
    );
}

export default PlanLifecycleActions;
