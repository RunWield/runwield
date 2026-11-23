/** Pure Plan text, presentation and compatibility helpers; this interface performs no storage operations. */
export {
    OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS,
    canonicalizeStoredPlanName,
    canonicalPlanStatus,
    getDeclaredPlanStatus,
    isRunWieldVerifiedStatus,
    isUserVerifiedStatus,
    isPlanDependencySatisfiedStatus,
    isCompletedPlanStatus,
    normalizeExecutionAgent,
    normalizeCollaborationMode,
    resolvePlanExecutionPolicy,
    normalizeExecutionMode,
    normalizeDeliveryEvidence,
    injectFrontMatter,
    parsePlanFrontMatter,
    summarizePlanBody,
    planDocumentMarkdown,
    splitPlanMarkdownBody,
    mergeFrontMatterText,
    hashPlanBody,
    getPlanRevisionForText,
    getPlanFrontMatterRevisionForText,
    parsePlanTextStrict,
    comparePlansForList,
    isTerminalArchivableStatus,
    isRecoverableWorktreeStatus,
    compareChildPlansByOrder,
    isHiddenPlanName,
    resolveSiblingChildPlanDependencyStates,
    isChildFeaturePlan,
    isChildPlannedChangePlan,
    groupPlanHierarchy,
    countChildPlanProgress,
    PlanFrontMatterParseError,
    type ParsedPlanFrontMatter,
    type ParsePlanFrontMatterResult,
    type PlanExecutionPolicy,
    type PlanExecutionPolicyError,
    type PlanExecutionPolicySuccess,
    type PlanTextLoaded,
    type PlanTextMalformed,
    type SplitPlanBody,
} from "./format/implementation.ts";
export type {
    PlanFrontMatter,
    PlanFrontMatterInput,
    DeliveryEvidence,
    ExecutionMode,
    WorktreeDeliveryEvidence,
} from "./document.ts";
export {
    EPIC_MANUAL_QA_FILE_NAME,
    EPIC_INTEGRATION_REPORT_FILE_NAME,
    EPIC_ARTIFACT_FILE_NAMES,
    isEpicArtifactPlanName,
    isEpicArtifactPlanPath,
    assertNotReservedEpicArtifactPlanName,
    splitPlanName,
} from "./format/artifacts.ts";

export { isPlanId, normalizePlanId, type PlanId } from "./identity.ts";
export { PLANS_DIR_NAME, isPlannedChangeClassification, type PlanClassification } from "./classification.ts";
export {
    isEpicPlan,
    isProjectPlan,
    isSequencePlan,
    projectPlanType,
    type ProjectPlanMetadata,
    type ProjectPlanType,
} from "./project-plan.ts";
export { PLAN_FRONT_MATTER_KEY_ORDER, PLAN_FRONT_MATTER_KEYS } from "./format/front-matter.ts";
export {
    safeHttpTicketReferenceUrl,
    normalizeTicketReferences,
    dedupeTicketReferencesByUrl,
    type TicketReference,
} from "./format/ticket-references.ts";
export {
    appendPlanDeviation,
    formatPlanDeviationForPrompt,
    normalizePlanDeviations,
    readPlanDeviations,
    renderApprovedPlanDeviations,
    renderPlanDeviationsForWorkRecord,
    type PlanDeviation,
    type PlanDeviationProposal,
} from "./format/plan-deviations.ts";
export {
    COLLABORATION_FRONT_MATTER_KEYS,
    COLLABORATION_STATE_REMOTE_CANONICAL,
    normalizeCollaborationFrontMatter,
    normalizePlanServerUrl,
    normalizeServerUrl,
    type CollaborationFrontMatter,
} from "./format/collaboration.ts";
