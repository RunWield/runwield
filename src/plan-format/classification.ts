/** Storage-free classification vocabulary shared by routing and Plan text. */
export const ROUTING_INTENT_PLANNED_CHANGE = "PLANNED_CHANGE";
export const LEGACY_ROUTING_INTENT_FEATURE = "FEATURE";
export const WORK_KINDS = ["BUG_FIX", "FEATURE", "REFACTOR", "MAINTENANCE", "DOCUMENTATION"];
export type WorkKind = "BUG_FIX" | "FEATURE" | "REFACTOR" | "MAINTENANCE" | "DOCUMENTATION";
export const PLANS_DIR_NAME = "docs/plans";

export function normalizePlanClassification<T>(value: T): "QUICK_FIX" | "PLANNED_CHANGE" | "PROJECT" {
    if (typeof value !== "string") return ROUTING_INTENT_PLANNED_CHANGE;
    if (value === LEGACY_ROUTING_INTENT_FEATURE) return ROUTING_INTENT_PLANNED_CHANGE;
    if (value === "PROJECT") return "PROJECT";
    if (value === "QUICK_FIX") return "QUICK_FIX";
    return ROUTING_INTENT_PLANNED_CHANGE;
}
export function isPlannedChangeClassification<T>(value: T): boolean {
    return value === ROUTING_INTENT_PLANNED_CHANGE || value === LEGACY_ROUTING_INTENT_FEATURE;
}
export function normalizeWorkKind<T>(value: T): WorkKind | undefined {
    if (typeof value !== "string") return undefined;
    return WORK_KINDS.includes(value) ? (value as WorkKind) : undefined;
}
