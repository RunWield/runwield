/**
 * Plan storage operations. Persistence, source selection, locks and revisions
 * belong to this module; callers supply intent and observe returned revisions.
 */
export {
    operatePlanFile,
    savePlanFileBatch,
    resolvePlanFileTarget,
    withPlanFileOperation,
    isCanonicalPlanMarkdownPath,
    type PlanFileCommand,
    type PlanFileResult,
} from "./agent-files.ts";
export { authorLocalPlan, type PlanAuthoringInput } from "./access.ts";
export { readPlanDocuments, savePlanDocument, readPlanDocumentLink, saveReviewedPlanDocument } from "./documents.ts";
export { importPlans, importedPlanCopyChoice } from "./imports.ts";
export {
    resolveSiblingChildPlanDependencies,
    onboardExternalPlan,
    createPulledCollaborationPlan,
    updatePlanCollaborationMetadata,
    clearPlanCollaborationMetadata,
    StalePlanBodyError,
    PlanFileIssueError,
} from "../plan-store.ts";
export type {
    ChildFeaturePlanDescriptor,
    PlanBodyResource,
    PlanResource,
    PlanListEntry,
    ArchivedPlanEntry,
    PlanReadAvailability,
    PlanTextLoaded,
    PlanWriteOptions,
    PlanDocumentDiagnostic,
    SavedChildFeaturePlan,
} from "../plan-store.ts";
export { authorPackageChildren, saveChildFeaturePlans } from "./children.ts";
export { readLocalHomeStore, withLocalPlanWorkflow, withLocalProjectAction } from "./access.ts";
export { continueMissingPlanExecution } from "./access.ts";
export { planDocumentReference } from "./access.ts";
export { recoverSealedPlanFormatting } from "./formatting-recovery.ts";
export {
    loadEpicReviewContext,
    syncEpicChildPlanDeviations,
    recordIntegrationNotes,
    type EpicReviewContext,
} from "./epic-context.ts";
export { inspectPlanIdentityDocuments } from "./diagnostics.ts";
export {
    loadCanonicalExecutionPlanSource,
    ensureExecutionPlanFile,
    prepareExecutionPlanFile,
    restoreExecutionPlanFromBaseline,
} from "../shared/workflow/execution-plan-file.ts";
export { requiresPlanWorkflow } from "./access.ts";
export { capturePackageWorkflowAccess as capturePlanReadContext } from "./workflows.ts";
export { workflowEpicArtifacts } from "./artifacts.ts";
export {
    resolveWorkflowPlanLocation,
    needsSessionPlanningWorktree,
    PlanningNotStartedError,
    recoverMissingExecutionWorktreesForPlanLoading,
} from "./location.ts";
export {
    preparePlanController,
    preparePlanWorkflow,
    preparePlanPublication,
    preparePlanDependencies,
} from "./preparation.ts";
export {
    retainPublishedWorkRecordSource,
    loadPublishedWorkRecordSource,
    readPublishedDeliverySources,
    verifyPackageRecordingDelivery,
} from "./published-source.ts";

export {
    savePlanDefinition,
    savePlanValidationCheckpoint,
    saveEpicIntegrationReview,
    type PlanDefinitionChanges,
    type PlanWritePrecondition,
} from "./definition.ts";

export {
    reservePlanExecution,
    readFrozenPlanExecutionDocuments,
    type PlanExecutionReservation,
    type PlanExecutionHost,
    type FrozenPlanExecutionDocuments,
} from "./workflows.ts";

export {
    recordPlanEvent,
    stageValidationPassedInExecutionWorktree,
    PlanLifecycleTransitionError,
    type RecordPlanEventRequest,
    type StageValidationRequest,
    type ValidationPassedStagingResult,
} from "./events.ts";

export { capturePlanExecutionContext, readPlanExecutionAttemptId, type PlanExecutionContext } from "./workflows.ts";

export { assertAuthorizedPlanPath, assertReadablePlanResource, readPlanReviewPresentation } from "./resources.ts";

export {
    applySharedPlanReviewDecision,
    reviewSourceStillMatches,
    type SharedPlanReviewDecision,
    type SharedPlanReviewEvidence,
    type SharedPlanReviewActionOptions,
    type SharedPlanReviewActionResult,
} from "./review.ts";
export {
    prepareSequenceReview,
    snapshotSequenceReview,
    validateSequenceReviewDecision,
    applySequenceReviewDecision,
    type SequenceChildInput,
    type SequenceReviewDocument,
    type SequenceDocumentDecision,
    type SequenceReviewDecision,
    type SequenceReviewResult,
} from "./sequence-review.ts";

export { withPlanExecutionAdmission, preparePlanValidationInput } from "./workflows.ts";
export { prepareEditedSiblingPlans } from "./sibling-scopes.ts";
export {
    resolvePlanWithPrimaryRecovery,
    discoverPlanDocumentRoot,
    resumePlanPublicationCleanup,
    type LoadPlanResolution,
    type PublicationCleanupNotice,
    type PlanDocumentTarget,
} from "./resolution.ts";
export {
    capturePlanAccess,
    hasCanonicalPlanAccess,
    selectPlanAccess,
    withPlanAccess,
    resumePlanAttempt,
    type PlanAccess,
} from "./handles.ts";
export type { TransitionResult, TransitionResource } from "./transitions.ts";

export { loadReviewPlanDocument, isCurrentPlan, planControllerRoot } from "./resources.ts";
export {
    readPlanRecordingContext,
    generatePlanPreparedRecord,
    settlePlanPreparedRecord,
    readRecordingPublication,
    planRecordingSourceRoot,
    withRecordingPlan,
} from "./recording.ts";

export { renderPlanReviewMarkdown } from "./resources.ts";
export { readPlanResource, type PlanDocumentIdentity } from "./documents.ts";
export { withPlanReadScope } from "./access.ts";
export { loadPlanDetail } from "./resources.ts";

export { runPlansDoctor, type DoctorIssue } from "./doctor.ts";

// Publication commands own Plan evidence and copy persistence; Git publication remains with its state machine.
export { settlePackagePublication, settlePlanPublicationRecording, settlePackageInPlace } from "./publication.ts";
// Named effect coordination derives its lock resources internally; callers perform external Git effects.
export {
    runExecutionPreparationTransition,
    runImplementationCheckpointTransition,
    listTransitionRecoveryRecords,
    reconcileTransitionRecoveryRecords,
} from "./transitions.ts";
export type { EffectProver, TransitionReconciliation } from "./transitions.ts";
export { PlanLockTimeoutError } from "../plan-store.ts";
export { StaleControllerWriteError, RegisteredPlanDocumentUnavailableError } from "./controllers.ts";

export {
    hasRetainedPublicationReceipt,
    retainPublicationCompletion,
    recordPublicationObservation,
    type RetainedPublicationCompletion,
} from "./publication-observations.ts";
export { readPlanRecordingContinuation, readEpicIntegrationReview, hasPlanDeliveryEvidence } from "./continuation.ts";
export { restoreNonGitPlanExecution, reconcilePlanExecutionBinding } from "./execution-recovery.ts";
export { recordPlanDeviation } from "./definition.ts";
export { preparePlanReviewDocument, capturePlanReviewInput } from "./review-snapshots.ts";
export { preparePlanInPlacePublication } from "./publication.ts";
export { readPlanPublicationReference } from "./recording.ts";
export { readRetainedExecutionPlan } from "./execution-recovery.ts";
export { findCompletionSiblings, prepareCompletionSiblings } from "./family.ts";

export {
    isPlanSessionArtifactReference,
    planSessionArtifactAlias,
    readPlanSessionArtifact,
    type RegisteredPlanSessionProject,
} from "./session-artifacts.ts";

export {
    archiveSavedPlan,
    restoreSavedPlan,
    archivedPlanProjectRoot,
    archiveEpicPlanFamily,
    type ArchivePlanOptions,
} from "./archiving.ts";

export { withPlanImplementationCompletion } from "./workflows.ts";

export {
    finalizePlanDecomposition,
    materializePlanChildren,
    type MaterializePlanChildrenOptions,
} from "./decomposition.ts";

export { recordPlanHumanReview, type PlanHumanReviewMetadata } from "./definition.ts";

export {
    readControllerWorktree as readPlanExecution,
    listControllerDocumentWorktrees as listPlanExecutionDocuments,
} from "./controllers.ts";

export { collectArchivedPlanUnits, type ArchivedPlanUnit } from "./archive-retention.ts";

export { recordPlanWorkRecord, type PlanRecordingSource } from "./recording.ts";

export { ensureArchivedPlanIdentity } from "./recording.ts";

export { savePlanProse, preparePlanRepairDraft } from "./documents.ts";

export {
    detachPlanExecution,
    resetPlanExecutionMetadata,
    refreshPlanExecutionReference,
    reopenPlanReview,
    restoreRecreatedPlanExecution,
} from "./recovery.ts";
export { runRecoveryTransition as runPlanRecoveryEffects, closeTransitionRecordByAttestation } from "./transitions.ts";

export { retainUserVerifiedPlan, clearPlanRecoveryAfterCleanup } from "./recovery.ts";

export { applyPlanReviewForExecution } from "./review.ts";

export { resolveRecoveryWorktree, type RecoveryWorktreeContext, type PlanRecoveryIdentity } from "./recovery-source.ts";

export {
    prepareTargetBranchPlansByParent,
    loadTargetPlan,
    loadPlanningTargetPlan,
    findTargetBranchPlan,
    inspectTargetBranchPlansByParent,
    findTargetBranchPlansByParent,
    readTargetBranchPlanCatalogByParent,
    withPlanningPlanIdentity,
    assertPlanningDocumentAvailable,
    bindPlanningDocument,
    installPlanningDocument,
    type LoadedPlan,
    type PlanningDocumentCopy,
} from "./planning-source.ts";

export { withPlanPublication, restartPlanValidation, preparePlanGeneratedArtifacts } from "./validation.ts";

export { loadPlanningTargetForPreparation } from "./planning-source.ts";

export {
    publicationCopiesForCheckout,
    retainedPublicationCopiesForCheckout,
    selectedPublicationCopies,
} from "./publication-copies.ts";
export type { PlanDeliveryBackup } from "./delivery-backup.ts";

export {
    mergePlanningDocumentBlobs,
    preparePlanningMergeDocuments,
    applyPlanningMergeDocuments,
    type PlanningMergeDocuments,
} from "./planning-merge.ts";

export { renamePlan } from "./names.ts";

export { PlanAccessMismatchError } from "./access.ts";

export {
    PreparedProjectStore,
    type ProjectStoreCommand,
    type ProjectStoreReply,
    type ProjectStoreDocument,
} from "./project-service.ts";

export { receiveManagedRuntimeTransfer, acknowledgeManagedRuntimeRetirement } from "./runtime-adoption.ts";

export {
    readOwnedWorkRecord,
    readOwnedWorkRecordById,
    listOwnedWorkRecords,
    searchOwnedWorkRecords,
} from "./recording.ts";

export { savePlanBodyById } from "./queries.ts";

export { archivePlan } from "./queries.ts";

export { readRetainedManagedExecution, type RetainedManagedExecution } from "./retained-managed-execution.ts";

export { settleRetainedExecutionCleanup } from "./managed.ts";

export { generateManagedRetainedRecord as generateRetainedPlanRecord } from "./managed.ts";

export type { PublishedDeliverySources } from "./published-source.ts";

export { settleRetainedExecutionRecording } from "./managed.ts";

export {
    sharePlanForReview,
    parsePlansShareArgs,
    runPlansShareCommand,
    type SharePlanForReviewOptions,
    type SharedPlanReviewLink,
} from "./collaboration/share.ts";
export {
    pushPlanRevision,
    parsePlansPushArgs,
    runPlansPushCommand,
    type PushPlanRevisionOptions,
    type PushedPlanRevision,
} from "./collaboration/push.ts";
export {
    pullPlanForRevision,
    parsePlansPullArgs,
    runPlansPullCommand,
    type PullPlanForRevisionOptions,
    type PulledPlanRevision,
    type RunPlansPullOptions,
} from "./collaboration/pull.ts";
export {
    unsharePlan,
    parsePlansUnshareArgs,
    runPlansUnshareCommand,
    type UnsharePlanOptions,
    type UnsharedPlan,
} from "./collaboration/unshare.ts";

export {
    inspectRetainedFamilyMember,
    type RetainedFamilyIdentity,
    type RetainedFamilyMember,
} from "./retained-family.ts";

export { ensurePlanIdentity } from "./queries.ts";

export { inspectManagedImportSource, type ManagedImportPreparationRequest } from "./import-source.ts";

export { archivePlansByStatus } from "./archiving.ts";

export * from "./retention-selection.ts";
export { previewPlanRetention, previewRecordRetention, confirmRetention } from "./retention.ts";

export { readExecutionRetention, type RetentionContext } from "./retention.ts";

export { pendingPruneRequest, confirmPruneRequest } from "./prune-requests.ts";

export {
    openProjectPlanStore,
    planDocumentsForCheckout,
    listSelectablePlanDocuments,
    openPlanStoreForCheckout,
} from "./project-plans.ts";
export { withPlanSubmission, type PlanSubmissionDocument, type PlanSubmissionOptions } from "./authoring.ts";
export {
    registeredWorkRecords,
    withWorkRecordReadScope,
    workRecordDisplayPath,
    workRecordsForCheckout,
} from "./work-record-readers.ts";
export { openRegisteredPlanDocuments } from "./registered-documents.ts";
export { editCheckoutPlanBody, readCheckoutPlanDisplayCatalog } from "./checkout-presentation.ts";
