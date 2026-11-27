import type { PackagePublicationReference } from "@runwield/plans/publication-copies";
import { projects } from "@runwield/projects";
import {
    managedPersonalStoreActive as managedPlanStoreActive,
    managedExecutionRoot,
} from "@runwield/plans/managed-project-connection";
import {
    readManagedRecordingContext,
    selectManagedPlan,
    withManagedPlan,
    generateManagedPreparedRecord,
    settleManagedPublication,
    verifyManagedRecording,
} from "./managed.ts";
import {
    generatePreparedPackageRecord as generateLocalPreparedRecord,
    settlePreparedPackageRecord as settleLocalPreparedRecord,
    readPreparedPackageRecord,
} from "../shared/work-records/package-recording.ts";
/** Plan-side recording evidence. Work Record content and publication remain with their owners. */
import { currentPackageSelection, selectedPackage, withPackageWorkflow } from "./workflows.ts";
import { readPlanPackage, readPlanPackagePublication } from "@runwield/plans/package-storage";
import { loadPublishedWorkRecordSource, verifyPackageRecordingDelivery } from "./published-source.ts";
import { getPlanDocumentRoot } from "../plan-store.ts";

export interface PlanRecordingContext {
    preparation?: PackagePublicationReference;
    autoGenerateRecords?: boolean;
    publishedReference?: PackagePublicationReference;
    preparedRecord?: import("@runwield/plans/work-record-files").RecordingPreparation;
}
export async function readPlanRecordingContext(
    planName: string,
    automatic: boolean,
    pendingPublication?: boolean,
): Promise<PlanRecordingContext | undefined> {
    if (managedPlanStoreActive()) return await readManagedRecordingContext(planName, automatic, pendingPublication);
    const selection = currentPackageSelection();
    if (!selection) return undefined;
    const selected = await selectedPackage(planName);
    const preparation = automatic && pendingPublication ? selected.metadata.workflow?.recordingPreparation : undefined;
    const retained = preparation ? await readPlanPackagePublication(selection.identity, preparation) : undefined;
    const publishedReference = !automatic
        ? selected.metadata.workflow?.recordingSource || selected.metadata.workflow?.delivery?.source
        : undefined;
    const reference = preparation || publishedReference;
    const preparedRecord = reference
        ? ((await readPreparedPackageRecord(reference.attemptId)) ?? undefined)
        : undefined;
    return { preparation, autoGenerateRecords: retained?.autoGenerateRecords, publishedReference, preparedRecord };
}

/** Verify receipt and retained source before exposing the publication manifest to the Recorder. */
export async function readRecordingPublication(cwd: string, planName: string, reference: PackagePublicationReference) {
    if (managedPlanStoreActive()) {
        return await verifyManagedRecording(cwd, reference);
    }
    const selection = currentPackageSelection();
    if (!selection) throw new Error("Recording requires admitted Plan authority.");
    await verifyPackageRecordingDelivery(cwd, reference);
    await loadPublishedWorkRecordSource(cwd, planName);
    return await readPlanPackagePublication(selection.identity, reference);
}

export function planRecordingSourceRoot(sourcePath: string): string {
    if (managedPlanStoreActive()) return managedExecutionRoot();
    const owner = currentPackageSelection()?.identity;
    return owner ? projects.home.storeLocation(owner) : getPlanDocumentRoot(sourcePath);
}

/** A Recorder may target a parent; the owner admits that Plan using its current revision. */
export async function withRecordingPlan<T>(cwd: string, planId: string, run: () => Promise<T>): Promise<T> {
    if (managedPlanStoreActive()) return await withManagedPlan(cwd, await selectManagedPlan(cwd, planId), run);
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
    workRecord: import("@runwield/plans").PlanFrontMatter["workRecord"],
): Promise<void> {
    const { recordRetainedRecordingBacklink } = await import("./retained-recording.ts");
    if (await recordRetainedRecordingBacklink(source, workRecord)) return;
    const { withLocalProjectAction } = await import("./access.ts");
    const { withPlanLock, loadPlan, loadArchivedPlan, updateArchivedPlanFrontMatter } =
        await import("../plan-store.ts");
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
    const { withPlanCatalogLock, loadArchivedPlan, updateArchivedPlanFrontMatter } = await import("../plan-store.ts");
    return await withPlanCatalogLock(cwd, async () => {
        const plan = await loadArchivedPlan(cwd, name);
        if (!plan) throw new Error(`Archived Plan not found: ${name}`);
        if (plan.attrs.planId) return plan.attrs;
        return await updateArchivedPlanFrontMatter(cwd, name, { planId: crypto.randomUUID() });
    });
}

type PreparedRecordArguments = [
    ...Parameters<typeof generateLocalPreparedRecord>,
    reference: PackagePublicationReference,
];
export async function generatePlanPreparedRecord(
    ...args: PreparedRecordArguments
): ReturnType<typeof generateLocalPreparedRecord> {
    const [cwd, source, attemptId, options, reference] = args;
    return managedPlanStoreActive()
        ? await generateManagedPreparedRecord(cwd, source, attemptId, options, reference)
        : await generateLocalPreparedRecord(cwd, source, attemptId, options);
}
export async function settlePlanPreparedRecord(
    ...args: Parameters<typeof settleLocalPreparedRecord>
): ReturnType<typeof settleLocalPreparedRecord> {
    if (managedPlanStoreActive()) {
        const reference = (
            await readManagedRecordingContext(
                args[1].members.find((member) => member.metadata.planId === args[1].planId)!.metadata.name,
                false,
            )
        )?.publishedReference;
        if (!reference) throw new Error("Prepared record has no confirmed delivery.");
        await settleManagedPublication(args[0], reference);
        return undefined;
    }
    return await settleLocalPreparedRecord(...args);
}

/** Canonical record retrieval uses the same personal owner as Plans. */
export async function listOwnedWorkRecords(
    cwd: string,
    options: import("@runwield/plans/work-record-files").ListWorkRecordsOptions = {},
) {
    const { listManagedWorkRecords } = await import("./managed.ts");
    const { listLocalWorkRecords } = await import("../shared/work-records/store.ts");
    return managedPlanStoreActive() ? await listManagedWorkRecords(cwd) : await listLocalWorkRecords(cwd, options);
}
export async function searchOwnedWorkRecords(
    cwd: string,
    query: string,
    options: import("../shared/work-records/search.ts").WorkRecordSearchOptions,
) {
    const { searchManagedWorkRecords } = await import("./managed.ts");
    const { searchLocalWorkRecords } = await import("../shared/work-records/search.ts");
    return managedPlanStoreActive()
        ? await searchManagedWorkRecords(cwd, query, options)
        : await searchLocalWorkRecords(cwd, query, options);
}

export async function readOwnedWorkRecord(
    cwd: string,
    fileName: string,
): Promise<import("@runwield/plans/work-records").WorkRecordResource> {
    const { readLocalWorkRecord } = await import("../shared/work-records/store.ts");
    if (!managedPlanStoreActive()) return await readLocalWorkRecord(cwd, fileName);
    const { basename } = await import("node:path");
    if (basename(fileName) !== fileName || !fileName.endsWith(".md"))
        throw new Error("Work Record requires a flat Markdown filename.");
    const record = (await listOwnedWorkRecords(cwd)).find((entry) => basename(entry.path) === fileName);
    if (!record) throw new Error(`Work Record not found: ${fileName}`);
    return record;
}
export { readWorkRecordById as readOwnedWorkRecordById } from "../shared/work-records/search.ts";
