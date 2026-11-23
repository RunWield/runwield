/** PROJECT containers share storage and child execution; type selects planning capabilities. */
export interface ProjectPlanMetadata {
    classification?: string;
    type?: string;
}

export type ProjectPlanType = "epic" | "sequence";

export function isProjectPlan(attrs: ProjectPlanMetadata | null | undefined): boolean {
    return attrs?.classification === "PROJECT";
}

export function projectPlanType(attrs: ProjectPlanMetadata): ProjectPlanType | undefined {
    if (!isProjectPlan(attrs)) return undefined;
    if (attrs.type === undefined || attrs.type === "epic") return "epic";
    if (attrs.type === "sequence") return "sequence";
    throw new Error(`Unsupported PROJECT type "${attrs.type}". Use epic or sequence.`);
}

export function isSequencePlan(attrs: ProjectPlanMetadata | null | undefined): boolean {
    return isProjectPlan(attrs) && attrs?.type === "sequence";
}

export function isEpicPlan(attrs: ProjectPlanMetadata | null | undefined): boolean {
    return isProjectPlan(attrs) && (attrs?.type === undefined || attrs?.type === "epic");
}
