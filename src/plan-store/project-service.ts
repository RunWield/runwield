import type {
    ExecutionRecoveryAction,
    LegacyManagedPlanAuthoring,
    ManagedPlanCreation,
    ManagedPlanRevision,
    ProjectStoreBinding,
} from "@runwield/plans/project-store-wire";
import { ProjectStorePreconditionError } from "@runwield/plans/project-store-wire";
import { adoptManagedExecutionReplacement, withManagedExecutionRecovery } from "@runwield/plans/managed-store-host";
import { assertSharedPlanWriteAllowed } from "@runwield/plans/collaboration-lock";
import { openShareAttemptJournal } from "@runwield/plans/share-attempt-journal";
import { StalePlanWriteError } from "@runwield/plans/store";
import type { ExecutionPublicationPolicy, PackagePublicationReference } from "@runwield/plans/publication-copies";
import { projects, type HomeProjectOwner } from "@runwield/projects";
import { plans, type PlanId } from "@runwield/plans";
import { isEpicArtifactName } from "@runwield/plans/format";
import { openPlanStoreForCheckout } from "./project-plans.ts";
import { HISTORY_PAGE_CHARS } from "../shared/remote/project-store-protocol.ts";
import { listPlanPackages } from "@runwield/plans/package-storage";
import { projectPlanAuthoring } from "@runwield/plans/project-plan-authoring";
import { projectPlanFiles } from "@runwield/plans/project-plan-files";
import type { PlanImportOptions } from "@runwield/plans/package-storage";
import type { RetainedFamilyRequest, RetainedFamilyCheckpoint } from "./retained-family.ts";
import { readPlanRecordingContext, type PlanRecordingContext } from "./recording.ts";
import type {
    CreateProjectWorkRecord,
    PackagePublicationManifest,
    PackageWorkflowInput,
    PlanAuthoringInput,
    ProjectWorkRecord,
} from "@runwield/plans/store";
import type { GeneratedWorkRecordSections } from "@runwield/plans/work-records";
import type { PublishedDeliverySources } from "./published-source.ts";
import type { ManagedProjectStoreLaunch } from "../shared/remote/project-store-launch.ts";
import { confirmManagedPublication } from "./retained-proof.ts";
import { loadPlan, listPlanDocuments, listPlans } from "../plan-store.ts";
import { authorLocalPlan } from "./access.ts";
import {
    getGlobalSecretStoreLocation,
    getProjectSecretStoreLocation,
    resolveCompatibleSecretRecord,
} from "../shared/collaboration/secrets.ts";
import {
    createCollaborationClient,
    SharedSpaceGoneError,
    SYSTEM_COLLABORATION_FETCH,
    normalizeSharedSpaceMetadata,
} from "@runwield/plans/plan-server";
import {
    currentPackageProject,
    currentPackageSelection,
    packageController,
    reservePlanExecution,
    capturePlanExecutionContext,
    readFrozenPlanExecutionDocuments,
    type FrozenPlanExecutionDocuments,
    withPackageExecutionHost,
    type PlanExecutionHost,
    type PlanExecutionReservation,
} from "./workflows.ts";
import {
    readPublishedDeliverySources,
    retainPublishedWorkRecordSource,
    withConfirmedPublication,
    verifyPackageRecordingDelivery,
} from "./published-source.ts";
import {
    generatePreparedPackageRecord,
    inspectPreparedPackageRecord,
    reservePreparedPackageRecord,
    settlePreparedPackageRecord,
} from "../shared/work-records/package-recording.ts";
import { findWorkRecordById } from "../shared/work-records/store.ts";
import { searchWorkRecordDocumentsInOwner, searchWorkRecords } from "../shared/work-records/search.ts";
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { requestWorkspaceSearchRefresh } from "@runwield/resources/workspace-search-refresh";
import { syncWorkRecordToIndex } from "../shared/work-records/index-adapter.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../shared/work-records/mnemoteca-port.ts";
import {
    freezePlanPublicationPolicy,
    sealPackagePublication,
    settlePackagePublication,
    assertPackagePublicationOwner,
    settlePackageInPlace,
    type PublicationOwnerClaim,
} from "./publication.ts";
import {
    readPlanPackageInput,
    readPlanPackagePublication,
    withPlanPackageCatalogDiscovery,
    type PlanImportCommitted,
} from "@runwield/plans/package-storage";
/** Prepared owner service. Only trusted local registration supplies the Project location. */
import { inspectLocalHomeStore, withLocalPlanWorkflow, readLocalHomeStore } from "./access.ts";
import { packageWorkflowLocks, selectedPackage } from "./workflows.ts";
import type { PlanDocumentView, PreparedPlanDocumentEdit } from "@runwield/plans/project-plan-documents";
import { readPlanDocuments, savePlanDocument, savePlanProse } from "./documents.ts";
import { savePlanDefinition, type PlanDefinitionChanges } from "./definition.ts";
import { recordPlanEvent, recordManagedExecutionCheckpoint, type ManagedExecutionCheckpoint } from "./events.ts";
import {
    inspectOperationReceipt,
    operationDigest,
    operationHash,
    planOperationReceiptDirectory,
    runReceiptedOperation,
    type OperationOutcome,
} from "@runwield/plans/operation-receipts";

export interface ProjectStorePublicationSettlement extends PlanMutation {
    kind: "settle-publication";
    reference: PackagePublicationReference;
}
export interface ProjectStoreInPlaceSettlement extends PlanMutation {
    kind: "settle-in-place";
    attemptId: string;
}
export interface ProjectStorePublicationCheck {
    kind: "check-publication-owner";
    planId: string;
    claim: PublicationOwnerClaim;
}
export interface ProjectStorePublicationRead {
    kind: "read-publication";
    planId: string;
    reference: PackagePublicationReference;
}
export interface ProjectStorePublication {
    manifest: PackagePublicationManifest;
}
export interface ProjectStoreExecutionRead {
    kind: "read-execution";
    planId: string;
}
export interface ProjectStoreExecutionDocumentsRead {
    kind: "read-execution-documents";
    planId: string;
    input: PackageWorkflowInput;
}
export interface ProjectStoreExecution {
    execution: { attemptId: string; input: PackageWorkflowInput } | null;
}
export interface ProjectStoreExecutionDocuments {
    documents: FrozenPlanExecutionDocuments;
}
export interface ProjectStoreResolve {
    kind: "resolve-plan";
    reference: string;
}
export type ProjectStoreList = { kind: "list-plans" } | { kind: "list-plan-documents" };
export interface ProjectStorePlan {
    plan: Awaited<ReturnType<typeof loadPlan>>;
}
export interface ProjectStoreCatalog {
    plans: Awaited<ReturnType<typeof listPlans>>;
}
export interface ProjectStoreDocumentsRead {
    kind: "read-documents";
    planId: string;
    resource: string;
}
export interface ProjectStoreDocumentView {
    documentView: PlanDocumentView;
}
export interface ProjectStoreRead {
    kind: "read";
    planId: string;
    resource: string;
}
interface PlanMutation {
    operationId: string;
    planId: string;
    expectedRevision: string;
}
export interface ProjectStoreDocumentWrite extends PlanMutation {
    kind: "save-document";
    resource: string;
    body: string;
}
interface ProjectStoreHistoryRestore extends PlanMutation {
    kind: "restore-history";
    version: string;
}
interface HistoryCursor {
    offset: number;
    snapshot: string;
}
type HistoryPlanTarget = { planId: string; reference?: never } | { reference: string; planId?: never };
type ProjectStoreHistoryList = HistoryCursor & HistoryPlanTarget & { kind: "list-history" };
type ProjectStoreHistoryShow = HistoryCursor & HistoryPlanTarget & { kind: "show-history"; version: string };
export interface ProjectStoreProseWrite extends PlanMutation {
    kind: "save-prose";
    body: string;
}
export interface ProjectStoreDefinitionWrite extends PlanMutation {
    kind: "save-definition";
    changes: PlanDefinitionChanges;
}
export interface ProjectStoreEventWrite extends PlanMutation {
    kind: "record-event";
    event: "review_approved" | "review_feedback" | "hold_reset_to_draft" | "readiness_passed" | "epic_readiness_passed";
}
export interface ProjectStoreCheckpoint extends PlanMutation {
    kind: "execution-checkpoint";
    attemptId: string;
    checkpoint: ManagedExecutionCheckpoint;
}
export interface ProjectStoreReconcile {
    kind: "reconcile";
    planId: string;
    operationId: string;
}
export interface ProjectStoreReserveExecution extends PlanMutation {
    kind: "reserve-execution";
    reservation: PlanExecutionReservation;
}
export interface ProjectStorePublicationPolicy extends PlanMutation {
    kind: "freeze-publication-policy";
    attemptId: string;
    policy: ExecutionPublicationPolicy;
}
export interface ProjectStoreSeal extends PlanMutation {
    kind: "seal-publication";
    preparation?: boolean;
    attemptId: string;
    validatedCommit: string;
    targetBranch: string;
}
export interface ProjectStoreFrozenRead {
    kind: "read-frozen";
    planId: string;
    snapshotId: string;
    snapshotDigest: string;
    attemptId: string;
    resource: string;
}
export interface ProjectStoreRecordingVerification {
    kind: "verify-recording-delivery";
    planId: string;
    reference: PackagePublicationReference;
}
export interface ProjectStoreRecordingContextRead {
    kind: "read-recording-context";
    planId: string;
    automatic: boolean;
    pendingPublication: boolean;
}
export interface ProjectStoreDeliverySourcesRead {
    kind: "read-delivery-sources";
    planId: string;
    reference: PackagePublicationReference;
    confirmed: boolean;
}
export interface ProjectStoreRecordingReservation extends PlanMutation {
    kind: "reserve-recording";
    attemptId: string;
    reference?: PackagePublicationReference;
}
export interface ProjectStoreRecordingWrite extends PlanMutation {
    kind: "prepare-record";
    attemptId: string;
    reference?: PackagePublicationReference;
    sections: GeneratedWorkRecordSections;
}
export interface ProjectStoreRecordingContext {
    recording: PlanRecordingContext | null;
}
export interface ProjectStoreDeliverySources {
    sources: PublishedDeliverySources;
}
export interface ProjectStoreRecordSave extends PlanMutation {
    kind: "save-record";
    title: string;
    summary: string;
}
export interface ProjectStoreFamilyControllerRead extends RetainedFamilyRequest {
    kind: "read-retained-family-controller";
}
export interface ProjectStoreFamilyControllerCheckpoint extends RetainedFamilyCheckpoint {
    kind: "checkpoint-retained-family-controller";
}
export interface ProjectStoreFamilyControllerResult {
    familyController: import("@runwield/plans/controller-state").ControllerRecord | null;
}
export interface ProjectStoreLifecycleDecision extends PlanMutation {
    kind: "lifecycle-decision";
    decision: import("./events.ts").ManagedLifecycleDecision;
}
export interface ProjectStoreRecoveryAction {
    kind: "recover-execution";
    operationId: string;
    planId: string;
    expectedRevision: string;
    attemptId: string | null;
    replacementAttemptId?: string;
    action: "non-git" | ExecutionRecoveryAction;
    controllerRevision: number | null;
}
export interface ProjectStoreReopenReview {
    kind: "reopen-review";
    operationId: string;
    planId: string;
    expectedRevision: string;
    attemptId: string;
}
export interface ProjectStoreUnsharePreview {
    kind: "unshare-preview";
    options: Omit<import("./collaboration/unshare.ts").UnsharePlanOptions, "cwd">;
}
export interface ProjectStoreUnsharePreviewResult {
    unsharePreview: import("./collaboration/unshare.ts").UnsharePreview;
}
export interface ProjectStoreCollaborationCommand {
    kind: "collaboration";
    operationId: string;
    planId?: PlanId;
    intent: import("./collaboration/operations.ts").CollaborationIntent;
}
export interface ProjectStoreCollaborationResultRead {
    kind: "read-collaboration-result";
    operationId: string;
}
export interface ProjectStoreCollaborationResult {
    collaborationResult:
        | import("./collaboration/operations.ts").CollaborationResult
        | import("./operation-results.ts").GoneShareOperationResult;
}
export interface ProjectStoreShareIdentityRead {
    kind: "inspect-share-identity";
    operationId: string;
}
export interface ProjectStoreShareIdentity {
    sharePlanId: PlanId | null;
    shareEffectStarted: boolean;
}
export interface ProjectStoreEpicArtifact extends PlanMutation {
    kind: "save-epic-artifact";
    resource: string;
    body: string;
}
export interface ProjectStoreEpicQa extends PlanMutation {
    kind: "append-epic-qa";
    childPlanId: string;
    childRevision: string;
    childHeading: string;
    checklistMarkdown: string;
}
export interface ProjectStoreEpicProjection {
    kind: "epic-projection";
    operationId: string;
    planId: string;
    expectedRevision: string;
    childPlanId: string;
    childRevision: string;
    projection: "deviations" | "notes";
    notes: import("@runwield/tools").ReviewIntegrationNote[];
}
export interface ProjectStoreDeviation {
    kind: "record-deviation";
    operationId: string;
    planId: string;
    expectedRevision: string;
    proposal: import("@runwield/plans/format").PlanDeviationProposal;
}
export interface ProjectStoreSequenceSnapshot {
    kind: "sequence-snapshot";
    planId: string;
}
export interface ProjectStoreSequencePrepare {
    kind: "prepare-sequence";
    planId: string;
    operationId: string;
    expectedRevision: string;
    inputs: import("./sequence-review.ts").SequenceChildInput[] | null;
}
export interface ProjectStoreSequenceDecision {
    kind: "sequence-decision";
    planId: string;
    operationId: string;
    expectedRevision: string;
    documents: import("./sequence-review.ts").SequenceReviewDocument[];
    decision: import("./sequence-review.ts").SequenceReviewDecision;
}
export interface ProjectStoreSequenceResultRead {
    kind: "read-sequence-result";
    planId: string;
    operationId: string;
}
export interface ProjectStoreSequenceDocuments {
    sequenceDocuments: import("./sequence-review.ts").SequenceReviewDocument[];
}
export interface ProjectStoreSequenceResult {
    sequenceResult: import("./sequence-review.ts").SequenceReviewResult;
}
export interface ProjectStoreAuthorChildren {
    kind: "author-children";
    operationId: string;
    planId: string;
    expectedRevision: string;
    children: import("../plan-store.ts").ChildFeaturePlanDescriptor[];
    options: Omit<import("../plan-store.ts").PlanWriteOptions, "onChildPlanWritten" | "collaborationLockBypass">;
    finalize: boolean;
}
export interface ProjectStoreChildrenResultRead {
    kind: "read-children-result";
    planId: string;
    operationId: string;
}
export interface ProjectStoreChildrenResult {
    children: import("../plan-store.ts").SavedChildFeaturePlan[];
}
export interface ProjectStoreRetainedRecordingSettle extends importRetainedCleanup {
    kind: "settle-retained-record";
}
export interface ProjectStoreRetainedRecordingRead {
    kind: "read-retained-recording";
    reference: string;
    pendingPublication: boolean;
}
export interface ProjectStoreRetainedRecordingPrepare extends importRetainedCleanup {
    kind: "prepare-retained-record";
    pendingPublication: boolean;
    sections: GeneratedWorkRecordSections | null;
}
export interface ProjectStoreRetainedRecordingResult {
    retainedRecording: import("./retained-recording.ts").RetainedRecordingContext | null;
}
export interface ProjectStoreRetainedAbandonment extends importRetainedCleanup {
    kind: "settle-retained-abandonment";
}
export interface ProjectStoreRetainedCleanup extends importRetainedCleanup {
    kind: "settle-retained-cleanup";
}
export interface ProjectStoreRetainedCheckpoint extends importRetainedCheckpoint {
    kind: "checkpoint-retained-execution";
}
type importRetainedCleanup = import("./retained-managed-execution.ts").RetainedCleanupRequest;
type importRetainedCheckpoint = import("./retained-managed-execution.ts").RetainedControllerCheckpoint;
export interface ProjectStoreRetainedRead {
    kind: "read-retained-execution";
    reference: string;
    attemptId: string | null;
}
export interface ProjectStoreRetained {
    retainedExecution: import("./retained-managed-execution.ts").RetainedManagedExecution | null;
}
export interface ProjectStoreArchiveCatalogRead {
    kind: "archive-catalog";
}
export interface ProjectStoreArchiveCatalog {
    archives: Awaited<ReturnType<typeof import("../plan-store.ts").listArchivedPlans>>;
}
export interface ProjectStoreArchivedRead {
    kind: "read-archive";
    reference: string;
}
export interface ProjectStoreArchived {
    archived: Awaited<ReturnType<typeof import("../plan-store.ts").loadArchivedPlan>>;
}
export interface ProjectStoreArchive extends PlanMutation {
    kind: "archive-plan";
    reason: string;
    force: boolean;
    now: string;
}
export interface ProjectStoreRestore extends PlanMutation {
    kind: "restore-plan";
}
export interface ProjectStoreRename extends PlanMutation {
    kind: "rename-plan";
    name: string;
}
export interface ProjectStoreResourceCatalogRead {
    kind: "plan-resource-catalog";
}
export interface ProjectStoreResourceCatalog {
    resourceCatalog: Awaited<ReturnType<typeof import("../plan-store.ts").readPlanResourceCatalog>>;
}
export interface ProjectStorePlanResourceRead {
    kind: "plan-resource";
    planId: string;
}
export interface ProjectStorePlanResource {
    planResource: Awaited<ReturnType<typeof import("../plan-store.ts").findPlanEvidenceById>>;
}
export interface ProjectStoreReviewPresentationRead {
    kind: "review-presentation";
    planId: string;
}
export interface ProjectStoreReviewPresentation {
    presentation: Exclude<Awaited<ReturnType<typeof import("./resources.ts").readPlanReviewPresentation>>, undefined>;
}
export interface ProjectStoreHumanReview extends PlanMutation {
    kind: "record-human-review";
    metadata: import("./definition.ts").PlanHumanReviewMetadata;
}
export interface ProjectStoreEpicReview extends PlanMutation {
    kind: "save-epic-review";
    review: import("@runwield/plans").PlanFrontMatter["epicIntegrationReview"];
}
export interface ProjectStoreReviewCapture {
    kind: "capture-review";
    planId: string;
    expectedRevision: string;
}
export interface ProjectStoreReviewInput {
    reviewInput: PackageWorkflowInput;
}
export interface ProjectStoreReviewDecision extends PlanMutation {
    kind: "review-decision";
    sourceStatus: import("@runwield/plans").PlanFrontMatter["status"];
    sourceMarkdown: string;
    controllerRevision: number | null;
    input: PackageWorkflowInput;
    decision: import("./review.ts").SharedPlanReviewDecision;
    classification: import("@runwield/plans").PlanFrontMatter["classification"];
    workKind: import("@runwield/plans").PlanFrontMatter["workKind"] | null;
}
export interface ProjectStoreRecordCreate {
    kind: "create-project-work-record";
    operationId: string;
    input: CreateProjectWorkRecord;
}
export interface ProjectStoreRecordCreated {
    operationId: string;
    createdRecord: Pick<ProjectWorkRecord, "markdown" | "relativePath">;
}
export interface ProjectStoreRecordCatalog {
    kind: "record-catalog";
}
export interface ProjectStoreRecordQuery {
    kind: "record-query";
    query: string;
    limit: number;
    accessMode: "current" | "all";
}
export interface ProjectStoreRecordResources {
    recordResources: import("@runwield/plans/work-records").WorkRecordResource[];
}
export interface ProjectStoreRecordQueryResult {
    recordSearch: import("../shared/work-records/search.ts").WorkRecordSearchResult;
}
export interface ProjectStoreRecordRead {
    kind: "read-record";
    planId: string;
    recordId: string;
}
export interface ProjectStoreRecordSearch {
    kind: "search-records";
    planId: string;
    query: string;
    limit: number;
}
export interface ProjectStoreRecordIndex extends PlanMutation {
    kind: "reconcile-record-index";
    recordId: string;
}
export interface ProjectStoreRecord {
    recordId: string;
    markdown: string;
}
export interface ProjectStoreRecords {
    records: ProjectStoreRecord[];
}
export interface ProjectStoreCollaborationRead {
    kind: "read-collaboration";
    planId: string;
}
export interface ProjectStoreCollaboration {
    planId: string;
    spaceId: string;
    latestRevision: number;
}
export interface ProjectStoreInspectOwner {
    kind: "inspect-owner";
}
export interface ProjectStoreRepairOwner {
    kind: "repair-owner";
    operationId: string;
}
export interface ProjectStoreOwnerDiagnostics {
    ownerDiagnostics: import("./doctor.ts").DoctorIssue[];
}
export interface ProjectStoreImport extends PlanImportOptions {
    kind: "import-plans";
    operationId: string;
    selection: string;
}
export interface ProjectStoreImportRead {
    kind: "read-import-result";
    operationId: string;
}
export interface ProjectStoreImportResult {
    importResult: PlanImportCommitted;
}
export type ProjectStoreCommand =
    | ProjectStoreInspectOwner
    | ProjectStoreRepairOwner
    | ProjectStoreImport
    | ProjectStoreImportRead
    | ProjectStorePublicationSettlement
    | ProjectStoreInPlaceSettlement
    | ProjectStorePublicationCheck
    | ProjectStorePublicationRead
    | ProjectStoreExecutionRead
    | ProjectStoreExecutionDocumentsRead
    | LegacyManagedPlanAuthoring
    | ManagedPlanCreation
    | ManagedPlanRevision
    | ProjectStoreResolve
    | ProjectStoreList
    | ProjectStoreCollaborationRead
    | ProjectStoreRecordingVerification
    | ProjectStoreRecordingContextRead
    | ProjectStoreDeliverySourcesRead
    | ProjectStoreRecordingReservation
    | ProjectStoreRecordingWrite
    | ProjectStoreRecordSave
    | ProjectStoreFamilyControllerRead
    | ProjectStoreFamilyControllerCheckpoint
    | ProjectStoreLifecycleDecision
    | ProjectStoreRecoveryAction
    | ProjectStoreReopenReview
    | ProjectStoreUnsharePreview
    | ProjectStoreCollaborationCommand
    | ProjectStoreCollaborationResultRead
    | ProjectStoreShareIdentityRead
    | ProjectStoreEpicArtifact
    | ProjectStoreEpicQa
    | ProjectStoreEpicProjection
    | ProjectStoreDeviation
    | ProjectStoreSequenceSnapshot
    | ProjectStoreSequencePrepare
    | ProjectStoreSequenceDecision
    | ProjectStoreSequenceResultRead
    | ProjectStoreAuthorChildren
    | ProjectStoreChildrenResultRead
    | ProjectStoreRetainedRecordingSettle
    | ProjectStoreRetainedRecordingRead
    | ProjectStoreRetainedRecordingPrepare
    | ProjectStoreRetainedAbandonment
    | ProjectStoreRetainedCleanup
    | ProjectStoreRetainedCheckpoint
    | ProjectStoreRetainedRead
    | ProjectStoreArchiveCatalogRead
    | ProjectStoreArchivedRead
    | ProjectStoreArchive
    | ProjectStoreRestore
    | ProjectStoreRename
    | ProjectStoreResourceCatalogRead
    | ProjectStorePlanResourceRead
    | ProjectStoreReviewPresentationRead
    | ProjectStoreHumanReview
    | ProjectStoreEpicReview
    | ProjectStoreReviewCapture
    | ProjectStoreReviewDecision
    | ProjectStoreRecordCreate
    | ProjectStoreRecordCatalog
    | ProjectStoreRecordQuery
    | ProjectStoreRecordRead
    | ProjectStoreRecordSearch
    | ProjectStoreRecordIndex
    | ProjectStoreReserveExecution
    | ProjectStorePublicationPolicy
    | ProjectStoreSeal
    | ProjectStoreFrozenRead
    | ProjectStoreDocumentsRead
    | ProjectStoreRead
    | (PlanMutation & { kind: "edit-documents"; edits: PreparedPlanDocumentEdit[] })
    | ProjectStoreDocumentWrite
    | ProjectStoreHistoryRestore
    | ({ kind: "preview-retention" } & HistoryCursor)
    | { kind: "settle-prune-copies"; target: import("./retention.ts").RetentionKind; token: string }
    | { kind: "confirm-retention"; target: import("./retention.ts").RetentionKind; token: string }
    | ProjectStoreHistoryList
    | ProjectStoreHistoryShow
    | ProjectStoreProseWrite
    | ProjectStoreDefinitionWrite
    | ProjectStoreCheckpoint
    | ProjectStoreEventWrite
    | ProjectStoreReconcile;
export interface ProjectStoreDocument {
    planId: string;
    resource: string;
    revision: string;
    body: string;
    writable: boolean;
}
interface StoreTextPage {
    text: string;
    snapshot: string;
    complete: boolean;
}
function pageStoreText(serialized: string, cursor: HistoryCursor): StoreTextPage {
    const snapshot = operationHash(serialized);
    if ((cursor.offset && snapshot !== cursor.snapshot) || cursor.offset >= serialized.length)
        throw new Error("Project store data changed during inspection.");
    const text = serialized.slice(cursor.offset, cursor.offset + HISTORY_PAGE_CHARS);
    return { text, snapshot, complete: cursor.offset + text.length === serialized.length };
}
export interface ProjectStoreReply {
    binding: ProjectStoreBinding;
    result:
        | ProjectStoreOwnerDiagnostics
        | ProjectStoreImportResult
        | ProjectStorePublication
        | ProjectStoreExecution
        | ProjectStoreExecutionDocuments
        | { retentionPage: StoreTextPage }
        | { pruneResult: import("./retention.ts").PruneResult }
        | { historyPage: StoreTextPage }
        | ProjectStoreDocumentView
        | ProjectStoreDocument
        | OperationOutcome
        | ProjectStoreRecordingContext
        | ProjectStoreDeliverySources
        | ProjectStoreFamilyControllerResult
        | ProjectStoreRetained
        | ProjectStoreUnsharePreviewResult
        | ProjectStoreCollaborationResult
        | ProjectStoreShareIdentity
        | ProjectStoreSequenceDocuments
        | ProjectStoreSequenceResult
        | ProjectStoreChildrenResult
        | ProjectStoreRetainedRecordingResult
        | ProjectStoreArchiveCatalog
        | ProjectStoreArchived
        | ProjectStoreResourceCatalog
        | ProjectStorePlanResource
        | ProjectStoreReviewPresentation
        | ProjectStoreReviewInput
        | ProjectStoreRecordCreated
        | ProjectStoreRecordResources
        | ProjectStoreRecordQueryResult
        | ProjectStoreRecords
        | ProjectStoreCollaboration
        | ProjectStorePlan
        | ProjectStoreCatalog;
}

export class PreparedProjectStore {
    readonly binding: ProjectStoreBinding;
    private readonly cwd: string;
    private readonly homeOwner?: HomeProjectOwner;
    constructor(
        registration: string | HomeProjectOwner,
        private readonly execution?: PlanExecutionHost,
        private readonly launch?: ManagedProjectStoreLaunch,
        private readonly signal?: AbortSignal,
    ) {
        this.cwd = typeof registration === "string" ? registration : projects.home.storeLocation(registration);
        this.homeOwner = typeof registration === "string" ? undefined : registration;
        if (this.homeOwner) projects.home.assertStoreIdentity(this.homeOwner);
        const owner = this.homeOwner
            ? { kind: "local" as const, identity: this.homeOwner }
            : inspectLocalHomeStore(this.cwd);
        if (owner.kind !== "local") throw new Error("Project store registration requires an existing local owner.");
        if (
            execution &&
            (execution.projectId !== owner.identity.projectId ||
                execution.repositoryId !== owner.identity.repositoryId ||
                execution.personalOwner.kind !== "managed-remote" ||
                execution.personalOwner.identity !== owner.identity.personalOwner.identity ||
                !execution.repositoryRoot.startsWith("/") ||
                !execution.checkoutRoot.startsWith("/") ||
                !execution.checkoutId)
        )
            throw new Error("Execution host does not match the registered personal owner.");
        this.binding = Object.freeze({
            projectId: owner.identity.projectId,
            repositoryId: owner.identity.repositoryId,
            ownerId: operationHash(owner.identity.personalOwner.identity),
        });
    }
    private owner() {
        const owner = this.homeOwner
            ? (projects.home.assertStoreIdentity(this.homeOwner), { kind: "local" as const, identity: this.homeOwner })
            : inspectLocalHomeStore(this.cwd);
        if (
            owner.kind !== "local" ||
            owner.identity.projectId !== this.binding.projectId ||
            owner.identity.repositoryId !== this.binding.repositoryId ||
            operationHash(owner.identity.personalOwner.identity) !== this.binding.ownerId
        )
            throw new Error("Project store authority changed.");
        return owner.identity;
    }
    async author(input: PlanAuthoringInput): Promise<ProjectStoreDocument> {
        const author = async () => {
            await authorLocalPlan(this.cwd, input);
            return await withLocalPlanWorkflow(this.cwd, input.planName, async () => {
                const plan = await selectedPackage(input.planName);
                const document = await readPlanDocuments(plan.metadata.planId);
                return {
                    planId: document.planId,
                    resource: document.resource,
                    revision: document.revision,
                    body: document.body,
                    writable: document.writable,
                };
            });
        };
        return this.homeOwner ? await projects.home.withOwner(this.homeOwner, author) : await author();
    }
    async execute(command: ProjectStoreCommand): Promise<ProjectStoreReply> {
        const run = () =>
            this.homeOwner
                ? projects.home.withOwner(this.homeOwner, () => this.executeAdmitted(command))
                : this.executeAdmitted(command);
        return this.execution ? await withPackageExecutionHost(this.execution, run) : await run();
    }
    private async executeAdmitted(command: ProjectStoreCommand): Promise<ProjectStoreReply> {
        const owner = this.owner();
        const directory = planOperationReceiptDirectory(owner);
        const result = await readLocalHomeStore(
            this.cwd,
            async () => {
                const identity = currentPackageProject();
                const files = identity && projectPlanFiles.forOwner(identity);
                if (command.kind === "inspect-owner") {
                    const catalog = await listPlanPackages(owner, true);
                    return {
                        ownerDiagnostics: catalog.issues.map((issue) => ({
                            kind: "package_integrity_error",
                            message: issue.message,
                        })),
                    };
                }
                if (command.kind === "repair-owner")
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            owner.projectId,
                            async () => {
                                await (await import("@runwield/plans/package-storage")).recoverPlanPackages(owner);
                                return {
                                    revision: operationDigest(JSON.stringify(await listPlanPackages(owner, true))),
                                };
                            },
                            true,
                        ),
                    );
                if (command.kind === "read-import-result")
                    return {
                        importResult: await (
                            await import("@runwield/plans/package-storage")
                        ).readManagedPlanImportResult(owner, command.operationId),
                    };
                if (command.kind === "import-plans") {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Managed import requires its trusted execution launcher.");
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            owner.projectId,
                            async () => {
                                const imported = await (
                                    await import("./import-packages.ts")
                                ).importManagedPlanPackages(
                                    owner,
                                    command.selection,
                                    {
                                        launch: this.launch!,
                                        operationId: command.operationId,
                                        signal: this.signal,
                                    },
                                    command.includeArchived ? { includeArchived: true } : {},
                                );
                                if ("message" in imported) throw new Error(imported.message);
                                return { revision: operationDigest(JSON.stringify(imported)) };
                            },
                            true,
                        ),
                    );
                }
                if (command.kind === "settle-prune-copies")
                    return {
                        pruneResult: await (
                            await import("./retention.ts")
                        ).settlePruneCopies(this.cwd, command.target, command.token),
                    };
                if (command.kind === "preview-retention" || command.kind === "confirm-retention") {
                    const retention = await import("./retention.ts");
                    const context = async () => {
                        if (!this.homeOwner) return await retention.readExecutionRetention(this.cwd);
                        if (!this.launch) throw new Error("Managed prune needs its bound execution repository.");
                        return await (
                            await import("../shared/remote/project-store-launch.ts")
                        ).readManagedRetentionContext(this.launch, this.binding, this.signal);
                    };
                    if (command.kind === "preview-retention")
                        return {
                            retentionPage: pageStoreText(
                                JSON.stringify(await retention.localRetentionPreview(this.cwd, context)),
                                command,
                            ),
                        };
                    return {
                        pruneResult: await retention.localConfirmRetention(
                            this.cwd,
                            command.target,
                            command.token,
                            context,
                        ),
                    };
                }
                if (command.kind === "list-plan-documents") return { plans: await listPlanDocuments(this.cwd) };
                if (command.kind === "list-plans") {
                    const catalog = files
                        ? await files.listWorkflowPlans(currentPackageSelection())
                        : await listPlans(this.cwd);
                    return { plans: catalog };
                }
                if (command.kind === "resolve-plan") {
                    const catalog = await listPlanDocuments(this.cwd);
                    const selected = catalog.find(
                        (plan) =>
                            plan.name === command.reference ||
                            plan.attrs.planId === command.reference ||
                            plan.path === command.reference,
                    );
                    return { plan: selected ? await loadPlan(this.cwd, selected.name) : null };
                }
                if (
                    command.kind === "read-retained-family-controller" ||
                    command.kind === "checkpoint-retained-family-controller"
                ) {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Retained family requires its trusted personal owner.");
                    const family = await import("./retained-family.ts");
                    if (command.kind === "read-retained-family-controller")
                        return {
                            familyController: await family.readManagedFamilyController(
                                this.homeOwner,
                                this.launch,
                                command,
                                this.signal,
                            ),
                        };
                    return await family.checkpointManagedFamilyController(
                        this.homeOwner,
                        this.launch,
                        command,
                        this.signal,
                    );
                }
                if (command.kind === "unshare-preview")
                    return {
                        unsharePreview: await (
                            await import("./collaboration/unshare.ts")
                        ).previewUnsharePlan({ ...command.options, cwd: this.cwd }),
                    };
                if (command.kind === "read-collaboration-result")
                    return {
                        collaborationResult: (await import("./operation-results.ts")).readCollaborationOperationResult(
                            directory,
                            command.operationId,
                            owner.projectId,
                        ),
                    };
                if (command.kind === "inspect-share-identity") {
                    const receipts = await import("./operation-results.ts");
                    const result = receipts.inspectCollaborationOperationResult(directory, command.operationId);
                    const mutation = receipts.inspectCollaborationMutation(directory, command.operationId);
                    const planId =
                        result?.action === "share" || result?.action === "share-gone"
                            ? result.value.planId
                            : mutation?.action === "share"
                              ? mutation.planId
                              : undefined;
                    return {
                        sharePlanId: plans.identity.parse(planId) ?? null,
                        shareEffectStarted: receipts.collaborationNetworkEffectStarted(directory, command.operationId),
                    };
                }
                if (command.kind === "collaboration")
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            owner.projectId,
                            async (recovering) => {
                                const receipts = await import("./operation-results.ts");
                                if (recovering) {
                                    const retained = receipts.inspectCollaborationOperationResult(
                                        directory,
                                        command.operationId,
                                    );
                                    if (retained) {
                                        if (retained.action === "share" || retained.action === "share-gone") {
                                            const { planId } = retained.value;
                                            if (!plans.identity.isValid(planId))
                                                throw new Error("Plan sharing requires a durable Plan ID.");
                                            const receipt =
                                                retained.action === "share-gone"
                                                    ? { requestId: retained.requestId }
                                                    : {
                                                          serverUrl: retained.value.serverUrl,
                                                          spaceId: retained.value.spaceId,
                                                      };
                                            await openShareAttemptJournal(owner).settle(planId, receipt);
                                        }
                                        return { revision: operationDigest(JSON.stringify(retained)) };
                                    }
                                    const recovered = await (
                                        await import("./collaboration/operation-state.ts")
                                    ).recoverCollaborationMutation(this.cwd, directory, command.operationId);
                                    if (recovered) return { revision: operationDigest(JSON.stringify(recovered)) };
                                    if (receipts.collaborationNetworkEffectBlocksRetry(directory, command.operationId))
                                        throw new Error(
                                            "Collaboration has an ambiguous external request; repeating it could create another remote effect.",
                                        );
                                }
                                const operations = await import("./collaboration/operations.ts");
                                const result = await operations
                                    .executeCollaborationIntent(this.cwd, command.intent, command.planId)
                                    .catch((error) => {
                                        if (error instanceof SharedSpaceGoneError) {
                                            const gone = receipts.inspectCollaborationOperationResult(
                                                directory,
                                                command.operationId,
                                            );
                                            if (gone?.action === "share-gone") return gone;
                                        }
                                        if (
                                            command.intent.action === "share" &&
                                            command.planId !== undefined &&
                                            !receipts.collaborationNetworkEffectStarted(directory, command.operationId)
                                        )
                                            throw new ProjectStorePreconditionError(
                                                "Plan sharing was refused before publication.",
                                            );
                                        throw error;
                                    });
                                receipts.retainCollaborationOperationResult(result);
                                return { revision: operationDigest(JSON.stringify(result)) };
                            },
                            true,
                        ),
                    );
                if (
                    command.kind === "create-plan" ||
                    command.kind === "revise-plan" ||
                    command.kind === "author-plan"
                ) {
                    const authoring = projectPlanAuthoring.forOwner(owner, this.cwd);
                    if (command.kind === "create-plan") return await authoring.createPlan(command);
                    if (command.kind === "revise-plan") return await authoring.revisePlan(command);
                    // Keep the historical command intact so its request digest and Plan ID still match.
                    return command.input.expectedRevision === undefined
                        ? await authoring.createPlan(command)
                        : await authoring.revisePlan(command);
                }
                if (command.kind === "read-sequence-result")
                    return {
                        sequenceResult: (await import("./operation-results.ts")).readSequenceOperationResult(
                            directory,
                            command.operationId,
                            command.planId,
                        ),
                    };
                if (command.kind === "read-children-result")
                    return {
                        children: (await import("./operation-results.ts")).readChildAuthoringResult(
                            directory,
                            command.operationId,
                            command.planId,
                        ),
                    };
                if (command.kind === "settle-retained-record") {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Retained recording requires its trusted owner.");
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            command.planId,
                            async () => {
                                const execution = await (
                                    await import("./retained-managed-execution.ts")
                                ).readRetainedManagedExecution(this.homeOwner!, command.planId, command.attemptId);
                                if (!execution) throw new Error("Retained recording attempt changed.");
                                const warning = await (
                                    await import("./retained-recording.ts")
                                ).settleRetainedRecord(this.homeOwner!, this.launch!, command.planId, this.signal);
                                if (warning) throw new Error(warning);
                                return { revision: command.expectedRevision };
                            },
                        ),
                    );
                }
                if (command.kind === "read-retained-recording") {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Retained recording requires its trusted owner.");
                    return {
                        retainedRecording:
                            (await (
                                await import("./retained-recording.ts")
                            ).readRetainedRecordingContext(
                                this.homeOwner,
                                this.launch,
                                command.reference,
                                command.pendingPublication,
                                this.signal,
                            )) ?? null,
                    };
                }
                if (command.kind === "prepare-retained-record") {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Retained recording requires its trusted owner.");
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            command.planId,
                            () =>
                                import("./retained-recording.ts").then(({ prepareRetainedRecord }) =>
                                    prepareRetainedRecord(
                                        this.homeOwner!,
                                        this.launch!,
                                        command.planId,
                                        command.attemptId,
                                        command.expectedRevision,
                                        command.pendingPublication,
                                        command.sections,
                                        this.signal,
                                    ),
                                ),
                        ),
                    );
                }
                if (command.kind === "settle-retained-abandonment") {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Retained abandonment requires its trusted owner.");
                    return await (
                        await import("./retained-managed-execution.ts")
                    ).settleRetainedManagedAbandonment(this.homeOwner, command, this.launch, this.signal);
                }
                if (command.kind === "settle-retained-cleanup") {
                    if (!this.homeOwner || !this.launch)
                        throw new Error("Retained cleanup requires its trusted owner and launcher.");
                    return await (
                        await import("./retained-managed-execution.ts")
                    ).settleRetainedManagedCleanup(this.homeOwner, command, this.launch, this.signal);
                }
                if (command.kind === "checkpoint-retained-execution") {
                    if (!this.homeOwner) throw new Error("Retained checkpoint requires its home owner.");
                    const { checkpointRetainedManagedExecution } = await import("./retained-managed-execution.ts");
                    return await checkpointRetainedManagedExecution(this.homeOwner, command, this.launch, this.signal);
                }
                if (command.kind === "read-retained-execution") {
                    if (!this.homeOwner) throw new Error("Retained remote execution requires its home owner.");
                    const { readRetainedManagedExecution } = await import("./retained-managed-execution.ts");
                    return {
                        retainedExecution:
                            (await readRetainedManagedExecution(
                                this.homeOwner,
                                command.reference,
                                command.attemptId || undefined,
                            )) ?? null,
                    };
                }
                if (command.kind === "list-history" || command.kind === "show-history") {
                    const { listLocalPlanHistory, readLocalPlanMilestone, resolveLocalHistoryPlan } =
                        await import("./history.ts");
                    // Existing clients can still send a name. Bound callers send only a durable ID.
                    const planId = command.planId ?? (await resolveLocalHistoryPlan(this.cwd, command.reference));
                    if (!plans.identity.isValid(planId)) throw new Error("Invalid Plan identity.");
                    const serialized = JSON.stringify(
                        command.kind === "list-history"
                            ? await listLocalPlanHistory(this.cwd, planId)
                            : await readLocalPlanMilestone(this.cwd, planId, command.version),
                    );
                    return { historyPage: pageStoreText(serialized, command) };
                }
                if (command.kind === "restore-history") {
                    const { planId } = command;
                    if (!plans.identity.isValid(planId)) throw new Error("Invalid Plan identity.");
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            command.planId,
                            async () => ({
                                revision: await (
                                    await import("./history.ts")
                                ).restoreLocalPlanMilestone(
                                    this.cwd,
                                    planId,
                                    command.version,
                                    command.expectedRevision,
                                ),
                            }),
                        ),
                    );
                }
                if (command.kind === "archive-catalog")
                    return { archives: await (await import("../plan-store.ts")).listArchivedPlans(this.cwd) };
                if (command.kind === "read-archive") {
                    const archived = files
                        ? await files.readArchivedResource(command.reference)
                        : await (await import("../plan-store.ts")).loadArchivedPlan(this.cwd, command.reference);
                    return { archived };
                }
                if (command.kind === "plan-resource-catalog") {
                    const resourceCatalog = files
                        ? await files.readResourceCatalog()
                        : await (await import("../plan-store.ts")).readPlanResourceCatalog(this.cwd);
                    return { resourceCatalog };
                }
                if (command.kind === "create-project-work-record")
                    return await withPlanPackageCatalogDiscovery(owner, async () => {
                        const records = workRecordFiles.forOwner(owner).workRecords;
                        const operation = {
                            operationId: command.operationId,
                            digest: operationDigest(JSON.stringify({ binding: this.binding, command })),
                        };
                        const receipt = await runReceiptedOperation(
                            directory,
                            operation.operationId,
                            operation.digest,
                            owner.projectId,
                            async () => {
                                const { attrs, markdown, relativePath } = await records.createOperationRecord(
                                    command.input,
                                    operation,
                                );
                                await requestWorkspaceSearchRefresh(this.cwd);
                                return {
                                    recordId: attrs.recordId,
                                    revision: operationDigest(JSON.stringify({ markdown, relativePath })),
                                };
                            },
                        );
                        const record = await records.readOperationRecord(operation);
                        if (!record || receipt.status !== "completed")
                            throw new Error("Completed Work Record creation evidence is unavailable.");
                        const createdRecord = { markdown: record.markdown, relativePath: record.relativePath };
                        if (
                            receipt.recordId !== record.attrs.recordId ||
                            receipt.revision !== operationDigest(JSON.stringify(createdRecord))
                        )
                            throw new Error("Completed Work Record creation evidence changed.");
                        return { operationId: operation.operationId, createdRecord };
                    });
                if (command.kind === "record-catalog")
                    return { recordResources: await workRecordFiles.forOwner(owner).list({ createDir: false }) };
                if (command.kind === "record-query")
                    return {
                        recordSearch: await searchWorkRecords(this.cwd, command.query, {
                            limit: command.limit,
                            accessMode: command.accessMode,
                            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                        }),
                    };
                const plan = await selectedPackage({ planId: command.planId });
                if (command.kind === "plan-resource") {
                    const { findPlanEvidenceById } = await import("../plan-store.ts");
                    return { planResource: await findPlanEvidenceById(this.cwd, command.planId) };
                }
                if (command.kind === "review-presentation") {
                    const { readPlanReviewPresentation } = await import("./resources.ts");
                    const presentation = await readPlanReviewPresentation(command.planId);
                    if (!presentation) throw new Error("Review presentation is unavailable.");
                    return { presentation };
                }
                if (command.kind === "capture-review") {
                    const { capturePlanReviewInput } = await import("./review-snapshots.ts");
                    const reviewInput = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                        capturePlanReviewInput(this.cwd, plan.metadata.name, command.expectedRevision),
                    );
                    if (!reviewInput) throw new Error("Retained review input is unavailable.");
                    return { reviewInput };
                }
                if (command.kind === "check-publication-owner") {
                    if (command.claim.planId !== command.planId || command.claim.planName !== plan.metadata.name)
                        throw new Error("Publication Plan mismatch.");
                    await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                        assertPackagePublicationOwner(command.claim),
                    );
                    return { plan: await loadPlan(this.cwd, plan.metadata.name) };
                }
                if (command.kind === "read-publication") {
                    if (command.reference.planId !== command.planId) throw new Error("Publication Plan mismatch.");
                    return { manifest: await readPlanPackagePublication(owner, command.reference) };
                }
                if (command.kind === "read-documents")
                    return { documentView: await readPlanDocuments(command.planId, command.resource) };
                if (command.kind === "read-execution") {
                    if (!plan.metadata.workflow?.attempt) return { execution: null };
                    const context = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                        capturePlanExecutionContext(plan.metadata.name),
                    );
                    return {
                        execution: context
                            ? { attemptId: context.packageAttemptId, input: context.packageInput }
                            : null,
                    };
                }
                if (command.kind === "read-execution-documents") {
                    const documents = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                        readFrozenPlanExecutionDocuments(plan.metadata.name, command.input),
                    );
                    if (!documents) throw new Error("Reserved execution input is unavailable.");
                    return { documents };
                }
                if (command.kind === "read-collaboration") {
                    const controller = await packageController(plan);
                    const spaceId = controller.collaborationSpaceId;
                    const serverUrl = controller.collaborationServerUrl;
                    if (!spaceId || !serverUrl) throw new Error("Plan is not shared.");
                    const secret = await resolveCompatibleSecretRecord(
                        [
                            await getProjectSecretStoreLocation(this.cwd),
                            getGlobalSecretStoreLocation(owner.executionAccountHome),
                        ],
                        command.planId,
                        spaceId,
                    );
                    const capability = secret?.record.maintainerCapability || secret?.record.reviewerCapability;
                    if (!capability) throw new Error("Shared Plan credentials are unavailable.");
                    const client = createCollaborationClient({
                        serverUrl,
                        bearerCapability: capability,
                        fetch: SYSTEM_COLLABORATION_FETCH,
                    });
                    const wire = await client.getSharedSpace(spaceId);
                    const response = normalizeSharedSpaceMetadata(
                        wire && typeof wire === "object" && "space" in wire ? wire.space : wire,
                    );
                    if (response.planId !== command.planId || response.spaceId !== spaceId)
                        throw new Error("Shared Plan identity changed.");
                    return { planId: command.planId, spaceId, latestRevision: response.latestRevision };
                }
                if (command.kind === "verify-recording-delivery") {
                    if (!this.homeOwner || !this.launch || command.reference.planId !== command.planId)
                        throw new Error("Recording proof requires its trusted owner.");
                    const retained = await readPlanPackagePublication(owner, command.reference);
                    if (!retained.validatedCommit && !retained.targetBranch) {
                        await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                            verifyPackageRecordingDelivery(this.cwd, command.reference),
                        );
                        return { manifest: retained };
                    }
                    const { proof, manifest } = await confirmManagedPublication(
                        this.homeOwner,
                        this.launch,
                        command.reference,
                        this.signal,
                    );
                    await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                        withConfirmedPublication(proof, () =>
                            verifyPackageRecordingDelivery(this.cwd, command.reference),
                        ),
                    );
                    return { manifest };
                }
                if (command.kind === "read-recording-context") {
                    return {
                        recording:
                            (await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                readPlanRecordingContext(
                                    plan.metadata.name,
                                    command.automatic,
                                    command.pendingPublication,
                                ),
                            )) ?? null,
                    };
                }
                if (command.kind === "read-delivery-sources") {
                    if (command.reference.planId !== command.planId) throw new Error("Recording source Plan changed.");
                    return {
                        sources: await readPublishedDeliverySources(this.cwd, {
                            planName: plan.metadata.name,
                            planId: command.planId,
                            packageInput: command.reference,
                            phase: command.confirmed ? "publication_verified" : "candidate_sealed",
                        }),
                    };
                }
                if (command.kind === "read-record") {
                    const record = await workRecordFiles.forOwner(owner).workRecords.read(command.recordId);
                    return { records: record ? [{ recordId: record.attrs.recordId, markdown: record.markdown }] : [] };
                }
                if (command.kind === "search-records") {
                    const result = await searchWorkRecordDocumentsInOwner(this.cwd, command.query, {
                        limit: command.limit,
                        mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    });
                    return {
                        records: result.records.map((record) => ({
                            recordId: record.attrs.recordId,
                            markdown: record.markdown,
                        })),
                    };
                }
                if (command.kind === "read-frozen") {
                    const manifest = await readPlanPackagePublication(owner, {
                        kind: "package",
                        projectId: owner.projectId,
                        repositoryId: owner.repositoryId,
                        personalOwner: owner.personalOwner.identity,
                        planId: command.planId,
                        attemptId: command.attemptId,
                        inputId: command.snapshotId,
                        digest: command.snapshotDigest,
                    });
                    const member = manifest.members.find((entry) => entry.metadata.planId === command.planId);
                    if (!member) throw new Error("Frozen Plan is unavailable.");
                    const input = await readPlanPackageInput(owner, member.input);
                    const document = input.documents.find((entry) => entry.name === command.resource);
                    if (!document) throw new Error("Frozen resource is unavailable.");
                    return {
                        planId: command.planId,
                        resource: command.resource,
                        revision: document.hash,
                        body: new TextDecoder().decode(document.bytes),
                        writable: false,
                    };
                }
                if (command.kind === "read") {
                    const document = await readPlanDocuments(command.planId, command.resource);
                    return {
                        planId: document.planId,
                        resource: document.resource,
                        revision: document.revision,
                        body: document.body,
                        writable: document.writable,
                    };
                }
                if (command.kind === "append-epic-qa")
                    return await packageWorkflowLocks(
                        [{ planId: command.planId }, { planId: command.childPlanId }],
                        () =>
                            runReceiptedOperation(
                                directory,
                                command.operationId,
                                operationDigest(JSON.stringify({ binding: this.binding, command })),
                                command.planId,
                                async (recovering) => {
                                    const child = await selectedPackage({ planId: command.childPlanId });
                                    if (child.metadata.parentPlanId !== command.planId)
                                        throw new Error("Epic family changed before QA preparation.");
                                    const artifacts = openPlanStoreForCheckout(this.cwd)!.artifacts;
                                    const epicId = plans.identity.parse(command.planId)!;
                                    const childId = plans.identity.parse(command.childPlanId)!;
                                    if (
                                        recovering &&
                                        child.metadata.workflow?.generatedArtifact?.operationId === command.operationId
                                    ) {
                                        await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                            import("./workflows.ts").then(({ recoverGeneratedManualQaArtifact }) =>
                                                recoverGeneratedManualQaArtifact({ planId: childId }),
                                            ),
                                        );
                                        return {
                                            revision: (await readPlanDocuments(command.planId)).revision,
                                            qaStatus: "recorded",
                                        };
                                    }
                                    const parentRevision = (await readPlanDocuments(command.planId)).revision;
                                    if ((await artifacts.findManualQaSection(epicId, childId)).exists)
                                        return { revision: parentRevision, qaStatus: "already_present" };
                                    const childRevision = (await readPlanDocuments(command.childPlanId)).revision;
                                    if (parentRevision !== command.expectedRevision)
                                        throw new StalePlanWriteError(command.expectedRevision, parentRevision);
                                    if (childRevision !== command.childRevision || !child.metadata.workflow?.attempt)
                                        throw new StalePlanWriteError(command.childRevision, childRevision);
                                    const result = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                        artifacts.appendManualQaSection(epicId, childId, {
                                            childHeading: command.childHeading,
                                            checklistMarkdown: command.checklistMarkdown,
                                        }),
                                    );
                                    return {
                                        revision: (await readPlanDocuments(command.planId)).revision,
                                        qaStatus: result.status,
                                    };
                                },
                                true,
                            ),
                    );
                if (command.kind === "epic-projection")
                    return await packageWorkflowLocks(
                        [{ planId: command.planId }, { planId: command.childPlanId }],
                        () =>
                            runReceiptedOperation(
                                directory,
                                command.operationId,
                                operationDigest(JSON.stringify({ binding: this.binding, command })),
                                command.planId,
                                async () => {
                                    const child = await readPlanDocuments(command.childPlanId);
                                    if (
                                        child.revision !== command.childRevision ||
                                        (await readPlanDocuments(command.planId)).revision !== command.expectedRevision
                                    )
                                        throw new Error("Epic family changed before projection.");
                                    const childPlan = await selectedPackage({ planId: command.childPlanId });
                                    if (childPlan.metadata.parentPlanId !== command.planId)
                                        throw new Error("Projection names another Epic family.");
                                    const { syncEpicChildPlanDeviations, recordIntegrationNotes } =
                                        await import("./epic-context.ts");
                                    await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                        command.projection === "deviations"
                                            ? syncEpicChildPlanDeviations(this.cwd, childPlan.metadata.name)
                                            : recordIntegrationNotes(
                                                  this.cwd,
                                                  plan.metadata.name,
                                                  childPlan.metadata.name,
                                                  command.notes,
                                              ),
                                    );
                                    return { revision: (await readPlanDocuments(command.planId)).revision };
                                },
                            ),
                    );
                if (command.kind === "sequence-snapshot")
                    return {
                        sequenceDocuments: await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                            import("./sequence-review.ts").then(({ snapshotSequenceReview }) =>
                                snapshotSequenceReview(this.cwd, plan.metadata.name),
                            ),
                        ),
                    };
                if (command.kind === "prepare-sequence" || command.kind === "sequence-decision")
                    return await withPlanPackageCatalogDiscovery(owner, async () => {
                        const members = await (
                            await import("../plan-store.ts")
                        ).findPlansByParent(this.cwd, plan.metadata.name);
                        return await packageWorkflowLocks(
                            [plan.metadata.name, ...members.map((member) => member.name)],
                            () =>
                                runReceiptedOperation(
                                    directory,
                                    command.operationId,
                                    operationDigest(JSON.stringify({ binding: this.binding, command })),
                                    command.planId,
                                    async () => {
                                        const sequence = await import("./sequence-review.ts");
                                        if (command.kind === "prepare-sequence") {
                                            if (
                                                (await readPlanDocuments(command.planId)).revision !==
                                                command.expectedRevision
                                            )
                                                throw new Error("Sequence changed before preparation.");
                                            await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                                sequence.prepareSequenceReview(
                                                    this.cwd,
                                                    plan.metadata.name,
                                                    command.inputs ?? undefined,
                                                ),
                                            );
                                        } else {
                                            const documents = await Promise.all(
                                                command.documents.map(async (document) => {
                                                    const current = await loadPlan(this.cwd, document.planName);
                                                    if (!current || current.attrs.planId !== document.planId)
                                                        throw new Error("Sequence member identity changed.");
                                                    return { ...document, planPath: current.path };
                                                }),
                                            );
                                            const result = await withLocalPlanWorkflow(
                                                this.cwd,
                                                plan.metadata.name,
                                                () =>
                                                    sequence.applySequenceReviewDecision({
                                                        cwd: this.cwd,
                                                        documents,
                                                        decision: command.decision,
                                                        toolCallId: command.operationId,
                                                    }),
                                            );
                                            (await import("./operation-results.ts")).retainSequenceOperationResult(
                                                result,
                                            );
                                        }
                                        return { revision: (await readPlanDocuments(command.planId)).revision };
                                    },
                                    true,
                                ),
                        );
                    });
                if (command.kind === "author-children")
                    return await withPlanPackageCatalogDiscovery(owner, () =>
                        runReceiptedOperation(
                            directory,
                            command.operationId,
                            operationDigest(JSON.stringify({ binding: this.binding, command })),
                            command.planId,
                            async () => {
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Parent Plan changed before child authoring.");
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    import("./children.ts").then(({ authorPackageChildren }) =>
                                        authorPackageChildren(
                                            this.cwd,
                                            plan.metadata.name,
                                            command.children,
                                            command.options,
                                            command.finalize,
                                        ),
                                    ),
                                );
                                return { revision: (await readPlanDocuments(command.planId)).revision };
                            },
                        ),
                    );
                const mutationPlans = [{ planId: command.planId }];
                if (command.kind === "edit-documents")
                    mutationPlans.push(...command.edits.map(({ planId }) => ({ planId })));
                if ((command.kind === "reserve-recording" || command.kind === "prepare-record") && command.reference)
                    mutationPlans.push({ planId: command.reference.planId });
                return await packageWorkflowLocks(mutationPlans, async () => {
                    this.owner();
                    if (command.kind === "reconcile")
                        return inspectOperationReceipt(directory, command.operationId, command.planId);
                    const digest = operationDigest(JSON.stringify({ binding: this.binding, command }));
                    if (command.kind === "recover-execution" && command.action === "recreate") {
                        const {
                            planId,
                            operationId,
                            expectedRevision,
                            attemptId: originalAttemptId,
                            replacementAttemptId,
                        } = command;
                        const homeOwner = this.homeOwner;
                        const launch = this.launch;
                        const execution = this.execution;
                        if (!homeOwner || !launch || !execution)
                            throw new Error("Execution recovery requires the admitted execution host.");
                        if (!originalAttemptId || !replacementAttemptId || originalAttemptId === replacementAttemptId)
                            throw new Error("Recreation requires a distinct replacement for the reserved Git attempt.");
                        const current = await selectedPackage({ planId });
                        const name = current.metadata.name;
                        const apply = () =>
                            runReceiptedOperation(directory, operationId, digest, planId, async () => {
                                this.signal?.throwIfAborted();
                                return {
                                    revision: await adoptManagedExecutionReplacement(homeOwner, {
                                        planId,
                                        originalAttemptId,
                                        replacementAttemptId,
                                        operationId,
                                        expectedRevision,
                                    }),
                                };
                            });
                        if (inspectOperationReceipt(directory, operationId, planId).status === "completed")
                            return await apply();
                        const { proveManagedExecutionRecovery } =
                            await import("../shared/remote/project-store-launch.ts");
                        return await withLocalPlanWorkflow(
                            this.cwd,
                            name,
                            () =>
                                withManagedExecutionRecovery(
                                    homeOwner,
                                    execution,
                                    {
                                        planId,
                                        expectedPlanName: name,
                                        expectedRevision: command.controllerRevision ?? current.metadata.revision,
                                        attemptId: originalAttemptId,
                                        action: "recreate",
                                        recreate: { operationId, replacementAttemptId, expectedRevision },
                                    },
                                    (request) => proveManagedExecutionRecovery(launch, request, this.signal),
                                    apply,
                                ),
                            planId,
                        );
                    }
                    return await runReceiptedOperation(
                        directory,
                        command.operationId,
                        digest,
                        command.planId,
                        async (recovering) => {
                            if (command.kind === "record-deviation") {
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    import("./definition.ts").then(({ recordPlanDeviation }) =>
                                        recordPlanDeviation(
                                            this.cwd,
                                            plan.metadata.name,
                                            command.proposal,
                                            command.expectedRevision,
                                        ),
                                    ),
                                );
                            } else if (
                                command.kind === "archive-plan" ||
                                command.kind === "restore-plan" ||
                                command.kind === "rename-plan"
                            ) {
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const { archivePlan, restoreArchivedPlan, findPlanEvidenceById } =
                                    await import("../plan-store.ts");
                                if (command.kind === "restore-plan")
                                    await restoreArchivedPlan(this.cwd, command.planId, { byId: true });
                                else if (
                                    command.kind === "rename-plan" &&
                                    plan.metadata.archive &&
                                    !plan.metadata.archive.restoredAt
                                ) {
                                    const { renamePlanPackage } = await import("@runwield/plans/package-storage");
                                    assertSharedPlanWriteAllowed(
                                        (await findPlanEvidenceById(this.cwd, command.planId)).attrs,
                                    );
                                    await renamePlanPackage(
                                        owner,
                                        command.planId,
                                        plan.metadata.revision,
                                        command.name,
                                    );
                                } else
                                    await withLocalPlanWorkflow(
                                        this.cwd,
                                        plan.metadata.name,
                                        async () => {
                                            if (command.kind === "archive-plan")
                                                await archivePlan(this.cwd, plan.metadata.name, {
                                                    expectedPlanId: command.planId,
                                                    reason: command.reason,
                                                    force: command.force,
                                                    now: command.now || undefined,
                                                });
                                            else
                                                await (
                                                    await import("./names.ts")
                                                ).renamePlan(
                                                    this.cwd,
                                                    command.planId,
                                                    command.name,
                                                    command.expectedRevision,
                                                );
                                        },
                                        command.planId,
                                    );
                            } else if (command.kind === "lifecycle-decision") {
                                const { isManagedLifecycleDecision, managedLifecycleDetails } =
                                    await import("./events.ts");
                                if (!isManagedLifecycleDecision(command.decision.event))
                                    throw new Error("Unsupported managed lifecycle decision.");
                                await recordPlanEvent({
                                    cwd: this.cwd,
                                    planName: plan.metadata.name,
                                    expectedPlanId: command.planId,
                                    event: command.decision.event,
                                    expectedRevision: command.expectedRevision,
                                    details: managedLifecycleDetails(command.decision.details),
                                });
                            } else if (command.kind === "recover-execution") {
                                const homeOwner = this.homeOwner;
                                const launch = this.launch;
                                if (!homeOwner || !launch)
                                    throw new Error("Execution recovery requires its trusted launcher.");
                                const { action } = command;
                                const binding = plan.metadata.workflow?.attempt;
                                if ((binding?.attemptId ?? null) !== command.attemptId)
                                    throw new Error("Recovery names another reserved attempt.");
                                const recover = async () => {
                                    const current = await loadPlan(this.cwd, plan.metadata.name);
                                    if (
                                        !current ||
                                        current.revision !== command.expectedRevision ||
                                        (command.controllerRevision !== null &&
                                            current.controllerRevision !== command.controllerRevision)
                                    )
                                        throw new Error("Recovery source changed.");
                                    const apply = async () => {
                                        const recovery = await import("./recovery.ts");
                                        if (command.action === "stop" || command.action === "clear")
                                            await recovery.resetPlanExecutionMetadata(
                                                this.cwd,
                                                plan.metadata.name,
                                                command.action,
                                                current.revision,
                                            );
                                        else if (command.action === "detach")
                                            await recovery.detachPlanExecution(
                                                this.cwd,
                                                plan.metadata.name,
                                                command.planId,
                                                current.controllerRevision,
                                            );
                                        else if (command.action === "clear-recovery")
                                            await recovery.clearPlanRecoveryAfterCleanup(
                                                this.cwd,
                                                plan.metadata.name,
                                                command.planId,
                                            );
                                        else if (command.action === "user-verified")
                                            await recovery.retainUserVerifiedPlan(
                                                this.cwd,
                                                plan.metadata.name,
                                                current.revision,
                                                command.attemptId ?? undefined,
                                            );
                                        else if (command.action === "refresh" && command.attemptId)
                                            await recovery.refreshPlanExecutionReference(
                                                this.cwd,
                                                plan.metadata.name,
                                                command.attemptId,
                                                current.revision,
                                            );
                                        else
                                            throw new Error("Recovery action requires its original execution attempt.");
                                    };
                                    if (action === "non-git") {
                                        if (binding && binding.executionMode !== "non_git_in_place")
                                            throw new Error("Non-Git recovery cannot replace a reserved Git attempt.");
                                        await (
                                            await import("../shared/remote/project-store-launch.ts")
                                        ).proveManagedNonGitExecution(
                                            launch,
                                            {
                                                projectId: owner.projectId,
                                                repositoryId: owner.repositoryId,
                                                personalOwner: owner.personalOwner.identity,
                                            },
                                            this.signal,
                                        );
                                        await (
                                            await import("./execution-recovery.ts")
                                        ).restoreNonGitPlanExecution(this.cwd, plan.metadata.name, current.revision);
                                        return;
                                    }
                                    if (!binding) {
                                        await apply();
                                        return;
                                    }
                                    const execution = this.execution;
                                    if (!execution)
                                        throw new Error("Execution recovery requires the admitted execution host.");
                                    const { proveManagedExecutionRecovery } =
                                        await import("../shared/remote/project-store-launch.ts");
                                    await withManagedExecutionRecovery(
                                        homeOwner,
                                        execution,
                                        {
                                            planId: command.planId,
                                            expectedPlanName: plan.metadata.name,
                                            expectedRevision: plan.metadata.revision,
                                            attemptId: binding.attemptId,
                                            action,
                                        },
                                        (request) => proveManagedExecutionRecovery(launch, request, this.signal),
                                        async () => {
                                            this.signal?.throwIfAborted();
                                            await apply();
                                        },
                                    );
                                };
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, recover, command.planId);
                            } else if (command.kind === "reopen-review") {
                                if (plan.metadata.workflow?.attempt?.attemptId !== command.attemptId)
                                    throw new Error("Review recovery belongs to another execution attempt.");
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, async () => {
                                    const current = await loadPlan(this.cwd, plan.metadata.name);
                                    if (!current || current.revision !== command.expectedRevision)
                                        throw new Error("Review recovery Plan changed.");
                                    await (
                                        await import("./recovery.ts")
                                    ).reopenPlanReview(
                                        this.cwd,
                                        plan.metadata.name,
                                        command.attemptId,
                                        current.attrs.status,
                                        current.revision,
                                    );
                                });
                            } else if (command.kind === "record-human-review" || command.kind === "save-epic-review") {
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Plan review revision changed.");
                                const { recordPlanHumanReview, saveEpicIntegrationReview } =
                                    await import("./definition.ts");
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, async () => {
                                    if (command.kind === "record-human-review")
                                        await recordPlanHumanReview(this.cwd, plan.metadata.name, command.metadata);
                                    else
                                        await saveEpicIntegrationReview(this.cwd, plan.metadata.name, command.review, {
                                            expectedRevision: command.expectedRevision,
                                        });
                                });
                            } else if (command.kind === "review-decision") {
                                const { applySharedPlanReviewDecision } = await import("./review.ts");
                                const document = await loadPlan(this.cwd, plan.metadata.name);
                                if (!document) throw new Error("Plan changed after review opened.");
                                const reviewed = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    applySharedPlanReviewDecision({
                                        cwd: this.cwd,
                                        planName: plan.metadata.name,
                                        planPath: document.path,
                                        planWithFrontMatter: command.sourceMarkdown,
                                        planRevision: command.expectedRevision,
                                        originalAttrs: { ...document.attrs, status: command.sourceStatus },
                                        expectedControllerRevision: command.controllerRevision ?? undefined,
                                        packageInput: command.input,
                                        decision: command.decision,
                                        trustedClassification: command.classification,
                                        trustedWorkKind: command.workKind ?? undefined,
                                    }),
                                );
                                if (reviewed.cancellationReason || reviewed.recoveryRequired)
                                    throw new Error(reviewed.feedback || "Review requires refreshed evidence.");
                            } else if (command.kind === "save-epic-artifact") {
                                const resource = command.resource;
                                if (!isEpicArtifactName(resource)) throw new Error("Unsupported Epic artifact.");
                                const saved = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    openPlanStoreForCheckout(this.cwd)!.artifacts.save(
                                        plans.identity.parse(command.planId)!,
                                        resource,
                                        command.body,
                                        command.expectedRevision,
                                    ),
                                );
                                return { revision: saved.revision };
                            } else if (command.kind === "edit-documents") {
                                await (await import("./documents.ts")).savePlanDocumentBatch(command.edits);
                            } else if (command.kind === "save-document") {
                                await savePlanDocument(
                                    command.planId,
                                    command.resource,
                                    command.expectedRevision,
                                    command.body,
                                );
                            } else if (command.kind === "save-prose") {
                                await savePlanProse(
                                    this.cwd,
                                    plan.metadata.name,
                                    command.body,
                                    command.expectedRevision,
                                );
                            } else if (command.kind === "save-definition") {
                                await savePlanDefinition(this.cwd, plan.metadata.name, command.changes, {
                                    expectedRevision: command.expectedRevision,
                                });
                            } else if (command.kind === "reserve-recording" || command.kind === "prepare-record") {
                                const current = await selectedPackage({ planId: command.planId });
                                const delivery = command.reference
                                    ? await selectedPackage({ planId: command.reference.planId })
                                    : current;
                                const reference =
                                    delivery.metadata.workflow?.recordingPreparation ||
                                    delivery.metadata.workflow?.delivery?.source;
                                if (
                                    !reference ||
                                    reference.attemptId !== command.attemptId ||
                                    (command.reference &&
                                        (command.reference.inputId !== reference.inputId ||
                                            command.reference.digest !== reference.digest)) ||
                                    (await readPlanDocuments(command.planId)).revision !== command.expectedRevision
                                )
                                    throw new Error("Recording attempt or Plan revision changed.");
                                await readPlanPackagePublication(owner, command.reference || reference);
                                const sources = await readPublishedDeliverySources(this.cwd, {
                                    planName: delivery.metadata.name,
                                    planId: delivery.metadata.planId,
                                    packageInput: reference,
                                    phase: delivery.metadata.workflow?.delivery
                                        ? "publication_verified"
                                        : "candidate_sealed",
                                });
                                if (!sources.workRecordOwner || sources.workRecordOwner.planId !== command.planId)
                                    throw new Error("Recording requires its retained parent owner.");
                                const workRecordOwner = sources.workRecordOwner;
                                const checkpoint = (await packageController(delivery)).validationCheckpoint;
                                const deliveryCheckpoint =
                                    checkpoint?.attemptId === command.attemptId ? checkpoint : null;
                                const prepared = await reservePreparedPackageRecord(
                                    command.attemptId,
                                    deliveryCheckpoint?.hostRecorder,
                                );
                                if (command.kind === "reserve-recording")
                                    return { revision: command.expectedRevision, recordId: prepared.recordId };
                                const generate = async () => {
                                    const source = {
                                        ...workRecordOwner,
                                        deliveryCheckpoint,
                                        preparation: { attemptId: prepared.attemptId, recordId: prepared.recordId },
                                        pendingPublication: !delivery.metadata.workflow?.delivery,
                                    };
                                    const saved = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                        generatePreparedPackageRecord(this.cwd, source, command.attemptId, {
                                            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                            runRecorderStep: () => Promise.resolve(command.sections),
                                        }),
                                    );
                                    if (saved.status !== "generated" && saved.status !== "linked")
                                        throw new Error("Canonical Work Record remains pending.");
                                    return {
                                        revision: (await readPlanDocuments(command.planId)).revision,
                                        recordId: prepared.recordId,
                                    };
                                };
                                if (delivery.metadata.workflow?.delivery) {
                                    if (!this.homeOwner || !this.launch)
                                        throw new Error("Recording requires its trusted execution launcher.");
                                    if (delivery.metadata.workflow.delivery.mode === "non_git_in_place") {
                                        await verifyPackageRecordingDelivery(this.cwd, reference);
                                        return await generate();
                                    }
                                    const { proof } = await confirmManagedPublication(
                                        this.homeOwner,
                                        this.launch,
                                        reference,
                                        this.signal,
                                    );
                                    return await withConfirmedPublication(proof, generate);
                                }
                                return await generate();
                            } else if (command.kind === "save-record") {
                                const receipt = inspectOperationReceipt(directory, command.operationId, command.planId);
                                const retained = receipt.recordId
                                    ? await findWorkRecordById(this.cwd, receipt.recordId)
                                    : null;
                                const current = await selectedPackage({ planId: command.planId });
                                if (
                                    retained &&
                                    current.metadata.workflow?.workRecord?.recordId === retained.attrs.recordId
                                ) {
                                    if (!retained.attrs.provenance?.sourcePlans?.includes(command.planId))
                                        throw new Error("Retained Work Record has conflicting provenance.");
                                    await syncWorkRecordToIndex(this.cwd, retained, {
                                        mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                    });
                                    return { revision: (await readPlanDocuments(command.planId)).revision };
                                }
                                const before = await readPlanDocuments(command.planId);
                                if (before.revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const reference = plan.metadata.workflow?.delivery?.source;
                                if (!reference) throw new Error("Work Record requires retained delivery evidence.");
                                if (recovering && !(await inspectPreparedPackageRecord(reference.attemptId)))
                                    throw new Error("Recording intent is unavailable; operation remains pending.");
                                const sources = await readPublishedDeliverySources(this.cwd, {
                                    phase: "publication_verified",
                                    planName: plan.metadata.name,
                                    planId: command.planId,
                                    packageInput: reference,
                                });
                                if (sources.workRecordOwner?.planId !== command.planId)
                                    throw new Error("Work Record belongs to a different recording owner.");
                                const saved = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    generatePreparedPackageRecord(
                                        this.cwd,
                                        sources.workRecordOwner!,
                                        reference.attemptId,
                                        {
                                            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                            runRecorderStep: () =>
                                                Promise.resolve({
                                                    title: command.title,
                                                    summary: command.summary,
                                                }),
                                        },
                                    ),
                                );
                                if (saved.status !== "generated" && saved.status !== "linked")
                                    throw new Error("Canonical Work Record was not persisted.");
                                if ("indexWarning" in saved && saved.indexWarning)
                                    throw new Error("Canonical record retained; index reconciliation remains pending.");
                                return {
                                    revision: (await readPlanDocuments(command.planId)).revision,
                                    recordId: "recordId" in saved ? saved.recordId : undefined,
                                };
                            } else if (command.kind === "reconcile-record-index") {
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const record = await findWorkRecordById(this.cwd, command.recordId);
                                if (!record || !record.attrs.provenance?.sourcePlans?.includes(command.planId))
                                    throw new Error("Work Record does not belong to this Plan.");
                                await syncWorkRecordToIndex(this.cwd, record, {
                                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                });
                            } else if (command.kind === "settle-in-place") {
                                if (!this.launch || !this.homeOwner)
                                    throw new Error("In-place completion requires its trusted execution launcher.");
                                const binding = plan.metadata.workflow?.attempt;
                                const delivery = plan.metadata.workflow?.delivery;
                                const settled =
                                    !binding &&
                                    delivery?.mode === "non_git_in_place" &&
                                    delivery.source.attemptId === command.attemptId;
                                if (
                                    !settled &&
                                    (await readPlanDocuments(command.planId)).revision !== command.expectedRevision
                                )
                                    throw new Error("Plan revision changed.");
                                if (
                                    !settled &&
                                    (binding?.attemptId !== command.attemptId ||
                                        binding.executionMode !== "non_git_in_place")
                                )
                                    throw new Error("In-place completion belongs to another execution attempt.");
                                await (
                                    await import("../shared/remote/project-store-launch.ts")
                                ).proveManagedNonGitExecution(
                                    this.launch,
                                    {
                                        projectId: owner.projectId,
                                        repositoryId: owner.repositoryId,
                                        personalOwner: owner.personalOwner.identity,
                                    },
                                    this.signal,
                                );
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    settlePackageInPlace(plan.metadata.name, SYSTEM_WORK_RECORD_MNEMOTECA_PORT),
                                );
                            } else if (command.kind === "settle-publication") {
                                if (!this.launch || command.reference.planId !== command.planId)
                                    throw new Error("Publication settlement requires its trusted execution launcher.");
                                if (!this.homeOwner) throw new Error("Managed publication requires a personal owner.");
                                const retained = await readPlanPackagePublication(owner, command.reference);
                                if (!retained.validatedCommit && !retained.targetBranch) {
                                    await withLocalPlanWorkflow(this.cwd, plan.metadata.name, async () => {
                                        await verifyPackageRecordingDelivery(this.cwd, command.reference);
                                        const warning = await settlePreparedPackageRecord(
                                            this.cwd,
                                            retained,
                                            SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                        );
                                        if (warning) throw new Error(warning);
                                        await retainPublishedWorkRecordSource(this.cwd, {
                                            phase: "publication_verified",
                                            packageInput: command.reference,
                                            planName: plan.metadata.name,
                                            planId: command.planId,
                                        });
                                    });
                                    return { revision: (await readPlanDocuments(command.planId)).revision };
                                }
                                const { proof, manifest } = await confirmManagedPublication(
                                    this.homeOwner,
                                    this.launch,
                                    command.reference,
                                    this.signal,
                                );
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    withConfirmedPublication(proof, async () => {
                                        await settlePackagePublication(this.cwd, proof);
                                        await retainPublishedWorkRecordSource(this.cwd, {
                                            ...proof,
                                            phase: "publication_verified",
                                        });
                                        const warning = await settlePreparedPackageRecord(
                                            this.cwd,
                                            manifest,
                                            SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                            this.execution?.repositoryRoot,
                                        );
                                        if (warning) throw new Error(warning);
                                    }),
                                );
                            } else if (command.kind === "execution-checkpoint") {
                                if (command.checkpoint.event === "validation_passed") {
                                    if (!this.launch)
                                        throw new Error("Non-Git validation requires its execution launcher.");
                                    await (
                                        await import("../shared/remote/project-store-launch.ts")
                                    ).proveManagedNonGitExecution(
                                        this.launch,
                                        {
                                            projectId: owner.projectId,
                                            repositoryId: owner.repositoryId,
                                            personalOwner: owner.personalOwner.identity,
                                        },
                                        this.signal,
                                    );
                                }
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    recordManagedExecutionCheckpoint(
                                        this.cwd,
                                        plan.metadata.name,
                                        command.attemptId,
                                        command.expectedRevision,
                                        command.checkpoint,
                                    ),
                                );
                            } else if (command.kind === "reserve-execution") {
                                if (this.homeOwner) {
                                    const retained = await (
                                        await import("./retained-managed-execution.ts")
                                    ).readRetainedManagedExecution(this.homeOwner, command.planId);
                                    if (retained && !retained.cleanupComplete && !retained.abandonmentComplete)
                                        throw new Error(
                                            "The original retained execution must finish publication and cleanup or be deliberately abandoned before replacement.",
                                        );
                                }
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                const attemptId = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    reservePlanExecution(plan.metadata.name, command.reservation),
                                );
                                return { revision: (await readPlanDocuments(command.planId)).revision, attemptId };
                            } else if (command.kind === "freeze-publication-policy") {
                                if ((await readPlanDocuments(command.planId)).revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    freezePlanPublicationPolicy(plan.metadata.name, command.attemptId, command.policy),
                                );
                            } else if (command.kind === "seal-publication") {
                                const before = await readPlanDocuments(command.planId);
                                if (before.revision !== command.expectedRevision)
                                    throw new Error("Plan revision changed.");
                                if (
                                    (!command.validatedCommit || !command.targetBranch) &&
                                    (command.validatedCommit !== "" ||
                                        command.targetBranch !== "" ||
                                        plan.metadata.workflow?.attempt?.executionMode !== "non_git_in_place")
                                )
                                    throw new Error(
                                        "Publication requires Git evidence or its reserved non-Git execution.",
                                    );
                                const snapshot = await withLocalPlanWorkflow(this.cwd, plan.metadata.name, () =>
                                    sealPackagePublication(
                                        plan.metadata.name,
                                        command.attemptId,
                                        command.validatedCommit,
                                        command.targetBranch,
                                        command.preparation,
                                    ),
                                );
                                return {
                                    revision: (await readPlanDocuments(command.planId)).revision,
                                    snapshotId: snapshot.inputId,
                                    snapshotDigest: snapshot.digest,
                                    attemptId: snapshot.attemptId,
                                };
                            } else {
                                await recordPlanEvent({
                                    cwd: this.cwd,
                                    planName: plan.metadata.name,
                                    expectedPlanId: command.planId,
                                    event: command.event,
                                    expectedRevision: command.expectedRevision,
                                });
                            }
                            return { revision: (await readPlanDocuments(command.planId)).revision };
                        },
                        command.kind === "prepare-record" ||
                            command.kind === "save-record" ||
                            command.kind === "reserve-execution" ||
                            command.kind === "settle-in-place" ||
                            command.kind === "settle-publication",
                    );
                });
            },
            () => {
                throw new Error("Project store authority is unavailable.");
            },
        );
        return { binding: this.binding, result };
    }
}
