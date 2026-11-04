/** Browser-safe interaction values shared with the Hosted Session broker. */
import type { RuntimeInteractionRequest } from "./session-runtime-interactions.ts";
export const RuntimeInteractionTypes = Object.freeze({
    SELECT: "select",
    TEXT: "text",
    APPROVAL: "approval",
    LINK: "link",
    PLAN_REVIEW: "plan_review",
    ARTIFACT_REVIEW: "artifact_review",
    CODE_REVIEW: "code_review",
    PAIR_CHECKPOINT: "pair_checkpoint",
    PLAN_DEVIATION_CONFIRMATION: "plan_deviation_confirmation",
});

export const RuntimeInteractionOutcomes = Object.freeze({
    SELECTED: "selected",
    TEXT: "text",
    ACCEPTED: "accepted",
    CANCELED: "canceled",
    UNSUPPORTED: "unsupported",
    BLOCKED: "blocked",
});

export function isApprovalAcceptedValue(request: RuntimeInteractionRequest, value: string): boolean {
    const options = request.options || [];
    const option = options.find((item) => item.value === value);
    if (option?._meta?.accepted === true || option?._meta?.approvalOutcome === "accepted") return true;
    if (option?._meta?.accepted === false || option?._meta?.approvalOutcome === "declined") return false;
    const acceptedValues = [
        "accept",
        "accepted",
        "approve",
        "approved",
        "yes",
        "true",
        "proceed",
        "continue",
        "confirm",
        "ok",
    ];
    const normalizedValue = value.toLowerCase();
    const normalizedLabel = String(option?.label || "").toLowerCase();
    return acceptedValues.includes(normalizedValue) || acceptedValues.includes(normalizedLabel);
}
