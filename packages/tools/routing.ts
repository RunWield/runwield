export const ROUTING_INTENT_PLANNED_CHANGE = "PLANNED_CHANGE";

/** Routing intents that a Router can submit. */
export const ROUTING_INTENTS = [
    "INQUIRY",
    "IDEATION",
    "OPERATION",
    "QUICK_FIX",
    ROUTING_INTENT_PLANNED_CHANGE,
    "PROJECT",
] as const;

export type RoutingIntent = (typeof ROUTING_INTENTS)[number];

export function normalizeRoutingIntent(value: string | null | undefined): RoutingIntent | null {
    return ROUTING_INTENTS.find((intent) => intent === value) ?? null;
}

/** A retired label invalidates either routing field, even when the other field is valid. */
export function hasRetiredRoutingIntent(
    routingIntent: string | undefined,
    classification: string | undefined,
): boolean {
    return routingIntent === "FEATURE" || classification === "FEATURE";
}

export const WORK_KINDS = ["BUG_FIX", "FEATURE", "REFACTOR", "MAINTENANCE", "DOCUMENTATION"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

export function normalizeWorkKind(value: string | null | undefined): WorkKind | undefined {
    return WORK_KINDS.find((kind) => kind === value);
}
