/** Plan-side recording evidence. Work Record content and publication remain with their owners. */
import { currentPackageSelection, selectedPackage, withPackageWorkflow } from "./workflows.ts";
import { readPlanPackage, readPlanPackagePublication, type PackagePublicationReference } from "./packages.ts";
import { loadPublishedWorkRecordSource, verifyPackageRecordingDelivery } from "./published-source.ts";
import { getPlanDocumentRoot } from "../plan-store.js";

export async function readPlanRecordingContext(planName: string, automatic: boolean, pendingPublication?: boolean) {
    const selection = currentPackageSelection();
    if (!selection) return undefined;
    const selected = await selectedPackage(planName);
    const preparation = automatic && pendingPublication ? selected.metadata.workflow?.recordingPreparation : undefined;
    const retained = preparation ? await readPlanPackagePublication(selection.identity, preparation) : undefined;
    const publishedReference = !automatic
        ? selected.metadata.workflow?.recordingSource || selected.metadata.workflow?.delivery?.source
        : undefined;
    return { preparation, autoGenerateRecords: retained?.autoGenerateRecords, publishedReference };
}

/** Verify receipt and retained source before exposing the publication manifest to the Recorder. */
export async function readRecordingPublication(cwd: string, planName: string, reference: PackagePublicationReference) {
    const selection = currentPackageSelection();
    if (!selection) throw new Error("Recording requires admitted Plan authority.");
    await verifyPackageRecordingDelivery(cwd, reference);
    await loadPublishedWorkRecordSource(cwd, planName);
    return await readPlanPackagePublication(selection.identity, reference);
}

export function planRecordingSourceRoot(sourcePath: string): string {
    return currentPackageSelection()?.identity.checkoutRoot || getPlanDocumentRoot(sourcePath);
}

/** A Recorder may target a parent; the owner admits that Plan using its current revision. */
export async function withRecordingPlan<T>(cwd: string, planId: string, run: () => Promise<T>): Promise<T> {
    const selection = currentPackageSelection();
    if (!selection) return await run();
    const plan = await readPlanPackage(selection.identity, { planId });
    if (plan.kind !== "loaded") throw new Error(plan.message);
    return await withPackageWorkflow(cwd, { ...selection, planId, expectedRevision: plan.metadata.revision }, run);
}

export async function readPlanPublicationReference(cwd: string, planName: string) {
    const { withLocalPlanWorkflow } = await import("./access.ts");
    return await withLocalPlanWorkflow(cwd, planName, async () =>
        currentPackageSelection() ? (await selectedPackage(planName)).metadata.workflow?.delivery?.source : undefined,
    );
}

export interface PlanRecordingSource {
    name: string;
    planId: string;
    sourceKind: "active" | "archived";
    recordingAttemptId?: string;
    documentRevision?: string;
}
/** Backlinks are bookkeeping, never recovery that can retire another publication's journal. */
export async function recordPlanWorkRecord(
    cwd: string,
    source: PlanRecordingSource,
    workRecord: import("../plan-store.js").PlanFrontMatter["workRecord"],
): Promise<void> {
    const { withLocalProjectAction } = await import("./access.ts");
    const { withPlanLock, loadPlan, loadArchivedPlan, updateArchivedPlanFrontMatter } =
        await import("../plan-store.js");
    const { runPlanFrontMatterTransition } = await import("./transitions.ts");
    await withLocalProjectAction(cwd, () =>
        withPlanLock(cwd, source.name, async () => {
            if (source.recordingAttemptId && currentPackageSelection()) {
                const live = await selectedPackage({ planId: source.planId });
                const attempt = live.metadata.workflow?.attempt;
                if (attempt && attempt.attemptId !== source.recordingAttemptId) return;
            }
            const plan =
                source.sourceKind === "archived"
                    ? await loadArchivedPlan(cwd, source.name)
                    : await loadPlan(cwd, source.name);
            if (!plan || plan.attrs.planId !== source.planId)
                throw new Error("Work Record source Plan identity changed.");
            if (source.sourceKind === "archived") {
                await updateArchivedPlanFrontMatter(cwd, source.name, { workRecord });
                return;
            }
            const result = await runPlanFrontMatterTransition({
                projectRoot: cwd,
                planName: source.name,
                operation: "work_record_backlink",
                expectedRevision: source.documentRevision,
                updates: { workRecord },
            });
            if (result.status !== "committed")
                throw new Error(result.message || `Could not link Work Record to Plan ${source.name}.`);
        }),
    );
}

/** Assign an identity to an explicit retained archive before recording its provenance. */
export async function ensureArchivedPlanIdentity(cwd: string, name: string) {
    const { withPlanCatalogLock, loadArchivedPlan, updateArchivedPlanFrontMatter } = await import("../plan-store.js");
    return await withPlanCatalogLock(cwd, async () => {
        const plan = await loadArchivedPlan(cwd, name);
        if (!plan) throw new Error(`Archived Plan not found: ${name}`);
        if (plan.attrs.planId) return plan.attrs;
        return await updateArchivedPlanFrontMatter(cwd, name, { planId: crypto.randomUUID() });
    });
}
