import type { ManualQaSection, PackageWorkflowInput } from "@runwield/plans/store";
import {
    assertEpicPackageFamily,
    prepareManualQaSection,
    readActiveArtifactPackage,
} from "@runwield/plans/artifact-files";
import { EPIC_MANUAL_QA_FILE_NAME } from "@runwield/plans/format";
import { planHistoryFiles } from "@runwield/plans/history-files";
import { projects, type ProjectStoreIdentity as ProjectIdentity } from "@runwield/projects";
import {
    managedPlanStoreActive,
    loadManagedWorkflowPlan,
    reserveManagedExecution,
    captureManagedExecution,
    readManagedExecutionDocuments,
} from "./managed.ts";
import {
    projectPlanFiles,
    type PackagePlanTarget,
    type ReviewDocumentEquivalence,
} from "@runwield/plans/project-plan-files";
import { retainPlanAccess, retainManagedPlanAccess, type PlanAccess } from "./handles.ts";
import { continueImportedPackage } from "./legacy.ts";
import { currentRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { withWorkRecordOwner, withoutWorkRecordOwner } from "../shared/work-records/owner.ts";
import { journalPackageMetadataWrite } from "./transitions.ts";
import {
    requiresLifecycleOperationDocument,
    stageLifecycleOperationDocument,
} from "@runwield/plans/operation-receipts";
import { retainPlanReviewOperationResult } from "./operation-results.ts";
import type { SharedPlanReviewActionResult } from "./review.ts";
/** Explicit internal package authority. A scope propagates an admitted source through existing workflow owners. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { packageDocumentText, type PackageInputReference } from "@runwield/plans/file-snapshots";
import {
    packageDocumentContent,
    commitPlanPackageBatch,
    savePlanPackageDocument,
    readPlanPackage,
    readPlanPackageInput,
    readPlanPackagePublication,
    updatePlanPackageMetadata,
    type LoadedPlanPackage,
    type PackageDefinition,
    type PackageWorkflowEvidence,
} from "@runwield/plans/package-storage";
import type { WorkflowControllerState } from "@runwield/plans/controller-state";
import { plans, type PlanFrontMatter, type PlanId } from "@runwield/plans";

export interface PlanExecutionHost {
    projectId: string;
    repositoryId: string;
    checkoutId: string;
    repositoryRoot: string;
    checkoutRoot: string;
    personalOwner: { kind: "managed-remote"; identity: string };
}
const executionHosts = new AsyncLocalStorage<PlanExecutionHost>();
export async function withPackageExecutionHost<T>(host: PlanExecutionHost, run: () => Promise<T>): Promise<T> {
    return await executionHosts.run(host, run);
}
function executionRepositoryRoot(identity: ProjectIdentity): string {
    if (!projects.home.isOwner(identity)) return projects.checkout.primaryRoot(identity.checkoutRoot);
    const host = executionHosts.getStore();
    if (
        !host ||
        host.projectId !== identity.projectId ||
        host.repositoryId !== identity.repositoryId ||
        host.personalOwner.identity !== identity.personalOwner.identity
    )
        throw new Error("Home-owned execution requires its authenticated execution host.");
    return host.repositoryRoot;
}

export interface PackageDeliveryCopyPolicy {
    plans: boolean;
    workRecords?: import("@runwield/plans/publication-copies").DeliveryCopy[];
}

export interface PackageWorkflowSelection {
    identity: ProjectIdentity;
    planId: string;
    expectedRevision: number;
    expectedName?: string;
    deliveryCopies?: PackageDeliveryCopyPolicy;
}

/** Re-enter a recorded execution only after its current Plan identity and attempt are checked together. */
export async function withRecordedPlanAttempt<T>(
    cwd: string,
    selection: PackageWorkflowSelection,
    attemptId: string | undefined,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    const current = await readPlanPackage(selection.identity, { planId: selection.planId });
    if (current.kind !== "loaded") throw new Error(current.message);
    if (current.metadata.workflow?.attempt?.attemptId !== attemptId)
        throw new Error("Recorded Plan execution attempt binding changed.");
    return await withPackageWorkflow(cwd, { ...selection, expectedRevision: current.metadata.revision }, run, planName);
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
    identity: ProjectIdentity;
    selection?: PackageWorkflowSelection;
    executionJournals?: boolean;
}
const sources = new AsyncLocalStorage<PackageWorkflowScope>();
export function packageExecutionJournalOwner(): string | undefined {
    const scope = sources.getStore();
    return scope?.executionJournals && !projects.home.isOwner(scope.identity) ? scope.identity.checkoutRoot : undefined;
}
export async function withPackageExecutionJournal<T>(run: () => Promise<T>): Promise<T> {
    const scope = sources.getStore();
    return scope ? await sources.run({ ...scope, executionJournals: true }, run) : await run();
}

export function currentPackageSelection(): PackageWorkflowSelection | undefined {
    const selected = currentRetainedCheckoutSource() ? undefined : sources.getStore()?.selection;
    return selected ? structuredClone(selected) : undefined;
}

/** Project authority does not require a selected Plan, including in an empty store. */
export function currentPackageProject(): ProjectIdentity | undefined {
    const identity = currentRetainedCheckoutSource() ? undefined : sources.getStore()?.identity;
    return identity ? structuredClone(identity) : undefined;
}

/** Revalidate the account and repository at each request boundary; inspection performs no writes. */
export async function withPackageProject<T>(cwd: string, identity: ProjectIdentity, run: () => Promise<T>): Promise<T> {
    const owner = projects.home.isOwner(identity)
        ? (projects.home.assertStoreIdentity(identity), { kind: "existing" as const, identity })
        : projects.checkout.inspect(cwd);
    if (
        identity.personalOwner.kind !== "execution-account" ||
        owner.kind !== "existing" ||
        owner.identity.projectId !== identity.projectId ||
        owner.identity.repositoryId !== identity.repositoryId ||
        owner.identity.personalOwner.identity !== identity.personalOwner.identity ||
        owner.identity.executionAccountHome !== identity.executionAccountHome
    )
        throw new Error("Package Project does not belong to this launch owner and repository.");
    return await withWorkRecordOwner(cwd, identity, () => sources.run({ identity }, run));
}

/** Selection is never inferred from a name, path, or the presence of a package. */
export async function withPackageWorkflow<T>(
    cwd: string,
    selection: PackageWorkflowSelection,
    run: () => Promise<T>,
    planName?: string,
): Promise<T> {
    const owner = projects.home.isOwner(selection.identity)
        ? (projects.home.assertStoreIdentity(selection.identity),
          { kind: "existing" as const, identity: selection.identity })
        : projects.checkout.inspect(cwd);
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
    const canonical = async (expectedRevision = selection.expectedRevision) => {
        const current = await readPlanPackage(selection.identity, { planId: selection.planId });
        if (current.kind !== "loaded") throw new Error(current.message);
        if (
            current.metadata.name !== selected.metadata.name ||
            current.metadata.revision !== expectedRevision ||
            (current.metadata.archive && !current.metadata.archive.restoredAt)
        ) {
            throw new Error("Package selection changed; reload its current metadata.");
        }
        const admitted = { ...selection, expectedRevision, ...(planName ? { expectedName: planName } : {}) };
        return await withWorkRecordOwner(cwd, selection.identity, () =>
            sources.run({ identity: selection.identity, selection: admitted }, run),
        );
    };
    if (projects.home.isOwner(selection.identity)) {
        if (selected.metadata.references.legacyImport && !selected.metadata.workflow?.legacySettlement) {
            const evidence = await (
                await import("@runwield/plans/package-storage")
            ).readPlanImportEvidence(selection.identity, selected.metadata.references.legacyImport);
            const unfinished = evidence.attempts.some(
                (attempt) => !["validated", "abandoned"].includes(attempt.status),
            );
            const retained = await (
                await import("./retained-managed-execution.ts")
            ).readRetainedManagedExecution(selection.identity, selected.metadata.planId);
            if (unfinished && !retained?.cleanupComplete && !retained?.abandonmentComplete)
                throw new Error("Imported execution requires its original execution owner.");
        }
        return await canonical();
    }
    return await continueImportedPackage(selection.identity, selected, run, canonical);
}

export async function selectedPackage(target: PackagePlanTarget): Promise<LoadedPlanPackage> {
    const identity = currentPackageProject();
    if (!identity) throw new Error("Package authority requires explicit admission.");
    return await projectPlanFiles.forOwner(identity).select(target, currentPackageSelection());
}

export async function packageWorkflowLocks<T>(planNames: PackagePlanTarget[], run: () => Promise<T>): Promise<T> {
    const identity = currentPackageProject();
    if (!identity) return await run();
    return await projectPlanFiles.forOwner(identity).withFamilyLocks(planNames, run, currentPackageSelection());
}

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}
export async function capturePackageWorkflowInput(
    planName: PackagePlanTarget,
    nextDefinition?: PackageDefinition,
    reviewedContext?: string,
): Promise<PackageWorkflowInput> {
    const selection = currentPackageSelection()!;
    return await projectPlanFiles
        .forOwner(selection.identity)
        .captureReviewInput(planName, selection, nextDefinition, reviewedContext);
}

export async function assertPackageWorkflowInput(
    planName: PackagePlanTarget,
    input: PackageWorkflowInput,
    equivalence?: ReviewDocumentEquivalence,
): Promise<void> {
    const selection = currentPackageSelection()!;
    await projectPlanFiles.forOwner(selection.identity).assertReviewInput(planName, selection, input, equivalence);
}

/** Bind a resolved default before reserving the attempt, preserving the reviewed document references. */
export async function resolvePackageExecutionTarget(planName: string, targetBranch: string): Promise<void> {
    const plan = await selectedPackage(planName);
    if (plan.metadata.definition.targetBranch) return;
    const workflow = { ...plan.metadata.workflow };
    if (!workflow.readiness) throw new Error("Execution requires retained package readiness input.");
    await assertPackageWorkflowInput(planName, workflow.readiness);
    const input = await projectPlanFiles
        .forOwner(currentPackageSelection()!.identity)
        .bindReviewInputTarget(plan, workflow.readiness, targetBranch);
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
        const entry = await projectPlanFiles.forOwner(currentPackageProject()!).observeAttempt(plan, binding);
        if (entry?.status === "abandoned") await updatePackageWorkflowMetadata(planName, {});
    });
}

export async function packageController(plan: LoadedPlanPackage): Promise<WorkflowControllerState> {
    return await projectPlanFiles.forOwner(currentPackageProject()!).readController(plan);
}

export async function loadPackageWorkflowPlan(
    planName: PackagePlanTarget,
): Promise<import("../plan-store.ts").PlanTextLoaded> {
    if (managedPlanStoreActive())
        return await loadManagedWorkflowPlan(typeof planName === "string" ? planName : planName.planId);
    return await projectPlanFiles.forOwner(currentPackageProject()!).readWorkflow(planName, currentPackageSelection());
}

export async function updatePackageWorkflowMetadata(
    planName: PackagePlanTarget,
    updates: Partial<PlanFrontMatter>,
    expectedRevision?: string,
    workflowUpdate?: PackageWorkflowEvidence,
    milestone?: "approved" | { delivered: PackageInputReference },
    reviewedContext?: {
        text: string;
        input: PackageWorkflowInput;
        result?: SharedPlanReviewActionResult;
    },
) {
    return await packageWorkflowLocks([planName], async () => {
        const current = (await selectedPackage(planName))!;
        const view = (await loadPackageWorkflowPlan(planName))!;
        if (expectedRevision !== undefined && view.revision !== expectedRevision)
            throw new Error("Package input changed before the metadata write.");
        const identity = currentPackageProject()!;
        const files = projectPlanFiles.forOwner(identity);
        const metadataUpdate = await files.prepareWorkflowMetadataUpdate(
            current,
            view.attrs,
            updates,
            workflowUpdate,
            Boolean(milestone),
        );
        const { definition, controller, workflow } = metadataUpdate;
        const eventPackage = {
            documents: current.documents,
            metadata: { ...current.metadata, ...metadataUpdate, revision: current.metadata.revision + 1 },
        };
        let history = current.metadata.history;
        const historyFiles = planHistoryFiles.forOwner(identity);
        const ownReview = workflow.review?.inputs.find((input) => input.planId === current.metadata.planId);
        const delivery = workflow.delivery;
        if (milestone === "approved") {
            if (!ownReview) throw new Error("Approval requires retained Plan documents.");
            history = await historyFiles.capture(
                eventPackage,
                { milestone: "approved", at: controller.updatedAt || new Date().toISOString(), reason: "" },
                ownReview,
            );
        } else if (milestone) {
            history = await historyFiles.capture(
                eventPackage,
                {
                    milestone: "delivered",
                    at: controller.verifiedAt || new Date().toISOString(),
                    reason: "Confirmed publication",
                },
                milestone.delivered,
            );
        } else if (delivery && delivery.source.inputId !== current.metadata.workflow?.delivery?.source.inputId) {
            const manifest = await readPlanPackagePublication(identity, delivery.source);
            const member = manifest.members.find((member) => member.metadata.planId === current.metadata.planId);
            if (!member) throw new Error("Delivery omits its Plan input.");
            history = await historyFiles.capture(
                eventPackage,
                { milestone: "delivered", at: delivery.verifiedAt, reason: delivery.mode },
                member.input,
            );
        } else if (
            definition.status !== current.metadata.definition.status &&
            ["user_verified", "closed_without_verification"].includes(definition.status)
        ) {
            history = await historyFiles.capture(eventPackage, {
                milestone: "closed",
                at:
                    definition.userVerifiedAt ||
                    definition.closedWithoutVerificationAt ||
                    definition.epicDoneEnoughAt ||
                    new Date().toISOString(),
                reason:
                    definition.status === "user_verified"
                        ? definition.userVerificationNote || definition.status
                        : definition.closedWithoutVerificationReason ||
                          definition.epicDoneEnoughSummary ||
                          definition.status,
            });
        }
        const update = { ...metadataUpdate, history };
        const change = reviewedContext
            ? await files.prepareReviewInvalidation(current, { kind: "review-commit" })
            : undefined;
        const reopened = change
            ? { ...current.metadata, ...change, revision: current.metadata.revision + 1 }
            : undefined;
        const nextMetadata = { ...eventPackage.metadata, history };
        await journalPackageMetadataWrite(current.metadata, nextMetadata, reopened);
        const previous = packageDocumentText(current.documents);
        if (reviewedContext) {
            const inputs = await files.retainedReviewWrites(current, reviewedContext.input);
            if (reviewedContext.result) {
                retainPlanReviewOperationResult({
                    ...reviewedContext.result,
                    ...(reviewedContext.result.approved && {
                        planAttrs: await files.projectWorkflowGeneration({ ...current, metadata: nextMetadata }),
                    }),
                });
            }
            await commitPlanPackageBatch(
                identity,
                [
                    {
                        before: { metadata: current.metadata, documents: previous },
                        metadata: nextMetadata,
                        documents: { ...previous, "context.md": reviewedContext.text },
                    },
                ],
                { inputs, reopened },
            );
        } else {
            const planId = plans.identity.parse(current.metadata.planId);
            if (planId && requiresLifecycleOperationDocument(planId))
                stageLifecycleOperationDocument(
                    await files.projectLifecycleGeneration({ ...current, metadata: nextMetadata }, planId),
                );
            await updatePlanPackageMetadata(
                identity,
                current.metadata.planId,
                current.metadata.revision,
                update,
                expectedRevision,
            );
        }
        return (await loadPackageWorkflowPlan(planName))!.attrs;
    });
}

export class PackageExecutionContinuation extends Error {
    constructor(
        readonly binding: NonNullable<import("@runwield/plans/package-storage").PackageWorkflowEvidence["attempt"]>,
    ) {
        super(`Continue attempt ${binding.attemptId} in its recorded repository.`);
        this.name = "PackageExecutionContinuation";
    }
}
export interface PlanExecutionReservation {
    targetBranch?: string;
    suggestedAttemptId?: string;
    executionMode?: "non_git_in_place";
}

/** Select, bind the resolved target, and reserve the reviewed input in one owner transaction. */
export async function reservePlanExecution(planName: string, request: PlanExecutionReservation): Promise<string> {
    if (managedPlanStoreActive()) return await reserveManagedExecution(planName, request);
    if (!currentPackageSelection())
        return (
            request.suggestedAttemptId || `${request.executionMode ? "non-git-" : ""}${crypto.randomUUID().slice(0, 8)}`
        );
    return await packageWorkflowLocks([planName], async () => {
        if (request.targetBranch) await resolvePackageExecutionTarget(planName, request.targetBranch);
        const plan = await selectedPackage(planName);
        const attemptId =
            plan.metadata.workflow?.attempt?.attemptId ||
            request.suggestedAttemptId ||
            `${request.executionMode ? "non-git-" : ""}${crypto.randomUUID().slice(0, 8)}`;
        await reservePackageExecution(planName, attemptId, request.executionMode);
        return attemptId;
    });
}

/** Read the reservation without entering the workflow, creating locks, or recovering attempts. */
export async function readPlanExecutionAttemptId(cwd: string, planId: string): Promise<string | undefined> {
    if (managedPlanStoreActive()) {
        const { readManagedExecution } = await import("./managed.ts");
        return (await readManagedExecution(cwd, planId))?.attemptId;
    }
    const { inspectLocalHomeStore } = await import("./access.ts");
    const store = inspectLocalHomeStore(cwd);
    if (store.kind !== "local") return undefined;
    const plan = await readPlanPackage(store.identity, { planId });
    if (plan.kind !== "loaded") throw new Error(plan.message);
    return plan.metadata.workflow?.attempt?.attemptId;
}

export interface PlanExecutionContext {
    packageSelection: PlanAccess;
    packageAttemptId: string;
    packageInput: PackageWorkflowInput;
}

/** Capture a reserved attempt as one coherent continuation value. */
export async function capturePlanExecutionContext(planName: string): Promise<PlanExecutionContext | undefined> {
    if (managedPlanStoreActive()) {
        const { selection, execution } = await captureManagedExecution(planName);
        return {
            packageSelection: retainManagedPlanAccess(selection),
            packageAttemptId: execution.attemptId,
            packageInput: execution.input,
        };
    }
    const selection = currentPackageSelection();
    if (!selection) return undefined;
    return await packageWorkflowLocks([planName], async () => {
        const plan = await selectedPackage(planName);
        const attempt = plan.metadata.workflow?.attempt;
        if (!attempt) throw new Error("Execution attempt has not been reserved.");
        return {
            packageSelection: retainPlanAccess({ ...selection, expectedRevision: plan.metadata.revision }),
            packageAttemptId: attempt.attemptId,
            packageInput: structuredClone(attempt.input),
        };
    });
}

export interface FrozenPlanExecutionDocuments {
    planBody: string;
    approvedMarkdown: string;
}

/** Read only the reserved immutable inputs, never substitute today's editable documents. */
export async function readFrozenPlanExecutionDocuments(
    planName: string,
    input: PackageWorkflowInput | undefined,
): Promise<FrozenPlanExecutionDocuments | undefined> {
    if (managedPlanStoreActive()) return await readManagedExecutionDocuments(planName, input);
    const selection = currentPackageSelection();
    if (!selection) return undefined;
    if (!input) throw new Error("Execution retained input is missing.");
    const selected = await selectedPackage(planName);
    const reserved = selected.metadata.workflow?.attempt?.input;
    if (!reserved || JSON.stringify(reserved) !== JSON.stringify(input))
        throw new Error("Execution retained input does not match the recorded attempt.");
    const ownIndex = input.inputs.findIndex((ref) => ref.planId === selected.metadata.planId);
    if (ownIndex < 0) throw new Error("Execution retained input belongs to a different Plan.");
    const retained = await Promise.all(input.inputs.map((ref) => readPlanPackageInput(selection.identity, ref)));
    const context = retained[ownIndex].documents.find((doc) => doc.name === "context.md");
    if (!context) throw new Error("Execution retained Plan context is missing.");
    return {
        planBody: retained
            .map((bundle, index) =>
                bundle.documents
                    .map(
                        (doc) =>
                            `# ${input.inputs[index].planId}/${doc.name}\n\n${new TextDecoder().decode(doc.bytes)}`,
                    )
                    .join("\n\n"),
            )
            .join("\n\n"),
        approvedMarkdown: new TextDecoder().decode(context.bytes),
    };
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
        if (existing.repositoryRoot !== executionRepositoryRoot(selection.identity) || existing.attemptId !== attemptId)
            throw new Error("Execution attempt binding changed.");
        const entry = projects.home.isOwner(selection.identity)
            ? null
            : await projectPlanFiles.forOwner(selection.identity).observeAttempt(plan, existing);
        if (
            (!projects.home.isOwner(selection.identity) &&
                !entry &&
                !existing.executionMode &&
                plan.metadata.definition.status !== "ready_for_work") ||
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
            generatedArtifact: undefined,
            attempt: {
                ...(executionMode ? { executionMode } : {}),
                personalOwner: selection.identity.personalOwner.identity,
                repositoryId: selection.identity.repositoryId,
                repositoryRoot: executionRepositoryRoot(selection.identity),
                attemptId,
                input,
            },
        },
    });
}

/** Retain an explicit admission across requests; resolve fresh revisions under its verified owner. */
export function capturePackageWorkflowAccess({ preserveSelection = true } = {}) {
    const admitted = preserveSelection ? currentPackageSelection() : undefined;
    return async function access<T>(cwd: string | undefined, run: () => Promise<T>): Promise<T> {
        if (!cwd) return await sources.exit(() => withoutWorkRecordOwner(run));
        if (!admitted) {
            const owner = projects.checkout.inspect(cwd);
            if (owner.kind === "invalid") throw new Error(owner.message);
            if (owner.kind === "existing" && owner.identity.personalOwner.kind === "execution-account")
                return await withPackageProject(cwd, owner.identity, run);
            return await sources.exit(() => withoutWorkRecordOwner(run));
        }
        const inspected = projects.checkout.inspect(cwd);
        if (
            inspected.kind !== "existing" ||
            inspected.identity.projectId !== admitted.identity.projectId ||
            inspected.identity.personalOwner.identity !== admitted.identity.personalOwner.identity
        )
            return await sources.exit(() => withoutWorkRecordOwner(run));
        const selected = await readPlanPackage(inspected.identity, { planId: admitted.planId });
        if (selected.kind !== "loaded") throw new Error(selected.message);
        return await withPackageWorkflow(
            cwd,
            {
                ...admitted,
                identity: inspected.identity,
                expectedRevision: selected.metadata.revision,
            },
            run,
        );
    };
}

/** Prepare the Epic document and retain the child's attempt evidence under the same family locks. */
export async function appendGeneratedManualQaSection(epicId: PlanId, childId: PlanId, section: ManualQaSection) {
    const identity = currentPackageProject();
    if (!identity) throw new Error("Generated checklist requires the recorded child attempt.");
    const epicTarget = { planId: epicId };
    const childTarget = { planId: childId };
    return await packageWorkflowLocks([epicTarget, childTarget], async () => {
        const epic = await readActiveArtifactPackage(identity, epicId);
        const child = await readActiveArtifactPackage(identity, childId);
        assertEpicPackageFamily(epic, child);
        const existing = packageDocumentContent(epic, EPIC_MANUAL_QA_FILE_NAME);
        const body = prepareManualQaSection(
            existing?.body ?? null,
            epic.metadata.name,
            child.metadata.name,
            childId,
            section,
        );
        if (body === null) return "already_present";
        await saveGeneratedManualQaArtifact(childTarget, epicTarget, existing?.packageHash ?? null, body);
        return "recorded";
    });
}

/** Durably record Core's generated checklist separately from the exact reviewed input. */
export async function saveGeneratedManualQaArtifact(
    childName: PackagePlanTarget,
    parentName: PackagePlanTarget,
    beforeHash: string | null,
    text: string,
): Promise<void> {
    await packageWorkflowLocks([childName, parentName], async () => {
        const child = await selectedPackage(childName);
        const parent = await selectedPackage(parentName);
        const attempt = child.metadata.workflow?.attempt;
        if (!attempt || child.metadata.parentPlanId !== parent.metadata.planId)
            throw new Error("Generated checklist requires the recorded child attempt.");
        await assertPackageWorkflowInput(childName, attempt.input);
        const artifact = child.metadata.workflow?.generatedArtifact;
        if (artifact && (artifact.reusedByAttemptId ?? artifact.attemptId) !== attempt.attemptId)
            throw new Error("Generated checklist belongs to another attempt.");
        if (!artifact)
            await updatePackageWorkflowMetadata(childName, {}, undefined, {
                ...child.metadata.workflow,
                generatedArtifact: {
                    attemptId: attempt.attemptId,
                    operationId: (await import("@runwield/plans/operation-receipts")).captureBatchOperation()
                        ?.operationId,
                    planId: parent.metadata.planId,
                    name: "manual-qa.md",
                    beforeHash,
                    text,
                    hash: hash(text),
                },
            });
        await recoverGeneratedManualQaArtifact(childName);
    });
}

/** Replay only the recorded before/after bytes; ordinary concurrent edits still fail. */
export async function recoverGeneratedManualQaArtifact(childName: PackagePlanTarget): Promise<void> {
    const child = await selectedPackage(childName);
    const artifact = child.metadata.workflow?.generatedArtifact;
    if (!artifact) return;
    const attempt = child.metadata.workflow?.attempt;
    if (
        !attempt ||
        (artifact.reusedByAttemptId ?? artifact.attemptId) !== attempt.attemptId ||
        artifact.planId !== child.metadata.parentPlanId
    )
        throw new Error("Generated checklist owner changed.");
    const parent = await selectedPackage({ planId: artifact.planId });
    const current = parent.documents.find((doc) => doc.name === artifact.name)?.hash ?? null;
    if (current === artifact.hash) return;
    if (artifact.reusedByAttemptId || current !== artifact.beforeHash)
        throw new Error("Generated checklist document changed; review the current input.");
    await savePlanPackageDocument(
        currentPackageSelection()!.identity,
        artifact.planId,
        artifact.name,
        artifact.beforeHash,
        artifact.text,
    );
}

/** Hold the admitted execution owner through preparation and recover its journal on failure. */
export async function withPlanExecutionAdmission<T>(cwd: string, planName: string, run: () => Promise<T>): Promise<T> {
    if (!currentPackageSelection()) return await run();
    const { prepareWorktreeRegistry } = await import("../shared/worktree-registry.ts");
    await prepareWorktreeRegistry(cwd);
    return await withPackageExecutionJournal(() =>
        packageWorkflowLocks([planName], async () => {
            await releaseSettledPackageAttempt(planName);
            const binding = (await selectedPackage(planName)).metadata.workflow?.attempt;
            if (binding && binding.repositoryId !== currentPackageSelection()!.identity.repositoryId)
                throw new PackageExecutionContinuation(binding);
            return await run();
        }),
    );
}

/** Validate the retained attempt and recover its recording preparation before validation dispatch. */
export async function preparePlanValidationInput(cwd: string, planName: string): Promise<void> {
    if (!currentPackageSelection()) return;
    const { realpath } = await import("node:fs/promises");
    const { recoverPackageRecordingPreparation } = await import("./publication.ts");
    await packageWorkflowLocks([planName], async () => {
        const plan = await selectedPackage(planName);
        const binding = plan.metadata.workflow?.attempt;
        if (binding && binding.repositoryRoot !== (await realpath(projects.checkout.primaryRoot(cwd))))
            throw new Error("Continue package validation in its recorded repository.");
        if (binding && !plan.metadata.workflow?.publication && !(await recoverPackageRecordingPreparation(planName)))
            await assertPackageWorkflowInput(planName, binding.input);
    });
}

/** Implementation completion keeps retained input validation and lock ordering with its persistence owner. */
export async function withPlanImplementationCompletion<T>(
    cwd: string,
    planName: string,
    attemptId: string | undefined,
    input: PackageWorkflowInput | undefined,
    complete: () => Promise<T>,
): Promise<T> {
    const { withOrderedTransitionResources } = await import("./transitions.ts");
    return await withPackageExecutionJournal(() =>
        withOrderedTransitionResources(
            cwd,
            [{ kind: "plan", id: planName }, ...(attemptId ? [{ kind: "attempt" as const, id: attemptId }] : [])],
            async () => {
                if (currentPackageSelection()) {
                    if (!input) throw new Error("Implementation retained input is missing.");
                    await assertPackageWorkflowInput(planName, input);
                }
                return await complete();
            },
        ),
    );
}
