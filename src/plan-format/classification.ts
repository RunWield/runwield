export const PLANS_DIR_NAME = "docs/plans";

/** Canonicalize stored Plan classification. Older Plan files used FEATURE for planned work. */
export function normalizeStoredPlanClassification(
    value: string | null | undefined,
): "QUICK_FIX" | "PLANNED_CHANGE" | "PROJECT" {
    if (value === "PROJECT" || value === "QUICK_FIX") return value;
    return "PLANNED_CHANGE";
}

export function isPlannedChangeClassification(value: string | null | undefined): boolean {
    return value === "PLANNED_CHANGE";
}
