export interface PlanRef {
    projectId: string;
    ownerId: string;
    planId: string;
    name: string;
}
export interface PlanDocument {
    title: string;
    body: string;
}
export interface PlanSummary {
    title: string;
    excerpt: string;
    words: number;
}
