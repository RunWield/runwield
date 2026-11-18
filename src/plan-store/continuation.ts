import { managedPlanStoreActive, readManagedPlan, readManagedPlanResource } from "./managed.ts";
/** Intent-specific continuation queries; callers never read a controller file or patch its fields. */
import { readControllerRecord } from "./controllers.ts";
import { inspectLocalHomeStore } from "./access.ts";
import { findPlanEvidenceById } from "../plan-store.js";

export async function readPlanRecordingContinuation(cwd: string, planId: string) {
    if (managedPlanStoreActive()) {
        const plan = await readManagedPlan(cwd, planId);
        return plan?.attrs.recordingSource ? { planId, planName: plan.attrs.recordingSource.planName } : undefined;
    }
    const record = await readControllerRecord(cwd, { planId, planName: "" });
    return record?.planId === planId && record.state.recordingSource
        ? { planId, planName: record.planName }
        : undefined;
}

export async function readEpicIntegrationReview(cwd: string, planName: string, planId?: string) {
    if (managedPlanStoreActive()) {
        const plan = await readManagedPlan(cwd, planId || planName);
        return { review: plan?.attrs.epicIntegrationReview, revision: plan?.controllerRevision || 0 };
    }
    const record = await readControllerRecord(cwd, { planName, planId });
    return { review: record?.state.epicIntegrationReview, revision: record?.revision || 0 };
}

export async function hasPlanDeliveryEvidence(cwd: string, planName: string, planId: string): Promise<boolean> {
    if (managedPlanStoreActive()) {
        const plan = await readManagedPlanResource(cwd, planId);
        return Boolean(plan && plan.planName === planName && plan.attrs.verifiedAt && plan.attrs.deliveryEvidence);
    }
    if (inspectLocalHomeStore(cwd).kind === "local") {
        const plan = await findPlanEvidenceById(cwd, planId);
        return Boolean(plan && plan.planName === planName && plan.attrs.verifiedAt && plan.attrs.deliveryEvidence);
    }
    const record = await readControllerRecord(cwd, { planName, planId });
    return Boolean(record?.state.verifiedAt && record.state.deliveryEvidence);
}
