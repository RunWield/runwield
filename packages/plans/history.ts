import type { PlanId } from "./identity.ts";

export type { PackageDocuments } from "./package-data.ts";

export interface PlanMilestoneEvent {
    milestone: "approved" | "delivered" | "closed" | "archived";
    at: string;
    reason: string;
}

export interface PlanMilestone extends PlanMilestoneEvent {
    version: string;
    digest: string;
}

export interface PlanHistory {
    planId: PlanId;
    revision: string;
    milestones: PlanMilestone[];
}

export function isPlanMilestoneVersion<T>(value: T): value is T & string {
    return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}

export function isPlanMilestone<T>(value: T): value is T & PlanMilestone {
    return (
        value !== null &&
        typeof value === "object" &&
        Object.keys(value).length === 5 &&
        "version" in value &&
        isPlanMilestoneVersion(value.version) &&
        "milestone" in value &&
        (value.milestone === "approved" ||
            value.milestone === "delivered" ||
            value.milestone === "closed" ||
            value.milestone === "archived") &&
        "at" in value &&
        typeof value.at === "string" &&
        "reason" in value &&
        typeof value.reason === "string" &&
        "digest" in value &&
        typeof value.digest === "string" &&
        /^[0-9a-f]{64}$/.test(value.digest)
    );
}
