import { StalePlanWriteError } from "@runwield/plans/store";
import { projectPlanDocuments } from "./checkout-documents.ts";
import { projectPlanArtifacts } from "./artifacts.ts";

import { currentRetainedCheckoutSource, hasRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { plans, type PlanEventDetails, type PlanId } from "@runwield/plans";
import type {
    ProjectPlanCatalogEntry,
    ProjectPlanCatalog,
    ProjectPlanDocument,
    ProjectPlanStore,
    ProjectPlanStoreOptions,
    ReviseProjectPlan,
} from "@runwield/plans/store";
import { type ProjectId } from "@runwield/projects";
import { requestWorkspaceSearchRefresh } from "@runwield/resources/workspace-search-refresh";
import { requireOwnedWorkRecordFiles } from "../shared/work-records/owner.ts";
import { projectWorkRecordReads } from "./project-work-records.ts";
import { bindProjectPlanStore, checkoutPlanIdentity } from "./project-binding.ts";
import { packagePublicationInput } from "./publication.ts";
import { PlanNotFoundError, type PlanResource } from "../plan-store.ts";
import {
    createSavedPlan,
    reviseSavedPlan,
    withLocalProjectAction,
    withLocalPlanWorkflow,
    type PlanAuthoringInput,
} from "./access.ts";
import { archiveSavedPlan, restoreSavedPlan } from "./archiving.ts";
import { canonicalizeStoredPlanName, planArtifactReference } from "@runwield/plans/format";
import { recordPlanEvent } from "./events.ts";
import {
    listLocalPlanHistory,
    readLocalPlanMilestone,
    resolveLocalHistoryPlan,
    restoreLocalPlanMilestone,
} from "./history.ts";
import { managedPersonalStoreActive } from "@runwield/plans/managed-project-connection";
import {
    admitManagedPlanCheckout,
    currentManagedRetainedExecution,
    createManagedProjectWorkRecord,
    managedPlanStoreActive,
    readManagedActivePlanById,
    readManagedPlanHistory,
    readManagedPlanMilestone,
    resolveManagedHistoryPlan,
    restoreManagedPlanMilestone,
} from "./managed.ts";
import {
    findPlanById,
    listPlanDocuments,
    loadArchivedPlan,
    loadPlanBodyById,
    readPlanResourceCatalog,
    savePlanBodyById,
} from "./queries.ts";

function requirePlanId(planId: string): PlanId {
    if (!plans.identity.isValid(planId)) throw new Error("Plan access requires a durable Plan ID.");
    return planId;
}

function requireRevision(revision: string): void {
    if (!revision) throw new Error("Plan mutation requires an expected revision.");
}

function checkRevision(expected: string, actual: string): void {
    if (expected !== actual) throw new StalePlanWriteError(expected, actual);
}

function safeDiagnostic(message: string, cwd: string, path: string): string {
    let sanitized = message;
    for (const locator of [cwd, path].filter(Boolean)) sanitized = sanitized.split(locator).join("[workspace path]");
    return sanitized.replace(/(?:[A-Za-z]:)?[\\/][^\s"'\`<>)]*/g, "[workspace path]");
}

type PlanDocumentFields = Pick<
    PlanResource,
    "name" | "relativePath" | "attrs" | "body" | "revision" | "readAvailability"
>;

function documentFields(resource: PlanDocumentFields): Omit<ProjectPlanDocument, "planId"> {
    const {
        worktreePath: _worktree,
        archivedFromPath: _archived,
        restoredFromPath: _restored,
        ...attrs
    } = resource.attrs;
    return {
        name: resource.name,
        relativePath: resource.relativePath,
        attrs,
        body: resource.body,
        revision: resource.revision,
        readAvailability: resource.readAvailability,
    };
}

function catalogEntry(resource: PlanResource): ProjectPlanCatalogEntry {
    const document = documentFields(resource);
    return resource.planId ? { ...document, planId: requirePlanId(resource.planId) } : { ...document, planId: "" };
}

export async function readProjectPlanDisplayCatalog(cwd: string): Promise<ProjectPlanCatalog> {
    const catalog = await readPlanResourceCatalog(cwd);
    return {
        resources: catalog.resources.map(catalogEntry),
        diagnostics: catalog.diagnostics.map(({ name, kind, message, path, planId }) => ({
            name,
            kind,
            message: safeDiagnostic(message, cwd, path),
            ...(plans.identity.isValid(planId) ? { planId } : {}),
        })),
    };
}

function document(resource: PlanResource, planId: PlanId): ProjectPlanDocument {
    if (resource.planId !== planId) throw new PlanNotFoundError(planId);
    return { ...documentFields(resource), planId };
}

async function readActive(cwd: string, planId: PlanId): Promise<ProjectPlanDocument> {
    const resource = managedPlanStoreActive()
        ? await readManagedActivePlanById(cwd, planId)
        : await findPlanById(cwd, planId);
    if (!resource) throw new PlanNotFoundError(planId);
    return document(resource, planId);
}

async function readArchived(cwd: string, planId: PlanId): Promise<ProjectPlanDocument> {
    const resource = await loadArchivedPlan(cwd, planId, true);
    if (!resource || resource.attrs.planId !== planId) throw new PlanNotFoundError(planId);
    return { ...documentFields({ ...resource, relativePath: planArtifactReference(planId) }), planId };
}

function eventDetails(details: PlanEventDetails = {}): PlanEventDetails {
    const { triageMeta: _metadata, now: _clock, ...input } = details;
    return input;
}

/** Internal review entry point for workflows that still use operational Plan evidence. */
interface CoreProjectPlanStore extends ProjectPlanStore {
    resolveHistoryPlan(reference: string): Promise<PlanId>;
    resolveAuthoredPlan(reference: string, expectedPlanId?: string): Promise<ProjectPlanDocument | undefined>;
    author(input: PlanAuthoringInput, expectedPlanId?: string): Promise<ProjectPlanDocument>;
    withWorkflow<Result>(planId: PlanId, name: string, run: (cwd: string) => Promise<Result>): Promise<Result>;
}

/** Resolve an agent-facing name within the admitted Project's active catalog. */
async function resolveProjectPlan(
    store: ProjectPlanStore,
    reference: string,
    expectedPlanId?: string,
): Promise<ProjectPlanDocument | undefined> {
    const { name } = canonicalizeStoredPlanName(reference);
    if (expectedPlanId !== undefined) {
        const plan = await store.read(requirePlanId(expectedPlanId));
        if (plan.name !== name) throw new Error("The bound Plan identity changed.");
        return plan;
    }
    const catalog = await store.list();
    const entry = catalog.resources.find((plan) => plan.name === name);
    if (!entry?.planId) return undefined;
    return { ...entry, planId: entry.planId };
}

/** Select the observed identity before passing authoring to the owner's guarded write. */
async function authorProjectPlan(
    store: ProjectPlanStore,
    input: PlanAuthoringInput,
    expectedPlanId?: string,
): Promise<ProjectPlanDocument> {
    const { planName: reference, expectedRevision, ...draft } = input;
    if (expectedRevision === undefined && expectedPlanId === undefined) {
        return await store.create({ ...draft, planName: canonicalizeStoredPlanName(reference).name });
    }
    const current = await resolveProjectPlan(store, reference, expectedPlanId);
    if (!current) throw new StalePlanWriteError(expectedRevision || "required", "missing");
    if (!expectedRevision) throw new StalePlanWriteError("required", current.revision);
    return await store.revise(current.planId, { ...draft, expectedRevision });
}

/** Open without admitting a fresh Project or exposing an owner locator. */
export function openProjectPlanStore(projectId: ProjectId, options: ProjectPlanStoreOptions = {}): ProjectPlanStore {
    return projectPlanStore(projectId, bindProjectPlanStore(projectId, options));
}

function projectPlanStore(projectId: ProjectId, run: ReturnType<typeof bindProjectPlanStore>): ProjectPlanStore {
    return {
        projectId,
        artifacts: projectPlanArtifacts(run),
        history: {
            list: (id) =>
                run((cwd) => {
                    const planId = requirePlanId(id);
                    return managedPersonalStoreActive()
                        ? readManagedPlanHistory(cwd, planId)
                        : listLocalPlanHistory(cwd, planId);
                }, "retained"),
            read: (id, version) =>
                run((cwd) => {
                    const planId = requirePlanId(id);
                    return managedPersonalStoreActive()
                        ? readManagedPlanMilestone(cwd, planId, version)
                        : readLocalPlanMilestone(cwd, planId, version);
                }, "retained"),
            restore: (id, version, expectedRevision) =>
                run((cwd) => {
                    const planId = requirePlanId(id);
                    requireRevision(expectedRevision);
                    return managedPersonalStoreActive()
                        ? restoreManagedPlanMilestone(cwd, planId, version, expectedRevision)
                        : restoreLocalPlanMilestone(cwd, planId, version, expectedRevision);
                }, "retained"),
        },
        publicationCopies: {
            read: (reference) =>
                run(async (cwd) => {
                    if (reference.projectId !== projectId)
                        throw new Error("Publication reference belongs to another Project.");
                    return (await packagePublicationInput(cwd, reference)).copies;
                }, "workflow-read"),
        },
        workRecords: {
            create: (input) =>
                run(async (cwd) => {
                    if (managedPlanStoreActive()) return await createManagedProjectWorkRecord(cwd, input);
                    const record = await requireOwnedWorkRecordFiles().workRecords.create(input);
                    await requestWorkspaceSearchRefresh(cwd);
                    return record;
                }),
            list: () => run((cwd) => projectWorkRecordReads(cwd).list(), "read"),
            read: (id) => run((cwd) => projectWorkRecordReads(cwd).read(id), "read"),
        },
        list: () => run(readProjectPlanDisplayCatalog, "read"),
        read: (planId) => run((cwd) => readActive(cwd, requirePlanId(planId)), "read"),
        readArchived: (planId) => run((cwd) => readArchived(cwd, requirePlanId(planId)), "read"),
        create: (input) =>
            run(async (cwd) => {
                const planId = requirePlanId(await createSavedPlan(cwd, input));
                return await readActive(cwd, planId);
            }),
        revise: (id, input: ReviseProjectPlan) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(input.expectedRevision);
                const current = await readActive(cwd, planId);
                checkRevision(input.expectedRevision, current.revision);
                await reviseSavedPlan(cwd, planId, { ...input, planName: current.name });
                return await readActive(cwd, planId);
            }),
        editBody: (id, { body, expectedRevision }) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(expectedRevision);
                await readActive(cwd, planId);
                const current = await loadPlanBodyById(cwd, planId);
                checkRevision(expectedRevision, current.revision);
                const saved = await savePlanBodyById(cwd, planId, body, current.bodyHash, {
                    expectedRevision,
                });
                return document(saved, planId);
            }),
        applyEvent: (id, request) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(request.expectedRevision);
                const current = await readActive(cwd, planId);
                checkRevision(request.expectedRevision, current.revision);
                await recordPlanEvent({
                    cwd,
                    planName: current.name,
                    expectedPlanId: planId,
                    event: request.event,
                    expectedRevision: request.expectedRevision,
                    details: eventDetails(request.details),
                });
                return await readActive(cwd, planId);
            }),
        archive: (id, archive) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(archive.expectedRevision);
                const current = await readActive(cwd, planId);
                checkRevision(archive.expectedRevision, current.revision);
                await archiveSavedPlan(cwd, current.name, {
                    expectedRevision: archive.expectedRevision,
                    expectedPlanId: planId,
                    reason: archive.reason,
                    force: archive.force,
                });
                return await readArchived(cwd, planId);
            }),
        restore: (id, expectedRevision) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(expectedRevision);
                const current = await readArchived(cwd, planId);
                checkRevision(expectedRevision, current.revision);
                await restoreSavedPlan(cwd, planId, undefined, expectedRevision);
                return await readActive(cwd, planId);
            }),
    };
}

/** Resolve a host checkout without creating a Project during a passive read. */
export function openPlanStoreForCheckout(cwd: string): CoreProjectPlanStore | undefined {
    const identity = checkoutPlanIdentity(cwd);
    if (!identity) return undefined;
    const run = bindProjectPlanStore(identity.projectId, { admitted: identity });
    const store = projectPlanStore(identity.projectId, run);
    return {
        ...store,
        resolveHistoryPlan: (reference) =>
            run(
                (cwd) =>
                    managedPersonalStoreActive()
                        ? resolveManagedHistoryPlan(cwd, reference)
                        : resolveLocalHistoryPlan(reference),
                "retained",
            ),
        author: (input, id) => authorProjectPlan(store, input, id),
        resolveAuthoredPlan: (reference, id) => resolveProjectPlan(store, reference, id),
        withWorkflow: (id, name, operation) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                const current = await readActive(cwd, planId);
                if (current.name !== name) throw new Error("The bound Plan identity changed.");
                return await withLocalPlanWorkflow(cwd, name, () => operation(cwd), planId);
            }),
    };
}

/** A write may admit a fresh checkout using the ordinary Project entry rules. */
export async function admitPlanStoreForCheckout(cwd: string) {
    if (managedPlanStoreActive()) await admitManagedPlanCheckout(cwd);
    return await withLocalProjectAction(cwd, () => {
        const store = openPlanStoreForCheckout(cwd);
        if (!store) throw new Error("Plan authoring requires an admitted Project.");
        return Promise.resolve(store);
    });
}

/** Picker reads are passive. Retained executions expose only their own checkout documents. */
export async function listSelectablePlanDocuments(cwd: string) {
    if (currentManagedRetainedExecution() || hasRetainedCheckoutSource(cwd)) {
        return (await listPlanDocuments(cwd)).map(({ name, attrs }) => ({
            name,
            attrs,
            planId: attrs.planId,
            projectId: undefined,
        }));
    }
    const store = openPlanStoreForCheckout(cwd);
    if (!store) return [];
    const catalog = await store.list();
    if (catalog.diagnostics.length) throw new Error(catalog.diagnostics[0].message);
    return catalog.resources.map(({ name, attrs, planId }) => ({ name, attrs, planId, projectId: store.projectId }));
}

/** Capture the read source once. Queries reject if a retained attempt or the admitted Project changes. */
function checkoutDocumentAccess(cwd: string): Parameters<typeof projectPlanDocuments>[0] {
    const retained = currentRetainedCheckoutSource();
    const managedAttempt = currentManagedRetainedExecution();
    const identity = retained ? undefined : checkoutPlanIdentity(cwd);
    const run = identity && bindProjectPlanStore(identity.projectId, { admitted: identity });
    return async (query) => {
        if (currentRetainedCheckoutSource() !== retained || currentManagedRetainedExecution() !== managedAttempt)
            throw new Error("Plan read authority changed. Reopen the Project.");
        if (run) return await run(query, "workflow-read");
        if (!hasRetainedCheckoutSource(cwd) && checkoutPlanIdentity(cwd))
            throw new Error("Plan read authority changed. Reopen the Project.");
        return await query(cwd);
    };
}

/** Keep admission failures on the same asynchronous error path as storage failures. */
export function planDocumentsForCheckout(cwd: string) {
    try {
        return projectPlanDocuments(checkoutDocumentAccess(cwd));
    } catch (error) {
        return projectPlanDocuments(() => Promise.reject(error));
    }
}
