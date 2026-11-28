import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { checkedProjectRuntimeLayout, withProjectRuntimeReadScope } from "@runwield/project-runtime/layout";
import { readWorktreeRegistryAtPath } from "@runwield/project-runtime/registry-inspection";
import { join } from "node:path";
import type { PendingControllerRepair } from "./checkout-controller.ts";
import { CONTROLLER_STATE_FIELDS, pickControllerState, type WorkflowControllerState } from "./controller-state.ts";
import type { PlanFrontMatter } from "./document.ts";
import { currentExecutionRecoveryObservation } from "./execution-recovery.ts";
import { packageDocumentText } from "./package-data.ts";
import { buildPlanEventUpdates, reopensReviewOnEdit } from "./lifecycle.ts";
import {
    assertReviewedDefinition,
    assertReviewedDocuments,
    changesReviewedInput,
    definitionHash,
    reviewInputWithDefinition,
    type PackageReviewChange,
    type ReviewDocumentEquivalence,
    type ReviewInputComparison,
} from "./review-input.ts";
import { comparePlansForList, isPlanId, planArtifactReference, type PlanId, type PlanTextLoaded } from "./format.ts";
import {
    capturePlanPackageInput,
    listPlanPackages,
    packageControllerEnums,
    packageControllerNumbers,
    packageControllerStrings,
    packageDefinitionStrings,
    planPackageFamilyIds,
    resolvePlanPackageReference,
    writePackageControllerEvidence,
    withPlanPackageLocks,
    packageWorkflowRevision,
    readPackageControllerEvidence,
    readPlanPackage,
    readPlanPackagePublication,
    type LoadedPlanPackage,
    type PackageAttemptReference,
    type PackageControllerState,
    type PackageDefinition,
    type PackageWorkflowEvidence,
    type PackageWorkflowInput,
} from "./package-storage.ts";
import { readRetainedExecutionPlan, type RetainedExecutionRead } from "./retained-execution.ts";
import { PlanNotFoundError } from "./store-errors.ts";
import type {
    ProjectPlanCatalog,
    ProjectPlanCatalogEntry,
    ProjectPlanDocument,
    ProjectPlanDiagnostic,
    ProjectPlanReadAvailability,
} from "./store.ts";

export { currentExecutionRecoveryObservation } from "./execution-recovery.ts";
export type { ReviewDocumentEquivalence } from "./review-input.ts";

interface PackagePlanIdentity {
    planId: string;
}
export type PackagePlanTarget = string | PackagePlanIdentity;

export interface PackageReadSelection {
    planId: string;
    expectedName?: string;
}

interface PackagePlanText extends PlanTextLoaded {
    readAvailability?: ProjectPlanReadAvailability;
    pendingControllerRepairs?: PendingControllerRepair[];
}

async function selectPackage(
    identity: ProjectStoreIdentity,
    target: PackagePlanTarget,
    selection?: PackageReadSelection,
    activeOnly = false,
): Promise<LoadedPlanPackage> {
    // Known identities never pass through the admitted publication's frozen-name alias.
    if (typeof target !== "string") {
        const plan = await readPlanPackage(identity, target);
        if (activeOnly && plan.kind === "missing") throw new PlanNotFoundError(target.planId);
        if (plan.kind !== "loaded") throw new Error(plan.message);
        return plan;
    }
    const planName = target;
    const catalog = await listPlanPackages(identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    const admitted = catalog.packages.find((p) => p.metadata.planId === selection?.planId);
    if (admitted?.metadata.name === planName) return admitted;
    if (selection?.expectedName === planName) throw new Error("The bound Plan identity changed.");
    const reference = admitted?.metadata.workflow?.publication;
    if (reference) {
        const retained = await readPlanPackagePublication(identity, reference);
        if (
            retained.members.some(
                (member) => member.metadata.planId === selection?.planId && member.metadata.name === planName,
            )
        )
            return admitted;
    }
    const selected = catalog.packages.find((p) => p.metadata.name === planName);
    if (!selected) throw new Error(`No canonical package named ${planName}.`);
    return selected;
}

async function readController(
    identity: ProjectStoreIdentity,
    plan: LoadedPlanPackage,
): Promise<WorkflowControllerState> {
    const ref = plan.metadata.workflow?.controller;
    const evidence = ref ? await readPackageControllerEvidence(identity, ref) : {};
    return { ...evidence, ...plan.metadata.controller };
}

async function observeAttempt(
    identity: ProjectStoreIdentity,
    plan: LoadedPlanPackage,
    binding: PackageAttemptReference | undefined,
) {
    if (!binding) return null;
    const inputMatches = binding.input.inputs.some(
        (input) => input.planId === plan.metadata.planId && input.projectId === identity.projectId,
    );
    if (projects.home.isOwner(identity)) {
        if (
            binding.personalOwner !== identity.personalOwner.identity ||
            binding.repositoryId !== identity.repositoryId ||
            !inputMatches
        )
            throw new Error("Package attempt belongs to a different admitted owner or repository.");
        return currentExecutionRecoveryObservation(identity, plan, binding)?.entry ?? null;
    }
    const boundOwner = projects.checkout.inspect(binding.repositoryRoot, { context: identity });
    if (
        binding.personalOwner !== identity.personalOwner.identity ||
        boundOwner.kind !== "existing" ||
        boundOwner.identity.repositoryId !== binding.repositoryId ||
        boundOwner.identity.projectId !== identity.projectId ||
        boundOwner.identity.personalOwner.identity !== binding.personalOwner
    )
        throw new Error("Package attempt repository or personal owner changed.");
    if (!inputMatches) throw new Error("Package attempt input belongs to a different Plan.");

    const attempt = await projects.launch.withContext(boundOwner.identity, () =>
        withProjectRuntimeReadScope(async () => {
            const layout = await checkedProjectRuntimeLayout(boundOwner.identity.checkoutRoot);
            const entries = await readWorktreeRegistryAtPath(layout.primary.worktreeRegistryPath);
            return entries.find((entry) => entry.id === binding.attemptId) ?? null;
        }),
    );
    if (attempt && attempt.planId !== plan.metadata.planId)
        throw new Error("Package attempt evidence belongs to a different Plan.");
    return attempt;
}

async function prepareWorkflowUpdate(
    identity: ProjectStoreIdentity,
    current: LoadedPlanPackage,
    attrs: PlanFrontMatter,
    updates: Partial<PlanFrontMatter>,
    workflowUpdate?: PackageWorkflowEvidence,
) {
    const scalarFields = [
        ...packageControllerStrings,
        ...packageControllerNumbers,
        ...Object.keys(packageControllerEnums),
    ];
    const definitionFields = [
        "classification",
        "status",
        "affectedPaths",
        "order",
        "frontend",
        "devServerHmr",
        "tickets",
        "supersedes",
        "planDeviations",
        ...packageDefinitionStrings,
    ];
    const workflow = { ...current.metadata.workflow, ...workflowUpdate };
    if (Object.hasOwn(updates, "workRecord")) workflow.workRecord = updates.workRecord;
    const entry = await observeAttempt(identity, current, workflow.attempt);
    if (entry?.status === "abandoned") workflow.attempt = undefined;
    const catalog = await listPlanPackages(identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    const related = (reference: string) => resolvePlanPackageReference(catalog.packages, reference, attrs.parentPlan);
    const relations = {
        parentPlanId: Object.hasOwn(updates, "parentPlan")
            ? updates.parentPlan
                ? related(updates.parentPlan)
                : null
            : current.metadata.parentPlanId,
        dependencyPlanIds: Object.hasOwn(updates, "dependencies")
            ? (updates.dependencies || []).map(related)
            : current.metadata.dependencyPlanIds,
    };
    const definition: PackageDefinition = { ...current.metadata.definition };
    const controller: PackageControllerState = { ...current.metadata.controller };
    const state = { ...(await readController(identity, current)), ...pickControllerState(updates) };
    for (const [key, value] of Object.entries(updates)) {
        if (definitionFields.includes(key)) Object.assign(definition, { [key]: value ?? undefined });
        if (scalarFields.includes(key)) Object.assign(controller, { [key]: value });
    }
    const evidence: WorkflowControllerState = {};
    for (const key of CONTROLLER_STATE_FIELDS) {
        if (!scalarFields.includes(key) && state[key] !== undefined) Object.assign(evidence, { [key]: state[key] });
    }
    const ref = await writePackageControllerEvidence(identity, current.metadata.planId, evidence);
    return { ...relations, definition, controller, workflow: { ...workflow, controller: ref } };
}

async function projectPackage(identity: ProjectStoreIdentity, plan: LoadedPlanPackage): Promise<PackagePlanText> {
    const { parentPlanId, dependencyPlanIds } = plan.metadata;
    const family = parentPlanId || dependencyPlanIds.length ? (await listPlanPackages(identity, true)).packages : [];
    const name = (id: string) => family.find((p) => p.metadata.planId === id)?.metadata.name || id;
    const markdown = new TextDecoder().decode(plan.documents.find((doc) => doc.name === "context.md")!.bytes);
    const attempt = await observeAttempt(identity, plan, plan.metadata.workflow?.attempt);
    const attrs = {
        ...plan.metadata.definition,
        ...(await readController(identity, plan)),
        workRecord: plan.metadata.workflow?.workRecord,
        planId: plan.metadata.planId,
        createdAt: plan.metadata.createdAt,
        ...(plan.metadata.archive && !plan.metadata.archive.restoredAt
            ? {
                  archivedAt: plan.metadata.archive.archivedAt,
                  archiveReason: plan.metadata.archive.reason,
                  archivedFromStatus: plan.metadata.archive.fromStatus,
              }
            : {}),
        ...(plan.metadata.archive?.restoredAt
            ? { restoredAt: plan.metadata.archive.restoredAt, restoredFromPath: plan.metadata.archive.restoredFromPath }
            : {}),
        parentPlan: parentPlanId ? name(parentPlanId) : undefined,
        dependencies: dependencyPlanIds.map(name),
        ...(attempt
            ? {
                  worktreeId: attempt.id,
                  worktreePath: attempt.path,
                  worktreeBranch: attempt.branch,
                  worktreeBaseBranch: attempt.baseBranch,
                  worktreeBaseCommit: attempt.baseCommit,
                  worktreeStatus: attempt.status,
                  executionBaselineTree: attempt.executionBaselineTree,
              }
            : {}),
    } as PlanFrontMatter;
    return {
        kind: "loaded" as const,
        path: join(plan.path, "context.md"),
        markdown,
        body: markdown,
        attrs,
        controllerRevision: plan.metadata.revision,
        revision: packageWorkflowRevision(plan),
        hasFrontMatter: false,
        frontMatterRevision: undefined,
        readAvailability: undefined,
    };
}

async function selectWorkflowRead(
    identity: ProjectStoreIdentity,
    target: PackagePlanTarget,
    selection: PackageReadSelection | undefined,
    activeOnly: boolean,
): Promise<RetainedExecutionRead> {
    const checkout = projects.home.isOwner(identity) ? undefined : identity;
    if (checkout && typeof target !== "string" && isPlanId(target.planId))
        return await readRetainedExecutionPlan(checkout, target.planId);
    const selected = await selectPackage(identity, target, selection, activeOnly);
    if (checkout && selected.metadata.references.legacyImport) {
        const planId = selected.metadata.planId;
        if (!isPlanId(planId)) throw new Error("Invalid Plan ID.");
        return await readRetainedExecutionPlan(checkout, planId);
    }
    return { selected };
}

type PlanDocumentFields = Pick<
    ProjectPlanDocument,
    "name" | "relativePath" | "body" | "revision" | "readAvailability"
> & {
    attrs: PlanFrontMatter;
};

interface PlanCatalogResource extends PlanDocumentFields {
    planId: string;
}

interface PlanCatalogDiagnostic extends Omit<ProjectPlanDiagnostic, "planId"> {
    path: string;
    planId?: string;
}

interface PlanResourceCatalog {
    resources: PlanCatalogResource[];
    diagnostics: PlanCatalogDiagnostic[];
}

/** Publish the logical resource fields without private filesystem locations. */
export function projectPlanDocumentFields(resource: PlanDocumentFields): Omit<ProjectPlanDocument, "planId"> {
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

/** Publish catalog resources and diagnostics without private filesystem locations. */
export function projectPlanCatalogFields(catalog: PlanResourceCatalog, cwd: string): ProjectPlanCatalog {
    return {
        resources: catalog.resources.map((resource): ProjectPlanCatalogEntry => {
            const document = projectPlanDocumentFields(resource);
            const { planId } = resource;
            if (!planId) return { ...document, planId: "" };
            if (!isPlanId(planId)) throw new Error("Plan access requires a durable Plan ID.");
            return { ...document, planId };
        }),
        diagnostics: catalog.diagnostics.map(({ name, kind, message, path, planId }) => {
            let sanitized = message;
            for (const locator of [cwd, path].filter(Boolean))
                sanitized = sanitized.split(locator).join("[workspace path]");
            return {
                name,
                kind,
                message: sanitized.replace(/(?:[A-Za-z]:)?[\\/][^\s"'\`<>)]*/g, "[workspace path]"),
                ...(isPlanId(planId) ? { planId } : {}),
            };
        }),
    };
}

function isArchived(plan: LoadedPlanPackage): boolean {
    return !!plan.metadata.archive && !plan.metadata.archive.restoredAt;
}

function resourceFields(loaded: PackagePlanText, { name, planId }: LoadedPlanPackage["metadata"]) {
    return { ...loaded, name, planName: name, planId, relativePath: planArtifactReference(planId) };
}

function forOwner(identity: ProjectStoreIdentity) {
    const select = (target: PackagePlanTarget, selection?: PackageReadSelection) =>
        selectPackage(identity, target, selection);

    async function requiredReviewPackages(plan: LoadedPlanPackage): Promise<LoadedPlanPackage[]> {
        if (!plan.metadata.parentPlanId) return [plan];
        const parent = await readPlanPackage(identity, { planId: plan.metadata.parentPlanId });
        if (parent.kind !== "loaded") throw new Error(parent.message);
        return [plan, parent];
    }

    async function assertInput(
        target: PackagePlanTarget,
        selection: PackageReadSelection,
        input: PackageWorkflowInput,
        comparison?: ReviewInputComparison,
    ): Promise<void> {
        const packages = await requiredReviewPackages(await select(target, selection));
        assertReviewedDefinition(packages, input);
        const owner = await select(target, selection);
        await assertReviewedDocuments(identity, packages, owner, input, comparison);
    }

    /** Freeze the selected Plan and its parent, permitting only the exact reviewed context replacement. */
    async function captureReviewInput(
        target: PackagePlanTarget,
        selection: PackageReadSelection,
        nextDefinition?: PackageDefinition,
        reviewedContext?: string,
    ): Promise<PackageWorkflowInput> {
        const packages = await requiredReviewPackages(await select(target, selection));
        return await withPlanPackageLocks(
            identity,
            packages.map(({ metadata }) => metadata.planId),
            async () => {
                const inputs = [];
                const reviewedSource = packages[0];
                for (const plan of packages) {
                    inputs.push(
                        await capturePlanPackageInput(
                            identity,
                            plan.metadata.planId,
                            plan === reviewedSource ? reviewedContext : undefined,
                        ),
                    );
                }
                const current = await requiredReviewPackages(await select(target, selection));
                const digest = definitionHash(current);
                if (digest !== definitionHash(packages))
                    throw new Error("Required Plan definition changed during capture.");
                const input = { inputs, definitionHash: digest };
                await assertInput(
                    target,
                    selection,
                    input,
                    reviewedContext === undefined
                        ? undefined
                        : {
                              kind: "captured-context",
                              planId: reviewedSource.metadata.planId,
                              retained: reviewedContext,
                              live: packageDocumentText(reviewedSource.documents)["context.md"],
                          },
                );
                return nextDefinition ? reviewInputWithDefinition(input, current, nextDefinition) : input;
            },
        );
    }

    async function readGeneration(target: PackagePlanTarget, selection?: PackageReadSelection, activeOnly = false) {
        const { selected, retained } = await selectWorkflowRead(identity, target, selection, activeOnly);
        if (activeOnly && isArchived(selected)) throw new PlanNotFoundError(selected.metadata.planId);
        return { selected, loaded: retained ?? (await projectPackage(identity, selected)) };
    }

    /** Prepare the reopened state for the caller to commit with the Plan edit. */
    async function prepareReviewInvalidation(plan: LoadedPlanPackage, change: PackageReviewChange) {
        const status = plan.metadata.definition.status;
        if (!changesReviewedInput(plan, change) || !reopensReviewOnEdit(status)) return;
        const { loaded } = await readGeneration({ planId: plan.metadata.planId });
        const updates = buildPlanEventUpdates("review_reopened", status, { triageMeta: loaded.attrs });
        return await prepareWorkflowUpdate(identity, plan, loaded.attrs, updates, {
            review: undefined,
            readiness: undefined,
        });
    }

    /** A write without an explicit workflow outcome or lifecycle transition may invalidate approval. */
    async function prepareWorkflowMetadataUpdate(
        plan: LoadedPlanPackage,
        attrs: PlanFrontMatter,
        updates: Partial<PlanFrontMatter>,
        workflow?: PackageWorkflowEvidence,
        recordsMilestone = false,
    ) {
        const prepared = await prepareWorkflowUpdate(identity, plan, attrs, updates, workflow);
        if (workflow || recordsMilestone || updates.status !== undefined) return prepared;
        const reopened = await prepareReviewInvalidation(plan, { kind: "edit", definition: prepared });
        if (!reopened) return prepared;
        return {
            ...prepared,
            definition: { ...prepared.definition, status: reopened.definition.status },
            controller: reopened.controller,
            workflow: reopened.workflow,
        };
    }

    async function readResource(target: PackagePlanTarget, selection?: PackageReadSelection, activeOnly = false) {
        const { selected, loaded } = await readGeneration(target, selection, activeOnly);
        return resourceFields(loaded, selected.metadata);
    }

    async function readResourceCatalog() {
        const catalog = await listPlanPackages(identity);
        const resources = await Promise.all(
            catalog.packages.map(async (entry) => {
                const { loaded } = await readGeneration({ planId: entry.metadata.planId });
                return resourceFields(loaded, entry.metadata);
            }),
        );
        return {
            resources: resources.sort(comparePlansForList),
            diagnostics: catalog.issues.map((issue) => ({
                name: "Plan package",
                path: issue.path,
                kind: "malformed" as const,
                message: issue.message,
            })),
        };
    }

    async function archivedPackages() {
        const catalog = await listPlanPackages(identity, true);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        return catalog.packages.filter(isArchived);
    }

    async function readArchivedResource(target: PackagePlanTarget) {
        const selected = (await archivedPackages()).find(({ metadata }) =>
            typeof target === "string"
                ? metadata.planId === target || metadata.name === target.replace(/^archived\//, "")
                : metadata.planId === target.planId,
        );
        if (!selected) return null;
        const { loaded } = await readGeneration({ planId: selected.metadata.planId });
        return { ...loaded, name: selected.metadata.name };
    }

    return {
        async list(): Promise<ProjectPlanCatalog> {
            return projectPlanCatalogFields(await readResourceCatalog(), projects.home.storeLocation(identity));
        },
        readResourceCatalog,
        async listWorkflowPlans(selection?: PackageReadSelection) {
            const catalog = await listPlanPackages(identity);
            if (catalog.issues.length) throw new Error(catalog.issues[0].message);
            const plans = await Promise.all(
                catalog.packages.map(async ({ metadata: { name } }) => ({
                    name,
                    ...(await readGeneration(name, selection)).loaded,
                })),
            );
            return plans.sort(comparePlansForList);
        },
        async listArchived() {
            const plans = await Promise.all(
                (await archivedPackages()).map(async ({ metadata: { name, planId } }) => {
                    const { loaded } = await readGeneration({ planId });
                    const { path, attrs } = loaded;
                    return {
                        name,
                        planName: name,
                        path,
                        attrs,
                        status: attrs.status,
                        summary: attrs.summary || "",
                        planId,
                    };
                }),
            );
            return plans.sort((a, b) => a.name.localeCompare(b.name));
        },
        readArchivedResource,
        async readArchived(planId: PlanId): Promise<ProjectPlanDocument> {
            const resource = await readArchivedResource({ planId });
            if (!resource || resource.attrs.planId !== planId) throw new PlanNotFoundError(planId);
            return {
                ...projectPlanDocumentFields({ ...resource, relativePath: planArtifactReference(planId) }),
                planId,
            };
        },
        async read(planId: PlanId): Promise<ProjectPlanDocument> {
            return { ...projectPlanDocumentFields(await readResource({ planId }, undefined, true)), planId };
        },
        readResource,
        async readWorkflow(target: PackagePlanTarget, selection?: PackageReadSelection): Promise<PackagePlanText> {
            return (await readGeneration(target, selection)).loaded;
        },
        select,
        async withFamilyLocks<T>(
            targets: PackagePlanTarget[],
            run: () => Promise<T>,
            selection?: PackageReadSelection,
        ) {
            const plans = await Promise.all(targets.map((target) => select(target, selection)));
            return await withPlanPackageLocks(identity, await planPackageFamilyIds(identity, plans), run);
        },
        captureReviewInput,
        async assertReviewInput(
            target: PackagePlanTarget,
            selection: PackageReadSelection,
            input: PackageWorkflowInput,
            equivalence?: ReviewDocumentEquivalence,
        ): Promise<void> {
            await assertInput(target, selection, input, equivalence);
        },
        async bindReviewInputTarget(plan: LoadedPlanPackage, input: PackageWorkflowInput, targetBranch: string) {
            return reviewInputWithDefinition(input, await requiredReviewPackages(plan), {
                ...plan.metadata.definition,
                targetBranch,
            });
        },
        async retainedReviewWrites(plan: LoadedPlanPackage, input: PackageWorkflowInput) {
            const required = await requiredReviewPackages(plan);
            return input.inputs.map((reference) => {
                const member = required.find(({ metadata }) => metadata.planId === reference.planId);
                if (!member) throw new Error("Reviewed Plan membership changed.");
                return { name: member.metadata.name, reference };
            });
        },
        prepareReviewInvalidation,
        readController: (plan: LoadedPlanPackage) => readController(identity, plan),
        prepareWorkflowMetadataUpdate,
        prepareWorkflowUpdate: (
            plan: LoadedPlanPackage,
            attrs: PlanFrontMatter,
            updates: Partial<PlanFrontMatter>,
            workflow?: PackageWorkflowEvidence,
        ) => prepareWorkflowUpdate(identity, plan, attrs, updates, workflow),
        observeAttempt: (plan: LoadedPlanPackage, binding: PackageAttemptReference | undefined) =>
            observeAttempt(identity, plan, binding),
    };
}

/** Read canonical Plan packages and prepare workflow metadata for an admitted personal Project owner. */
export const projectPlanFiles = { forOwner };
