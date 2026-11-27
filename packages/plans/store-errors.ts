export class StalePlanWriteError extends Error {
    declare expectedRevision: string;
    declare currentRevision: string;

    constructor(expectedRevision: string, currentRevision: string) {
        super("Plan changed on disk after this operation loaded it.");
        this.name = "StalePlanWriteError";
        this.expectedRevision = expectedRevision;
        this.currentRevision = currentRevision;
    }
}

export class PlanNotFoundError extends Error {
    constructor(planId: string) {
        super(`Plan not found for planId: ${planId}`);
        this.name = "PlanNotFoundError";
    }
}
