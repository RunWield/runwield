/**
 * Plan storage operations. Persistence, source selection, locks and revisions
 * belong to this module; callers supply intent and observe returned revisions.
 */
export {
    operatePlanFile,
    isCanonicalPlanMarkdownPath,
    type PlanFileCommand,
    type PlanFileResult,
} from "./agent-files.ts";
export { authorLocalPlan, type PlanAuthoringInput, type PlanAuthoringDefinition } from "./access.ts";
export { readPlanDocuments, savePlanDocument, readPlanDocumentLink, saveReviewedPlanDocument } from "./documents.ts";
export { importPlans, importedPlanCopyChoice } from "./imports.ts";
export {
    loadPlan,
    loadPlanStrict,
    inspectPlanStrict,
    listPlans,
    listPlanDocuments,
    listPlanResources,
    readPlanResourceCatalog,
    findPlanById,
    findPlanEvidenceById,
    loadPlanBodyById,
    savePlanBodyById,
    findPlansByParent,
    resolvePlan,
    resolveSiblingChildPlanDependencies,
    saveChildFeaturePlans,
    archivePlan,
    archivePlansByStatus,
    listArchivedPlans,
    loadArchivedPlan,
    restoreArchivedPlan,
    deleteArchivedPlanUnit,
    ensurePlanIdentity,
    onboardExternalPlan,
    createPulledCollaborationPlan,
    updatePlanCollaborationMetadata,
    clearPlanCollaborationMetadata,
    StalePlanWriteError,
    StalePlanBodyError,
    PlanNotFoundError,
    PlanFileIssueError,
} from "../plan-store.js";
export type {
    ChildFeaturePlanDescriptor,
    DeliveryEvidence,
    ExecutionMode,
    PlanExecutionPolicy,
    PlanExecutionPolicyError,
    PlanExecutionPolicySuccess,
    PlanFrontMatter,
    PlanFrontMatterInput,
    PlanReadAvailability,
    PlanTextLoaded,
    PlanTextMalformed,
    PlanWriteOptions,
    SplitPlanBody,
    WorktreeDeliveryEvidence,
    PlanDocumentDiagnostic,
    SavedChildFeaturePlan,
} from "../plan-store.js";
export { authorPackageChildren } from "./children.ts";
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
} from "../shared/workflow/execution-plan-file.js";
export { requiresPlanWorkflow } from "./access.ts";
export { capturePackageWorkflowAccess as capturePlanReadContext } from "./workflows.ts";
export {
    resolveEpicArtifactPath,
    saveEpicArtifact,
    appendEpicManualQaSection,
    findEpicManualQaSection,
} from "./artifacts.ts";
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
    readPublishedRecordMarkdown,
    verifyPackageRecordingDelivery,
} from "./published-source.ts";
export type {
    DeliveryCopy,
    PackageAttemptContinuation,
    PackagePublicationManifest,
    PackagePublicationReference,
    PackageWorkflowInput,
} from "./packages.ts";

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

export { capturePlanExecutionContext, type PlanExecutionContext } from "./workflows.ts";

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
export { capturePlanAccess, selectPlanAccess, withPlanAccess, resumePlanAttempt, type PlanAccess } from "./handles.ts";
export type { TransitionResult } from "./transitions.ts";

export { loadReviewPlanDocument, isCurrentPlan, planControllerRoot } from "./resources.ts";
export {
    readPlanRecordingContext,
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
export {
    packagePublicationInput,
    sealPackagePublication,
    packageArtifactEvidence,
    uncommittedPackageCopyPaths,
    preparePackageCopies,
    settlePackagePublication,
    packageTargetEvidence,
    settlePackageInPlace,
    assertPackageCopyTargets,
    retirePackageCopies,
    assertPackagePublicationOwner,
    assertPackagePublicationCandidate,
} from "./publication.ts";
// Named effect coordination derives its lock resources internally; callers perform external Git effects.
export {
    runExecutionPreparationTransition,
    runImplementationCheckpointTransition,
    listTransitionRecoveryRecords,
    reconcileTransitionRecoveryRecords,
} from "./transitions.ts";
export type { EffectProver, TransitionReconciliation } from "./transitions.ts";
export { PlanLockTimeoutError } from "../plan-store.js";
export { StaleControllerWriteError, RegisteredPlanDocumentUnavailableError } from "./controllers.ts";

export {
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

export { planSessionArtifactReference, readPlanSessionArtifact } from "./session-artifacts.ts";

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
export { assertPackagePublicationReference as assertPlanPublicationReference } from "./packages.ts";

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
    finalizePublicationLifecycle,
    hasFinalizedPublicationLifecycle,
    checkLocalPublicationMetadata,
    readPublishedWorkRecordIndex,
} from "./delivery-copies.ts";

export {
    preserveUnpublishedPlanCopies,
    restoreUnpublishedPlanCopies,
    type PlanDeliveryBackup,
} from "./delivery-backup.ts";

export {
    mergePlanningDocumentBlobs,
    preparePlanningMergeDocuments,
    applyPlanningMergeDocuments,
    type PlanningMergeDocuments,
} from "./planning-merge.ts";

export { recoverLegacyPlanControllers } from "./runtime-recovery.ts";

export { renamePlan } from "./names.ts";

export { PlanAccessMismatchError } from "./access.ts";
