import { withWorkRecordOwner } from "../work-records/owner.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import { validationCheckpointCanResume } from "./validation-checkpoint.ts";
import { journalPackageMetadataWrite } from "./state-transition.ts";
/** Explicit internal package authority. A scope propagates an admitted source through existing workflow owners. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { inspectProjectIdentity, type ProjectIdentity } from "../project-identity.ts";
import {
    capturePlanPackageInput,
    listPlanPackages,
    readPlanPackage,
    readPlanImportEvidence,
    readPlanPackageInput,
    readPlanPackagePublication,
    updatePlanPackageMetadata,
    withPlanPackageLocks,
    packageDefinitionStrings,
    packageControllerStrings,
    packageControllerNumbers,
    packageControllerEnums,
    type LoadedPlanPackage,
    type PackageWorkflowInput,
    type PackageDefinition,
    type PackageControllerState,
    type PackageWorkflowEvidence,
} from "../plan-package-store.ts";
import {
    readPackageControllerEvidence,
    writePackageControllerEvidence,
    readControllerRecord,
    inspectControllerDocumentWorktrees,
    assertControllerDocumentAvailable,
} from "./controller-registry.ts";
import { CONTROLLER_STATE_FIELDS, pickControllerState, type WorkflowControllerState } from "./controller-state.ts";
import { findById } from "../worktree-registry.js";
import { inspectImportFile } from "../plan-package-import.ts";
import type { PlanFrontMatter } from "../../plan-store.js";

export interface PackageDeliveryCopyPolicy {
    plans: boolean;
    workRecords?: import("../plan-package-store.ts").DeliveryCopy[];
}

export interface PackageWorkflowSelection {
    identity: ProjectIdentity;
    planId: string;
    expectedRevision: number;
    deliveryCopies?: PackageDeliveryCopyPolicy;
}
export class LegacyPackageContinuation extends Error {
    constructor(
        readonly repositoryRoot: string,
        readonly planName: string,
        readonly attemptId: string,
    ) {
        super("This imported Plan continues through its original legacy execution owner.");
        this.name = "LegacyPackageContinuation";
    }
}
interface PackageWorkflowScope {
    selection: PackageWorkflowSelection;
    executionJournals?: boolean;
}
const sources = new AsyncLocalStorage<PackageWorkflowScope>();
export function packageExecutionJournalOwner(): string | undefined {
    const scope = sources.getStore();
    return scope?.executionJournals ? scope.selection.identity.checkoutRoot : undefined;
}
export async function withPackageExecutionJournal<T>(run: () => Promise<T>): Promise<T> {
    const scope = sources.getStore();
    return scope ? await sources.run({ ...scope, executionJournals: true }, run) : await run();
}

export function currentPackageSelection(): PackageWorkflowSelection | undefined {
    return sources.getStore()?.selection;
}

/** Selection is never inferred from a name, path, or the presence of a package. */
export async function withPackageWorkflow<T>(
    cwd: string,
    selection: PackageWorkflowSelection,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    const owner = inspectProjectIdentity(cwd);
    if (
        owner.kind !== "existing" ||
        owner.identity.projectId !== selection.identity.projectId ||
        owner.identity.repositoryId !== selection.identity.repositoryId ||
        owner.identity.personalOwner.kind !== selection.identity.personalOwner.kind ||
        owner.identity.personalOwner.identity !== selection.identity.personalOwner.identity ||
        owner.identity.executionAccountHome !== selection.identity.executionAccountHome
    )
        throw new Error("Package selection does not belong to this launch owner and repository.");
    const selected = await readPlanPackage(selection.identity, { planId: selection.planId });
    if (selected.kind !== "loaded") throw new Error(selected.message);
    if (planName !== undefined && selected.metadata.name !== planName)
        throw new Error("Package selection does not match the requested Plan name.");
    if (selected.metadata.revision !== selection.expectedRevision)
        throw new Error("Package selection changed; reload its current metadata.");
    if (selected.metadata.archive && !selected.metadata.archive.restoredAt)
        throw new Error("This Plan package is archived.");
    if (selected.metadata.references.legacyImport) {
        const retained = await readPlanImportEvidence(selection.identity, selected.metadata.references.legacyImport);
        if (retained.repositoryId !== selection.identity.repositoryId)
            throw new Error("Imported execution evidence belongs to another repository.");
        const unfinished = retained.attempts.filter((entry) => !["merged", "abandoned"].includes(entry.status));
        if (!unfinished.length && retained.attempts.length) {
            const controller = await readControllerRecord(selection.identity.checkoutRoot, {
                planId: selected.metadata.planId,
                planName: selected.metadata.name,
            });
            const authority = await inspectImportFile(retained.authority.path);
            if (
                JSON.stringify(controller) !== JSON.stringify(retained.controller) ||
                authority.digest !== retained.authority.digest
            )
                throw new Error("Settled import evidence changed; preserve its original owner evidence.");
            for (const prior of retained.attempts) {
                const live = await findById(selection.identity.checkoutRoot, prior.id);
                if (
                    prior.planId !== selected.metadata.planId ||
                    !live ||
                    JSON.stringify(live) !== JSON.stringify(prior)
                )
                    throw new Error("Settled import attempt evidence is missing or changed.");
            }
        }
        if (unfinished.length > 1)
            throw new Error("Imported execution ownership is ambiguous; retain all attempts for recovery.");
        if (unfinished.length) {
            const attempt = unfinished[0];
            if (attempt.planId !== selected.metadata.planId)
                throw new Error("Imported execution Plan identity changed.");
            const live = await findById(selection.identity.checkoutRoot, attempt.id);
            const controller = await readControllerRecord(selection.identity.checkoutRoot, {
                planId: selected.metadata.planId,
                planName: selected.metadata.name,
            });
            const authority = await inspectImportFile(retained.authority.path);
            if (
                !live ||
                JSON.stringify(live) !== JSON.stringify(attempt) ||
                JSON.stringify(controller) !== JSON.stringify(retained.controller) ||
                authority.digest !== retained.authority.digest
            )
                throw new Error("Imported execution evidence changed; preserve the original attempt for recovery.");
            const checkpoint = controller?.state.validationCheckpoint;
            if (
                checkpoint &&
                !validationCheckpointCanResume(checkpoint, attempt.id, selected.metadata.definition.status)
            )
                throw new Error("Imported checkpoint does not apply to its original attempt.");
            const [checked] = await inspectControllerDocumentWorktrees(selection.identity.checkoutRoot, [live]);
            assertControllerDocumentAvailable(checked);
            throw new LegacyPackageContinuation(selection.identity.checkoutRoot, attempt.planName, attempt.id);
        }
    }
    return await withWorkRecordOwner(cwd, selection.identity, () => sources.run({ selection }, run));
}

interface PackagePlanIdentity {
    planId: string;
}
type PackageWorkflowTarget = string | PackagePlanIdentity;

export async function selectedPackage(target: PackageWorkflowTarget): Promise<LoadedPlanPackage> {
    const selection = currentPackageSelection();
    if (!selection) throw new Error("Package authority requires explicit admission.");
    // Known identities never pass through the admitted publication's frozen-name alias.
    if (typeof target !== "string") {
        const plan = await readPlanPackage(selection.identity, target);
        if (plan.kind !== "loaded") throw new Error(plan.message);
        return plan;
    }
    const planName = target;
    const catalog = await listPlanPackages(selection.identity, true);
    if (catalog.issues.length) throw new Error(catalog.issues[0].message);
    const admitted = catalog.packages.find((p) => p.metadata.planId === selection.planId);
    if (admitted?.metadata.name === planName) return admitted;
    const reference = admitted?.metadata.workflow?.publication;
    if (reference) {
        const retained = await readPlanPackagePublication(selection.identity, reference);
        if (
            retained.members.some(
                (member) => member.metadata.planId === selection.planId && member.metadata.name === planName,
            )
        )
            return admitted;
    }
    const selected = catalog.packages.find((p) => p.metadata.name === planName);
    if (!selected) throw new Error(`No canonical package named ${planName}.`);
    return selected;
}

export async function packageWorkflowLocks<T>(planNames: PackageWorkflowTarget[], run: () => Promise<T>): Promise<T> {
    const selection = currentPackageSelection();
    if (!selection) return await run();
    const packages = await Promise.all(planNames.map(selectedPackage));
    const catalog = await listPlanPackages(selection.identity, true);
    for (const parent of [...packages]) {
        const ownerId = parent.metadata.parentPlanId || parent.metadata.planId;
        if (parent.metadata.definition.classification === "PROJECT" || parent.metadata.parentPlanId)
            packages.push(...catalog.packages.filter((p) => p.metadata.parentPlanId === ownerId));
    }
    const ids = [
        ...new Set(
            packages.flatMap((p) => [p.metadata.planId, ...(p.metadata.parentPlanId ? [p.metadata.parentPlanId] : [])]),
        ),
    ];
    return await withPlanPackageLocks(selection.identity, ids, run);
}

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}
function definitionHash(packages: LoadedPlanPackage[], ignoreCompletion = true): string {
    return hash(
        JSON.stringify(
            packages.map(({ metadata }) => {
                const { status: _status, ...definition } = metadata.definition;
                if (ignoreCompletion) {
                    delete definition.epicCompletionMode;
                    delete definition.epicDoneEnoughAt;
                    delete definition.epicDoneEnoughSummary;
                }
                return {
                    planId: metadata.planId,
                    definition,
                    parentPlanId: metadata.parentPlanId,
                    dependencyPlanIds: metadata.dependencyPlanIds,
                };
            }),
        ),
    );
}
async function requiredPackages(plan: LoadedPlanPackage): Promise<LoadedPlanPackage[]> {
    const selection = currentPackageSelection()!;
    const result = [plan];
    if (plan.metadata.parentPlanId) {
        const parent = await readPlanPackage(selection.identity, { planId: plan.metadata.parentPlanId });
        if (parent.kind !== "loaded") throw new Error(parent.message);
        result.push(parent);
    }
    return result;
}
export async function capturePackageWorkflowInput(
    planName: string,
    nextDefinition?: PackageDefinition,
): Promise<PackageWorkflowInput> {
    const selection = currentPackageSelection()!;
    const packages = await requiredPackages((await selectedPackage(planName))!);
    return await withPlanPackageLocks(
        selection.identity,
        packages.map((p) => p.metadata.planId),
        async () => {
            const inputs = [];
            for (const plan of packages)
                inputs.push(await capturePlanPackageInput(selection.identity, plan.metadata.planId));
            const current = await requiredPackages((await selectedPackage(planName))!);
            if (definitionHash(current) !== definitionHash(packages))
                throw new Error("Required Plan definition changed during capture.");
            const input = { inputs, definitionHash: definitionHash(current) };
            await assertPackageWorkflowInput(planName, input);
            if (nextDefinition)
                input.definitionHash = definitionHash(
                    current.map((p, index) =>
                        index === 0 ? { ...p, metadata: { ...p.metadata, definition: nextDefinition } } : p,
                    ),
                );
            return input;
        },
    );
}
export async function assertPackageWorkflowInput(
    planName: string,
    input: PackageWorkflowInput,
    equivalent?: (left: string, right: string, documentName: string, planId: string) => boolean,
): Promise<void> {
    const selection = currentPackageSelection()!;
    const packages = await requiredPackages((await selectedPackage(planName))!);
    // Accept legacy full-definition digests; new inputs omit Core-authored completion facts.
    if (
        (input.definitionHash !== definitionHash(packages) &&
            input.definitionHash !== definitionHash(packages, false)) ||
        input.inputs.length !== packages.length
    ) {
        throw new Error("Required Plan definition or membership changed; review the current input.");
    }
    for (const plan of packages) {
        const reference = input.inputs.find((ref) => ref.planId === plan.metadata.planId);
        if (!reference) throw new Error("Required parent input is missing.");
        const retained = await readPlanPackageInput(selection.identity, reference);
        if (
            retained.documents.length !== plan.documents.length ||
            plan.documents.some((doc) => {
                const before = retained.documents.find((prior) => prior.name === doc.name);
                return (
                    !before ||
                    (before.hash !== doc.hash &&
                        (!equivalent ||
                            !equivalent(
                                new TextDecoder().decode(before.bytes),
                                new TextDecoder().decode(doc.bytes),
                                doc.name,
                                plan.metadata.planId,
                            )))
                );
            })
        )
            throw new Error("Required Plan documents changed; review the current input.");
    }
}

/** Bind a resolved default before reserving the attempt, preserving the reviewed document references. */
export async function resolvePackageExecutionTarget(planName: string, targetBranch: string): Promise<void> {
    const plan = await selectedPackage(planName);
    if (plan.metadata.definition.targetBranch) return;
    const workflow = { ...plan.metadata.workflow };
    if (!workflow.readiness) throw new Error("Execution requires retained package readiness input.");
    await assertPackageWorkflowInput(planName, workflow.readiness);
    const packages = await requiredPackages(plan);
    const input = {
        ...workflow.readiness,
        definitionHash: definitionHash(
            packages.map((item, index) =>
                index === 0
                    ? {
                          ...item,
                          metadata: { ...item.metadata, definition: { ...item.metadata.definition, targetBranch } },
                      }
                    : item,
            ),
        ),
    };
    workflow.review = input;
    workflow.readiness = input;
    if (workflow.attempt) workflow.attempt = { ...workflow.attempt, input };
    await updatePackageWorkflowMetadata(
        planName,
        { targetBranch },
        (await loadPackageWorkflowPlan(planName)).revision,
        workflow,
    );
}

/** Only positive settlement evidence releases the personal owner's attempt guard. */
export async function releaseSettledPackageAttempt(planName: string): Promise<void> {
    await packageWorkflowLocks([planName], async () => {
        await loadPackageWorkflowPlan(planName);
        const plan = await selectedPackage(planName);
        const binding = plan.metadata.workflow?.attempt;
        const entry = binding ? await findById(binding.repositoryRoot, binding.attemptId) : null;
        if (entry?.status === "abandoned") await updatePackageWorkflowMetadata(planName, {});
    });
}

export async function packageController(plan: LoadedPlanPackage): Promise<WorkflowControllerState> {
    const ref = plan.metadata.workflow?.controller;
    const evidence = ref ? await readPackageControllerEvidence(currentPackageSelection()!.identity, ref) : {};
    return { ...evidence, ...plan.metadata.controller };
}
export async function loadPackageWorkflowPlan(planName: PackageWorkflowTarget) {
    const plan = await selectedPackage(planName);

    const selection = currentPackageSelection()!;
    const catalog = await listPlanPackages(selection.identity, true);
    const name = (id: string) => catalog.packages.find((p) => p.metadata.planId === id)?.metadata.name || id;
    const markdown = new TextDecoder().decode(plan.documents.find((doc) => doc.name === "context.md")!.bytes);
    const binding = plan.metadata.workflow?.attempt;
    if (binding) {
        const boundOwner = inspectProjectIdentity(binding.repositoryRoot);
        if (
            binding.personalOwner !== selection.identity.personalOwner.identity ||
            boundOwner.kind !== "existing" ||
            boundOwner.identity.repositoryId !== binding.repositoryId ||
            boundOwner.identity.projectId !== selection.identity.projectId ||
            boundOwner.identity.personalOwner.identity !== binding.personalOwner
        )
            throw new Error("Package attempt repository or personal owner changed.");
        if (
            !binding.input.inputs.some(
                (input) => input.planId === plan.metadata.planId && input.projectId === selection.identity.projectId,
            )
        )
            throw new Error("Package attempt input belongs to a different Plan.");
    }
    const attempt = binding ? await findById(binding.repositoryRoot, binding.attemptId) : null;
    if (attempt && (attempt.planId !== plan.metadata.planId || attempt.id !== binding?.attemptId))
        throw new Error("Package attempt evidence belongs to a different Plan.");
    const attrs = {
        ...plan.metadata.definition,
        ...(await packageController(plan)),
        workRecord: plan.metadata.workflow?.workRecord,
        planId: plan.metadata.planId,
        createdAt: plan.metadata.createdAt,
        parentPlan: plan.metadata.parentPlanId ? name(plan.metadata.parentPlanId) : undefined,
        dependencies: plan.metadata.dependencyPlanIds.map(name),
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
        revision: hash(
            JSON.stringify({
                revision: plan.metadata.revision,
                documents: plan.documents.map(({ name, hash }) => ({ name, hash })),
            }),
        ),
        hasFrontMatter: false,
        frontMatterRevision: undefined,
        readAvailability: undefined,
    };
}

export async function updatePackageWorkflowMetadata(
    planName: PackageWorkflowTarget,
    updates: Partial<PlanFrontMatter>,
    expectedRevision?: string,
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
    return await packageWorkflowLocks([planName], async () => {
        const current = (await selectedPackage(planName))!;
        const view = (await loadPackageWorkflowPlan(planName))!;
        if (expectedRevision !== undefined && view.revision !== expectedRevision)
            throw new Error("Package input changed before the metadata write.");
        const workflow = { ...current.metadata.workflow, ...workflowUpdate };
        if (Object.hasOwn(updates, "workRecord")) workflow.workRecord = updates.workRecord;
        const binding = workflow.attempt;
        const entry = binding ? await findById(binding.repositoryRoot, binding.attemptId) : null;
        if (entry?.status === "abandoned") workflow.attempt = undefined;
        const definition: PackageDefinition = { ...current.metadata.definition };
        const controller: PackageControllerState = { ...current.metadata.controller };
        const state = { ...(await packageController(current)), ...pickControllerState(updates) };
        for (const [key, value] of Object.entries(updates)) {
            if (definitionFields.includes(key)) Object.assign(definition, { [key]: value ?? undefined });
            if (scalarFields.includes(key)) Object.assign(controller, { [key]: value ?? undefined });
        }
        const evidence: WorkflowControllerState = {};
        for (const key of CONTROLLER_STATE_FIELDS) {
            if (!scalarFields.includes(key) && state[key] !== undefined) Object.assign(evidence, { [key]: state[key] });
        }
        const ref = await writePackageControllerEvidence(
            currentPackageSelection()!.identity,
            current.metadata.planId,
            evidence,
        );
        await journalPackageMetadataWrite(
            current.metadata,
            JSON.parse(
                JSON.stringify({
                    ...current.metadata,
                    revision: current.metadata.revision + 1,
                    definition,
                    controller,
                    workflow: { ...workflow, controller: ref },
                }),
            ),
        );
        await updatePlanPackageMetadata(
            currentPackageSelection()!.identity,
            current.metadata.planId,
            current.metadata.revision,
            {
                definition,
                controller,
                workflow: { ...workflow, controller: ref },
            },
        );
        return (await loadPackageWorkflowPlan(planName))!.attrs;
    });
}

export class PackageExecutionContinuation extends Error {
    constructor(readonly binding: NonNullable<import("../plan-package-store.ts").PackageWorkflowEvidence["attempt"]>) {
        super(`Continue attempt ${binding.attemptId} in its recorded repository.`);
        this.name = "PackageExecutionContinuation";
    }
}
export async function reservePackageExecution(
    planName: string,
    attemptId: string,
    executionMode?: "non_git_in_place",
): Promise<void> {
    const selection = currentPackageSelection()!;
    const plan = await selectedPackage(planName);
    const existing = plan.metadata.workflow?.attempt;
    if (existing) {
        if (existing.personalOwner !== selection.identity.personalOwner.identity)
            throw new Error("Execution belongs to another personal owner.");
        if (existing.repositoryId !== selection.identity.repositoryId) throw new PackageExecutionContinuation(existing);
        if (
            existing.repositoryRoot !== resolvePrimaryCheckoutRoot(selection.identity.checkoutRoot) ||
            existing.attemptId !== attemptId
        )
            throw new Error("Execution attempt binding changed.");
        const entry = await findById(existing.repositoryRoot, existing.attemptId);
        if (
            (!entry && !existing.executionMode && plan.metadata.definition.status !== "ready_for_work") ||
            (entry && entry.planId !== plan.metadata.planId)
        )
            throw new Error("Recorded package execution attempt is missing or replaced.");
        await assertPackageWorkflowInput(planName, plan.metadata.workflow?.readiness || existing.input);
        return;
    }
    const input = plan.metadata.workflow?.readiness;
    if (!input) throw new Error("Execution requires retained package readiness input.");
    await assertPackageWorkflowInput(planName, input);
    await updatePlanPackageMetadata(selection.identity, plan.metadata.planId, plan.metadata.revision, {
        workflow: {
            ...plan.metadata.workflow,
            attempt: {
                ...(executionMode ? { executionMode } : {}),
                personalOwner: selection.identity.personalOwner.identity,
                repositoryId: selection.identity.repositoryId,
                repositoryRoot: resolvePrimaryCheckoutRoot(selection.identity.checkoutRoot),
                attemptId,
                input,
            },
        },
    });
}
