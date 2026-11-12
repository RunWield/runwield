/** Intent-specific continuation queries; callers never read a controller file or patch its fields. */
import { readControllerRecord } from "./controllers.ts";
import { inspectLocalHomeStore } from "./access.ts";
import { findPlanEvidenceById } from "../plan-store.js";

export async function readPlanRecordingContinuation(cwd: string, planId: string) {
    const record = await readControllerRecord(cwd, { planId, planName: "" });
    return record?.planId === planId && record.state.recordingSource
        ? { planId, planName: record.planName }
        : undefined;
}

export async function readEpicIntegrationReview(cwd: string, planName: string, planId?: string) {
    const record = await readControllerRecord(cwd, { planName, planId });
    return { review: record?.state.epicIntegrationReview, revision: record?.revision || 0 };
}

export async function hasPlanDeliveryEvidence(cwd: string, planName: string, planId: string): Promise<boolean> {
    if (inspectLocalHomeStore(cwd).kind === "local") {
        const plan = await findPlanEvidenceById(cwd, planId);
        return Boolean(plan && plan.planName === planName && plan.attrs.verifiedAt && plan.attrs.deliveryEvidence);
    }
    const record = await readControllerRecord(cwd, { planName, planId });
    return Boolean(record?.state.verifiedAt && record.state.deliveryEvidence);
}
