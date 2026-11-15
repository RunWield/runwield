/**
 * Real-store fixture setup for legacy and interrupted states that authoring cannot create.
 * Consumer journeys use these only to arrange evidence; exercise behavior through plan-store/index.ts.
 * This module is an explicit test-only member of the Plan persistence boundary, never a production API.
 */
import { savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { readControllerRecord, writeControllerState } from "../../plan-store/controllers.ts";

export async function seedPlan(...args: Parameters<typeof savePlan>) {
    return await savePlan(...args);
}
/** Arrange a persisted lifecycle/checkpoint state without simulating the workflow that produced it. */
export async function seedPlanState(...args: Parameters<typeof updatePlanFrontMatter>) {
    return await updatePlanFrontMatter(...args);
}
/** Arrange a partial or interrupted controller write for recovery qualification. */
export async function seedPlanController(...args: Parameters<typeof writeControllerState>) {
    return await writeControllerState(...args);
}
/** Observe real durable controller evidence, including deliberately incomplete fixture states. */
export async function inspectPlanFixtureController(...args: Parameters<typeof readControllerRecord>) {
    return await readControllerRecord(...args);
}

import { getStoredPlanPath, getPlanDocumentRoot, withPlanLock, withPlanCatalogLock } from "../../plan-store.js";
import { getTransitionJournalDir, getTransitionJournalPath } from "../../plan-store/transitions.ts";
import { controllerRecordPath } from "../../plan-store/controllers.ts";
/** Locate a deliberately retained legacy document for filesystem corruption/recovery fixtures. */
export function legacyPlanFixturePath(...args: Parameters<typeof getStoredPlanPath>) {
    return getStoredPlanPath(...args);
}
export function planFixtureDocumentRoot(...args: Parameters<typeof getPlanDocumentRoot>) {
    return getPlanDocumentRoot(...args);
}
export function planFixtureJournalDirectory(...args: Parameters<typeof getTransitionJournalDir>) {
    return getTransitionJournalDir(...args);
}
export function planFixtureJournalPath(...args: Parameters<typeof getTransitionJournalPath>) {
    return getTransitionJournalPath(...args);
}
export function planFixtureControllerPath(...args: Parameters<typeof controllerRecordPath>) {
    return controllerRecordPath(...args);
}
/** Hold the real locks to exercise contention and crash boundaries, never inject a replacement lock. */
export async function holdPlanFixtureLock<T>(cwd: string, name: string, action: () => Promise<T>): Promise<T> {
    return await withPlanLock(cwd, name, action);
}
export async function holdPlanFixtureCatalogLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    return await withPlanCatalogLock(cwd, action);
}

import { withLocalPlanWorkflow } from "../../plan-store/index.ts";
import { currentPackageProject, selectedPackage, capturePackageWorkflowInput } from "../../plan-store/workflows.ts";
import { updatePlanPackageMetadata } from "../../plan-store/packages.ts";
/** Arrange an already delivered attempt for read-only catalog/progress scenarios. */
export async function seedPlanAttemptReference(cwd: string, name: string, attemptId: string): Promise<void> {
    await withLocalPlanWorkflow(cwd, name, async () => {
        const identity = currentPackageProject()!;
        const plan = await selectedPackage(name);
        const input = await capturePackageWorkflowInput(name);
        await updatePlanPackageMetadata(identity, plan.metadata.planId, plan.metadata.revision, {
            workflow: {
                attempt: {
                    personalOwner: identity.personalOwner.identity,
                    repositoryId: identity.repositoryId,
                    repositoryRoot: identity.checkoutRoot,
                    attemptId,
                    input,
                },
            },
        });
    });
}

export type { ControllerRecord as PlanFixtureController } from "../../plan-store/controllers.ts";
import { inspectControllerView } from "../../plan-store/controllers.ts";
import { assertPackageWorkflowInput } from "../../plan-store/workflows.ts";
import { planPackageControllerDirectory } from "../../plan-store/packages.ts";
/** Inspect private controller reconciliation evidence after exercising a public workflow. */
export async function inspectPlanFixtureView(...args: Parameters<typeof inspectControllerView>) {
    return await inspectControllerView(...args);
}
/** Assert retained review evidence without advancing the review or execution. */
export async function assertPlanFixtureInput(...args: Parameters<typeof assertPackageWorkflowInput>) {
    return await assertPackageWorkflowInput(...args);
}
/** Locate evidence for deliberate corruption and filesystem-observation qualification. */
export function planFixtureEvidenceDirectory(...args: Parameters<typeof planPackageControllerDirectory>) {
    return planPackageControllerDirectory(...args);
}
