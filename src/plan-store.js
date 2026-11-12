/**
 * @typedef {"none"|"ask"|"always"|null} HumanReviewMode
 */
/**
 * @typedef {"not_required"|"skipped"|"approved"|"changes_requested"|null} HumanReviewDecision
 */
/**
 * @typedef {"worktree"|"non_git_in_place"|null} ExecutionMode
 */
/**
 * @typedef {Object} WorktreeDeliveryEvidence
 * @property {1} version
 * @property {"worktree_merge"} mode
 * @property {string} executionCommit
 * @property {string} targetBranch
 * @property {string} targetHeadBeforeMerge
 */
/**
 * @typedef {Object} NonGitDeliveryEvidence
 * @property {1} version
 * @property {"non_git_in_place"} mode
 */
/** @typedef {WorktreeDeliveryEvidence|NonGitDeliveryEvidence|null} DeliveryEvidence
 */
/**
 * @typedef {Object} PlanDocumentMetadata
 * @property {string} [title] - Explicit canonical display title; heading text remains editable prose.
 * @property {string} [planId] - Durable project-scoped resource identity for URL/addressable Plan lookup
 * @property {"QUICK_FIX"|"PLANNED_CHANGE"|"FEATURE"|"PROJECT"} classification
 * @property {"BUG_FIX"|"FEATURE"|"REFACTOR"|"MAINTENANCE"|"DOCUMENTATION"} [workKind] - Optional nature of planned executable work; legacy classification FEATURE does not imply this.
 * @property {string} [type] - PROJECT capability: epic (default) or sequence. Invalid values remain visible for correction.
 * @property {"LOW"|"MEDIUM"|"HIGH"} complexity
 * @property {string[]} affectedPaths - Files that will be created/modified
 * @property {import('./shared/ticket-references.ts').TicketReference[]} [tickets] - Optional provider-neutral Ticket References identified by the user.
 * @property {string[]} [supersedes] - Optional ordered Work Record IDs that this Plan is confirmed to replace.
 * @property {PlanDeviation[]} [planDeviations] - Ordered user-confirmed replacements to effective Plan requirements.
 * @property {unknown} [executionAgent] - Canonical FEATURE execution owner, preserved raw when invalid for diagnostics
 * @property {unknown} [collaborationRecommendation] - Planner's suggested execution style, preserved raw when invalid for diagnostics
 * @property {boolean} [frontend] - Legacy browser UI/UX marker retained for source compatibility
 * @property {string|null} [devServerCommand] - Project dev/preview command for browser verification, if known
 * @property {string|null} [devServerUrl] - Local URL expected for browser verification, if known
 * @property {boolean|null} [devServerHmr] - Whether the dev server is expected to support hot module reload
 * @property {string} createdAt - ISO timestamp
 * @property {string} [planId] - Durable project-scoped resource identity for Workspace URLs
 * @property {"draft"|"approved"|"ready_for_decomposition"|"ready_for_work"|"in_progress"|"failed"|"implemented"|"validated_ci"|"reviewed"|"validated"|"verified"|"user_verified"|"closed_without_verification"|"on_hold"} status
 * @property {"internal"|"external"} [origin] - "internal" = created by a RunWield agent; "external" = a pre-existing markdown file loaded from an arbitrary path and resumed with RunWield
 * @property {string} [parentPlan] - Canonical parent plan name for child FEATURE plans
 * @property {number} [order] - Epic child FEATURE execution order.
 * @property {string[]} [dependencies] - Sibling FEATURE plan identifiers that should be completed first
 * @property {string|null} [userVerifiedAt] - ISO timestamp when the user attested verification outside Workflow Validation
 * @property {string|null} [userVerificationNote] - Required note for user_verified terminal plans
 * @property {string|null} [closedWithoutVerificationReason] - Required reason for new manual closed_without_verification transitions
 * @property {string|null} [closedWithoutVerificationAt] - ISO timestamp when the Plan was manually closed without verification
 * @property {{ status?: "generated"|"failed", recordId?: string, path?: string, lastAttemptAt?: string, error?: string }} [workRecord] - Neutral backlink to canonical Work Record generation state
 * @property {"done_enough"|null} [epicCompletionMode] - Explicit Epic completion mode when an Epic is marked done enough for now
 * @property {string|null} [epicDoneEnoughAt] - ISO timestamp when an Epic was marked done enough for now
 * @property {string|null} [epicDoneEnoughSummary] - Human-readable summary captured when an Epic was marked done enough for now
 * @property {string|null} [epicDeliveryTargetBranch] - Final target of the reviewed Epic branch
 * @property {string|null} [epicBaseCommit] - Primary-branch commit the Epic branch was created from; the integration gate diffs from it
 * @property {string|null} [epicIntegrationReport] - Project-relative path of the latest failing Epic integration gate report
 * @property {string} [deliveryBranch] - Recorded landing branch, independent of setting changes
 * @property {string} [targetBranch] - User-selected target branch, independent of the current execution attempt
 * @property {string|null} [validatedCommit] - Validated implementation commit; durable after runtime cleanup
 * @property {"mechanical"|"semantic"|"delivery"} [validationPhase] - Current Workflow Validation phase while status stays "implemented"
 * @property {PlanFrontMatter["status"]|null} [heldFromStatus] - Status captured before the Plan moved to on_hold
 * @property {string|null} [heldAt] - ISO timestamp when the Plan was put on hold
 * @property {string|null} [holdReason] - Optional human reason for the hold
 * @property {string|null} [archivedAt] - ISO timestamp when the Plan was physically moved to docs/plans/archived/
 * @property {string|null} [archiveReason] - Optional human reason captured when the Plan was archived
 * @property {PlanFrontMatter["status"]|null} [archivedFromStatus] - Durable lifecycle status captured before archival
 * @property {string|null} [archivedFromPath] - Project-relative path the Plan occupied before archival
 * @property {string|null} [restoredAt] - ISO timestamp when the Plan was physically restored to active docs/plans/
 * @property {string|null} [restoredFromPath] - Project-relative archived path restored from
 */
/**
 * @typedef {Object} PlanPresentationFields
 * @property {string} summary - First paragraph of Context; not duplicated in Front Matter
 */
/**
 * Loaded metadata view. The legacy name is retained for callers; only
 * PlanDocumentMetadata is stored in Markdown. Runtime facts come from the controller.
 * @typedef {PlanDocumentMetadata & PlanPresentationFields & import('./shared/workflow/controller-state.ts').WorkflowControllerState & import('./shared/workflow/controller-state.ts').WorkflowWorktreeContext} PlanFrontMatter
 */
/** @typedef {Partial<PlanFrontMatter> & Record<string, unknown>} PlanFrontMatterInput */
/**
 * Descriptor for a draft child FEATURE plan produced by the Slicer.
 *
 * Repeated writes are deterministic: the child file path is derived from the
 * optional sequence number and title, and existing files at that path are
 * overwritten with the latest draft content.
 *
 * @typedef {Object} ChildFeaturePlanDescriptor
 * @property {string} title - Human-readable child plan title.
 * @property {string} summary - Brief child FEATURE summary.
 * @property {string[]} affectedPaths - Files that the child FEATURE expects to touch.
 * @property {"engineer"|"frontend-engineer"} [executionAgent] - Canonical child execution owner.
 * @property {"pair"|"autonomous"} [collaborationRecommendation] - Suggested execution style.
 * @property {boolean} [frontend] - Legacy child UI/UX marker; new child descriptors should use executionAgent.
 * @property {string|null} [devServerCommand] - Project dev/preview command for browser verification, if known.
 * @property {string|null} [devServerUrl] - Local URL expected for browser verification, if known.
 * @property {boolean|null} [devServerHmr] - Whether the dev server is expected to support hot module reload.
 * @property {string|null} [worktreeBaseBranch] - Target branch this child FEATURE should execute from and merge back into.
 * @property {string|null} [worktreeBaseCommit] - Recorded base commit for worktree recovery.
 * @property {string} [targetBranch] - User-selected target branch for this child.
 * @property {string[]} dependencies - Sibling child plan names or identifiers required first.
 * @property {import('./shared/ticket-references.ts').TicketReference[]} [tickets] - Direct child Ticket References; omitted preserves existing child references, [] clears.
 * @property {string} content - Planner-format markdown body for the child planned change.
 * @property {"BUG_FIX"|"FEATURE"|"REFACTOR"|"MAINTENANCE"|"DOCUMENTATION"} [workKind] - Optional child Work Kind.
 * @property {number} [order] - Optional execution order stored in front matter, independent of the file name.
 * @property {number} [sequence] - Deprecated alias for order.
 */
/**
 * @typedef {Object} SavedChildFeaturePlan
 * @property {string} name - Canonical nested plan name, e.g. `epic/01-child`.
 * @property {string} path - Absolute markdown path written.
 * @property {string} title - Human-readable child plan title.
 * @property {"created" | "updated"} action - Whether the derived file existed before this write.
 * @property {string[]} dependencies - Serialized child FEATURE dependencies.
 * @property {Partial<PlanFrontMatter> & { classification: "PLANNED_CHANGE", status: "draft", parentPlan: string, order?: number, affectedPaths: string[] }} metadata - Front matter values owned by child materialization.
 */
/**
 * @typedef {Object} PlanExecutionPolicy
 * @property {"engineer"|"frontend-engineer"} executionAgent
 * @property {"autonomous"|"pair"} collaborationRecommendation
 * @property {"canonical"|"legacy_frontend"|"legacy_frontend_false"|"absent"} source
 */
/**
 * @typedef {Object} PlanExecutionPolicyError
 * @property {false} ok
 * @property {string} error
 * @property {string} reason
 */
/**
 * @typedef {Object} PlanExecutionPolicySuccess
 * @property {true} ok
 * @property {PlanExecutionPolicy} policy
 */
/**
 * @typedef {Object} SplitPlanBody
 * @property {string} frontMatterBlock
 * @property {string} body
 */
/**
 * @typedef {Object} PlanTextLoaded
 * @property {"loaded"} kind
 * @property {string} path
 * @property {string} markdown
 * @property {PlanFrontMatter} attrs
 * @property {string} body
 * @property {string} revision
 * @property {string | undefined} frontMatterRevision
 * @property {boolean} hasFrontMatter
 * @property {number} controllerRevision
 * @property {PlanReadAvailability} [readAvailability]
 * @property {import("./plan-store/controllers.ts").PendingControllerRepair[]} [pendingControllerRepairs]
 */
/**
 * @typedef {Object} PlanTextMalformed
 * @property {"malformed"} kind
 * @property {string} path
 * @property {string} markdown
 * @property {string} revision
 * @property {PlanFrontMatterParseError} error
 */
import {
    canonicalizeStoredPlanName,
    DEFAULT_FRONT_MATTER,
    KNOWN_FRONT_MATTER_KEYS,
    HIDDEN_PLAN_DIRS,
    PLAN_STATUSES,
    getDeclaredPlanStatus,
    normalizeOptionalBoolean,
    resolvePlanExecutionPolicy,
    normalizePlanId,
    normalizeStringList,
    normalizeNonNegativeInteger,
    injectFrontMatter,
    parsePlanFrontMatter,
    planDocumentMarkdown,
    splitPlanMarkdownBody,
    mergeFrontMatterText,
    hashPlanBody,
    PlanFrontMatterParseError,
    getPlanRevisionForText,
    getPlanFrontMatterRevisionForText,
    parsePlanTextStrict,
    rememberFrontMatterRevision,
    comparePlansForList,
    isTerminalArchivableStatus,
    isRecoverableWorktreeStatus,
    compareChildPlansByOrder,
    isHiddenPlanName,
    stripSequencePrefix,
    resolveSiblingChildPlanDependencyStates,
    isChildFeaturePlan,
} from "./plan-format-implementation.ts";
export {
    canonicalizeStoredPlanName,
    OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS,
    canonicalPlanStatus,
    getDeclaredPlanStatus,
    isRunWieldVerifiedStatus,
    isUserVerifiedStatus,
    isPlanDependencySatisfiedStatus,
    isCompletedPlanStatus,
    normalizeExecutionAgent,
    normalizeCollaborationMode,
    resolvePlanExecutionPolicy,
    normalizePlanId,
    normalizeExecutionMode,
    normalizeDeliveryEvidence,
    injectFrontMatter,
    parsePlanFrontMatter,
    summarizePlanBody,
    planDocumentMarkdown,
    splitPlanMarkdownBody,
    mergeFrontMatterText,
    hashPlanBody,
    PlanFrontMatterParseError,
    getPlanRevisionForText,
    getPlanFrontMatterRevisionForText,
    parsePlanTextStrict,
    getKnownFrontMatterRevision,
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
} from "./plan-format-implementation.ts";
import { requiresPlanWorkflow } from "./plan-store/index.ts";
import { atomicWriteTextFile, atomicWriteTextFileIfAbsent, syncDirectory } from "./shared/atomic-text-file.ts";
import {
    readLocalHomeStore,
    missingHomePlan,
    saveLocalHomePlan,
    withLocalPlanWorkflow,
    inspectLocalHomeStore,
    withLocalProjectAction,
} from "./plan-store/access.ts";
import {
    archivePlanPackage,
    restorePlanPackage,
    renamePlanPackage,
    listPlanPackages,
    readPlanPackage,
    savePlanPackageDocument,
} from "./plan-store/packages.ts";
import {
    currentPackageProject,
    selectedPackage,
    loadPackageWorkflowPlan,
    packageWorkflowLocks,
    updatePackageWorkflowMetadata,
} from "./plan-store/workflows.ts";
import { hasApplicablePublicationReceipt } from "./shared/workflow/publication-receipt.ts";
import fs from "node:fs/promises";
import { openNativeFileLock } from "./shared/native-file-lock.ts";
import {
    lstat as fsLstat,
    mkdir as fsMkdir,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
} from "node:fs/promises";
import { pid, platform } from "node:process";
import { isProjectPlan } from "./shared/project-plan.ts";
export { isEpicPlan, isProjectPlan, isSequencePlan } from "./shared/project-plan.ts";
/**
 * @module plan-store
 * Manages plan persistence: front matter injection, save/load/list, and
 * resumption of saved or external plans.
 *
 * Owner-private compatibility implementation, consumed through plan-store/index.ts.
 * Local/manual-SSH Plans use home packages with stable opaque IDs. Legacy checkout
 * files are explicit import/retained-execution sources or delivery copies; names are not IDs.
 * External plans (missing front matter) get sensible defaults applied.
 */

import { extractYaml, test as hasFrontMatter } from "./shared/front-matter.ts";
import { readLockFileSnapshot, removeLockFileIfSnapshotMatches } from "./shared/lock-file-snapshot.ts";
import { getLockHostname, isLockHolderGone } from "./shared/process-liveness.ts";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { CLI_BIN, normalizeWorkKind, PLANS_DIR_NAME, ROUTING_INTENT_PLANNED_CHANGE } from "./constants.js";

import { normalizeTicketReferences } from "./shared/ticket-references.ts";

import { resolveWorkflowPlanLocation } from "./plan-store/location.ts";
import {
    findTargetBranchPlansByParent,
    readTargetBranchPlanCatalogByParent,
    loadTargetPlan,
    TargetBranchSnapshotUnavailableError,
} from "./shared/workflow/planning-worktree.ts";
import { probeGitRepository } from "./shared/git.ts";
import { prepareWorktreeRegistry, renameRestoredPlanEntry } from "./shared/worktree-registry.js";
import { resolvePrimaryCheckoutRoot } from "./shared/primary-checkout.ts";
import { writePlanDocumentAndController } from "./plan-store/transitions.ts";

import { requestWorkspaceSearchRefresh } from "./shared/workspace-search-refresh.ts";
import { pickControllerState, stripRuntimeFields } from "./shared/workflow/controller-state.ts";
import {
    enterProjectRuntime,
    inspectProjectRuntimeReadAccess,
    ProjectRuntimeReadPendingError,
    WORKFLOW_DETAILS_PENDING,
    ProjectRuntimeEntryRefusedError,
    withProjectRuntimeReadScope,
} from "./shared/project-runtime-layout.ts";
import {
    assertControllerDocumentAvailable,
    bindControllerPlanIdentity,
    finishControllerPlanIdentity,
    inspectControllerView,
    listControllerDocumentWorktrees,
    prepareControllerView,
    writeControllerState,
} from "./plan-store/controllers.ts";
import {
    assertSharedPlanWriteAllowed,
    COLLABORATION_FRONT_MATTER_KEYS,
    COLLABORATION_LOCK_BYPASS,
    COLLABORATION_STATE_REMOTE_CANONICAL,
    normalizeCollaborationFrontMatter,
} from "./shared/collaboration/lock.ts";
import { moveEpicArtifactsFromArchive, moveEpicArtifactsToArchive } from "./plan-store/artifacts.ts";
import { assertNotReservedEpicArtifactPlanName, isEpicArtifactPlanName } from "./plan-format.ts";

/** @typedef {import("./plan-store/artifacts.ts").MoveEpicArtifactResult} MoveEpicArtifactResult */
/** @typedef {import("./shared/plan-deviations.ts").PlanDeviation} PlanDeviation */
/** @typedef {import("./shared/worktree-registry.js").WorktreeRegistryEntry} WorktreeRegistryEntry */

export { PLAN_FRONT_MATTER_KEY_ORDER, PLAN_FRONT_MATTER_KEYS } from "./plan-front-matter.ts";

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Get the plans directory path for the current project.
 * @param {string} cwd - Project root
 * @returns {string}
 */
export function getPlansDir(cwd) {
    return join(cwd, PLANS_DIR_NAME);
}

/**
 * Ensure the plans directory exists.
 * @param {string} cwd
 * @returns {Promise<string>} The plans directory path
 */
export async function ensurePlansDir(cwd) {
    const dir = getPlansDir(cwd);
    try {
        await fsMkdir(dir, { recursive: true });
    } catch {
        // already exists, fine
    }
    return dir;
}

/**
 * @param {string} cwd
 * @param {string} planName
 * @returns {{ name: string, segments: string[], filePath: string }}
 */
function getStoredPlanLocation(cwd, planName) {
    const { name, segments } = canonicalizeStoredPlanName(planName);
    return { name, segments, filePath: join(getPlansDir(cwd), ...segments) + ".md" };
}

/**
 * Resolve the canonical stored path for a Project Plan without reading it.
 *
 * @param {string} cwd
 * @param {string} planName
 * @returns {string}
 */
export function getStoredPlanPath(cwd, planName) {
    return getStoredPlanLocation(cwd, planName).filePath;
}

/**
 * @param {Record<string, unknown>} attrs
 * @returns {Partial<PlanFrontMatter>}
 */
function pickKnownPlanFrontMatter(attrs) {
    /** @type {Partial<PlanFrontMatter>} */
    const picked = {};
    const pickedRecord = /** @type {Record<string, unknown>} */ (picked);
    for (const key of KNOWN_FRONT_MATTER_KEYS) {
        if (Object.hasOwn(attrs, key)) {
            pickedRecord[key] = attrs[key];
        }
    }
    return picked;
}

/** @param {string} filePath */
function planControllerLocation(filePath) {
    const path = resolve(filePath).replaceAll("\\", "/");
    const marker = `/${PLANS_DIR_NAME}/`;
    const split = path.lastIndexOf(marker);
    if (split < 0) return null;
    return { cwd: path.slice(0, split), planName: path.slice(split + marker.length).replace(/\.md$/, "") };
}

/** Directory that owns the selected document and its lock. @param {string} filePath */
export function getPlanDocumentRoot(filePath) {
    const owner = currentPackageProject();
    if (owner) {
        const root = join(owner.executionAccountHome, ".wld", "projects", owner.projectId, "plans");
        const child = relative(root, resolve(filePath));
        if (child && !child.startsWith("../") && child !== ".." && !isAbsolute(child)) return owner.checkoutRoot;
    }
    if (/^[^:]+:docs\/plans\//.test(filePath)) {
        throw new Error(`Published Plan snapshot is not a writable document path: ${filePath}`);
    }
    const location = planControllerLocation(filePath);
    if (!location) throw new Error(`Not a stored Plan path: ${filePath}`);
    return location.cwd;
}

/**
 * Read availability is transport metadata, never Plan Front Matter.
 * @typedef {Object} PlanReadAvailability
 * @property {"ready" | "pending"} kind
 * @property {string} [message]
 */

/** @returns {PlanReadAvailability} */
function pendingPlanReadAvailability() {
    return { kind: "pending", message: WORKFLOW_DETAILS_PENDING };
}

/** @param {PlanFrontMatter} attrs @param {import("./plan-store/controllers.ts").PendingControllerRepair[]} [pendingControllerRepairs] */
function pendingControllerMetadata(attrs, pendingControllerRepairs = []) {
    return {
        attrs: effectivePlanLifecycleAttrs(attrs, {}),
        controllerRevision: 0,
        readAvailability: pendingPlanReadAvailability(),
        pendingControllerRepairs,
    };
}

/** @param {string} filePath @param {PlanFrontMatter} attrs */
async function withControllerMetadata(filePath, attrs) {
    const location = planControllerLocation(filePath);
    if (!location) return pendingControllerMetadata(attrs);
    try {
        const view = await inspectControllerView(
            location.cwd,
            { planId: attrs.planId, planName: location.planName },
            attrs,
        );
        /** @type {PlanReadAvailability} */
        const readAvailability =
            attrs.planId && !view.pendingRepairs.length ? { kind: "ready" } : pendingPlanReadAvailability();
        return {
            attrs: effectivePlanLifecycleAttrs(attrs, view.state, view.publicationConfirmed),
            controllerRevision: view.revision,
            readAvailability,
            pendingControllerRepairs: view.pendingRepairs,
        };
    } catch (error) {
        if (error instanceof ProjectRuntimeReadPendingError) return pendingControllerMetadata(attrs);
        throw error;
    }
}

/** Explicit write preparation must not use a pending read projection for guards.
 * @param {string} filePath
 * @param {PlanFrontMatter} attrs
 */
async function prepareControllerMetadata(filePath, attrs) {
    const location = planControllerLocation(filePath);
    if (!location) throw new Error(`Not a stored Plan path: ${filePath}`);
    const view = await prepareControllerView(
        location.cwd,
        { planId: attrs.planId, planName: location.planName },
        attrs,
    );
    return {
        attrs: effectivePlanLifecycleAttrs(attrs, view.state, view.publicationConfirmed),
        controllerRevision: view.revision,
    };
}

/** @param {string} filePath */
async function preparePlanFileStrict(filePath) {
    const parsed = await loadPlanFileStrict(filePath, true);
    if (parsed.kind !== "loaded") return parsed;
    return { ...parsed, ...(await prepareControllerMetadata(filePath, parsed.attrs)) };
}

/** @param {string} cwd @param {string} planName */
async function prepareStoredPlan(cwd, planName) {
    const plan = await loadPlan(cwd, planName);
    if (!plan) return null;
    return { ...plan, ...(await prepareControllerMetadata(plan.path, parsePlanFrontMatter(plan.markdown).attrs)) };
}

/**
 * Project only durable local controller evidence. Publication verification and
 * receipt invalidation belong to the lifecycle owner, not readers.
 * @param {PlanFrontMatter} attrs
 * @param {import('./shared/workflow/controller-state.ts').WorkflowControllerState & import('./shared/workflow/controller-state.ts').WorkflowWorktreeContext} state
 * @param {boolean} [publicationConfirmed]
 * @returns {PlanFrontMatter}
 */
function effectivePlanLifecycleAttrs(attrs, state, publicationConfirmed = false) {
    const combined = { ...stripRuntimeFields(attrs), ...state };
    if (
        (publicationConfirmed || hasApplicablePublicationReceipt(combined)) &&
        !["on_hold", "user_verified", "closed_without_verification"].includes(combined.status)
    ) {
        combined.status = "verified";
    } else if (combined.status === "validated") {
        const delivered = Boolean(
            combined.deliveryEvidence?.mode === "non_git_in_place" ||
            (combined.verifiedAt &&
                !combined.worktreeId &&
                (!combined.publicationReceipt || hasApplicablePublicationReceipt(combined))),
        );
        combined.status = delivered
            ? "verified"
            : isProjectPlan(combined) && combined.epicCompletionMode === "done_enough"
              ? "closed_without_verification"
              : "reviewed";
    }
    if (combined.status === "validated_ci") {
        combined.status = "implemented";
        combined.validationPhase = "semantic";
    }
    return combined;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

export class StalePlanWriteError extends Error {
    /**
     * @param {string} expectedRevision
     * @param {string} currentRevision
     */
    constructor(expectedRevision, currentRevision) {
        super("Plan changed on disk after this operation loaded it.");
        this.name = "StalePlanWriteError";
        this.expectedRevision = expectedRevision;
        this.currentRevision = currentRevision;
    }
}

export class PlanFileIssueError extends Error {
    /**
     * @param {string} path
     * @param {string} kind
     * @param {string} message
     */
    constructor(path, kind, message) {
        super(message);
        this.name = "PlanFileIssueError";
        this.path = path;
        this.kind = kind;
    }
}

/** @param {string} value */
function lockSafeSegment(value) {
    return (
        String(value || "plan")
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "plan"
    );
}

const PLAN_LOCK_WAIT_TIMEOUT_MS = 5 * 60_000;
const PLAN_LOCK_HEARTBEAT_MS = 10_000;
const PLAN_LOCK_ABANDONED_MS = 3 * PLAN_LOCK_HEARTBEAT_MS;

export class PlanLockTimeoutError extends Error {
    /** @param {string} lockPath */
    constructor(lockPath) {
        super(`Timed out waiting for the Plan lock at ${lockPath}.`);
        this.name = "PlanLockTimeoutError";
    }
}

/** @param {string} lockPath */
async function acquireSimpleLock(lockPath) {
    await fsMkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + PLAN_LOCK_WAIT_TIMEOUT_MS;
    const token = crypto.randomUUID();
    while (true) {
        try {
            const file = openNativeFileLock(lockPath, "exclusive");
            try {
                file.lockSync(true);
                const writeHeartbeat = () => {
                    // Hostname scopes the pid to this machine; stale recovery still
                    // requires the real OS lock and matching ownership evidence.
                    file.replaceTextSync(
                        JSON.stringify({
                            token,
                            pid,
                            hostname: getLockHostname(),
                            updatedAtMs: Date.now(),
                        }),
                    );
                };
                await writeHeartbeat();
                let heartbeatWrite = Promise.resolve();
                const heartbeat = setInterval(() => {
                    heartbeatWrite = heartbeatWrite.then(writeHeartbeat).catch(() => {});
                }, PLAN_LOCK_HEARTBEAT_MS);
                return async () => {
                    clearInterval(heartbeat);
                    // A heartbeat already in flight can leave truncated bytes if
                    // release closes its descriptor between truncate and write.
                    await heartbeatWrite;
                    file.close();
                    const snapshot = await readLockFileSnapshot(lockPath);
                    if (snapshot?.token !== token) return;
                    await removeLockFileIfSnapshotMatches(lockPath, snapshot);
                };
            } catch (setupError) {
                file.close();
                throw setupError;
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            let snapshot;
            try {
                snapshot = await readLockFileSnapshot(lockPath);
            } catch (readError) {
                if (!(
                    platform === "win32" &&
                    readError instanceof Error &&
                    "code" in readError &&
                    readError.code === "EBUSY"
                )) {
                    throw readError;
                }
                if (Date.now() > deadline) throw new PlanLockTimeoutError(lockPath);
                await new Promise((resolve) => setTimeout(resolve, 50));
                continue;
            }
            if (!snapshot) continue;
            // Deliberately no same-process shortcut here. Re-entrancy is handled by
            // the AsyncLocalStorage guard in withProcessAwarePlanLock, which knows
            // whether *this* call chain already holds the lock. Treating any lock
            // written by this pid as already-held would let two concurrent tasks in
            // one process both proceed, which is the mutual exclusion this lock
            // exists to provide.
            //
            // A dead holder is reclaimed at once. Age alone cannot tell a crash from
            // legitimate work, so waiting it out made a killed process block every
            // operation on this Plan for the whole stale window — RunWield's own
            // bookkeeping locking the user out of their Plan.
            // A long-lived Workspace process can abandon a file without exiting.
            // Age only permits an ownership check: removal must still acquire the
            // OS lock and match the snapshot, so a paused live holder stays safe.
            // Windows removal cannot retain that OS lock across unlink.
            const abandoned =
                platform !== "win32" &&
                Date.now() - Math.max(snapshot.mtime, snapshot.updatedAt || 0) > PLAN_LOCK_ABANDONED_MS;
            const stale = abandoned || (await isLockHolderGone(snapshot.text));
            if (stale && (await removeLockFileIfSnapshotMatches(lockPath, snapshot))) {
                continue;
            }
            if (Date.now() > deadline) {
                throw new PlanLockTimeoutError(lockPath);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}

/** @type {AsyncLocalStorage<Set<string>>} */
const ACTIVE_PROCESS_PLAN_LOCKS = new AsyncLocalStorage();

/**
 * @template T
 * @param {string} key
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withProcessAwarePlanLock(key, lockPath, fn) {
    const activeLocks = ACTIVE_PROCESS_PLAN_LOCKS.getStore();
    if (activeLocks?.has(key)) return await fn();
    const release = await acquireSimpleLock(lockPath);
    const nestedLocks = new Set(activeLocks || []);
    nestedLocks.add(key);
    try {
        return await ACTIVE_PROCESS_PLAN_LOCKS.run(nestedLocks, fn);
    } finally {
        await release();
    }
}

/**
 * @template T
 * @param {string} cwd
 * @param {string} planName
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPlanLock(cwd, planName, fn) {
    if (currentPackageProject() && !planName.startsWith("__")) return await packageWorkflowLocks([planName], fn);
    const layout = await enterProjectRuntime(cwd);
    const key = resolve(layout.selected.planLocksDir, `${lockSafeSegment(planName)}.lock`);
    return await withProcessAwarePlanLock(
        key,
        join(layout.selected.planLocksDir, `${lockSafeSegment(planName)}.lock`),
        fn,
    );
}

/**
 * @template T
 * @param {string} cwd
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPlanCatalogLock(cwd, fn) {
    if (currentPackageProject()) return await packageWorkflowLocks([], fn);
    const layout = await enterProjectRuntime(cwd);
    const key = resolve(layout.selected.planCatalogLockPath);
    return await withProcessAwarePlanLock(key, layout.selected.planCatalogLockPath, fn);
}

/** Read one Plan document without controller imports or writes.
 * @param {string} filePath
 */
export async function inspectPlanFileStrict(filePath) {
    const result = await loadPlanFileStrict(filePath);
    return result.kind === "loaded"
        ? { ...result, pendingControllerRepairs: result.pendingControllerRepairs || [] }
        : result;
}

/**
 * Join strict document bytes with checked local controller evidence, without writes.
 * @param {string} markdown
 * @param {string} filePath
 * @param {string} [controllerPath] - Local document location for a Git snapshot.
 * @returns {Promise<PlanTextLoaded | PlanTextMalformed>}
 */
export async function inspectPlanTextStrict(markdown, filePath, controllerPath = filePath) {
    const parsed = await parsePlanTextStrict(markdown, filePath);
    if (parsed.kind !== "loaded") return parsed;
    return { ...parsed, ...(await withControllerMetadata(controllerPath, parsed.attrs)) };
}

/**
 * @param {string} filePath
 * @param {boolean} [documentOnly]
 * @returns {Promise<PlanTextLoaded | PlanTextMalformed | { kind: "not_found", path: string } | { kind: "not_file", path: string, message: string } | { kind: "unreadable", path: string, error: Error }>}
 */
export async function loadPlanFileStrict(filePath, documentOnly = false) {
    const owner = currentPackageProject();
    if (owner) {
        const catalog = await listPlanPackages(owner, true);
        const selected = catalog.packages.find((plan) => resolve(join(plan.path, "context.md")) === resolve(filePath));
        if (selected) return await loadPackageWorkflowPlan({ planId: selected.metadata.planId });
    }
    let stat;
    try {
        stat = await fsLstat(filePath);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { kind: "not_found", path: filePath };
        }
        return { kind: "unreadable", path: filePath, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!stat.isFile()) {
        return { kind: "not_file", path: filePath, message: `Plan path is not a regular file: ${filePath}` };
    }
    try {
        const markdown = await fsReadFile(filePath, "utf8");
        return documentOnly
            ? await parsePlanTextStrict(markdown, filePath)
            : await inspectPlanTextStrict(markdown, filePath);
    } catch (error) {
        if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
        return { kind: "unreadable", path: filePath, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

/** @param {unknown} result */
function planIssueMessage(result) {
    const issue = /** @type {{ message?: string, error?: Error, path?: string }} */ (result || {});
    return issue.message || issue.error?.message || issue.path || "Plan file issue";
}

/**
 * Load a plan with typed fail-closed outcomes.
 * @param {string} cwd
 * @param {string} planName
 * @returns {Promise<Awaited<ReturnType<typeof loadPlanFileStrict>>>}
 */
export async function loadPlanStrict(cwd, planName) {
    return await readLocalHomeStore(
        cwd,
        () => loadPlanStrictInProject(cwd, planName),
        () => missingHomePlan(getStoredPlanPath(cwd, planName)),
    );
}

/**
 * @param {string} cwd
 * @param {string} planName
 * @returns {ReturnType<typeof loadPlanStrict>}
 */
async function loadPlanStrictInProject(cwd, planName) {
    const project = currentPackageProject();
    if (project) {
        const plan = await readPlanPackage(project, { name: planName });
        if (
            plan.kind === "missing" ||
            (plan.kind === "loaded" && plan.metadata.archive && !plan.metadata.archive.restoredAt)
        )
            return missingHomePlan(plan.path);
        if (plan.kind !== "loaded") throw new Error(plan.message);
        return await loadPackageWorkflowPlan({ planId: plan.metadata.planId });
    }
    const { name, filePath } = getStoredPlanLocation(cwd, planName);
    if (isEpicArtifactPlanName(name)) return { kind: "not_found", path: filePath };
    return await loadPlanFileStrict(filePath);
}

/** Read raw Plan facts without controller imports or cleanup.
 * @param {string} cwd
 * @param {string} planName
 */
export async function inspectPlanStrict(cwd, planName) {
    return await readLocalHomeStore(
        cwd,
        () => inspectPlanStrictInProject(cwd, planName),
        () => missingHomePlan(getStoredPlanPath(cwd, planName)),
    );
}

/**
 * @param {string} cwd
 * @param {string} planName
 * @returns {ReturnType<typeof loadPlanStrict>}
 */
async function inspectPlanStrictInProject(cwd, planName) {
    const project = currentPackageProject();
    if (project) {
        const plan = await readPlanPackage(project, { name: planName });
        if (
            plan.kind === "missing" ||
            (plan.kind === "loaded" && plan.metadata.archive && !plan.metadata.archive.restoredAt)
        )
            return missingHomePlan(plan.path);
        if (plan.kind !== "loaded") throw new Error(plan.message);
        return await loadPackageWorkflowPlan({ planId: plan.metadata.planId });
    }
    const { name, filePath } = getStoredPlanLocation(cwd, planName);
    if (isEpicArtifactPlanName(name)) return { kind: "not_found", path: filePath };
    return await inspectPlanFileStrict(filePath);
}

/** @param {string} filePath */
function workspaceSearchRootForPlanPath(filePath) {
    const normalizedPath = resolve(filePath).replaceAll("\\", "/");
    const marker = `/${PLANS_DIR_NAME}/`;
    const markerIndex = normalizedPath.lastIndexOf(marker);
    if (markerIndex < 0) return null;
    return resolvePrimaryCheckoutRoot(normalizedPath.slice(0, markerIndex));
}

/**
 * Atomically replace an existing Plan after verifying its byte revision.
 * @param {string} filePath
 * @param {string} nextMarkdown
 * @param {string|undefined} expectedRevision
 * @returns {Promise<string>}
 */
export async function writePlanMarkdownWithRevision(filePath, nextMarkdown, expectedRevision) {
    if (expectedRevision !== undefined) {
        const current = await loadPlanFileStrict(filePath);
        if (current.kind !== "loaded") {
            if (current.kind === "malformed") throw current.error;
            throw new Error(
                current.kind === "not_found"
                    ? `Plan not found: ${filePath}`
                    : planIssueMessage(current) || `Plan is not writable: ${filePath}`,
            );
        }
        if (current.revision !== expectedRevision) {
            throw new StalePlanWriteError(expectedRevision, current.revision);
        }
    }
    nextMarkdown = planDocumentMarkdown(nextMarkdown);
    await atomicWriteTextFile(filePath, nextMarkdown);
    const revision = await getPlanRevisionForText(nextMarkdown);
    const frontMatterRevision = await getPlanFrontMatterRevisionForText(nextMarkdown);
    recordPlanWriteRevision(filePath, revision, frontMatterRevision);
    rememberFrontMatterRevision(revision, frontMatterRevision);
    const searchRoot = workspaceSearchRootForPlanPath(filePath);
    if (searchRoot) await requestWorkspaceSearchRefresh(searchRoot);
    return revision;
}

/**
 * Revisions this process wrote, keyed by Plan path.
 *
 * Every RunWield-owned Plan write funnels through
 * `writePlanMarkdownWithRevision`, so this is a complete record of what RunWield
 * itself put on disk. It lets a failed transaction tell its own partial write
 * apart from an unmanaged external edit: if the file still holds exactly the
 * bytes RunWield last wrote, restoring the pre-transaction bytes cannot destroy
 * anyone else's work. Anything else stays fail-closed.
 *
 * Deliberately in-process and non-durable. After a crash the map is empty, so no
 * restore is attempted and recovery goes through the journal instead.
 *
 * The Front Matter revision is recorded alongside the whole-file one because the
 * two answer different questions. Whole-file authorship proves nothing was
 * touched at all; Front Matter authorship proves RunWield still owns the half it
 * is allowed to rewrite, which is what lets a failed transition undo its own
 * metadata on top of a body the user edited meanwhile.
 *
 * @type {Map<string, { revision: string, frontMatterRevision?: string }>}
 */
const planWriteRevisions = new Map();

/** Bound the map so a long-lived Workspace server cannot grow it without limit. */
const PLAN_WRITE_REVISION_LIMIT = 512;

/** @param {string} filePath @param {string} revision @param {string} [frontMatterRevision] */
function recordPlanWriteRevision(filePath, revision, frontMatterRevision) {
    planWriteRevisions.delete(filePath);
    planWriteRevisions.set(filePath, { revision, frontMatterRevision });
    while (planWriteRevisions.size > PLAN_WRITE_REVISION_LIMIT) {
        const oldest = planWriteRevisions.keys().next();
        if (oldest.done) break;
        planWriteRevisions.delete(oldest.value);
    }
}

/**
 * The revision RunWield last wrote to this Plan path in this process, if any.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function getRecordedPlanWriteRevision(filePath) {
    return planWriteRevisions.get(filePath)?.revision;
}

/**
 * The Front Matter revision RunWield last wrote to this Plan path, if any.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function getRecordedPlanWriteFrontMatterRevision(filePath) {
    return planWriteRevisions.get(filePath)?.frontMatterRevision;
}

/**
 * Run a revision-checked Plan markdown write while holding the canonical Plan lock.
 * Use this for Agent structured file edits that edit Plan markdown directly.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {string} filePath
 * @param {string} nextMarkdown
 * @param {string|undefined} expectedRevision
 * @returns {Promise<string>}
 */
export async function writePlanMarkdownWithRevisionLocked(cwd, planName, filePath, nextMarkdown, expectedRevision) {
    return await readLocalHomeStore(
        cwd,
        async () => {
            const project = currentPackageProject();
            if (project) {
                return await packageWorkflowLocks([planName], async () => {
                    const current = await loadPackageWorkflowPlan(planName);
                    if (resolve(filePath) !== resolve(current.path))
                        throw new Error("Plan path does not match its canonical owner.");
                    if (expectedRevision !== undefined && current.revision !== expectedRevision)
                        throw new StalePlanWriteError(expectedRevision, current.revision);
                    const plan = await selectedPackage(planName);
                    const context = plan.documents.find((document) => document.name === "context.md");
                    if (!context) throw new Error("Canonical Plan context is missing.");
                    await savePlanPackageDocument(
                        project,
                        plan.metadata.planId,
                        "context.md",
                        context.hash,
                        nextMarkdown,
                    );
                    return (await loadPackageWorkflowPlan(planName)).revision;
                });
            }
            return await withPlanLock(
                cwd,
                planName,
                async () => await writePlanMarkdownWithRevision(filePath, nextMarkdown, expectedRevision),
            );
        },
        () => {
            throw new Error(`Plan not found: ${planName}`);
        },
    );
}

export class StalePlanBodyError extends Error {
    /**
     * @param {string} expectedBodyHash
     * @param {string} currentBodyHash
     */
    constructor(expectedBodyHash, currentBodyHash) {
        super("Plan body changed on disk after this editor loaded.");
        this.name = "StalePlanBodyError";
        this.expectedBodyHash = expectedBodyHash;
        this.currentBodyHash = currentBodyHash;
    }
}

/**
 * @typedef {Object} PlanWriteOptions
 * @property {symbol} [collaborationLockBypass]
 * @property {string} [expectedRevision]
 * @property {number} [expectedControllerRevision]
 * @property {Record<string, string>} [expectedRevisions]
 * @property {(result: SavedChildFeaturePlan) => Promise<void>|void} [onChildPlanWritten]
 */

/**
 * @param {string} markdown
 * @returns {string | undefined}
 */
function leadingFrontMatterCandidate(markdown) {
    const lines = markdown.split(/\r?\n/);
    if (lines[0] !== "---") return undefined;
    const bodyStart = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    return lines.slice(1, bodyStart === -1 ? lines.length : bodyStart).join("\n");
}

/**
 * @param {string} markdown
 * @returns {boolean}
 */
function hasRemoteCanonicalCollaborationMarker(markdown) {
    const frontMatter = leadingFrontMatterCandidate(markdown);
    if (frontMatter === undefined) return false;
    return frontMatter
        .split("\n")
        .some((line) => /^\s*["']?collaborationState["']?\s*:\s*["']?remote_canonical["']?(?:\s+#.*)?\s*$/.test(line));
}

/**
 * @param {string} markdown
 * @param {PlanWriteOptions} [options]
 */
function assertPlanMarkdownWriteAllowed(markdown, options = {}) {
    try {
        const { attrs } = parsePlanFrontMatter(markdown);
        assertSharedPlanWriteAllowed(attrs, options);
    } catch (error) {
        if (error instanceof Error && error.name === "SharedPlanLockError") throw error;
        if (hasRemoteCanonicalCollaborationMarker(markdown)) {
            assertSharedPlanWriteAllowed({ collaborationState: COLLABORATION_STATE_REMOTE_CANONICAL }, options);
        }
    }
}

// ─── Save / Load / List ──────────────────────────────────────────────

/**
 * Convert a title into a filesystem-safe plan-name segment.
 * @param {string} title
 * @returns {string}
 */
function slugifyPlanTitle(title) {
    return String(title || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * @param {unknown} child
 * @returns {ChildFeaturePlanDescriptor}
 */
function validateChildFeaturePlanDescriptor(child) {
    if (!child || typeof child !== "object") {
        throw new Error("Child plan descriptor must be an object");
    }

    const descriptor = /** @type {Partial<ChildFeaturePlanDescriptor>} */ (child);
    if (typeof descriptor.title !== "string") throw new Error("Child plan title must be a string");
    if (typeof descriptor.summary !== "string") throw new Error("Child plan summary must be a string");
    if (!Array.isArray(descriptor.affectedPaths)) throw new Error("Child plan affectedPaths must be an array");
    if (!Array.isArray(descriptor.dependencies)) throw new Error("Child plan dependencies must be an array");
    if (typeof descriptor.content !== "string") throw new Error("Child plan content must be a string");

    const rawOrder = Object.hasOwn(descriptor, "order") ? descriptor.order : descriptor.sequence;
    const order = normalizeNonNegativeInteger(rawOrder);
    if (rawOrder !== undefined && order === undefined) {
        throw new Error(`Child plan order must be a non-negative integer: ${rawOrder}`);
    }
    descriptor.order = order;
    if (Object.hasOwn(descriptor, "tickets")) {
        descriptor.tickets = normalizeTicketReferences(descriptor.tickets) || [];
    }

    return /** @type {ChildFeaturePlanDescriptor} */ (descriptor);
}

/**
 * Resolve child names before writes so materialization and finalization lock the same files.
 * Exact descriptive names take precedence; unique legacy numbered names keep their identity.
 *
 * @param {string} cwd
 * @param {string} epicPlanName
 * @param {ChildFeaturePlanDescriptor[]} children
 * @returns {Promise<string[]>}
 */
export async function resolveChildPlanNames(cwd, epicPlanName, children) {
    const { name: parent, segments } = canonicalizeStoredPlanName(epicPlanName);
    if (segments.length !== 1) {
        throw new Error(`Parent Epic plan name must be a top-level plan: ${epicPlanName}`);
    }
    if (!Array.isArray(children)) throw new Error("Child plans must be an array");
    const existing = await listPlans(cwd);
    const names = new Set(existing.map((plan) => plan.name));
    const seen = new Set();
    return children.map((rawChild) => {
        const child = validateChildFeaturePlanDescriptor(rawChild);
        const slug = slugifyPlanTitle(child.title);
        if (!slug) throw new Error(`Child plan title must produce a valid plan name: ${child.title}`);
        let name = `${parent}/${slug}`;
        if (!names.has(name)) {
            const matches = existing.filter((plan) => {
                const parts = plan.name.split("/");
                return parts.length === 2 && parts[0] === parent && parts[1].replace(/^\d{2,}-/, "") === slug;
            });
            if (matches.length > 1) throw new Error(`Ambiguous legacy child plan name: ${name}`);
            if (matches.length === 1) name = matches[0].name;
        }
        if (seen.has(name)) throw new Error(`Duplicate child plan name: ${name}`);
        seen.add(name);
        return name;
    });
}

/**
 * @typedef {Object} ChildPlanWritePrecondition
 * @property {"created" | "updated"} action
 * @property {string} [expectedRevision]
 * @property {string} [planId]
 */

/**
 * Save draft child FEATURE plans below `docs/plans/<epicPlanName>/`.
 *
 * This helper intentionally overwrites existing draft files at the derived
 * child path. Conflict detection/finalization belongs to the Slicer flow that
 * promotes the decomposition, not to draft materialization.
 *
 * @param {string} cwd - Project root.
 * @param {string} epicPlanName - Parent Epic plan name.
 * @param {ChildFeaturePlanDescriptor[]} children - Child FEATURE descriptors.
 * @param {PlanWriteOptions} [options]
 * @returns {Promise<SavedChildFeaturePlan[]>}
 */
export async function saveChildFeaturePlans(cwd, epicPlanName, children, options = {}) {
    if (!currentPackageProject()) {
        const owner = await inspectLocalHomeStore(cwd);
        if (owner.kind === "local" || owner.kind === "empty")
            return await withLocalProjectAction(cwd, () => saveChildFeaturePlans(cwd, epicPlanName, children, options));
    }
    if (currentPackageProject()) {
        const { authorPackageChildren } = await import("./plan-store/children.ts");
        return await authorPackageChildren(cwd, epicPlanName, children, options);
    }
    await prepareWorktreeRegistry(cwd);
    const { name: parentPlanName, segments: parentSegments } = canonicalizeStoredPlanName(epicPlanName);
    if (parentSegments.length !== 1) {
        throw new Error(`Parent Epic plan name must be a top-level plan: ${epicPlanName}`);
    }
    if (!Array.isArray(children)) throw new Error("Child plans must be an array");

    /** @type {Array<{ child: ChildFeaturePlanDescriptor, name: string, filePath: string }>} */
    const validatedChildren = [];
    const childNames = await resolveChildPlanNames(cwd, parentPlanName, children);

    for (const [index, rawChild] of children.entries()) {
        const child = validateChildFeaturePlanDescriptor(rawChild);
        const childPlanName = childNames[index];
        const { name, filePath, segments } = getStoredPlanLocation(cwd, childPlanName);
        if (segments.length !== 2 || segments[0] !== parentPlanName) {
            throw new Error(`Invalid child plan name: ${childPlanName}`);
        }
        const policy = resolvePlanExecutionPolicy({
            classification: ROUTING_INTENT_PLANNED_CHANGE,
            executionAgent: child.executionAgent,
            collaborationRecommendation: child.collaborationRecommendation,
            frontend: child.frontend,
        });
        if (!policy.ok) throw new Error(`Invalid child plan execution policy for ${child.title}: ${policy.error}`);
        validatedChildren.push({ child, name, filePath });
    }

    /** @type {Map<string, ChildPlanWritePrecondition>} */
    const writePreconditions = new Map();
    for (const { name, filePath } of validatedChildren) {
        let action = /** @type {"created" | "updated"} */ ("created");
        /** @type {string | undefined} */
        let childExpectedRevision = options.expectedRevisions?.[name] || options.expectedRevision;
        const existingChild = currentPackageProject()
            ? await loadPlanStrict(cwd, name)
            : await preparePlanFileStrict(filePath);
        if (existingChild.kind === "loaded") {
            assertSharedPlanWriteAllowed(existingChild.attrs, options);
            if (existingChild.attrs.status !== "draft") {
                throw new Error(`Cannot regenerate non-draft child plan: ${name}`);
            }
            action = "updated";
            childExpectedRevision = childExpectedRevision || existingChild.revision;
            if (childExpectedRevision !== existingChild.revision) {
                throw new StalePlanWriteError(childExpectedRevision, existingChild.revision);
            }
        } else if (existingChild.kind === "malformed") {
            throw existingChild.error;
        } else if (existingChild.kind !== "not_found") {
            throw new PlanFileIssueError(
                filePath,
                existingChild.kind,
                planIssueMessage(existingChild) || `Plan is not writable: ${filePath}`,
            );
        }
        writePreconditions.set(name, {
            action,
            expectedRevision: childExpectedRevision,
            planId: existingChild.kind === "loaded" ? existingChild.attrs.planId : undefined,
        });
    }

    /** @type {SavedChildFeaturePlan[]} */
    const results = [];

    for (const { child, name, filePath } of validatedChildren) {
        const precondition = writePreconditions.get(name) || { action: /** @type {const} */ ("created") };
        const action = precondition.action;
        const childExpectedRevision = precondition.expectedRevision;

        const dependencies = normalizeStringList(child.dependencies) || [];
        const affectedPaths = normalizeStringList(child.affectedPaths) || [];
        /** @type {Partial<PlanFrontMatter> & { classification: "PLANNED_CHANGE", status: "draft", parentPlan: string, order?: number, affectedPaths: string[] }} */
        const metadata = {
            classification: "PLANNED_CHANGE",
            status: /** @type {const} */ ("draft"),
            parentPlan: parentPlanName,
            order: child.order,
            affectedPaths,
        };
        if (precondition.planId) metadata.planId = precondition.planId;
        const workKind = normalizeWorkKind(child.workKind);
        if (workKind) metadata.workKind = workKind;
        const policyResult = resolvePlanExecutionPolicy({
            classification: ROUTING_INTENT_PLANNED_CHANGE,
            executionAgent: child.executionAgent,
            collaborationRecommendation: child.collaborationRecommendation,
            frontend: child.frontend,
        });
        if (!policyResult.ok) throw new Error(policyResult.error);
        const devServerCommand =
            typeof child.devServerCommand === "string"
                ? child.devServerCommand
                : child.devServerCommand === null
                  ? null
                  : undefined;
        const devServerUrl =
            typeof child.devServerUrl === "string"
                ? child.devServerUrl
                : child.devServerUrl === null
                  ? null
                  : undefined;
        const devServerHmr = child.devServerHmr === null ? null : normalizeOptionalBoolean(child.devServerHmr);
        const worktreeBaseBranch =
            typeof child.targetBranch === "string"
                ? child.targetBranch
                : typeof child.worktreeBaseBranch === "string"
                  ? child.worktreeBaseBranch
                  : child.worktreeBaseBranch === null
                    ? null
                    : undefined;
        metadata.executionAgent = policyResult.policy.executionAgent;
        if (policyResult.policy.executionAgent === "frontend-engineer") {
            metadata.collaborationRecommendation = policyResult.policy.collaborationRecommendation;
        }
        if (devServerCommand !== undefined) metadata.devServerCommand = devServerCommand;
        if (devServerUrl !== undefined) metadata.devServerUrl = devServerUrl;
        if (devServerHmr !== undefined) metadata.devServerHmr = devServerHmr;
        if (worktreeBaseBranch) metadata.targetBranch = worktreeBaseBranch;
        if (Object.hasOwn(child, "tickets")) {
            metadata.tickets = normalizeTicketReferences(child.tickets);
        } else if (action === "updated") {
            try {
                const existing = currentPackageProject()
                    ? (await loadPlan(cwd, name))?.attrs
                    : parsePlanFrontMatter(await fsReadFile(filePath, "utf8")).attrs;
                const tickets = normalizeTicketReferences(existing?.tickets);
                if (tickets) metadata.tickets = tickets;
            } catch {
                // Best-effort preservation; savePlan will surface unreadable-file errors.
            }
        }
        const path = await savePlan(
            cwd,
            name,
            child.content,
            {
                ...metadata,
                summary: child.summary,
                dependencies,
                origin: "internal",
            },
            { ...options, expectedRevision: childExpectedRevision },
        );
        const result = { name, path, title: child.title, action, dependencies, metadata };
        results.push(result);
        await options.onChildPlanWritten?.(result);
    }

    return results;
}

/**
 * Save a plan to the plans directory with front matter.
 *
 * @param {string} cwd - Project root
 * @param {string} planName - Filename without .md (e.g., "add-dark-mode-toggle")
 * @param {string} content - Plan markdown content
 * @param {PlanFrontMatterInput} [fmOverrides] - Front matter fields, including preserved unknown metadata
 * @param {PlanWriteOptions} [options]
 * @returns {Promise<string>} The full path where the plan was saved
 */
export async function savePlan(cwd, planName, content, fmOverrides = {}, options = {}) {
    const localPath = await saveLocalHomePlan(cwd, planName, content, fmOverrides, options);
    if (localPath !== null) return localPath;
    assertNotReservedEpicArtifactPlanName(planName);
    await prepareWorktreeRegistry(cwd);
    return await withPlanCatalogLock(
        cwd,
        async () =>
            await withPlanLock(cwd, planName, async () => {
                const dir = await ensurePlansDir(cwd);
                const { filePath, segments } = getStoredPlanLocation(cwd, planName);
                const existing = await preparePlanFileStrict(filePath);
                if (existing.kind === "loaded") assertSharedPlanWriteAllowed(existing.attrs, options);
                else if (existing.kind === "malformed") {
                    assertPlanMarkdownWriteAllowed(existing.markdown, options);
                    throw existing.error;
                } else if (existing.kind !== "not_found") {
                    throw new PlanFileIssueError(
                        filePath,
                        existing.kind,
                        planIssueMessage(existing) || `Plan is not writable: ${filePath}`,
                    );
                }
                if (segments.length > 1) {
                    await fsMkdir(join(dir, ...segments.slice(0, -1)), { recursive: true });
                }
                if (existing.kind === "loaded" && options.expectedRevision === undefined) {
                    throw new StalePlanWriteError("required", existing.revision);
                }
                const withFm = injectFrontMatter(content, {
                    ...(existing.kind === "loaded" && existing.attrs.planId ? { planId: existing.attrs.planId } : {}),
                    ...fmOverrides,
                });
                const documentAttrs = parsePlanFrontMatter(withFm).attrs;
                if (existing.kind === "loaded" && existing.revision !== options.expectedRevision) {
                    throw new StalePlanWriteError(options.expectedRevision || "required", existing.revision);
                }
                // Import once from the authoritative copy; an ordinary document save
                // can never overwrite workflow state with an old in-memory snapshot.
                const controller = await prepareControllerView(
                    cwd,
                    { planName, planId: documentAttrs.planId },
                    documentAttrs,
                );
                // Normalizing legacy CI status removes its phase from Markdown. Keep
                // that already-passed gate durably before replacing the old document.
                // Other saves still cannot overwrite controller state from a snapshot.
                if (
                    existing.kind === "loaded" &&
                    getDeclaredPlanStatus(existing.markdown) === "validated_ci" &&
                    documentAttrs.status === "implemented" &&
                    controller.state.validationPhase === undefined
                ) {
                    await writeControllerState(
                        cwd,
                        { planName, planId: documentAttrs.planId },
                        {
                            validationPhase: "semantic",
                        },
                        {
                            expectedRevision: controller.revision,
                        },
                    );
                }
                if (existing.kind === "not_found") {
                    await atomicWriteTextFileIfAbsent(filePath, planDocumentMarkdown(withFm));
                    await requestWorkspaceSearchRefresh(resolvePrimaryCheckoutRoot(cwd));
                } else {
                    await writePlanMarkdownWithRevision(filePath, withFm, options.expectedRevision);
                }
                return filePath;
            }),
    );
}

/**
 * Create a local locked Plan from a decrypted remote collaboration payload.
 *
 * @param {string} cwd
 * @param {{ preferredName?: string, title?: string, body: string, attrs: Partial<PlanFrontMatter> }} options
 * @returns {Promise<{ planName: string, path: string, attrs: PlanFrontMatter, body: string, markdown: string }>}
 */
export async function createPulledCollaborationPlan(cwd, options) {
    const planId = normalizePlanId(options.attrs.planId);
    if (!planId) throw new Error("Pulled collaboration Plan requires a planId");
    const generatedName = slugifyPlanTitle(options.title || "shared-plan") || "shared-plan";
    const baseName = canonicalizeStoredPlanName(options.preferredName || generatedName).name;
    const explicitName = Boolean(options.preferredName);
    let planName = baseName;
    let suffix = 2;
    while (await loadPlan(cwd, planName)) {
        if (explicitName) throw new Error(`Plan already exists: ${planName}`);
        planName = `${baseName}-${suffix++}`;
    }
    const path = await savePlan(cwd, planName, options.body, options.attrs, {
        collaborationLockBypass: COLLABORATION_LOCK_BYPASS.pull,
    });
    await updatePlanCollaborationMetadata(cwd, planName, options.attrs, COLLABORATION_LOCK_BYPASS.pull);
    const loaded = await loadPlan(cwd, planName);
    if (!loaded) throw new Error(`Failed to create pulled Plan: ${planName}`);
    return { planName, path, attrs: loaded.attrs, body: loaded.body, markdown: loaded.markdown };
}

/**
 * Load a plan by name from the plans directory.
 *
 * @param {string} cwd
 * @param {string} planName - Filename without .md
 * @returns {Promise<{ path: string, markdown: string, attrs: PlanFrontMatter, controllerRevision: number, readAvailability?: PlanReadAvailability, body: string, revision: string, frontMatterRevision?: string, hasFrontMatter?: boolean } | null>}
 */
export async function loadPlan(cwd, planName) {
    if (isEpicArtifactPlanName(planName)) return null;
    const result = await loadPlanStrict(cwd, planName);
    if (result.kind === "not_found") return null;
    if (result.kind === "loaded") {
        return {
            path: result.path,
            markdown: result.markdown,
            attrs: result.attrs,
            controllerRevision: result.controllerRevision,
            readAvailability: result.readAvailability,
            body: result.body,
            revision: result.revision,
            frontMatterRevision: result.frontMatterRevision,
            hasFrontMatter: result.hasFrontMatter,
        };
    }
    if (result.kind === "malformed") throw result.error;
    throw new PlanFileIssueError(
        result.path,
        result.kind,
        planIssueMessage(result) || `Plan could not be loaded: ${result.path}`,
    );
}

/**
 * Load an external plan (a pre-existing markdown file not created by RunWield)
 * from any path. Applies defaults if front matter is missing.
 *
 * @param {string} absolutePath - Absolute path to the plan file
 * @returns {Promise<{ path: string, markdown: string, attrs: PlanFrontMatter, body: string, revision: string }>}
 */
export async function loadExternalPlan(absolutePath) {
    const markdown = await fsReadFile(absolutePath, "utf8");
    const { attrs, body } = parsePlanFrontMatter(markdown, {
        missingOrigin: "external",
    });
    // If front matter was missing, rewrite with defaults injected
    if (!hasFrontMatter(markdown)) {
        const withFm = injectFrontMatter(markdown, { origin: "external" });
        return {
            path: absolutePath,
            markdown: withFm,
            attrs,
            body,
            revision: await getPlanRevisionForText(withFm),
        };
    }
    return { path: absolutePath, markdown, attrs, body, revision: await getPlanRevisionForText(markdown) };
}

/**
 * Update the status field in a plan's front matter.
 *
 * If the plan file exists but has malformed front matter,
 * this function self-heals by rewriting front matter using
 * provided recovery metadata and then applying the target status.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {PlanFrontMatter["status"]} status
 * @param {Partial<PlanFrontMatter>} [recoveryAttrs]
 * @param {PlanWriteOptions} [options]
 * @returns {Promise<void>}
 */
export async function updatePlanStatus(cwd, planName, status, recoveryAttrs = {}, options = {}) {
    await updatePlanFrontMatter(cwd, planName, { ...recoveryAttrs, status }, {}, options);
}

/**
 * Update arbitrary plan front matter fields while preserving the body.
 * Passing null for optional fields clears them.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {Partial<PlanFrontMatter>} updates
 * @param {Partial<PlanFrontMatter>} [recoveryAttrs]
 * @param {PlanWriteOptions} [options]
 * @returns {Promise<PlanFrontMatter>}
 */
export async function updatePlanFrontMatter(cwd, planName, updates, recoveryAttrs = {}, options = {}) {
    if (requiresPlanWorkflow(cwd))
        return await withLocalPlanWorkflow(cwd, planName, () =>
            updatePlanFrontMatter(cwd, planName, updates, recoveryAttrs, options),
        );
    if (currentPackageProject())
        return await updatePackageWorkflowMetadata(planName, updates, options.expectedRevision);
    return await withPlanLock(cwd, planName, async () => {
        const result = await preparePlanFileStrict(getStoredPlanPath(cwd, planName));
        if (result.kind === "not_found") throw new Error(`Plan not found: ${planName}`);
        if (result.kind === "malformed") throw result.error;
        if (result.kind !== "loaded") {
            throw new PlanFileIssueError(
                result.path,
                result.kind,
                planIssueMessage(result) || `Plan could not be updated: ${result.path}`,
            );
        }
        assertSharedPlanWriteAllowed(result.attrs, options);
        if (options.expectedRevision === undefined) {
            throw new Error(`Plan Front Matter update for ${planName} requires expectedRevision.`);
        }
        if (result.revision !== options.expectedRevision) {
            throw new StalePlanWriteError(options.expectedRevision, result.revision);
        }
        const attrs = { ...recoveryAttrs, ...updates, updatedAt: updates.updatedAt ?? new Date().toISOString() };
        const normalizedAttrs = parsePlanFrontMatter(injectFrontMatter(result.markdown, attrs)).attrs;
        const previousValues = new Map(Object.entries(result.attrs));
        const storedValues = new Map(
            Object.entries(hasFrontMatter(result.markdown) ? extractYaml(result.markdown).attrs : {}),
        );
        const nextValues = new Map(Object.entries(normalizedAttrs));
        /** @type {Partial<PlanFrontMatter>} */
        const normalizedOverrides = {};
        for (const key of Object.keys(attrs)) {
            // Recovery attributes often contain the entire loaded Plan. Replacing
            // unchanged fields reformats YAML lists and invalidates sealed commits
            // during controller-only operations such as claiming a retry.
            // Explicit document updates must compare against the stored value:
            // parsing may already normalize a retired status that still needs
            // to be repaired on disk. Recovery defaults are not explicit edits.
            const previous = Object.hasOwn(updates, key) ? storedValues.get(key) : previousValues.get(key);
            if (JSON.stringify(nextValues.get(key)) === JSON.stringify(previous)) continue;
            /** @type {Record<string, unknown>} */ (normalizedOverrides)[key] = /** @type {Record<string, unknown>} */ (
                normalizedAttrs
            )[key];
        }
        await writeControllerState(
            cwd,
            { planName, planId: result.attrs.planId },
            pickControllerState({ ...updates, updatedAt: attrs.updatedAt }),
            {
                expectedRevision: options.expectedControllerRevision,
                ...(updates.worktreeId === null ? { recovery: null } : {}),
            },
        );
        const changesDocument = Object.keys(stripRuntimeFields(updates)).some((key) => key !== "summary");
        const withFm = planDocumentMarkdown(
            changesDocument ? mergeFrontMatterText(result.markdown, normalizedOverrides) : result.markdown,
        );
        if (withFm !== result.markdown) await writePlanMarkdownWithRevision(result.path, withFm, result.revision);
        return (await prepareControllerMetadata(result.path, parsePlanFrontMatter(withFm).attrs)).attrs;
    });
}

/**
 * Future collaboration commands can use this narrow helper to update collaboration metadata
 * with an explicit lock bypass. When body is provided, the body and collaborationBodyHash
 * are updated together.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {Partial<PlanFrontMatter>} updates
 * @param {symbol} collaborationLockBypass
 * @param {{ body?: string }} [options]
 * @returns {Promise<PlanFrontMatter>}
 */
export async function updatePlanCollaborationMetadata(cwd, planName, updates, collaborationLockBypass, options = {}) {
    if (!currentPackageProject() && inspectLocalHomeStore(cwd).kind === "local")
        return await withLocalPlanWorkflow(cwd, planName, () =>
            updatePlanCollaborationMetadata(cwd, planName, updates, collaborationLockBypass, options),
        );
    const selection = currentPackageProject();
    if (selection)
        return await packageWorkflowLocks([planName], async () => {
            const plan = await selectedPackage(planName);
            const view = await loadPackageWorkflowPlan({ planId: plan.metadata.planId });
            assertSharedPlanWriteAllowed(view.attrs, { collaborationLockBypass });
            const collaboration = normalizeCollaborationFrontMatter(updates);
            const next = Object.fromEntries(Object.entries(collaboration).filter(([, value]) => value !== undefined));
            if (typeof options.body === "string") {
                const document = plan.documents.find((entry) => entry.name === "context.md");
                if (!document) throw new Error("Plan context is unavailable.");
                await savePlanPackageDocument(
                    selection,
                    plan.metadata.planId,
                    "context.md",
                    document.hash,
                    options.body,
                );
                next.collaborationBodyHash = await hashPlanBody(options.body);
            }
            // Remote metadata never replaces the local lifecycle, controller, or execution binding.
            return await updatePackageWorkflowMetadata({ planId: plan.metadata.planId }, next);
        });
    cwd = (await resolveWorkflowPlanLocation(cwd, planName)).documentRoot;
    return await withPlanLock(cwd, planName, async () => {
        const plan = await prepareStoredPlan(cwd, planName);
        if (!plan) throw new Error(`Plan not found: ${planName}`);
        const hasControlledBodyWrite = typeof options.body === "string";
        const nextBody = hasControlledBodyWrite ? /** @type {string} */ (options.body) : plan.body;
        const collaborationUpdates = normalizeCollaborationFrontMatter(updates);
        if (!hasControlledBodyWrite) {
            delete collaborationUpdates.collaborationBodyHash;
        }
        const planMetadataUpdates = pickKnownPlanFrontMatter(updates);
        for (const key of [
            "collaborationState",
            "collaborationServerUrl",
            "collaborationSpaceId",
            "collaborationRevision",
            "collaborationBodyHash",
            "collaborationSyncedAt",
        ]) {
            delete (/** @type {Record<string, unknown>} */ (planMetadataUpdates)[key]);
        }
        const definedCollaborationUpdates = Object.fromEntries(
            Object.entries(collaborationUpdates).filter(([, value]) => value !== undefined),
        );
        const attrs = {
            ...pickKnownPlanFrontMatter(plan.attrs),
            ...planMetadataUpdates,
            ...definedCollaborationUpdates,
            bearerCapability: undefined,
            contentKey: undefined,
            reviewerUrl: undefined,
            collaborationSyncedAt: collaborationUpdates.collaborationSyncedAt ?? new Date().toISOString(),
            updatedAt: updates.updatedAt ?? new Date().toISOString(),
        };
        if (hasControlledBodyWrite) {
            attrs.collaborationBodyHash = await hashPlanBody(nextBody);
        }
        assertSharedPlanWriteAllowed(plan.attrs, { collaborationLockBypass });
        const sourceMarkdown = hasControlledBodyWrite ? injectFrontMatter(nextBody, plan.attrs) : plan.markdown;
        const markdown = mergeFrontMatterText(sourceMarkdown, attrs);
        await writePlanDocumentAndController({
            projectRoot: cwd,
            planName,
            operation: "collaboration_update",
            markdown,
            controllerUpdates: pickControllerState(attrs),
            expectedRevision: plan.revision,
            expectedControllerRevision: plan.controllerRevision,
        });
        return (await prepareControllerMetadata(plan.path, parsePlanFrontMatter(planDocumentMarkdown(markdown)).attrs))
            .attrs;
    });
}

/**
 * Clear local collaboration metadata after an intentional unshare cleanup.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {symbol} collaborationLockBypass
 * @param {{ updatedAt?: string }} [options]
 * @returns {Promise<PlanFrontMatter>}
 */
export async function clearPlanCollaborationMetadata(cwd, planName, collaborationLockBypass, options = {}) {
    if (!currentPackageProject() && inspectLocalHomeStore(cwd).kind === "local")
        return await withLocalPlanWorkflow(cwd, planName, () =>
            clearPlanCollaborationMetadata(cwd, planName, collaborationLockBypass, options),
        );
    if (collaborationLockBypass !== COLLABORATION_LOCK_BYPASS.unshare) {
        throw new Error("Clearing collaboration metadata requires the unshare collaboration lock bypass.");
    }
    if (currentPackageProject())
        return await packageWorkflowLocks([planName], async () => {
            const plan = await selectedPackage(planName);
            const view = await loadPackageWorkflowPlan({ planId: plan.metadata.planId });
            assertSharedPlanWriteAllowed(view.attrs, { collaborationLockBypass });
            const updates = Object.fromEntries(
                Object.values(COLLABORATION_FRONT_MATTER_KEYS).map((key) => [key, undefined]),
            );
            return await updatePackageWorkflowMetadata({ planId: plan.metadata.planId }, updates);
        });
    cwd = (await resolveWorkflowPlanLocation(cwd, planName)).documentRoot;
    return await withPlanLock(cwd, planName, async () => {
        const plan = await prepareStoredPlan(cwd, planName);
        if (!plan) throw new Error(`Plan not found: ${planName}`);
        assertSharedPlanWriteAllowed(plan.attrs, { collaborationLockBypass });
        const attrs = {
            updatedAt: options.updatedAt ?? new Date().toISOString(),
        };
        for (const key of Object.values(COLLABORATION_FRONT_MATTER_KEYS)) {
            /** @type {Record<string, unknown>} */ (attrs)[key] = undefined;
        }
        const markdown = mergeFrontMatterText(plan.markdown, attrs);
        await writePlanDocumentAndController({
            projectRoot: cwd,
            planName,
            operation: "collaboration_clear",
            markdown,
            controllerUpdates: pickControllerState(attrs),
            expectedRevision: plan.revision,
            expectedControllerRevision: plan.controllerRevision,
        });
        return (await prepareControllerMetadata(plan.path, parsePlanFrontMatter(planDocumentMarkdown(markdown)).attrs))
            .attrs;
    });
}

/**
 * @typedef {Object} PlanResourceEntry
 * @property {string} name - Canonical plan name relative to docs/plans/ without .md.
 * @property {string} planName - Alias for name used by resource consumers.
 * @property {string} relativePath - Project-relative markdown path, e.g. docs/plans/name.md.
 * @property {string} path - Absolute markdown path.
 * @property {string} planId - Durable resource identity.
 * @property {PlanFrontMatter} attrs - Parsed front matter including planId.
 * @property {PlanReadAvailability} [readAvailability]
 * @property {string} [body] - Parsed markdown body when loaded by identity helpers.
 * @property {string} [markdown] - Full markdown when loaded by identity helpers.
 */

/**
 * Display-only document failure. Paths are internal and must not reach browser payloads.
 * @typedef {Object} PlanDocumentDiagnostic
 * @property {string} name
 * @property {string} path
 * @property {"malformed" | "not_file" | "unreadable"} kind
 * @property {string} message
 * @property {string} [planId] Trusted registry identity only.
 */

/**
 * @param {PlanParseIssue} issue
 * @returns {PlanDocumentDiagnostic}
 */
function documentDiagnostic(issue) {
    return {
        name: issue.name,
        path: issue.path,
        kind:
            issue.error instanceof PlanFrontMatterParseError
                ? "malformed"
                : issue.error instanceof PlanFileIssueError && issue.error.kind === "not_file"
                  ? "not_file"
                  : "unreadable",
        message: issue.message,
    };
}

/**
 * @typedef {Object} PlanParseIssue
 * @property {string} name
 * @property {string} path
 * @property {string} message
 * @property {unknown} error
 */

/**
 * @param {string} dir
 * @param {string[]} prefix
 * @param {Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>} results
 * @param {PlanParseIssue[]} [parseIssues]
 * @param {boolean} [documentOnly] Read file metadata without entering runtime storage.
 * @returns {Promise<void>}
 */
async function collectPlans(dir, prefix, results, parseIssues, documentOnly = false) {
    for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        const name = [...prefix, entry.name.replace(/\.md$/, "")].join("/");
        if (entry.isDirectory()) {
            if (entry.name.endsWith(".md")) {
                parseIssues?.push({
                    name,
                    path: entryPath,
                    message: `Plan path is a directory, not a markdown file: ${entryPath}`,
                    error: new PlanFileIssueError(
                        entryPath,
                        "not_file",
                        `Plan path is a directory, not a markdown file: ${entryPath}`,
                    ),
                });
                continue;
            }
            if (prefix.length === 0 && HIDDEN_PLAN_DIRS.has(entry.name)) continue;
            await collectPlans(entryPath, [...prefix, entry.name], results, parseIssues, documentOnly);
            continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        if (isEpicArtifactPlanName(name)) continue;
        if (!entry.isFile()) {
            parseIssues?.push({
                name,
                path: entryPath,
                message: `Plan path is not a regular markdown file: ${entryPath}`,
                error: new PlanFileIssueError(
                    entryPath,
                    "not_file",
                    `Plan path is not a regular markdown file: ${entryPath}`,
                ),
            });
            continue;
        }
        try {
            const markdown = await fsReadFile(entryPath, "utf8");
            try {
                const { attrs } = parsePlanFrontMatter(markdown);
                const current = documentOnly ? { attrs } : await withControllerMetadata(entryPath, attrs);
                results.push({ name, path: entryPath, ...current });
            } catch (error) {
                if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
                const wrapped = new PlanFrontMatterParseError(entryPath, error);
                parseIssues?.push({ name, path: entryPath, message: formatErrorMessage(error), error: wrapped });
            }
        } catch (error) {
            if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
            parseIssues?.push({ name, path: entryPath, message: formatErrorMessage(error), error });
        }
    }
}

/**
 * List all saved plans in the project's plans directory in canonical UI order.
 *
 * @param {string} cwd
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>}
 */
export async function listPlans(cwd) {
    return await readLocalHomeStore(
        cwd,
        () => listPlansInProject(cwd),
        () => [],
    );
}

/**
 * @param {string} cwd
 * @returns {ReturnType<typeof listPlans>}
 */
async function listPlansInProject(cwd) {
    const packageSelection = currentPackageProject();
    if (packageSelection) {
        const catalog = await listPlanPackages(packageSelection);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        const plans = await Promise.all(
            catalog.packages.map(async (p) => ({
                name: p.metadata.name,
                ...(await loadPackageWorkflowPlan(p.metadata.name)),
            })),
        );
        return plans.sort(comparePlansForList);
    }
    return await listPlansWithTargetChildren(cwd, null);
}

/**
 * Replace the same-name projection first, leaving conflicting IDs visible to identity checks.
 * An ID-only match remains a fallback for a renamed Plan's stale projection.
 * @param {Pick<PlanResourceEntry, "name" | "attrs">[]} plans
 * @param {string} name
 * @param {string | undefined} planId
 * @returns {number}
 */
function findCatalogPlanIndex(plans, name, planId) {
    const named = plans.findIndex((plan) => plan.name === name);
    return named >= 0 ? named : planId ? plans.findIndex((plan) => plan.attrs.planId === planId) : -1;
}

/**
 * List saved plans, reading target-branch children only for `onlyEpic` when it
 * is given. Catalog evidence uses existing Git snapshots; remote refresh belongs
 * to the selected Epic's workflow. A scoped lookup also avoids reading every
 * Plan on unrelated Epic branches.
 *
 * @param {string} cwd
 * @param {string | null} onlyEpic
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>}
 */
async function listPlansWithTargetChildren(cwd, onlyEpic) {
    return (await readPlansWithTargetChildren(cwd, onlyEpic, false)).plans;
}

/**
 * @param {string} cwd
 * @param {string | null} onlyEpic
 * @param {boolean} display
 */
async function readPlansWithTargetChildren(cwd, onlyEpic, display) {
    return await withProjectRuntimeReadScope(async () => {
        const dir = getPlansDir(cwd);
        /** @type {Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>} */
        const results = [];
        /** @type {PlanParseIssue[]} */
        const parseIssues = [];
        /** @type {Map<string, PlanDocumentDiagnostic>} */
        const diagnostics = new Map();
        try {
            await collectPlans(dir, [], results, parseIssues);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const access = await inspectProjectRuntimeReadAccess(cwd);
        if (access.kind === "blocked") throw new ProjectRuntimeEntryRefusedError(access);
        if (access.kind === "pending") {
            if (!display && parseIssues.length) throw parseIssues[0].error;
            return { plans: results.sort(comparePlansForList), diagnostics: parseIssues.map(documentDiagnostic) };
        }
        const unavailableTargets = new Map();
        for (const projectPlan of [...results]) {
            const targetBranch =
                typeof projectPlan.attrs.targetBranch === "string" ? projectPlan.attrs.targetBranch.trim() : "";
            if (!targetBranch || !isProjectPlan(projectPlan.attrs)) continue;
            if (onlyEpic !== null && projectPlan.name !== onlyEpic) continue;
            const repository = await probeGitRepository(cwd);
            if (repository.state === "not_git") continue;
            if (!repository.ok) throw new Error(repository.message);
            let targetChildren;
            try {
                if (display) {
                    const catalog = await readTargetBranchPlanCatalogByParent(cwd, targetBranch, projectPlan.name);
                    targetChildren = catalog.plans;
                    for (const diagnostic of catalog.diagnostics) {
                        diagnostics.set(diagnostic.name, diagnostic);
                        const index = findCatalogPlanIndex(results, diagnostic.name, diagnostic.planId);
                        if (index >= 0) results.splice(index, 1);
                    }
                } else targetChildren = await findTargetBranchPlansByParent(cwd, targetBranch, projectPlan.name);
            } catch (error) {
                if (error instanceof TargetBranchSnapshotUnavailableError) {
                    unavailableTargets.set(projectPlan.name, `${WORKFLOW_DETAILS_PENDING} ${error.message}`);
                    continue;
                }
                throw error;
            }
            for (const child of targetChildren) {
                const index = findCatalogPlanIndex(results, child.name, child.attrs.planId);
                if (
                    index >= 0 &&
                    results[index].name === child.name &&
                    results[index].attrs.planId &&
                    child.attrs.planId &&
                    results[index].attrs.planId !== child.attrs.planId
                ) {
                    throw new Error(
                        `Target Plan ${child.name} has a different Plan ID. Your files have not been changed.`,
                    );
                }
                if (display) {
                    diagnostics.delete(child.name);
                    for (let i = parseIssues.length - 1; i >= 0; i--) {
                        if (parseIssues[i].name === child.name) parseIssues.splice(i, 1);
                    }
                }
                const metadata = await withControllerMetadata(getStoredPlanPath(cwd, child.name), child.attrs);
                const item = { name: child.name, path: child.path, ...metadata };
                if (index < 0) results.push(item);
                else results[index] = item;
            }
        }
        const attempts = await listControllerDocumentWorktrees(cwd);
        for (const attempt of attempts) {
            if (attempts.filter((entry) => entry.planName === attempt.planName).length !== 1) continue;
            let execution;
            try {
                execution = attempt.documentUnavailable ? null : await loadPlan(attempt.path, attempt.planName);
            } catch (error) {
                if (!display || !(error instanceof PlanFrontMatterParseError)) throw error;
                const index = findCatalogPlanIndex(results, attempt.planName, attempt.planId);
                if (index >= 0) results.splice(index, 1);
                for (let i = parseIssues.length - 1; i >= 0; i--) {
                    if (parseIssues[i].name === attempt.planName) parseIssues.splice(i, 1);
                }
                diagnostics.set(attempt.planName, {
                    name: attempt.planName,
                    path: error.path,
                    kind: "malformed",
                    message: error.cause instanceof Error ? error.cause.message : error.message,
                    ...(attempt.planId ? { planId: attempt.planId } : {}),
                });
                continue;
            }
            if (display) diagnostics.delete(attempt.planName);
            if (!execution) {
                // A missing or archived authority cannot expose a stale primary copy.
                // Direct Plan loading owns the recovery error, not the project catalog.
                const index = findCatalogPlanIndex(results, attempt.planName, attempt.planId);
                if (index >= 0) results.splice(index, 1);
                const issueIndex = parseIssues.findIndex((issue) => issue.name === attempt.planName);
                if (issueIndex >= 0) parseIssues.splice(issueIndex, 1);
                continue;
            }
            if (attempt.planId && execution.attrs.planId && execution.attrs.planId !== attempt.planId) {
                throw new Error(
                    `The execution directory contains a different Plan at ${execution.path}. Your files have not been changed.`,
                );
            }
            const index = findCatalogPlanIndex(results, attempt.planName, attempt.planId);
            const item = {
                name: attempt.planName,
                path: execution.path,
                attrs: execution.attrs,
                readAvailability: execution.readAvailability,
            };
            if (index < 0) results.push(item);
            else results[index] = item;
            const issueIndex = parseIssues.findIndex((issue) => issue.name === attempt.planName);
            if (issueIndex >= 0) parseIssues.splice(issueIndex, 1);
        }
        if (!display && parseIssues.length > 0) {
            const issue = parseIssues[0];
            if (issue.error instanceof Error) throw issue.error;
            throw new PlanFileIssueError(issue.path, "malformed", issue.message);
        }
        for (const plan of results) {
            const message = unavailableTargets.get(plan.name) || unavailableTargets.get(plan.attrs.parentPlan);
            if (message) plan.readAvailability = { kind: "pending", message };
        }
        for (const issue of parseIssues) {
            if (!diagnostics.has(issue.name)) diagnostics.set(issue.name, documentDiagnostic(issue));
        }
        return { plans: results.sort(comparePlansForList), diagnostics: [...diagnostics.values()] };
    });
}

/**
 * List local Plan documents for selection. Deliberately does not enter runtime
 * storage, fetch Git refs, repair worktrees, or adopt external Markdown files.
 * Loading the selected Plan is a separate command phase.
 * @param {string} cwd
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>}
 */
export async function listPlanDocuments(cwd) {
    return await readLocalHomeStore(
        cwd,
        () => listPlanDocumentsInProject(cwd),
        () => [],
    );
}

/**
 * @param {string} cwd
 * @returns {ReturnType<typeof listPlanDocuments>}
 */
async function listPlanDocumentsInProject(cwd) {
    if (currentPackageProject()) return await listPlans(cwd);
    /** @type {Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>} */
    const plans = [];
    /** @type {PlanParseIssue[]} */
    const issues = [];
    try {
        await collectPlans(getPlansDir(cwd), [], plans, issues, true);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const issue of issues) {
        if (issue.error instanceof Error) throw issue.error;
        throw new PlanFileIssueError(issue.path, "malformed", issue.message);
    }
    return plans.sort(comparePlansForList);
}

const ARCHIVED_DIR_NAME = "archived";

/**
 * @typedef {Object} ArchivePlanOptions
 * @property {string} [reason]
 * @property {boolean} [force]
 * @property {string} [now]
 * @property {boolean} [abandonedWorktree] - Archive after the user confirmed abandonment in the active recovery flow.
 */

/**
 * @typedef {Object} ArchivedPlanEntry
 * @property {string} name
 * @property {string} planName
 * @property {string} relativePath
 * @property {string} path
 * @property {PlanFrontMatter} attrs
 * @property {string} status
 * @property {string} summary
 * @property {string} [planId]
 * @property {PlanReadAvailability} [readAvailability]
 */

/**
 * @param {string} cwd
 * @returns {string}
 */
function getArchivedPlansDir(cwd) {
    return join(getPlansDir(cwd), ARCHIVED_DIR_NAME);
}

/**
 * @param {string} cwd
 * @param {string} absolutePath
 * @returns {string}
 */
function projectRelativePath(cwd, absolutePath) {
    return relative(cwd, absolutePath).replaceAll("\\", "/");
}

/**
 * @param {string} cwd
 * @param {string} planName
 * @returns {{ name: string, segments: string[], filePath: string }}
 */
function getArchivedPlanLocation(cwd, planName) {
    const { segments } = canonicalizeStoredPlanName(planName);
    const archiveSegments = segments[0] === ARCHIVED_DIR_NAME ? segments.slice(1) : segments;
    if (archiveSegments.length === 0) throw new Error("Archived plan name cannot be empty");
    return {
        name: archiveSegments.join("/"),
        segments: archiveSegments,
        filePath: join(getArchivedPlansDir(cwd), ...archiveSegments) + ".md",
    };
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
    try {
        const stat = await fsStat(path);
        return stat.isFile();
    } catch {
        return false;
    }
}

/**
 * @param {string} cwd
 * @param {string} planNameOrId
 * @returns {Promise<{ name: string, path: string, attrs: PlanFrontMatter, body: string, markdown: string }>}
 */
async function resolveActivePlanNameOrId(cwd, planNameOrId) {
    if (isHiddenPlanName(canonicalizeStoredPlanName(planNameOrId).name)) {
        throw new Error(`Use an active Plan name, not ${ARCHIVED_DIR_NAME}/...: ${planNameOrId}`);
    }
    const { preparePlanWorkflow } = await import("./plan-store/preparation.ts");
    await preparePlanWorkflow(cwd, planNameOrId);
    // Archive and restore move documents; resolving a name must not start a planning attempt.
    const location = await resolveWorkflowPlanLocation(cwd, planNameOrId, { readOnly: true });
    const byName = location.plan;
    if (byName) {
        if ("publishedSnapshot" in location && location.publishedSnapshot) {
            throw new Error(
                `Plan ${planNameOrId} exists only as a published read snapshot. Restore a local document before archiving.`,
            );
        }
        const { name } = canonicalizeStoredPlanName(planNameOrId);
        if (isHiddenPlanName(name)) {
            throw new Error(`Use an active Plan name, not ${ARCHIVED_DIR_NAME}/...: ${planNameOrId}`);
        }
        return {
            name,
            ...byName,
            ...(await prepareControllerMetadata(byName.path, parsePlanFrontMatter(byName.markdown).attrs)),
        };
    }

    const planId = normalizePlanId(planNameOrId);
    if (planId) {
        const matches = (await listPlans(cwd)).filter((plan) => plan.attrs.planId === planId);
        if (matches.length > 1) {
            throw new Error(`Duplicate planId values found for ${planId}; repair plan front matter before continuing.`);
        }
        if (matches.length === 1) {
            await preparePlanWorkflow(cwd, matches[0].name);
            const loaded = await prepareStoredPlan(getPlanDocumentRoot(matches[0].path), matches[0].name);
            if (loaded) return { name: matches[0].name, ...loaded };
        }
    }

    throw new Error(`Active Plan not found: ${planNameOrId}`);
}

/**
 * @param {string} cwd
 * @param {string} archivedPlanNameOrId
 * @returns {Promise<{ name: string, path: string, attrs: PlanFrontMatter, body: string, markdown: string }>}
 */
async function resolveArchivedPlanNameOrId(cwd, archivedPlanNameOrId) {
    const archived = await loadArchivedPlan(cwd, archivedPlanNameOrId);
    if (archived) return archived;
    throw new Error(`Archived Plan not found: ${archivedPlanNameOrId}`);
}

/**
 * Archive an active Plan by name or planId into docs/plans/archived/.
 * @param {string} cwd
 * @param {string} planNameOrId
 * @param {ArchivePlanOptions} [options]
 * @returns {Promise<{ name: string, fromPath: string, toPath: string, relativePath: string, attrs: PlanFrontMatter, artifacts?: Array<{ fileName: string, relativePath: string }> }>}
 */
export async function archivePlan(cwd, planNameOrId, options = {}) {
    if (!currentPackageProject() && (await inspectLocalHomeStore(cwd)).kind === "local")
        return await withLocalPlanWorkflow(cwd, planNameOrId, () => archivePlan(cwd, planNameOrId, options));
    const owner = currentPackageProject();
    if (owner)
        return await packageWorkflowLocks([planNameOrId], async () => {
            const selected = await selectedPackage(planNameOrId);
            const source = await loadPackageWorkflowPlan({ planId: selected.metadata.planId });
            const worktreeStatus = options.abandonedWorktree ? "abandoned" : source.attrs.worktreeStatus;
            if (isRecoverableWorktreeStatus(worktreeStatus))
                throw new Error(
                    `Cannot archive ${selected.metadata.name}: worktreeStatus ${worktreeStatus} is recoverable.`,
                );
            if (!isTerminalArchivableStatus(source.attrs.status) && !options.force)
                throw new Error(
                    `Cannot archive ${selected.metadata.name} with status ${source.attrs.status} without --force.`,
                );
            await archivePlanPackage(
                owner,
                selected.metadata.planId,
                selected.metadata.revision,
                options.reason || "",
                options.now,
            );
            return {
                name: selected.metadata.name,
                fromPath: source.path,
                toPath: source.path,
                relativePath: projectRelativePath(cwd, source.path),
                attrs: source.attrs,
                artifacts: [],
            };
        });
    const source = await resolveActivePlanNameOrId(cwd, planNameOrId);
    cwd = getPlanDocumentRoot(source.path);
    if (source.name.split("/")[0] === ARCHIVED_DIR_NAME) {
        throw new Error(`Cannot archive from ${ARCHIVED_DIR_NAME}/...; choose an active Plan name.`);
    }

    const worktreeStatus = options.abandonedWorktree ? "abandoned" : source.attrs.worktreeStatus;
    if (isRecoverableWorktreeStatus(worktreeStatus)) {
        throw new Error(
            `Cannot archive ${source.name}: worktreeStatus ${worktreeStatus} is recoverable. Resolve or abandon the worktree before archiving; --force does not bypass recoverable worktree guards.`,
        );
    }

    const status = source.attrs.status;
    if (!isTerminalArchivableStatus(status) && !options.force) {
        throw new Error(
            `Cannot archive ${source.name} with status ${status} without --force. Only validated, verified, user_verified, and closed_without_verification archive by default.`,
        );
    }

    const destination = getArchivedPlanLocation(cwd, source.name);
    if (await fileExists(destination.filePath)) {
        throw new Error(`Archived Plan already exists: ${projectRelativePath(cwd, destination.filePath)}`);
    }

    const now = options.now || new Date().toISOString();
    /** @type {Partial<PlanFrontMatter>} */
    const archiveMetadata = {
        archivedAt: now,
        archivedFromStatus: status,
        archivedFromPath: projectRelativePath(cwd, source.path),
        updatedAt: now,
    };
    if (options.abandonedWorktree) {
        Object.assign(archiveMetadata, {
            executionMode: undefined,
            executionBaselineTree: undefined,
            worktreeId: undefined,
            worktreePath: undefined,
            worktreeBranch: undefined,
            worktreeBaseBranch: undefined,
            worktreeStatus: "abandoned",
        });
    }
    if (options.reason !== undefined) archiveMetadata.archiveReason = options.reason;
    const markdown = planDocumentMarkdown(mergeFrontMatterText(source.markdown, archiveMetadata));
    return await withPlanCatalogLock(
        cwd,
        async () =>
            await withPlanLock(cwd, source.name, async () => {
                const lockedSource = await resolveActivePlanNameOrId(cwd, source.name);
                if (
                    (await getPlanRevisionForText(lockedSource.markdown)) !==
                    (await getPlanRevisionForText(source.markdown))
                ) {
                    throw new StalePlanWriteError(
                        await getPlanRevisionForText(source.markdown),
                        await getPlanRevisionForText(lockedSource.markdown),
                    );
                }
                await fsMkdir(join(getArchivedPlansDir(cwd), ...destination.segments.slice(0, -1)), {
                    recursive: true,
                });
                await atomicWriteTextFileIfAbsent(destination.filePath, markdown);
                /** @type {MoveEpicArtifactResult[]} */
                let movedArtifacts = [];
                try {
                    movedArtifacts =
                        source.attrs.classification === "PROJECT" && source.name.split("/").length === 1
                            ? await moveEpicArtifactsToArchive(cwd, source.name)
                            : [];
                    await fsRm(source.path);
                    await syncDirectory(dirname(source.path));
                    await syncDirectory(dirname(destination.filePath));
                    for (const artifact of movedArtifacts) await syncDirectory(dirname(artifact.toPath));
                } catch (error) {
                    for (const artifact of movedArtifacts.toReversed()) {
                        await fs.rename(artifact.toPath, artifact.fromPath).catch(() => {});
                    }
                    await fsRm(destination.filePath).catch(() => {});
                    throw error;
                }
                return {
                    name: source.name,
                    fromPath: source.path,
                    toPath: destination.filePath,
                    relativePath: projectRelativePath(cwd, destination.filePath),
                    attrs: parsePlanFrontMatter(markdown).attrs,
                    artifacts: movedArtifacts.map((artifact) => ({
                        fileName: artifact.fileName,
                        relativePath: artifact.relativePath,
                    })),
                };
            }),
    );
}

/**
 * @typedef {Object} BulkArchivePlanEntry
 * @property {string} name
 * @property {string} relativePath
 */

/**
 * @typedef {BulkArchivePlanEntry & { message: string }} BulkArchivePlanFailure
 */

/**
 * @typedef {Object} BulkArchivePlansResult
 * @property {BulkArchivePlanEntry[]} matched
 * @property {BulkArchivePlanEntry[]} archived
 * @property {BulkArchivePlanFailure[]} failed
 */

/**
 * Archive active parent or standalone Plans whose status exactly matches the requested lifecycle status.
 *
 * Child FEATURE statuses are ignored for matching. When a parent Plan matches,
 * its child FEATURE Plans are archived with it regardless of child lifecycle status.
 * Best-effort semantics: successful archives are moved even when another matching
 * parent or child Plan fails.
 *
 * @param {string} cwd
 * @param {PlanFrontMatter["status"]} status
 * @param {ArchivePlanOptions} [options]
 * @returns {Promise<BulkArchivePlansResult>}
 */
export async function archivePlansByStatus(cwd, status, options = {}) {
    if (!PLAN_STATUSES.has(status)) {
        throw new Error(`Unknown Plan status for bulk archive: ${status}`);
    }

    await prepareWorktreeRegistry(cwd);
    const { preparePlanWorkflow } = await import("./plan-store/preparation.ts");
    for (const plan of await listPlans(cwd)) await preparePlanWorkflow(cwd, plan.name);
    const plans = await listPlans(cwd);
    /** @type {Map<string, Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>} */
    const childrenByParent = new Map();
    for (const plan of plans) {
        if (!isChildFeaturePlan(plan)) continue;
        const parentPlan = plan.attrs.parentPlan || "";
        const children = childrenByParent.get(parentPlan) || [];
        children.push(plan);
        childrenByParent.set(parentPlan, children);
    }
    for (const children of childrenByParent.values()) children.sort(compareChildPlansByOrder);

    const matchingParentPlans = plans
        .filter((plan) => !isChildFeaturePlan(plan) && plan.attrs.status === status)
        .sort((a, b) => a.name.localeCompare(b.name));
    const matchingPlans = matchingParentPlans.flatMap((plan) => [plan, ...(childrenByParent.get(plan.name) || [])]);
    const matched = matchingPlans.map((plan) => ({
        name: plan.name,
        relativePath: projectRelativePath(cwd, plan.path),
    }));
    const now = options.now || new Date().toISOString();
    /** @type {Array<{ name: string, relativePath: string }>} */
    const archived = [];
    /** @type {Array<{ name: string, relativePath: string, message: string }>} */
    const failed = [];

    for (const parentPlan of matchingParentPlans) {
        try {
            const result = await archivePlan(cwd, parentPlan.name, { ...options, now });
            archived.push({ name: result.name, relativePath: result.relativePath });
        } catch (error) {
            failed.push({
                name: parentPlan.name,
                relativePath: projectRelativePath(cwd, parentPlan.path),
                message: formatErrorMessage(error),
            });
            continue;
        }

        for (const childPlan of childrenByParent.get(parentPlan.name) || []) {
            try {
                const result = await archivePlan(cwd, childPlan.name, { ...options, force: true, now });
                archived.push({ name: result.name, relativePath: result.relativePath });
            } catch (error) {
                failed.push({
                    name: childPlan.name,
                    relativePath: projectRelativePath(cwd, childPlan.path),
                    message: formatErrorMessage(error),
                });
            }
        }
    }

    return { matched, archived, failed };
}

/**
 * List archived Plans under docs/plans/archived/.
 * @param {string} cwd
 * @returns {Promise<ArchivedPlanEntry[]>}
 */
export async function listArchivedPlans(cwd) {
    return await readLocalHomeStore(
        cwd,
        () => listArchivedPlansInProject(cwd),
        () => [],
    );
}
/** @param {string} cwd @returns {Promise<ArchivedPlanEntry[]>} */
async function listArchivedPlansInProject(cwd) {
    const owner = currentPackageProject();
    if (owner) {
        const catalog = await listPlanPackages(owner, true);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        return (
            await Promise.all(
                catalog.packages
                    .filter((p) => p.metadata.archive && !p.metadata.archive.restoredAt)
                    .map(async (p) => {
                        const plan = await loadPackageWorkflowPlan({ planId: p.metadata.planId });
                        return {
                            name: p.metadata.name,
                            planName: p.metadata.name,
                            path: plan.path,
                            relativePath: projectRelativePath(cwd, plan.path),
                            attrs: plan.attrs,
                            status: plan.attrs.status,
                            summary: plan.attrs.summary || "",
                            planId: p.metadata.planId,
                        };
                    }),
            )
        ).sort((a, b) => a.name.localeCompare(b.name));
    }
    const dir = getArchivedPlansDir(cwd);
    /** @type {Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>} */
    const results = [];
    /** @type {PlanParseIssue[]} */
    const parseIssues = [];
    try {
        await collectPlans(dir, [], results, parseIssues);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    /** @type {import("./plan-store/controllers.ts").ControllerDocumentWorktree[]} */
    let attempts;
    try {
        attempts = await listControllerDocumentWorktrees(cwd);
    } catch (error) {
        if (!(error instanceof ProjectRuntimeReadPendingError)) throw error;
        // Local documents already carry a pending notice; unknown workflow authority cannot replace them.
        attempts = [];
    }
    for (const attempt of attempts) {
        if (attempts.filter((entry) => entry.planName === attempt.planName).length !== 1) continue;
        if (attempt.documentUnavailable) {
            const index = results.findIndex((plan) => plan.name === attempt.planName);
            if (index >= 0) results.splice(index, 1);
            continue;
        }
        const archived = await loadArchivedPlanByName(attempt.path, attempt.planName);
        if (!archived || (attempt.planId && archived.attrs.planId !== attempt.planId)) continue;
        const index = results.findIndex((plan) => plan.name === attempt.planName);
        const item = {
            name: attempt.planName,
            path: archived.path,
            attrs: archived.attrs,
            readAvailability: archived.readAvailability,
        };
        if (index < 0) results.push(item);
        else results[index] = item;
    }
    for (const issue of parseIssues) {
        console.warn(`Skipping malformed archived Plan ${projectRelativePath(cwd, issue.path)}: ${issue.message}`);
    }
    return results
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((plan) => ({
            name: plan.name,
            planName: plan.name,
            relativePath: projectRelativePath(cwd, plan.path),
            path: plan.path,
            attrs: plan.attrs,
            readAvailability: plan.readAvailability,
            status: plan.attrs.status,
            summary: plan.attrs.summary || "",
            planId: plan.attrs.planId,
        }));
}

/**
 * Delete one top-level archived Plan unit. If the Plan has an archived child
 * directory, every file in that directory must be markdown and is removed with
 * the parent Plan.
 *
 * @param {string} cwd
 * @param {string} archivedPlanName
 * @returns {Promise<string[]>}
 */
export async function deleteArchivedPlanUnit(cwd, archivedPlanName) {
    const owner = inspectLocalHomeStore(cwd);
    if (owner.kind === "local" || owner.kind === "empty")
        throw new Error("Personal Plan history retention is not enabled; archived home packages remain available.");
    const location = getArchivedPlanLocation(cwd, archivedPlanName);
    if (location.segments.length !== 1) {
        throw new Error(`Archived Plan prune target must be top-level: ${archivedPlanName}`);
    }
    const directoryPath = join(getArchivedPlansDir(cwd), location.name);

    return await withPlanCatalogLock(cwd, async () => {
        const removedPaths = [];
        let planStat;
        try {
            planStat = await fsStat(location.filePath);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error(`Archived Plan not found: ${location.name}`);
            }
            throw error;
        }
        if (!planStat.isFile()) {
            throw new Error(`Archived Plan is not a file: ${projectRelativePath(cwd, location.filePath)}`);
        }

        let directoryExists = false;
        const directoryEntries = [];
        try {
            const directoryStat = await fsStat(directoryPath);
            if (!directoryStat.isDirectory()) {
                throw new Error(
                    `Refusing to prune ${location.name}: archived Plan directory path is not a directory ${projectRelativePath(
                        cwd,
                        directoryPath,
                    )}`,
                );
            }
            directoryExists = true;
            for await (const entry of await fsReaddir(directoryPath, { withFileTypes: true })) {
                const entryPath = join(directoryPath, entry.name);
                if (!entry.isFile() || !entry.name.endsWith(".md")) {
                    throw new Error(
                        `Refusing to prune ${location.name}: archived Plan directory contains non-markdown entry ${projectRelativePath(
                            cwd,
                            entryPath,
                        )}`,
                    );
                }
                directoryEntries.push(entryPath);
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }

        await fsRm(location.filePath);
        removedPaths.push(projectRelativePath(cwd, location.filePath));
        if (directoryExists) {
            await fsRm(directoryPath, { recursive: true });
            removedPaths.push(...directoryEntries.map((entryPath) => projectRelativePath(cwd, entryPath)));
        }
        await syncDirectory(dirname(location.filePath));
        if (directoryExists) await syncDirectory(dirname(directoryPath));
        return removedPaths.sort((a, b) => a.localeCompare(b));
    });
}

/**
 * @typedef {Object} ArchivedPlanDocument
 * @property {string} name
 * @property {string} path
 * @property {string} markdown
 * @property {PlanFrontMatter} attrs
 * @property {string} body
 * @property {PlanReadAvailability} [readAvailability]
 */

/**
 * @param {string} cwd
 * @param {string} archivedPlanName
 * @returns {Promise<ArchivedPlanDocument | null>}
 */
async function loadArchivedPlanByName(cwd, archivedPlanName) {
    const { name, filePath } = getArchivedPlanLocation(cwd, archivedPlanName);
    let markdown;
    try {
        markdown = await fsReadFile(filePath, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }

    try {
        const { attrs, body } = parsePlanFrontMatter(markdown);
        const current = await withControllerMetadata(filePath, attrs);
        return {
            name,
            path: filePath,
            markdown,
            attrs: current.attrs,
            readAvailability: current.readAvailability,
            body,
        };
    } catch (error) {
        if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
        throw new Error(`Malformed archived Plan ${projectRelativePath(cwd, filePath)}: ${formatErrorMessage(error)}`);
    }
}

/**
 * Load an archived Plan by archived name/path or durable planId.
 * @param {string} cwd
 * @param {string} archivedPlanNameOrId
 * @returns {Promise<ArchivedPlanDocument | null>}
 */
export async function loadArchivedPlan(cwd, archivedPlanNameOrId) {
    return await readLocalHomeStore(
        cwd,
        () => loadArchivedPlanInProject(cwd, archivedPlanNameOrId),
        () => null,
    );
}
/** @param {string} cwd @param {string} archivedPlanNameOrId @returns {Promise<ArchivedPlanDocument | null>} */
async function loadArchivedPlanInProject(cwd, archivedPlanNameOrId) {
    const owner = currentPackageProject();
    if (owner) {
        const catalog = await listPlanPackages(owner, true);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        const selected = catalog.packages.find(
            (p) =>
                p.metadata.name === archivedPlanNameOrId.replace(/^archived\//, "") ||
                p.metadata.planId === archivedPlanNameOrId,
        );
        if (!selected?.metadata.archive || selected.metadata.archive.restoredAt) return null;
        return {
            ...(await loadPackageWorkflowPlan({ planId: selected.metadata.planId })),
            name: selected.metadata.name,
        };
    }
    const name = getArchivedPlanLocation(cwd, archivedPlanNameOrId).name;
    let attempts;
    try {
        attempts = (await listControllerDocumentWorktrees(cwd)).filter((entry) => entry.planName === name);
    } catch (error) {
        if (!(error instanceof ProjectRuntimeReadPendingError)) throw error;
        return await loadArchivedPlanByName(cwd, archivedPlanNameOrId);
    }
    if (attempts.length === 1) {
        assertControllerDocumentAvailable(attempts[0]);
        const archived = await loadArchivedPlanByName(attempts[0].path, name);
        if (archived && (!attempts[0].planId || archived.attrs.planId === attempts[0].planId)) return archived;
    }
    const byName = await loadArchivedPlanByName(cwd, archivedPlanNameOrId);
    if (byName) return byName;

    const planId = normalizePlanId(archivedPlanNameOrId);
    if (!planId) return null;

    const matches = (await listArchivedPlans(cwd)).filter((plan) => plan.planId === planId);
    if (matches.length > 1) {
        throw new Error(`Duplicate archived planId values found for ${planId}; use an archived Plan name instead.`);
    }
    if (matches.length === 0) return null;
    return await loadArchivedPlanByName(getPlanDocumentRoot(matches[0].path), matches[0].name);
}

/**
 * Update front matter for an archived Plan without restoring it.
 * @param {string} cwd
 * @param {string} archivedPlanNameOrId
 * @param {Partial<PlanFrontMatter>} updates
 * @returns {Promise<PlanFrontMatter>}
 */
export async function updateArchivedPlanFrontMatter(cwd, archivedPlanNameOrId, updates) {
    if (!currentPackageProject() && inspectLocalHomeStore(cwd).kind === "local")
        return await withLocalProjectAction(cwd, () =>
            updateArchivedPlanFrontMatter(cwd, archivedPlanNameOrId, updates),
        );
    if (currentPackageProject()) {
        const archived = await loadArchivedPlan(cwd, archivedPlanNameOrId);
        if (!archived) throw new Error(`Archived Plan not found: ${archivedPlanNameOrId}`);
        const current = await loadPackageWorkflowPlan(archived.name);
        return await updatePackageWorkflowMetadata(archived.name, updates, current.revision);
    }
    await prepareWorktreeRegistry(cwd);
    const plan = await loadArchivedPlan(cwd, archivedPlanNameOrId);
    if (!plan) throw new Error(`Archived Plan not found: ${archivedPlanNameOrId}`);
    const prepared = await prepareControllerMetadata(plan.path, parsePlanFrontMatter(plan.markdown).attrs);
    const attrs = { ...prepared.attrs, ...updates, updatedAt: updates.updatedAt ?? new Date().toISOString() };
    const withFm = injectFrontMatter(plan.body, attrs);
    await writePlanMarkdownWithRevision(plan.path, withFm, await getPlanRevisionForText(plan.markdown));
    return parsePlanFrontMatter(withFm).attrs;
}

/**
 * Restore an archived Plan back under docs/plans/.
 * @param {string} cwd
 * @param {string} archivedPlanNameOrId
 * @param {{ to?: string, now?: string }} [options]
 * @returns {Promise<{ name: string, fromPath: string, toPath: string, relativePath: string, attrs: PlanFrontMatter, artifacts?: Array<{ fileName: string, relativePath: string }> }>}
 */
export async function restoreArchivedPlan(cwd, archivedPlanNameOrId, options = {}) {
    if (!currentPackageProject() && (await inspectLocalHomeStore(cwd)).kind === "local")
        return await withLocalProjectAction(cwd, () => restoreArchivedPlan(cwd, archivedPlanNameOrId, options));
    const owner = currentPackageProject();
    if (owner) {
        const archived = await loadArchivedPlan(cwd, archivedPlanNameOrId);
        if (!archived) throw new Error(`Archived Plan not found: ${archivedPlanNameOrId}`);
        return await packageWorkflowLocks([archived.name], async () => {
            let selected = await selectedPackage(archived.name);
            if (options.to && options.to !== archived.name) {
                await renamePlanPackage(owner, selected.metadata.planId, selected.metadata.revision, options.to);
                selected = await selectedPackage({ planId: selected.metadata.planId });
            }
            await restorePlanPackage(owner, selected.metadata.planId, selected.metadata.revision);
            const restored = await loadPackageWorkflowPlan({ planId: selected.metadata.planId });
            return {
                name: selected.metadata.name,
                fromPath: archived.path,
                toPath: restored.path,
                relativePath: projectRelativePath(cwd, restored.path),
                attrs: restored.attrs,
                artifacts: [],
            };
        });
    }
    await prepareWorktreeRegistry(cwd);
    const archived = await resolveArchivedPlanNameOrId(cwd, archivedPlanNameOrId);
    cwd = getPlanDocumentRoot(archived.path);
    const destination = getStoredPlanLocation(cwd, options.to || archived.name);
    if (destination.segments[0] === ARCHIVED_DIR_NAME) {
        throw new Error("Restore destination must be an active Plan name, not archived/...");
    }
    if (await fileExists(destination.filePath)) {
        throw new Error(`Active Plan already exists: ${projectRelativePath(cwd, destination.filePath)}`);
    }

    await prepareControllerMetadata(archived.path, parsePlanFrontMatter(archived.markdown).attrs);
    const now = options.now || new Date().toISOString();
    const markdown = planDocumentMarkdown(
        mergeFrontMatterText(archived.markdown, {
            archivedAt: undefined,
            archiveReason: undefined,
            archivedFromStatus: undefined,
            archivedFromPath: undefined,
            restoredAt: now,
            restoredFromPath: projectRelativePath(cwd, archived.path),
            updatedAt: now,
        }),
    );
    return await withPlanCatalogLock(
        cwd,
        async () =>
            await withPlanLock(cwd, destination.name, async () => {
                const renamedAttempt =
                    destination.name !== archived.name
                        ? (await listControllerDocumentWorktrees(cwd)).find(
                              (entry) =>
                                  entry.planName === archived.name &&
                                  resolve(entry.path) === resolve(cwd) &&
                                  entry.planId === archived.attrs.planId,
                          )
                        : undefined;
                if (
                    destination.name !== archived.name &&
                    (await listPlans(resolvePrimaryCheckoutRoot(cwd))).some((plan) => plan.name === destination.name)
                ) {
                    throw new Error(`Active Plan already exists: ${destination.name}`);
                }
                const lockedArchived = await resolveArchivedPlanNameOrId(cwd, archived.name);
                if (
                    (await getPlanRevisionForText(lockedArchived.markdown)) !==
                    (await getPlanRevisionForText(archived.markdown))
                ) {
                    throw new StalePlanWriteError(
                        await getPlanRevisionForText(archived.markdown),
                        await getPlanRevisionForText(lockedArchived.markdown),
                    );
                }
                if (await fileExists(destination.filePath)) {
                    throw new Error(`Active Plan already exists: ${projectRelativePath(cwd, destination.filePath)}`);
                }
                await fsMkdir(join(getPlansDir(cwd), ...destination.segments.slice(0, -1)), { recursive: true });
                await atomicWriteTextFileIfAbsent(destination.filePath, markdown);
                /** @type {MoveEpicArtifactResult[]} */
                let movedArtifacts = [];
                let renamed = false;
                let sourceRemoved = false;
                try {
                    movedArtifacts =
                        archived.attrs.classification === "PROJECT" && archived.name.split("/").length === 1
                            ? await moveEpicArtifactsFromArchive(cwd, archived.name)
                            : [];
                    await syncDirectory(dirname(destination.filePath));
                    if (renamedAttempt) {
                        await renameRestoredPlanEntry(cwd, renamedAttempt.id, archived.name, destination.name);
                        renamed = true;
                    }
                    await fsRm(archived.path);
                    sourceRemoved = true;
                    await syncDirectory(dirname(archived.path));
                    await syncDirectory(dirname(destination.filePath));
                    for (const artifact of movedArtifacts) await syncDirectory(dirname(artifact.toPath));
                } catch (error) {
                    // Once the archive was removed, the destination is the only copy.
                    // Keep it (and its registry address) even if directory syncing failed.
                    if (sourceRemoved) throw error;
                    if (renamed && renamedAttempt) {
                        await renameRestoredPlanEntry(cwd, renamedAttempt.id, destination.name, archived.name);
                    }
                    for (const artifact of movedArtifacts.toReversed()) {
                        await fs.rename(artifact.toPath, artifact.fromPath).catch(() => {});
                    }
                    await fsRm(destination.filePath).catch(() => {});
                    throw error;
                }
                return {
                    name: destination.name,
                    fromPath: archived.path,
                    toPath: destination.filePath,
                    relativePath: projectRelativePath(cwd, destination.filePath),
                    attrs: parsePlanFrontMatter(markdown).attrs,
                    artifacts: movedArtifacts.map((artifact) => ({
                        fileName: artifact.fileName,
                        relativePath: artifact.relativePath,
                    })),
                };
            }),
    );
}

/**
 * @param {Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>} plans
 * @returns {Map<string, Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>}
 */
function groupExistingPlanIds(plans) {
    /** @type {Map<string, Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>} */
    const byId = new Map();
    for (const plan of plans) {
        if (!plan.attrs.planId) continue;
        const entries = byId.get(plan.attrs.planId) || [];
        entries.push(plan);
        byId.set(plan.attrs.planId, entries);
    }
    return byId;
}

/**
 * @param {Map<string, Array<{ name: string }>>} byId
 */
function assertNoDuplicatePlanIds(byId) {
    const duplicates = [...byId.entries()].filter(([, plans]) => plans.length > 1);
    if (duplicates.length === 0) return;
    const details = duplicates
        .map(([planId, plans]) => `${planId}: ${plans.map((plan) => plan.name).join(", ")}`)
        .join("; ");
    throw new Error(`Duplicate planId values found; repair plan front matter before continuing: ${details}`);
}

/**
 * @typedef {Object} PlanResource
 * @property {string} planName
 * @property {string} name
 * @property {string} relativePath
 * @property {string} path
 * @property {string} planId
 * @property {PlanFrontMatter} attrs
 * @property {string} body
 * @property {string} markdown
 * @property {string} revision
 * @property {PlanReadAvailability} [readAvailability]
 */

/**
 * Ensure a single saved Plan has a durable planId.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {{ idGenerator?: () => string, reservedPlanIds?: Set<string>, collaborationLockBypass?: symbol, onboardExternal?: boolean }} [options]
 * @returns {Promise<PlanResource>}
 */
async function ensurePlanIdentityLocked(cwd, planName, options = {}) {
    const { name } = canonicalizeStoredPlanName(planName);
    return await withPlanLock(cwd, name, async () => {
        const plan = await prepareStoredPlan(cwd, name);
        if (!plan) throw new Error(`Plan not found: ${planName}`);
        if (isHiddenPlanName(name)) {
            throw new Error(`Plan is archived or hidden and cannot be assigned a planId: ${name}`);
        }

        const attempts = await listControllerDocumentWorktrees(cwd);
        const registered = attempts.filter((attempt) => attempt.planName === name);
        for (const entry of registered) assertControllerDocumentAvailable(entry);
        if (registered.length > 1) {
            throw new Error(
                `Registered Plan ${name} has ambiguous document authority. Your files have not been changed.`,
            );
        }
        const registeredPlanId = normalizePlanId(registered[0]?.planId);
        let planId = normalizePlanId(plan.attrs.planId);
        if (registeredPlanId && planId && registeredPlanId !== planId) {
            throw new Error(
                `Registered Plan ${name} does not match the saved Plan ID. Your files have not been changed.`,
            );
        }
        if (
            registeredPlanId &&
            attempts.some(
                (attempt) => attempt.planName !== name && normalizePlanId(attempt.planId) === registeredPlanId,
            )
        ) {
            throw new Error(
                `Registered Plan ID ${registeredPlanId} belongs to multiple Plans. Your files have not been changed.`,
            );
        }
        const plans = await listPlans(cwd);
        const byId = groupExistingPlanIds(plans);
        assertNoDuplicatePlanIds(byId);
        if (registeredPlanId && byId.get(registeredPlanId)?.some((other) => other.name !== name)) {
            throw new Error(
                `Registered Plan ID ${registeredPlanId} belongs to another Plan. Your files have not been changed.`,
            );
        }
        const reservedPlanIds = options.reservedPlanIds || new Set(byId.keys());
        // Registry IDs are already assigned identities, not just collision reservations.
        // Reserve them even when their document is missing from the catalog.
        for (const attempt of attempts) {
            const id = normalizePlanId(attempt.planId);
            if (id) reservedPlanIds.add(id);
        }
        const idGenerator = options.idGenerator || (() => crypto.randomUUID());
        let markdown = plan.markdown;
        let attrs = { ...plan.attrs, planId };

        // A file with no Front Matter has not been onboarded, and a listing is not
        // consent to onboard it. Backfilling here would let opening a Plan Board or
        // reading the worktree registry stamp RunWield metadata into a markdown file
        // the user merely dropped in docs/plans/. Onboarding is deliberate: see
        // onboardExternalPlan(), which /load-plan calls.
        if (!plan.hasFrontMatter && !options.onboardExternal) {
            return {
                planName: name,
                name,
                relativePath: `${PLANS_DIR_NAME}/${name}.md`,
                path: plan.path,
                planId: "",
                attrs: plan.attrs,
                body: plan.body,
                markdown: plan.markdown,
                revision: plan.revision,
            };
        }

        if (!planId) {
            planId = registeredPlanId;
            if (!planId) {
                do {
                    planId = normalizePlanId(idGenerator());
                } while (!planId || reservedPlanIds.has(planId));
            }
            assertSharedPlanWriteAllowed(plan.attrs, options);
            attrs = { ...plan.attrs, planId };
            await bindControllerPlanIdentity(cwd, { planName: name, planId });
            markdown = planDocumentMarkdown(mergeFrontMatterText(plan.markdown, { planId }));
            await writePlanMarkdownWithRevision(plan.path, markdown, plan.revision);
        }

        await finishControllerPlanIdentity(cwd, { planName: name, planId });

        return {
            planName: name,
            name,
            relativePath: `${PLANS_DIR_NAME}/${name}.md`,
            path: plan.path,
            planId,
            attrs: /** @type {PlanFrontMatter} */ (attrs),
            body: parsePlanFrontMatter(markdown).body,
            markdown,
            revision: await getPlanRevisionForText(markdown),
        };
    });
}

/**
 * Ensure a single saved Plan has a durable planId under the shared catalog/Plan lock boundary.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {{ idGenerator?: () => string, reservedPlanIds?: Set<string>, collaborationLockBypass?: symbol, onboardExternal?: boolean }} [options]
 * @returns {Promise<PlanResource>}
 */
export async function ensurePlanIdentity(cwd, planName, options = {}) {
    if (requiresPlanWorkflow(cwd))
        return await withLocalPlanWorkflow(cwd, planName, () => ensurePlanIdentity(cwd, planName, options));
    if (currentPackageProject())
        return await findPlanEvidenceById(cwd, (await selectedPackage(planName)).metadata.planId);
    return await withPlanCatalogLock(cwd, async () => await ensurePlanIdentityLocked(cwd, planName, options));
}

/**
 * Adopt a plain markdown file in `docs/plans/` as a RunWield Plan.
 *
 * Users write Plans in their own editors and drop them in `docs/plans/`. Such a file
 * has no Front Matter, and every read path already tolerates that — parsing
 * yields defaults so nothing panics. What it must not stay is anonymous: without
 * durable metadata it has no identity, no status, and no place in the lifecycle.
 *
 * This is the one place that writes metadata into such a file, and it only ever
 * runs from a deliberate user action (`/load-plan`), never from a listing. The
 * body is preserved byte for byte — the user owns it. `createdAt` comes from the
 * file's own creation time rather than the clock, because the Plan existed before
 * RunWield learned about it and its age is real history.
 *
 * Idempotent: a file that already has Front Matter is returned untouched, so
 * loading a Plan twice cannot rewrite metadata the lifecycle has since set.
 *
 * @param {string} cwd
 * @param {string} planName
 * @param {{ idGenerator?: () => string, now?: () => Date }} [options]
 * @returns {Promise<{ resource: PlanResource, onboarded: boolean }>}
 */
export async function onboardExternalPlan(cwd, planName, options = {}) {
    if (requiresPlanWorkflow(cwd))
        return await withLocalPlanWorkflow(cwd, planName, () => onboardExternalPlan(cwd, planName, options));
    if (currentPackageProject()) return { resource: await ensurePlanIdentity(cwd, planName), onboarded: false };
    const { name } = canonicalizeStoredPlanName(planName);
    const existing = await loadPlan(cwd, name);
    if (!existing) throw new Error(`Plan not found: ${planName}`);
    if (existing.hasFrontMatter) {
        return {
            resource: await ensurePlanIdentity(cwd, name, { idGenerator: options.idGenerator }),
            onboarded: false,
        };
    }

    const fileCreatedAt = await fsStat(existing.path)
        .then((info) => (info.birthtimeMs > 0 ? info.birthtime : info.mtime))
        .catch(() => null);
    const now = options.now ? options.now() : new Date();
    return await withPlanCatalogLock(cwd, async () => {
        const resource = await withPlanLock(cwd, name, async () => {
            const plan = await prepareStoredPlan(cwd, name);
            if (!plan) throw new Error(`Plan not found: ${planName}`);
            // Re-checked under the lock: another onboarding may have won the race, and
            // adopting twice would overwrite the identity the first one established.
            if (plan.hasFrontMatter) return null;
            const markdown = injectFrontMatter(plan.markdown, {
                classification: DEFAULT_FRONT_MATTER.classification,
                complexity: DEFAULT_FRONT_MATTER.complexity,
                summary: DEFAULT_FRONT_MATTER.summary,
                affectedPaths: [],
                createdAt: (fileCreatedAt || now).toISOString(),
                updatedAt: now.toISOString(),
                status: "draft",
                origin: "external",
            });
            await writeControllerState(cwd, { planName: name }, { updatedAt: now.toISOString() });
            await writePlanMarkdownWithRevision(plan.path, markdown, plan.revision);
            return true;
        });
        // planId generation belongs to the identity writer, which already handles
        // collision retry against the whole catalog. Onboarding sets the metadata that
        // makes this file a Plan; that call gives it a durable id.
        return {
            resource: await ensurePlanIdentityLocked(cwd, name, {
                idGenerator: options.idGenerator,
                onboardExternal: true,
            }),
            onboarded: Boolean(resource),
        };
    });
}

/**
 * List non-archived resources without assigning identities or preparing runtime.
 * @param {string} cwd
 * @returns {Promise<PlanResource[]>}
 */
export async function listPlanResources(cwd) {
    return await readLocalHomeStore(
        cwd,
        () => listPlanResourcesInProject(cwd),
        () => [],
    );
}

/**
 * @param {string} cwd
 * @returns {ReturnType<typeof listPlanResources>}
 */
async function listPlanResourcesInProject(cwd) {
    if (currentPackageProject()) return (await readPlanResourceCatalog(cwd)).resources;
    return (await readPlanResources(cwd, false)).resources;
}

/**
 * Read a partial display catalog. This result never authorizes actions or identity writes.
 * @param {string} cwd
 * @returns {Promise<{ resources: PlanResource[], diagnostics: PlanDocumentDiagnostic[] }>}
 */
export async function readPlanResourceCatalog(cwd) {
    return await readLocalHomeStore(
        cwd,
        () => readPlanResourceCatalogInProject(cwd),
        () => ({ resources: [], diagnostics: [] }),
    );
}

/**
 * @param {string} cwd
 * @returns {ReturnType<typeof readPlanResourceCatalog>}
 */
async function readPlanResourceCatalogInProject(cwd) {
    const selection = currentPackageProject();
    if (selection) {
        const catalog = await listPlanPackages(selection);
        const resources = await Promise.all(
            catalog.packages.map(async (entry) => {
                const loaded = await loadPackageWorkflowPlan({ planId: entry.metadata.planId });
                return {
                    ...loaded,
                    planName: entry.metadata.name,
                    name: entry.metadata.name,
                    planId: entry.metadata.planId,
                    relativePath: `plans/${entry.metadata.planId}/context.md`,
                };
            }),
        );
        return {
            resources: resources.sort(comparePlansForList),
            diagnostics: catalog.issues.map((issue) => ({
                name: "Plan package",
                path: issue.path,
                kind: "malformed",
                message: issue.message,
            })),
        };
    }
    return await readPlanResources(cwd, true);
}

/**
 * @param {string} cwd
 * @param {boolean} display
 */
async function readPlanResources(cwd, display) {
    return await withProjectRuntimeReadScope(async () => {
        const { plans, diagnostics } = await readPlansWithTargetChildren(cwd, null, display);
        assertNoDuplicatePlanIds(groupExistingPlanIds(plans));
        /** @type {PlanResource[]} */
        const resources = [];
        for (const plan of plans) {
            const snapshot = /^([a-f0-9]{40,64}):docs\/plans\//.exec(plan.path);
            let loaded;
            try {
                loaded = snapshot
                    ? await loadTargetPlan(cwd, plan.name, snapshot[1])
                    : await loadPlanFileStrict(plan.path);
            } catch (error) {
                if (!display || !(error instanceof PlanFrontMatterParseError)) throw error;
                diagnostics.push({
                    name: plan.name,
                    path: plan.path,
                    kind: "malformed",
                    message: error.cause instanceof Error ? error.cause.message : error.message,
                });
                continue;
            }
            if (!loaded || loaded.kind !== "loaded") {
                if (display && loaded && loaded.kind !== "not_found") {
                    diagnostics.push({
                        name: plan.name,
                        path: plan.path,
                        kind: loaded.kind,
                        message:
                            loaded.kind === "malformed"
                                ? loaded.error.cause instanceof Error
                                    ? loaded.error.cause.message
                                    : loaded.error.message
                                : loaded.kind === "unreadable"
                                  ? loaded.error.message
                                  : loaded.message,
                    });
                }
                continue;
            }
            resources.push({
                planName: plan.name,
                name: plan.name,
                relativePath: `${PLANS_DIR_NAME}/${plan.name}.md`,
                path: plan.path,
                planId: plan.attrs.planId || "",
                attrs: plan.attrs,
                body: loaded.body,
                markdown: loaded.markdown,
                revision: loaded.revision,
                readAvailability: plan.readAvailability,
            });
        }
        return { resources, diagnostics };
    });
}

/**
 * @param {Array<PlanResource>} resources
 * @param {string} normalized
 * @returns {Array<PlanResource>}
 */
function findPlanResourceMatchesById(resources, normalized) {
    const directMatches = resources.filter((resource) => resource.planId === normalized);
    if (directMatches.length > 0) return directMatches;
    return resources.filter((resource) => stripSequencePrefix(resource.planId) === normalized);
}

/** A missing durable ID is distinct from an unreadable or unsafe Plan catalog. */
export class PlanNotFoundError extends Error {
    /** @param {string} planId */
    constructor(planId) {
        super(`Plan not found for planId: ${planId}`);
        this.name = "PlanNotFoundError";
    }
}

/**
 * Find a non-archived Plan resource by durable planId.
 *
 * @param {string} cwd
 * @param {string} planId
 * @returns {Promise<PlanResource>}
 */
export async function findPlanById(cwd, planId) {
    const normalized = normalizePlanId(planId);
    if (!normalized) throw new Error("Plan ID cannot be empty");
    const resources = await listPlanResources(cwd);
    const matches = findPlanResourceMatchesById(resources, normalized);
    if (matches.length > 1) {
        throw new Error(`Duplicate planId values found for ${normalized}; repair plan front matter before continuing.`);
    }
    if (matches.length === 0) throw new PlanNotFoundError(normalized);
    return matches[0];
}

/**
 * Find a Plan by durable ID without writing missing identity metadata.
 *
 * @param {string} cwd
 * @param {string} planId
 * @returns {Promise<PlanResource>}
 */
export async function findPlanEvidenceById(cwd, planId) {
    return await readLocalHomeStore(
        cwd,
        () => findPlanEvidenceByIdInProject(cwd, planId),
        () => {
            throw new PlanNotFoundError(planId);
        },
    );
}
/** @param {string} cwd @param {string} planId @returns {Promise<PlanResource>} */
async function findPlanEvidenceByIdInProject(cwd, planId) {
    if (currentPackageProject()) {
        const plan = await loadPackageWorkflowPlan({ planId });
        const entry = await selectedPackage({ planId });
        return {
            ...plan,
            name: entry.metadata.name,
            planName: entry.metadata.name,
            planId: entry.metadata.planId,
            relativePath: `plans/${entry.metadata.planId}/context.md`,
        };
    }
    return await withProjectRuntimeReadScope(async () => {
        const normalized = normalizePlanId(planId);
        if (!normalized) throw new Error("Plan ID cannot be empty");
        const plans = await listPlans(cwd);
        const matches = plans.filter((plan) => {
            if (plan.attrs.planId === normalized) return true;
            const stripped = stripSequencePrefix(plan.attrs.planId || "");
            return stripped === normalized;
        });
        if (matches.length > 1) {
            throw new Error(
                `Duplicate planId values found for ${normalized}; repair plan front matter before continuing.`,
            );
        }
        if (matches.length === 0) throw new Error(`Plan not found for planId: ${normalized}`);
        // Catalog entries can be Git snapshots. Resolve their document authority without writing or fetching.
        const { plan: loaded } = await resolveWorkflowPlanLocation(cwd, matches[0].name, { readOnly: true });
        if (!loaded) throw new Error(`Plan not found for planId: ${normalized}`);
        const durableId = loaded.attrs.planId;
        if (!durableId) {
            throw new Error(
                "Plan is missing durable planId metadata; adopt or repair it locally before remote action.",
            );
        }
        return {
            planName: matches[0].name,
            name: matches[0].name,
            relativePath: `${PLANS_DIR_NAME}/${matches[0].name}.md`,
            path: loaded.path,
            planId: durableId,
            attrs: loaded.attrs,
            body: loaded.body,
            markdown: loaded.markdown,
            revision: loaded.revision,
            readAvailability: loaded.readAvailability,
        };
    });
}

/**
 * @typedef {PlanResource & { bodyHash: string }} PlanBodyResource
 */

/**
 * Load editable body metadata for a non-archived Plan by durable planId.
 * @param {string} cwd
 * @param {string} planId
 * @returns {Promise<PlanBodyResource>}
 */
export async function loadPlanBodyById(cwd, planId) {
    return await readLocalHomeStore(
        cwd,
        () => loadPlanBodyByIdInProject(cwd, planId),
        () => {
            throw new PlanNotFoundError(planId);
        },
    );
}
/** @param {string} cwd @param {string} planId @returns {Promise<PlanBodyResource>} */
async function loadPlanBodyByIdInProject(cwd, planId) {
    const resource = await findPlanById(cwd, planId);
    if (!currentPackageProject() && isProjectPlan(resource.attrs)) {
        throw new Error("Epic Plan bodies are not editable in the workspace body editor.");
    }
    const markdown = resource.markdown;
    if (!currentPackageProject()) parsePlanFrontMatter(markdown);
    const body = currentPackageProject() ? markdown : splitPlanMarkdownBody(markdown).body;
    return {
        ...resource,
        body,
        markdown,
        bodyHash: await hashPlanBody(body),
    };
}

/**
 * Save only the markdown body while preserving the exact raw front matter block.
 * @param {string} cwd
 * @param {string} planId
 * @param {string} newBody
 * @param {string} expectedBodyHash
 * @param {PlanWriteOptions} [options]
 * @returns {Promise<PlanBodyResource>}
 */
export async function savePlanBodyById(cwd, planId, newBody, expectedBodyHash, options = {}) {
    if (!currentPackageProject() && inspectLocalHomeStore(cwd).kind === "local")
        return await withLocalProjectAction(cwd, () =>
            savePlanBodyById(cwd, planId, newBody, expectedBodyHash, options),
        );
    const selection = currentPackageProject();
    if (selection) {
        return await packageWorkflowLocks([{ planId }], async () => {
            const resource = await findPlanEvidenceById(cwd, planId);
            assertSharedPlanWriteAllowed(resource.attrs, options);
            if (options.expectedRevision !== resource.revision)
                throw new StalePlanWriteError(options.expectedRevision || "required", resource.revision);
            const actual = await hashPlanBody(resource.body);
            if (actual !== expectedBodyHash) throw new StalePlanBodyError(expectedBodyHash, actual);
            await savePlanPackageDocument(selection, planId, "context.md", actual, newBody);
            return { ...(await findPlanEvidenceById(cwd, planId)), bodyHash: await hashPlanBody(newBody) };
        });
    }
    await prepareWorktreeRegistry(cwd);
    return await withPlanCatalogLock(cwd, async () => {
        const resource = await findPlanById(cwd, planId);
        return await withPlanLock(getPlanDocumentRoot(resource.path), resource.planName || resource.name, async () => {
            const selected = await findPlanById(cwd, planId);
            if (selected.path !== resource.path) throw new StalePlanWriteError(resource.revision, selected.revision);
            if (isProjectPlan(resource.attrs)) {
                throw new Error("Epic Plan bodies are not editable in the workspace body editor.");
            }
            const result = await preparePlanFileStrict(resource.path);
            if (result.kind === "malformed") throw result.error;
            if (result.kind !== "loaded") {
                throw new PlanFileIssueError(
                    result.path,
                    result.kind,
                    planIssueMessage(result) || `Plan could not be saved: ${result.path}`,
                );
            }
            const { attrs } = result;
            assertSharedPlanWriteAllowed(attrs, options);
            if (options.expectedRevision === undefined) {
                throw new Error(`Plan body write for ${resource.planName || resource.name} requires expectedRevision.`);
            }
            if (result.revision !== options.expectedRevision) {
                throw new StalePlanWriteError(options.expectedRevision, result.revision);
            }
            const { frontMatterBlock, body } = splitPlanMarkdownBody(result.markdown);
            const currentBodyHash = await hashPlanBody(body);
            if (currentBodyHash !== expectedBodyHash) {
                throw new StalePlanBodyError(expectedBodyHash, currentBodyHash);
            }

            const nextMarkdown = planDocumentMarkdown(`${frontMatterBlock}${newBody}`);
            await writePlanMarkdownWithRevision(result.path, nextMarkdown, result.revision);
            return {
                ...resource,
                attrs,
                body: newBody,
                markdown: nextMarkdown,
                revision: await getPlanRevisionForText(nextMarkdown),
                bodyHash: await hashPlanBody(newBody),
            };
        });
    });
}

/**
 * Find child plans by their loose parentPlan pointer.
 *
 * @param {string} cwd
 * @param {string} parentPlan
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter, readAvailability?: PlanReadAvailability }>>}
 */
export async function findPlansByParent(cwd, parentPlan) {
    return await readLocalHomeStore(
        cwd,
        () => findPlansByParentInProject(cwd, parentPlan),
        () => [],
    );
}

/**
 * @param {string} cwd
 * @param {string} parentPlan
 * @returns {ReturnType<typeof findPlansByParent>}
 */
async function findPlansByParentInProject(cwd, parentPlan) {
    const packageSelection = currentPackageProject();
    if (packageSelection) {
        const parent = await selectedPackage(parentPlan);
        const catalog = await listPlanPackages(packageSelection);
        if (catalog.issues.length) throw new Error(catalog.issues[0].message);
        return (
            await Promise.all(
                catalog.packages
                    .filter((p) => p.metadata.parentPlanId === parent.metadata.planId)
                    .map(async (p) => ({ name: p.metadata.name, ...(await loadPackageWorkflowPlan(p.metadata.name)) })),
            )
        ).sort(compareChildPlansByOrder);
    }
    const { name } = canonicalizeStoredPlanName(parentPlan);
    const plans = await listPlansWithTargetChildren(cwd, name);
    return plans.filter((plan) => plan.attrs.parentPlan === name).sort(compareChildPlansByOrder);
}

/**
 * Resolve child FEATURE dependencies relative to a shared parent Epic.
 *
 * @param {string} cwd
 * @param {string} parentPlan
 * @param {unknown} dependencies
 * @returns {Promise<Array<{ dependency: string, planId?: string, planName?: string, path?: string, status?: string, state: "verified" | "user_verified" | "unverified" | "missing" }>>}
 */
export async function resolveSiblingChildPlanDependencies(cwd, parentPlan, dependencies) {
    const { name: parentPlanName } = canonicalizeStoredPlanName(parentPlan);
    const siblings = await findPlansByParent(cwd, parentPlanName);
    return resolveSiblingChildPlanDependencyStates(parentPlanName, dependencies, siblings);
}

/**
 * Resolve a plan name or path argument to a loadable plan.
 * Stored plans are tried first, including nested names such as
 * `project-breakdown-epic/feature1`. If no stored plan matches and the
 * argument looks like a path (contains / or \, or ends with .md), load it as
 * an external markdown file.
 *
 * @param {string} cwd
 * @param {string} arg - Plan name (e.g., "add-dark-mode" or "epic/feature1") or file path
 * @returns {Promise<{ path: string, markdown: string, attrs: PlanFrontMatter, body: string, revision: string, planName: string, hasFrontMatter?: boolean, readAvailability?: PlanReadAvailability }>}
 */
export async function resolvePlan(cwd, arg) {
    return await readLocalHomeStore(
        cwd,
        () => resolvePlanInProject(cwd, arg),
        () => {
            throw new Error(`Plan not found: ${arg}. Import an external Plan explicitly first.`);
        },
    );
}
/** @param {string} cwd @param {string} arg */
async function resolvePlanInProject(cwd, arg) {
    if (currentPackageProject()) return { ...(await loadPackageWorkflowPlan(arg)), planName: arg };
    try {
        const plan = await loadPlan(cwd, arg);
        if (plan) {
            const { name } = canonicalizeStoredPlanName(arg);
            return { ...plan, planName: name };
        }
    } catch (error) {
        if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
        // Not a valid stored plan name. Fall through to external path handling.
    }

    const isPath = arg.includes("/") || arg.includes("\\") || arg.endsWith(".md");

    if (isPath) {
        const absPath = resolve(cwd, arg);
        const projectRelative = relative(cwd, absPath).replaceAll("\\", "/");
        if (projectRelative === "plans" || projectRelative.startsWith("plans/")) {
            throw new Error(
                `Legacy Plan path is not supported: ${projectRelative}. RunWield reads Plans only from ${PLANS_DIR_NAME}/.`,
            );
        }
        const plan = await loadExternalPlan(absPath);
        const planName = basename(absPath, ".md");
        return { ...plan, planName };
    }

    throw new Error(`Plan not found: ${arg}. Use '${CLI_BIN} plans' to list available plans.`);
}
