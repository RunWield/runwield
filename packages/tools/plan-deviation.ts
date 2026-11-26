import type { PlanDeviationParameters } from "./definitions/plan-deviation.ts";

/** Trim the confirmation text, dropping an omitted or blank reason. */
export function preparePlanDeviation(params: PlanDeviationParameters): PlanDeviationParameters {
    const reason = params.reason?.trim();
    return {
        supersededRequirement: params.supersededRequirement.trim(),
        replacementRequirement: params.replacementRequirement.trim(),
        ...(reason ? { reason } : {}),
    };
}
