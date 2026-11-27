import { isPersistedPlanId } from "@runwield/project-runtime/publication-evidence";

declare const planIdBrand: unique symbol;

/** Stable Plan identifier. Legacy Plans may have non-UUID IDs. */
export type PlanId = string & { readonly [planIdBrand]: true };

export function normalizePlanId<T>(value: T): PlanId | undefined {
    const trimmed = typeof value === "string" ? value.trim() : undefined;
    return isPlanId(trimmed) ? trimmed : undefined;
}

export function isPlanId(value: string | null | undefined): value is PlanId {
    return isPersistedPlanId(value);
}
