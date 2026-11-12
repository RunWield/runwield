import { seedPlan } from "./plan-state-fixture.ts";
import { loadPlan } from "../../plan-store/index.ts";

import { withLocalPlanWorkflow } from "../../plan-store/index.ts";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";

/** Establish real review and readiness evidence for a fixture's saved proposal. */
export async function approvePlanForExecution(root: string, name: string): Promise<void> {
    await withLocalPlanWorkflow(root, name, async () => {
        const plan = await loadPlan(root, name);
        if (!plan) throw new Error(`Missing fixture Plan: ${name}`);
        if (plan.attrs.status !== "draft") {
            await recordPlanEvent({
                cwd: root,
                planName: name,
                event: "review_reopened",
                currentStatus: plan.attrs.status,
            });
        }
        await recordPlanEvent({ cwd: root, planName: name, event: "review_approved", currentStatus: "draft" });
        await recordPlanEvent({ cwd: root, planName: name, event: "readiness_passed", currentStatus: "approved" });
    });
}

/** Author a fresh execution fixture, retaining real review evidence rather than only a status label. */
export async function savePlanWithReadiness(...args: Parameters<typeof seedPlan>) {
    const [root, name, , attrs] = args;
    const existing = await loadPlan(root, name);
    const path = await seedPlan(...args);
    if (!existing && attrs?.status === "ready_for_work") await approvePlanForExecution(root, name);
    return path;
}
