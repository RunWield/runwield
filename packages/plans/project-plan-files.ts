import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { checkedProjectRuntimeLayout, withProjectRuntimeReadScope } from "@runwield/project-runtime/layout";
import { readWorktreeRegistryAtPath } from "@runwield/project-runtime/registry-inspection";
import { join } from "node:path";
import type { PendingControllerRepair } from "./checkout-controller.ts";
import type { WorkflowControllerState } from "./controller-state.ts";
import type { PlanFrontMatter } from "./document.ts";
import { currentExecutionRecoveryObservation } from "./execution-recovery.ts";
import { isPlanId, planArtifactReference, type PlanId, type PlanTextLoaded } from "./format.ts";
import {
    listPlanPackages,
    packageWorkflowRevision,
    readPackageControllerEvidence,
    readPlanPackage,
    readPlanPackagePublication,
    type LoadedPlanPackage,
    type PackageAttemptReference,
} from "./package-storage.ts";
import { readRetainedExecutionPlan, type RetainedExecutionRead } from "./retained-execution.ts";
import { PlanNotFoundError } from "./store-errors.ts";
import type { ProjectPlanDocument, ProjectPlanReadAvailability } from "./store.ts";

export { currentExecutionRecoveryObservation } from "./execution-recovery.ts";

interface PackagePlanIdentity {
    planId: string;
}
export type PackagePlanTarget = string | PackagePlanIdentity;

interface PackageReadSelection {
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

function forOwner(identity: ProjectStoreIdentity) {
    async function readGeneration(target: PackagePlanTarget, selection?: PackageReadSelection, activeOnly = false) {
        const { selected, retained } = await selectWorkflowRead(identity, target, selection, activeOnly);
        if (activeOnly && selected.metadata.archive && !selected.metadata.archive.restoredAt)
            throw new PlanNotFoundError(selected.metadata.planId);
        return { selected, loaded: retained ?? (await projectPackage(identity, selected)) };
    }

    async function readResource(target: PackagePlanTarget, selection?: PackageReadSelection, activeOnly = false) {
        const { selected, loaded } = await readGeneration(target, selection, activeOnly);
        const { name, planId } = selected.metadata;
        return { ...loaded, name, planName: name, planId, relativePath: planArtifactReference(planId) };
    }

    return {
        async read(planId: PlanId): Promise<ProjectPlanDocument> {
            return { ...projectPlanDocumentFields(await readResource({ planId }, undefined, true)), planId };
        },
        readResource,
        async readWorkflow(target: PackagePlanTarget, selection?: PackageReadSelection): Promise<PackagePlanText> {
            return (await readGeneration(target, selection)).loaded;
        },
        select: (target: PackagePlanTarget, selection?: PackageReadSelection) =>
            selectPackage(identity, target, selection),
        readController: (plan: LoadedPlanPackage) => readController(identity, plan),
        observeAttempt: (plan: LoadedPlanPackage, binding: PackageAttemptReference | undefined) =>
            observeAttempt(identity, plan, binding),
    };
}

/** Read canonical Plan packages for an admitted personal Project owner. */
export const projectPlanFiles = { forOwner };
