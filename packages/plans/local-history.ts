import type { ProjectStoreIdentity } from "@runwield/projects";
import { COLLABORATION_STATE_REMOTE_CANONICAL } from "./format.ts";
import { planHistoryFiles } from "./history-files.ts";
import type { PackageDocuments, PlanHistory } from "./history.ts";
import { isPlanId, type PlanId } from "@runwield/plan-storage-format";
import { packageDocumentText, PlanPackageError } from "./package-data.ts";
import {
    commitPlanPackageBatch,
    listPlanPackages,
    packageWorkflowRevision,
    readPlanPackage,
    type LoadedPlanPackage,
    type PackageMetadataUpdate,
} from "./package-storage.ts";
import { sameReviewedMarkdown } from "./review-markdown.ts";
import { StalePlanWriteError } from "./store-errors.ts";

async function historyCatalog(owner: ProjectStoreIdentity): Promise<LoadedPlanPackage[]> {
    const catalog = await listPlanPackages(owner, true);
    const problem = catalog.issues[0];
    if (problem) throw new PlanPackageError(problem.kind, problem.message);
    return catalog.packages;
}

async function resolve(owner: ProjectStoreIdentity, reference: string): Promise<PlanId> {
    const catalog = await historyCatalog(owner);
    const plan =
        catalog.find(({ metadata }) => metadata.planId === reference) ??
        catalog.find(({ metadata }) => metadata.name === reference);
    const id = plan?.metadata.planId;
    if (!isPlanId(id)) throw new Error("Plan history requires an admitted Plan.");
    return id;
}

async function select(owner: ProjectStoreIdentity, planId: PlanId): Promise<LoadedPlanPackage> {
    const catalog = await historyCatalog(owner);
    const plan = catalog.find(({ metadata }) => metadata.planId === planId);
    if (!plan) throw new Error("Plan history requires an admitted Plan.");
    return plan;
}

function list(planId: PlanId, plan: LoadedPlanPackage): PlanHistory {
    return { planId, revision: packageWorkflowRevision(plan), milestones: plan.metadata.history ?? [] };
}

async function read(owner: ProjectStoreIdentity, plan: LoadedPlanPackage, version: string): Promise<PackageDocuments> {
    return await planHistoryFiles.forOwner(owner).read(plan.metadata, version);
}

interface PreparedHistoryRestore {
    plan: LoadedPlanPackage;
    before: PackageDocuments;
    documents: PackageDocuments;
    changed: boolean;
}

async function prepareRestore(
    owner: ProjectStoreIdentity,
    plan: LoadedPlanPackage,
    version: string,
    expectedRevision: string,
): Promise<PreparedHistoryRestore> {
    const revision = packageWorkflowRevision(plan);
    if (expectedRevision !== revision) throw new StalePlanWriteError(expectedRevision, revision);
    const documents = await read(owner, plan, version);
    const before = packageDocumentText(plan.documents);
    const changed =
        Object.keys(before).length !== Object.keys(documents).length ||
        plan.documents.some(
            ({ name }) => documents[name] === undefined || !sameReviewedMarkdown(before[name]!, documents[name]!),
        );
    return { plan, before, documents, changed };
}

type HistoryReviewUpdate = Pick<PackageMetadataUpdate, "definition" | "controller" | "workflow">;

/** The host holds the Plan lock while evaluating the review update and restoring the frozen documents. */
async function commitRestore(
    owner: ProjectStoreIdentity,
    restore: PreparedHistoryRestore,
    review: HistoryReviewUpdate = {},
): Promise<string> {
    const {
        plan: { metadata },
        before,
        documents,
    } = restore;
    if (metadata.archive && !metadata.archive.restoredAt)
        throw new Error("Restore the archived Plan before editing its documents.");
    if (metadata.controller.collaborationState === COLLABORATION_STATE_REMOTE_CANONICAL)
        throw new Error("This shared Plan is remote-canonical and cannot be changed by history restore.");
    await commitPlanPackageBatch(owner, [
        {
            before: { metadata, documents: before },
            documents,
            metadata: {
                ...metadata,
                revision: metadata.revision + 1,
                definition: review.definition ?? metadata.definition,
                controller: review.controller ?? metadata.controller,
                workflow: review.workflow ?? metadata.workflow,
            },
        },
    ]);
    const saved = await readPlanPackage(owner, { planId: metadata.planId });
    if (saved.kind !== "loaded") throw new PlanPackageError(saved.kind, saved.message);
    return packageWorkflowRevision(saved);
}

/** Inspect committed history and restore documents under the canonical Plan owner. */
export const localPlanHistory = { resolve, select, list, read, prepareRestore, commitRestore };
