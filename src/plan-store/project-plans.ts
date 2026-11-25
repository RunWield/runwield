import { plans, type PlanEventDetails, type PlanId } from "@runwield/plans";
import type { ProjectPlanCatalogEntry, ProjectPlanDocument, ProjectPlanStore } from "@runwield/plans/store";
import {
    parseProjectId,
    projects,
    type ProjectId,
    type ProjectRegistry,
    type ProjectStoreIdentity,
} from "@runwield/projects";
import { PlanNotFoundError, StalePlanWriteError, type PlanResource } from "../plan-store.ts";
import { createSavedPlan } from "./access.ts";
import { archiveSavedPlan, restoreSavedPlan } from "./archiving.ts";
import { recordPlanEvent } from "./events.ts";
import {
    captureManagedProjectPlanAccess,
    managedPersonalStoreActive,
    managedPlanStoreActive,
    readManagedActivePlanById,
} from "./managed.ts";
import {
    findPlanById,
    loadArchivedPlan,
    loadPlanBodyById,
    readPlanResourceCatalog,
    savePlanBodyById,
} from "./queries.ts";
import { hasRetainedCheckoutSource } from "./retained-source.ts";
import { withPackageProject } from "./workflows.ts";

export type ProjectPlanStoreOptions = RegisteredProjectPlanOptions | AdmittedProjectPlanOptions;

interface RegisteredProjectPlanOptions {
    /** Trusted registration already opened by the application. */
    registry?: ProjectRegistry;
    admitted?: never;
}

interface AdmittedProjectPlanOptions {
    /** The checkout or owner already admitted by Projects. */
    admitted: ProjectStoreIdentity;
    registry?: never;
}

function registeredRoot(projectId: ProjectId, registry: ProjectPlanStoreOptions["registry"]): string {
    if (registry) return projects.registrations.requireActiveRoot(registry, projectId);
    const opened = projects.registrations.open();
    try {
        return projects.registrations.requireActiveRoot(opened, projectId);
    } finally {
        opened.close();
    }
}

function checkoutIdentity(projectId: ProjectId, root: string) {
    const inspected = projects.checkout.inspect(root);
    if (inspected.kind !== "existing" || inspected.identity.projectId !== projectId)
        throw new Error("Plan access requires this Project's admitted checkout.");
    return inspected.identity;
}

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
    return { ...documentFields({ ...resource, relativePath: `plans/${planId}/context.md` }), planId };
}

function eventDetails(details: PlanEventDetails = {}): PlanEventDetails {
    const { triageMeta: _metadata, now: _clock, ...input } = details;
    return input;
}

/** Open without admitting a fresh Project or exposing an owner locator. */
export function openProjectPlanStore(projectId: ProjectId, options: ProjectPlanStoreOptions = {}): ProjectPlanStore {
    if (!parseProjectId(projectId)) throw new Error("Invalid Project ID.");
    const admitted = options.admitted && structuredClone(options.admitted);
    if (admitted && admitted.projectId !== projectId) throw new Error("Plan access belongs to a different Project.");
    const managed = captureManagedProjectPlanAccess(projectId, admitted);
    const registry = options.registry;
    const verifyLocal = () => {
        if (managedPersonalStoreActive()) throw new Error("The Project's Plan owner changed after opening.");
        if (admitted) {
            projects.home.assertStoreIdentity(admitted);
            if (projects.home.isOwner(admitted)) return admitted;
        }
        const current = checkoutIdentity(projectId, admitted?.checkoutRoot ?? registeredRoot(projectId, registry));
        if (current.personalOwner.kind !== "execution-account") throw new Error("Managed Plan owner is unavailable.");
        if (
            admitted &&
            (projects.home.isOwner(admitted) ||
                current.repositoryId !== admitted.repositoryId ||
                current.checkoutId !== admitted.checkoutId ||
                current.personalOwner.identity !== admitted.personalOwner.identity ||
                current.executionAccountHome !== admitted.executionAccountHome)
        )
            throw new Error("Project Plan authority changed.");
        return current;
    };
    const verifyManagedRegistration = () => {
        if (registry) checkoutIdentity(projectId, projects.registrations.requireActiveRoot(registry, projectId));
    };
    if (managed) verifyManagedRegistration();
    const initialLocal = managed ? undefined : verifyLocal();
    const run = async <Result>(operation: (cwd: string) => Promise<Result>, passive = false): Promise<Result> => {
        if (managed) {
            verifyManagedRegistration();
            return await managed(operation);
        }
        const local = verifyLocal();
        if (
            !initialLocal ||
            local.personalOwner.identity !== initialLocal.personalOwner.identity ||
            local.executionAccountHome !== initialLocal.executionAccountHome
        )
            throw new Error("The Project's Plan owner changed after opening.");
        projects.launch.verifyAccountHome(initialLocal);
        const cwd = projects.home.storeLocation(local);
        if (projects.home.isOwner(local))
            return await projects.home.withOwner(local, () => withPackageProject(cwd, local, () => operation(cwd)));
        if (hasRetainedCheckoutSource(cwd)) {
            if (!passive) throw new Error("Plan mutation requires the canonical Project owner.");
            return await operation(cwd);
        }
        return await withPackageProject(cwd, local, () => operation(cwd));
    };

    return {
        projectId,
        list: () =>
            run(async (cwd) => {
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
            }, true),
        read: (planId) => run((cwd) => readActive(cwd, requirePlanId(planId)), true),
        readArchived: (planId) => run((cwd) => readArchived(cwd, requirePlanId(planId)), true),
        create: (input) =>
            run(async (cwd) => {
                const planId = requirePlanId(await createSavedPlan(cwd, input));
                return await readActive(cwd, planId);
            }),
        edit: (id, edit) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(edit.expectedRevision);
                await readActive(cwd, planId);
                const current = await loadPlanBodyById(cwd, planId);
                checkRevision(edit.expectedRevision, current.revision);
                const saved = await savePlanBodyById(cwd, planId, edit.body, current.bodyHash, {
                    expectedRevision: edit.expectedRevision,
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
