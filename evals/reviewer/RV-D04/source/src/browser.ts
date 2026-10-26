import type { PlanRef, PlanSummary } from "./model.ts";
import { PlanRepository } from "./repository.ts";
import { summarize } from "./summary.ts";

export class SummaryBrowser {
    constructor(private readonly repository: PlanRepository) {}
    async load(ref: PlanRef): Promise<PlanSummary> {
        return summarize(await this.repository.read(ref));
    }
}
