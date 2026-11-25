import { compareChildPlansByOrder } from "@runwield/plans/format";
import { listSelectablePlanDocuments } from "../../plan-store/index.ts";
import { getCwd } from "../../constants.ts";
import type { CommandCompletionItem } from "../registry.ts";

export async function getLoadPlanCompletions(argumentPrefix: string, cwd = getCwd()): Promise<CommandCompletionItem[]> {
    // Completion is an optional hint. A malformed or unreadable Plan must not
    // reject the editor's background lookup; command execution reports it.
    const plans = await listSelectablePlanDocuments(cwd).catch(() => []);
    // A complete Plan name is ready to submit. Offering it again makes the
    // editor consume Enter as argument completion, depending on lookup timing.
    if (plans.some((plan) => plan.name === argumentPrefix)) return [];
    const matches = plans.filter((plan) => plan.name.startsWith(argumentPrefix));
    const parent = matches[0]?.attrs.parentPlan;
    if (parent && matches.every((plan) => plan.attrs.parentPlan === parent)) {
        matches.sort(compareChildPlansByOrder);
    }
    return matches.map((plan) => ({
        value: plan.name,
        label: plan.name,
        description: `${plan.attrs.classification} - ${plan.attrs.status}`,
    }));
}
