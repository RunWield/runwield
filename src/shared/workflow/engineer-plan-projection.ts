import { parsePlanFrontMatter, renderApprovedPlanDeviations } from "@runwield/plans/format";

/** Return the only Plan definition content that an execution Agent can receive. */
export function projectEngineerPlanBody(planContent: string): string {
    const parsed = parsePlanFrontMatter(planContent);
    const body = parsed.body.trim();
    const deviations = renderApprovedPlanDeviations(parsed.attrs.planDeviations);
    return [body, deviations].filter(Boolean).join("\n\n");
}
