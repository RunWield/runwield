import process from "node:process";
import { loadPlan } from "../../../plan-store.js";
import { resolvePlanWithPrimaryRecovery } from "../../../cmd/load-plan/primary-plan-recovery.ts";

const [root, planName] = process.argv.slice(2);
if (!root || !planName) throw new Error("A project and Plan are required.");
const { plan } = await resolvePlanWithPrimaryRecovery(root, planName);
const direct = await loadPlan(root, planName);
console.log(JSON.stringify({
    path: plan.path,
    status: plan.attrs.status,
    worktreeId: plan.attrs.worktreeId,
    worktreeStatus: plan.attrs.worktreeStatus,
    validationCiAttempts: plan.attrs.validationCiAttempts,
    checkpoint: plan.attrs.validationCheckpoint,
    primaryStatus: direct?.attrs.status,
}));
