export interface PlanRecord {
    id: string;
    title: string;
    body: string;
    archivedAt?: string;
}
export interface ListOptions {
    archivedOnly: boolean;
}
export type PlanArea = "active" | "archived";

export function validateId(id: string): void {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Invalid Plan id");
}
