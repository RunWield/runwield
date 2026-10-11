import { isProjectPlan } from "./shared/project-plan.ts";
export { isEpicPlan, isProjectPlan, isSequencePlan } from "./shared/project-plan.ts";
/**
 * @module plan-store
 * Manages plan persistence: front matter injection, save/load/list, and
 * resumption of saved or external plans.
 *
 * Plans live in `<project root>/docs/plans/` as markdown files with YAML front matter.
 * The plan "id" is the filename without .md.
 * External plans (missing front matter) get sensible defaults applied.
 */

import { extractYaml, test as hasFrontMatter } from "@std/front-matter";
import { readLockFileSnapshot, removeLockFileIfSnapshotMatches } from "./shared/lock-file-snapshot.ts";
import { getLockHostname, isLockHolderGone } from "./shared/process-liveness.ts";
import { basename, dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { AsyncLocalStorage } from "node:async_hooks";
import {
    CLI_BIN,
    isPlannedChangeClassification,
    normalizePlanClassification,
    normalizeWorkKind,
    PLANS_DIR_NAME,
    ROUTING_INTENT_PLANNED_CHANGE,
} from "./constants.js";
import { PLAN_FRONT_MATTER_KEY_ORDER, PLAN_FRONT_MATTER_KEYS } from "./plan-front-matter.ts";
import { normalizeTicketReferences } from "./shared/ticket-references.js";
import { normalizePlanDeviations } from "./shared/plan-deviations.ts";
import { resolveWorkflowPlanLocation } from "./shared/workflow/plan-location.ts";
import { findTargetBranchPlansByParent } from "./shared/workflow/planning-worktree.ts";
import { renameRestoredPlanEntry } from "./shared/worktree-registry.js";
import { resolvePrimaryCheckoutRoot } from "./shared/primary-checkout.ts";
import { writePlanDocumentAndController } from "./shared/workflow/state-transition.ts";
import { escapeYamlDoubleQuoted } from "./shared/yaml-scalar.ts";
import { requestWorkspaceSearchRefresh } from "./shared/workspace-search-refresh.ts";
import { pickControllerState, PLAN_RUNTIME_FIELDS, stripRuntimeFields } from "./shared/workflow/controller-state.ts";
import {
    enterProjectRuntime,
    ProjectRuntimeEntryRefusedError,
    withProjectRuntimeReadScope,
} from "./shared/project-runtime-layout.ts";
import {
    bindControllerPlanIdentity,
    finishControllerPlanIdentity,
    inspectControllerView,
    listControllerDocumentWorktrees,
    loadControllerView,
    writeControllerState,
} from "./shared/workflow/controller-registry.ts";
import {
    assertSharedPlanWriteAllowed,
    COLLABORATION_FRONT_MATTER_KEYS,
    COLLABORATION_LOCK_BYPASS,
    COLLABORATION_STATE_REMOTE_CANONICAL,
    normalizeCollaborationFrontMatter,
} from "./shared/collaboration/lock.ts";
import {
    assertNotReservedEpicArtifactPlanName,
    isEpicArtifactPlanName,
    moveEpicArtifactsFromArchive,
    moveEpicArtifactsToArchive,
} from "./shared/epic-artifacts.ts";

/** @typedef {import("./shared/epic-artifacts.ts").MoveEpicArtifactResult} MoveEpicArtifactResult */
/** @typedef {import("./shared/plan-deviations.ts").PlanDeviation} PlanDeviation */

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
        await Deno.mkdir(dir, { recursive: true });
    } catch {
        // already exists, fine
    }
    return dir;
}

/**
 * Canonicalize a stored plan name relative to docs/plans/.
 * @param {string} planName
 * @returns {{ name: string, segments: string[] }}
 */
export function canonicalizeStoredPlanName(planName) {
    let normalized = String(planName || "").trim().replaceAll("\\", "/");
    if (normalized.toLowerCase().endsWith(".md")) {
        normalized = normalized.slice(0, -3);
    }
    if (/^docs\/plans\//i.test(normalized)) {
        normalized = normalized.replace(/^docs\/plans\//i, "");
    }

    if (!normalized) throw new Error("Plan name cannot be empty");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
        throw new Error(`Plan name must be relative to ${PLANS_DIR_NAME}/: ${planName}`);
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Plan name cannot escape ${PLANS_DIR_NAME}/: ${planName}`);
    }

    return { name: segments.join("/"), segments };
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

// ─── Front Matter ─────────────────────────────────────────────────────

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
 * @property {string} [planId] - Durable project-scoped resource identity for URL/addressable Plan lookup
 * @property {"QUICK_FIX"|"PLANNED_CHANGE"|"FEATURE"|"PROJECT"} classification
 * @property {"BUG_FIX"|"FEATURE"|"REFACTOR"|"MAINTENANCE"|"DOCUMENTATION"} [workKind] - Optional nature of planned executable work; legacy classification FEATURE does not imply this.
 * @property {string} [type] - PROJECT capability: epic (default) or sequence. Invalid values remain visible for correction.
 * @property {"LOW"|"MEDIUM"|"HIGH"} complexity
 * @property {string[]} affectedPaths - Files that will be created/modified
 * @property {import('./shared/ticket-references.js').TicketReference[]} [tickets] - Optional provider-neutral Ticket References identified by the user.
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
 * @property {"draft"|"feedback"|"approved"|"ready_for_decomposition"|"ready_for_work"|"in_progress"|"failed"|"implemented"|"validated_ci"|"reviewed"|"validated"|"verified"|"user_verified"|"closed_without_verification"|"on_hold"} status
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
 * @property {import('./shared/ticket-references.js').TicketReference[]} [tickets] - Direct child Ticket References; omitted preserves existing child references, [] clears.
 * @property {string} content - Planner-format markdown body for the child planned change.
 * @property {"BUG_FIX"|"FEATURE"|"REFACTOR"|"MAINTENANCE"|"DOCUMENTATION"} [workKind] - Optional child Work Kind.
 * @property {number} [order] - Optional stable execution order used in front matter and the file name.
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
 * Default front matter for plans.
 * @type     {PlanFrontMatter}
 */
const DEFAULT_FRONT_MATTER = {
    classification: "PLANNED_CHANGE",
    complexity: "MEDIUM",
    summary: "",
    affectedPaths: [],
    get createdAt() {
        return new Date().toISOString();
    },
    status: "draft",
    origin: "internal",
};

/** @type {Set<string>} */
const KNOWN_FRONT_MATTER_KEYS = new Set(PLAN_FRONT_MATTER_KEY_ORDER);

export const OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS = Object.freeze([
    "objectiveChecks",
    "objectiveChecksBaseline",
    "objectiveCheckWaivers",
    "validationObjectiveCheckAttempts",
]);

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

const HIDDEN_PLAN_DIRS = new Set(["archived"]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSupportedYamlValue(value) {
    if (value === null) return true;
    if (["string", "number", "boolean"].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.every(isSupportedYamlValue);
    if (value && typeof value === "object") {
        return Object.values(/** @type {Record<string, unknown>} */ (value)).every(isSupportedYamlValue);
    }
    return false;
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @param {unknown} value
 */
function appendYamlField(lines, key, value) {
    appendYamlValue(lines, key, value, 0, { emptyArrays: true });
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @param {unknown} value
 * @param {number} indent
 * @param {{ emptyArrays?: boolean }} [options]
 */
function appendYamlValue(lines, key, value, indent, options = {}) {
    if (value === undefined) return;
    if (!isSupportedYamlValue(value)) return;
    const pad = " ".repeat(indent);

    if (Array.isArray(value)) {
        lines.push(`${pad}${key}:`);
        if (value.length === 0) {
            if (options.emptyArrays !== false) lines.push(`${pad}  []`);
        } else {
            for (const item of value) appendYamlListItem(lines, item, indent + 2, options);
        }
        return;
    }

    if (value && typeof value === "object") {
        const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).filter(([, child]) => {
            if (child === undefined) return false;
            if (Array.isArray(child) && child.length === 0 && options.emptyArrays === false) return false;
            if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
                return false;
            }
            return true;
        });
        if (!entries.length) return;
        lines.push(`${pad}${key}:`);
        for (const [childKey, childValue] of entries) appendYamlValue(lines, childKey, childValue, indent + 2, options);
        return;
    }

    if (typeof value === "string") lines.push(`${pad}${key}: "${escapeYamlDoubleQuoted(value)}"`);
    else if (value === null) lines.push(`${pad}${key}: null`);
    else lines.push(`${pad}${key}: ${String(value)}`);
}

/**
 * @param {string[]} lines
 * @param {unknown} value
 * @param {number} indent
 * @param {{ emptyArrays?: boolean }} options
 */
function appendYamlListItem(lines, value, indent, options) {
    const pad = " ".repeat(indent);
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).filter(([, child]) =>
            child !== undefined
        );
        if (!entries.length) return;
        const [firstKey, firstValue] = entries[0];
        if (typeof firstValue === "string") lines.push(`${pad}- ${firstKey}: "${escapeYamlDoubleQuoted(firstValue)}"`);
        else if (firstValue === null) lines.push(`${pad}- ${firstKey}: null`);
        else if (["number", "boolean"].includes(typeof firstValue)) {
            lines.push(`${pad}- ${firstKey}: ${String(firstValue)}`);
        } else {
            lines.push(`${pad}- ${firstKey}:`);
            appendYamlListItem(lines, firstValue, indent + 2, options);
        }
        for (const [childKey, childValue] of entries.slice(1)) {
            appendYamlValue(lines, childKey, childValue, indent + 2, options);
        }
        return;
    }
    if (typeof value === "string") lines.push(`${pad}- "${escapeYamlDoubleQuoted(value)}"`);
    else if (value === null) lines.push(`${pad}- null`);
    else lines.push(`${pad}- ${String(value)}`);
}

/**
 * Build YAML front matter string from a PlanFrontMatter object.
 * @param {PlanFrontMatter} fm
 * @returns {string}
 */
function formatFrontMatter(fm) {
    const lines = ["---"];
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.planId, fm.planId);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.classification, fm.classification);
    if (fm.classification === "PROJECT") appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.type, fm.type);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.workKind, fm.workKind);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.complexity, fm.complexity);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.summary, fm.summary);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.affectedPaths, fm.affectedPaths);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.tickets, fm.tickets);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.supersedes, fm.supersedes);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.planDeviations, fm.planDeviations);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.executionAgent, fm.executionAgent);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationRecommendation, fm.collaborationRecommendation);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.frontend, fm.frontend);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.devServerCommand, fm.devServerCommand);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.devServerUrl, fm.devServerUrl);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.devServerHmr, fm.devServerHmr);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.createdAt, fm.createdAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.updatedAt, fm.updatedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.status, fm.status);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.origin, fm.origin);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.parentPlan, fm.parentPlan);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.order, fm.order);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.dependencies, fm.dependencies);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.failureReason, fm.failureReason);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.failedAt, fm.failedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.implementedAt, fm.implementedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.validatedAt, fm.validatedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.verifiedAt, fm.verifiedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.userVerifiedAt, fm.userVerifiedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.userVerificationNote, fm.userVerificationNote);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.closedWithoutVerificationReason, fm.closedWithoutVerificationReason);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.closedWithoutVerificationAt, fm.closedWithoutVerificationAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.executionReport, fm.executionReport);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.workRecord, fm.workRecord);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.humanReviewMode, fm.humanReviewMode);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.humanReviewDecision, fm.humanReviewDecision);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.humanReviewedAt, fm.humanReviewedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.validationCheckpoint, fm.validationCheckpoint);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.epicCompletionMode, fm.epicCompletionMode);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.epicDoneEnoughAt, fm.epicDoneEnoughAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.epicDoneEnoughSummary, fm.epicDoneEnoughSummary);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.epicBaseCommit, fm.epicBaseCommit);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.epicDeliveryTargetBranch, fm.epicDeliveryTargetBranch);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.epicIntegrationReport, fm.epicIntegrationReport);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.executionMode, fm.executionMode);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.deliveryEvidence, fm.deliveryEvidence);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.executionBaselineTree, fm.executionBaselineTree);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.worktreeId, fm.worktreeId);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.worktreePath, fm.worktreePath);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.worktreeBranch, fm.worktreeBranch);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.worktreeBaseBranch, fm.worktreeBaseBranch);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.targetBranch, fm.targetBranch);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.deliveryBranch, fm.deliveryBranch);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.validatedCommit, fm.validatedCommit);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.worktreeStatus, fm.worktreeStatus);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.heldFromStatus, fm.heldFromStatus);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.heldAt, fm.heldAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.holdReason, fm.holdReason);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.holdStalenessBaseline, fm.holdStalenessBaseline);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.archivedAt, fm.archivedAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.archiveReason, fm.archiveReason);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.archivedFromStatus, fm.archivedFromStatus);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.archivedFromPath, fm.archivedFromPath);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.restoredAt, fm.restoredAt);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.restoredFromPath, fm.restoredFromPath);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationState, fm.collaborationState);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationServerUrl, fm.collaborationServerUrl);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationSpaceId, fm.collaborationSpaceId);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationRevision, fm.collaborationRevision);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationBodyHash, fm.collaborationBodyHash);
    appendYamlField(lines, PLAN_FRONT_MATTER_KEYS.collaborationSyncedAt, fm.collaborationSyncedAt);

    for (const key of Object.keys(fm).filter((key) => !KNOWN_FRONT_MATTER_KEYS.has(key)).sort()) {
        appendYamlField(lines, key, /** @type {Record<string, unknown>} */ (fm)[key]);
    }

    lines.push("---");
    return lines.join("\n");
}

/**
 * @param {string} frontMatter
 * @param {string} body
 * @returns {string}
 */
function joinFrontMatterAndBody(frontMatter, body) {
    const trimmedBody = body.trimStart();
    if (!trimmedBody) return `${frontMatter}\n`;
    return `${frontMatter}\n\n${trimmedBody}`;
}

const PLAN_STATUSES = new Set([
    "draft",
    "feedback",
    "approved",
    "ready_for_decomposition",
    "ready_for_work",
    "in_progress",
    "failed",
    "implemented",
    "validated_ci",
    "reviewed",
    "validated",
    "verified",
    "user_verified",
    "closed_without_verification",
    "on_hold",
]);

const PLAN_LIST_STATUS_ORDER = new Map([
    ["failed", 0],
    ["implemented", 1],
    ["validated_ci", 1],
    ["reviewed", 1],
    ["validated", 8],
    ["ready_for_work", 2],
    ["ready_for_decomposition", 3],
    ["draft", 4],
    ["feedback", 5],
    ["approved", 6],
    ["in_progress", 7],
    ["verified", 8],
    ["user_verified", 9],
    ["closed_without_verification", 10],
    ["on_hold", 10],
]);

const PLAN_LIST_CLASSIFICATION_ORDER = new Map([
    ["PROJECT", 0],
    ["PLANNED_CHANGE", 1],
    ["FEATURE", 1],
    ["QUICK_FIX", 2],
]);

const LEGACY_PLAN_STATUSES = new Map([
    ["validated_reviewer", "reviewed"],
    ["completed", "verified"],
    ["in_review", "feedback"],
    // Older/manual recovery copies used this to mean implementation was done
    // and Workflow Validation had not started yet.
    ["ready_for_review", "implemented"],
]);

/**
 * Return the current lifecycle name for a current or retired Plan status.
 * Truly unknown values remain unknown so callers can fail closed.
 *
 * @param {string | undefined} status
 * @returns {PlanFrontMatter["status"] | undefined}
 */
export function canonicalPlanStatus(status) {
    const legacy = status ? LEGACY_PLAN_STATUSES.get(status) : undefined;
    if (legacy) return /** @type {PlanFrontMatter["status"]} */ (legacy);
    if (status && PLAN_STATUSES.has(status)) {
        return /** @type {PlanFrontMatter["status"]} */ (status);
    }
    return undefined;
}

/**
 * Read the status exactly as the Plan declares it, before compatibility normalization.
 * @param {string} planContent
 * @returns {string | undefined}
 */
export function getDeclaredPlanStatus(planContent) {
    if (!planContent.startsWith("---")) return undefined;
    const parsed = extractYaml(planContent);
    return typeof parsed.attrs?.status === "string" ? parsed.attrs.status : undefined;
}

/**
 * Normalize legacy statuses from older saved plans into the current lifecycle.
 *
 * @param {string | undefined} status
 * @returns {PlanFrontMatter["status"]}
 */
function normalizePlanStatus(status) {
    return canonicalPlanStatus(status) || DEFAULT_FRONT_MATTER.status;
}

/** @param {string | undefined | null} status */
export function isRunWieldVerifiedStatus(status) {
    return status === "validated" || status === "verified";
}

/** @param {string | undefined | null} status */
export function isUserVerifiedStatus(status) {
    return status === "user_verified";
}

/** @param {string | undefined | null} status */
export function isPlanDependencySatisfiedStatus(status) {
    return status === "validated" || status === "verified" || status === "user_verified";
}

/** @param {string | undefined | null} status */
export function isCompletedPlanStatus(status) {
    return status === "validated" || status === "verified" || status === "user_verified" ||
        status === "closed_without_verification";
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function normalizeOptionalBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
    }
    return undefined;
}

/** @param {unknown} value @returns {"engineer"|"frontend-engineer"|undefined} */
export function normalizeExecutionAgent(value) {
    return value === "engineer" || value === "frontend-engineer" ? value : undefined;
}

/** @param {unknown} value @returns {"pair"|"autonomous"|undefined} */
export function normalizeCollaborationMode(value) {
    return value === "pair" || value === "autonomous" ? value : undefined;
}

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
 * @param {unknown} value
 * @returns {boolean}
 */
function hasExplicitPolicyValue(value) {
    return value !== undefined && value !== null && value !== "";
}

/**
 * Resolve and validate Plan execution policy without mutating source Front Matter.
 *
 * @param {Partial<PlanFrontMatter>} meta
 * @returns {PlanExecutionPolicySuccess | PlanExecutionPolicyError}
 */
export function resolvePlanExecutionPolicy(meta) {
    const classification = normalizePlanClassification(meta.classification || DEFAULT_FRONT_MATTER.classification);
    const explicitAgent = hasExplicitPolicyValue(meta.executionAgent);
    const explicitRecommendation = hasExplicitPolicyValue(meta.collaborationRecommendation);
    const validAgent = normalizeExecutionAgent(meta.executionAgent);
    const validRecommendation = normalizeCollaborationMode(meta.collaborationRecommendation);

    if (explicitAgent && !validAgent) {
        return {
            ok: false,
            reason: "invalid_execution_agent",
            error: `Invalid executionAgent: ${
                String(meta.executionAgent)
            }. Supported values are engineer and frontend-engineer.`,
        };
    }
    if (explicitRecommendation && !validRecommendation) {
        return {
            ok: false,
            reason: "invalid_collaboration_recommendation",
            error: `Invalid collaborationRecommendation: ${
                String(meta.collaborationRecommendation)
            }. Supported values are autonomous and pair.`,
        };
    }
    if (classification === "PROJECT") {
        if (explicitAgent) {
            return {
                ok: false,
                reason: "project_execution_agent",
                error: "PROJECT Epics are non-executable and must not define executionAgent.",
            };
        }
        if (explicitRecommendation) {
            return {
                ok: false,
                reason: "project_collaboration_recommendation",
                error: "PROJECT Epics are non-executable and must not define collaborationRecommendation.",
            };
        }
        return {
            ok: false,
            reason: "project_epic",
            error: "PROJECT Epics are non-executable and do not have an execution owner.",
        };
    }

    const isPlannedChange = isPlannedChangeClassification(classification);
    const executionAgent = isPlannedChange && validAgent
        ? validAgent
        : isPlannedChange && meta.frontend === true
        ? "frontend-engineer"
        : "engineer";
    const source = isPlannedChange && validAgent
        ? "canonical"
        : isPlannedChange && meta.frontend === true
        ? "legacy_frontend"
        : isPlannedChange && meta.frontend === false
        ? "legacy_frontend_false"
        : "absent";
    return {
        ok: true,
        policy: {
            executionAgent,
            collaborationRecommendation: validRecommendation || "autonomous",
            source,
        },
    };
}

/**
 * @param {Partial<PlanFrontMatter>} attempted
 * @param {Partial<PlanFrontMatter>} merged
 */
function assertExecutionPolicyWriteAllowed(attempted, merged) {
    const writesPolicy = Object.hasOwn(attempted, "executionAgent") ||
        Object.hasOwn(attempted, "collaborationRecommendation") ||
        Object.hasOwn(attempted, "classification") ||
        Object.hasOwn(attempted, "frontend");
    if (!writesPolicy) return;
    const result = resolvePlanExecutionPolicy(merged);
    if (!result.ok && result.reason !== "project_epic") throw new Error(result.error);
}

/**
 * Return an optional front matter value, allowing explicit null to clear it.
 *
 * @param {Partial<PlanFrontMatter>} overrides
 * @param {Partial<PlanFrontMatter>} existingFm
 * @param {keyof PlanFrontMatter} key
 * @returns {string | null | undefined}
 */
function optionalFrontMatterValue(overrides, existingFm, key) {
    if (Object.hasOwn(overrides, key)) {
        return /** @type {string | null | undefined} */ (overrides[key] ?? undefined);
    }
    return /** @type {string | null | undefined} */ (existingFm[key]);
}

/**
 * @param {Partial<PlanFrontMatter>} overrides
 * @param {Partial<PlanFrontMatter>} existingFm
 * @param {keyof PlanFrontMatter} key
 * @returns {string | undefined}
 */
function optionalStringValue(overrides, existingFm, key) {
    if (Object.hasOwn(overrides, key)) {
        const value = overrides[key];
        return typeof value === "string" ? value : undefined;
    }
    const value = existingFm[key];
    return typeof value === "string" ? value : undefined;
}

/**
 * @param {Partial<PlanFrontMatter>} overrides
 * @param {Partial<PlanFrontMatter>} existingFm
 * @param {keyof PlanFrontMatter} key
 * @returns {unknown}
 */
function optionalExecutionPolicyValue(overrides, existingFm, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key] ?? undefined;
    return existingFm[key] ?? undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizePlanId(value) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function normalizeStringList(value) {
    return Array.isArray(value) ? value.map(String) : undefined;
}

const WORK_RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalize optional Work Record supersession IDs without coercing malformed values.
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function normalizeSupersedes(value) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
    const normalized = [];
    const seen = new Set();
    for (const item of value) {
        const recordId = item.trim();
        if (!recordId) continue;
        if (!WORK_RECORD_ID_RE.test(recordId)) return undefined;
        const identity = recordId.toLowerCase();
        if (seen.has(identity)) continue;
        seen.add(identity);
        normalized.push(recordId);
    }
    return normalized.length > 0 ? normalized : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function normalizeNonNegativeInteger(value) {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 0 ? value : undefined;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
    }
    return undefined;
}

/**
 * @param {unknown} status
 * @returns {PlanFrontMatter["status"] | null | undefined}
 */
function normalizePlanStatusForOptionalHold(status) {
    if (status === null) return null;
    if (typeof status !== "string") return undefined;
    const normalized = normalizePlanStatus(status);
    return normalized === DEFAULT_FRONT_MATTER.status && status !== DEFAULT_FRONT_MATTER.status
        ? undefined
        : normalized;
}

/**
 * @param {unknown} status
 * @returns {PlanFrontMatter["worktreeStatus"]}
 */
function normalizeWorktreeStatus(status) {
    const allowed = new Set([
        "none",
        "planning",
        "active",
        "completed",
        "execution_failed",
        "validation_failed",
        "merge_conflict",
        "merged",
        "abandoned",
    ]);
    if (typeof status === "string" && allowed.has(status)) {
        return /** @type {PlanFrontMatter["worktreeStatus"]} */ (status);
    }
    return undefined;
}

/**
 * @param {unknown} value
 * @returns {ExecutionMode | undefined}
 */
export function normalizeExecutionMode(value) {
    if (value === "worktree" || value === "non_git_in_place") return value;
    return undefined;
}

/** @param {unknown} value */
function isShaLike(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * @param {unknown} value
 * @returns {DeliveryEvidence | undefined}
 */
export function normalizeDeliveryEvidence(value) {
    if (value === null) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const evidence = /** @type {Record<string, unknown>} */ (value);
    if (evidence.version !== 1) return undefined;
    if (evidence.mode === "non_git_in_place") return { version: 1, mode: "non_git_in_place" };
    if (evidence.mode === "worktree_merge") {
        const executionCommit = evidence.executionCommit;
        const targetBranch = evidence.targetBranch;
        const targetHeadBeforeMerge = evidence.targetHeadBeforeMerge;
        if (!isShaLike(executionCommit) || typeof targetBranch !== "string" || !targetBranch.trim()) return undefined;
        if (!isShaLike(targetHeadBeforeMerge)) return undefined;
        return {
            version: 1,
            mode: "worktree_merge",
            executionCommit: String(executionCommit),
            targetBranch: targetBranch.trim(),
            targetHeadBeforeMerge: String(targetHeadBeforeMerge),
        };
    }
    return undefined;
}

/**
 * @param {unknown} mode
 * @returns {PlanFrontMatter["humanReviewMode"]}
 */
function normalizeHumanReviewMode(mode) {
    if (mode === null) return null;
    if (mode === "none" || mode === "ask" || mode === "always") return mode;
    return undefined;
}

/**
 * @param {unknown} decision
 * @returns {PlanFrontMatter["humanReviewDecision"]}
 */
function normalizeHumanReviewDecision(decision) {
    if (decision === null) return null;
    if (decision === "not_required" || decision === "skipped" || decision === "approved") return decision;
    // Not a final decision: the user read the diff and asked for changes, so they own
    // this Plan's review from here. It survives the repair round so the Semantic Code
    // Reviewer knows to stand down and hand the diff straight back to them.
    if (decision === "changes_requested") return decision;
    return undefined;
}

/**
 * @param {unknown} value
 * @returns {PlanFrontMatter["workRecord"]}
 */
function normalizeWorkRecordBacklink(value) {
    if (!value || typeof value !== "object") return undefined;
    const source = /** @type {Record<string, unknown>} */ (value);
    const status = source.status === "generated" || source.status === "failed" ? source.status : undefined;
    const recordId = typeof source.recordId === "string" && source.recordId.trim() ? source.recordId.trim() : undefined;
    const path = typeof source.path === "string" && source.path.trim() ? source.path.trim() : undefined;
    const lastAttemptAt = typeof source.lastAttemptAt === "string" && source.lastAttemptAt.trim()
        ? source.lastAttemptAt.trim()
        : undefined;
    const error = typeof source.error === "string" && source.error.trim() ? source.error.trim() : undefined;
    if (!status && !recordId && !path && !lastAttemptAt && !error) return undefined;
    return {
        ...(status ? { status } : {}),
        ...(recordId ? { recordId } : {}),
        ...(path ? { path } : {}),
        ...(lastAttemptAt ? { lastAttemptAt } : {}),
        ...(error ? { error } : {}),
    };
}

/**
 * Inject or update front matter on a plan's markdown content.
 * If front matter already exists, merge with existing values.
 *
 * @param {string} markdown - The plan content (may or may not have front matter)
 * @param {Partial<PlanFrontMatter>} overrides - Fields to inject/override
 * @returns {string} The markdown with front matter
 */
export function injectFrontMatter(markdown, overrides = {}) {
    /** @type {Partial<PlanFrontMatter>} */
    let existingFm = {};
    let body = markdown;

    if (hasFrontMatter(markdown)) {
        const { attrs, body: b } = extractYaml(markdown);
        existingFm = attrs || {};
        body = b;
    }

    /** @type {PlanFrontMatter} */
    const fm = {
        ...existingFm,
        ...overrides,
        planId: Object.hasOwn(overrides, "planId")
            ? normalizePlanId(overrides.planId)
            : normalizePlanId(existingFm.planId),
        classification: normalizePlanClassification(
            overrides.classification ??
                existingFm.classification ??
                DEFAULT_FRONT_MATTER.classification,
        ),
        workKind: Object.hasOwn(overrides, "workKind")
            ? normalizeWorkKind(overrides.workKind)
            : normalizeWorkKind(existingFm.workKind),
        complexity: overrides.complexity ??
            existingFm.complexity ??
            DEFAULT_FRONT_MATTER.complexity,
        summary: overrides.summary ?? existingFm.summary ?? DEFAULT_FRONT_MATTER.summary,
        affectedPaths: overrides.affectedPaths ??
            existingFm.affectedPaths ??
            DEFAULT_FRONT_MATTER.affectedPaths,
        tickets: Object.hasOwn(overrides, "tickets")
            ? normalizeTicketReferences(overrides.tickets)
            : normalizeTicketReferences(existingFm.tickets),
        supersedes: Object.hasOwn(overrides, "supersedes")
            ? normalizeSupersedes(overrides.supersedes)
            : normalizeSupersedes(existingFm.supersedes),
        planDeviations: Object.hasOwn(overrides, "planDeviations")
            ? normalizePlanDeviations(overrides.planDeviations)
            : normalizePlanDeviations(existingFm.planDeviations),
        executionAgent: optionalExecutionPolicyValue(overrides, existingFm, "executionAgent"),
        collaborationRecommendation: optionalExecutionPolicyValue(overrides, existingFm, "collaborationRecommendation"),
        frontend: Object.hasOwn(overrides, "frontend")
            ? normalizeOptionalBoolean(overrides.frontend)
            : normalizeOptionalBoolean(existingFm.frontend),
        devServerCommand: optionalFrontMatterValue(overrides, existingFm, "devServerCommand"),
        devServerUrl: optionalFrontMatterValue(overrides, existingFm, "devServerUrl"),
        devServerHmr: Object.hasOwn(overrides, "devServerHmr")
            ? normalizeOptionalBoolean(overrides.devServerHmr)
            : normalizeOptionalBoolean(existingFm.devServerHmr),
        createdAt: overrides.createdAt ??
            existingFm.createdAt ??
            DEFAULT_FRONT_MATTER.createdAt,
        updatedAt: overrides.updatedAt ?? existingFm.updatedAt ?? new Date().toISOString(),
        status: normalizePlanStatus(overrides.status ?? existingFm.status),
        origin: overrides.origin ?? existingFm.origin ?? "internal",
        parentPlan: optionalStringValue(overrides, existingFm, "parentPlan"),
        order: Object.hasOwn(overrides, "order")
            ? normalizeNonNegativeInteger(overrides.order)
            : normalizeNonNegativeInteger(existingFm.order),
        dependencies: Object.hasOwn(overrides, "dependencies")
            ? normalizeStringList(overrides.dependencies)
            : normalizeStringList(existingFm.dependencies),
        failureReason: optionalFrontMatterValue(overrides, existingFm, "failureReason"),
        failedAt: optionalFrontMatterValue(overrides, existingFm, "failedAt"),
        implementedAt: optionalFrontMatterValue(overrides, existingFm, "implementedAt"),
        validatedAt: optionalFrontMatterValue(overrides, existingFm, "validatedAt"),
        verifiedAt: optionalFrontMatterValue(overrides, existingFm, "verifiedAt"),
        closedWithoutVerificationReason: optionalFrontMatterValue(
            overrides,
            existingFm,
            "closedWithoutVerificationReason",
        ),
        closedWithoutVerificationAt: optionalFrontMatterValue(overrides, existingFm, "closedWithoutVerificationAt"),
        executionReport: optionalFrontMatterValue(overrides, existingFm, "executionReport"),
        workRecord: Object.hasOwn(overrides, "workRecord")
            ? normalizeWorkRecordBacklink(overrides.workRecord)
            : normalizeWorkRecordBacklink(existingFm.workRecord),
        humanReviewMode: normalizeHumanReviewMode(
            Object.hasOwn(overrides, "humanReviewMode") ? overrides.humanReviewMode : existingFm.humanReviewMode,
        ),
        humanReviewDecision: normalizeHumanReviewDecision(
            Object.hasOwn(overrides, "humanReviewDecision")
                ? overrides.humanReviewDecision
                : existingFm.humanReviewDecision,
        ),
        humanReviewedAt: optionalFrontMatterValue(overrides, existingFm, "humanReviewedAt"),
        validationCheckpoint: Object.hasOwn(overrides, "validationCheckpoint")
            ? overrides.validationCheckpoint
            : existingFm.validationCheckpoint,
        epicCompletionMode: /** @type {"done_enough" | null | undefined} */ (
            optionalFrontMatterValue(overrides, existingFm, "epicCompletionMode") === "done_enough"
                ? "done_enough"
                : undefined
        ),
        epicDoneEnoughAt: optionalFrontMatterValue(overrides, existingFm, "epicDoneEnoughAt"),
        epicDoneEnoughSummary: optionalFrontMatterValue(overrides, existingFm, "epicDoneEnoughSummary"),
        epicBaseCommit: optionalFrontMatterValue(overrides, existingFm, "epicBaseCommit"),
        epicDeliveryTargetBranch: optionalStringValue(overrides, existingFm, "epicDeliveryTargetBranch"),
        epicIntegrationReport: optionalFrontMatterValue(overrides, existingFm, "epicIntegrationReport"),
        executionMode: Object.hasOwn(overrides, "executionMode")
            ? normalizeExecutionMode(overrides.executionMode)
            : normalizeExecutionMode(existingFm.executionMode),
        deliveryEvidence: Object.hasOwn(overrides, "deliveryEvidence")
            ? normalizeDeliveryEvidence(overrides.deliveryEvidence)
            : normalizeDeliveryEvidence(existingFm.deliveryEvidence),
        executionBaselineTree: optionalFrontMatterValue(overrides, existingFm, "executionBaselineTree"),
        worktreeId: optionalFrontMatterValue(overrides, existingFm, "worktreeId"),
        worktreePath: optionalFrontMatterValue(overrides, existingFm, "worktreePath"),
        worktreeBranch: optionalFrontMatterValue(overrides, existingFm, "worktreeBranch"),
        worktreeBaseBranch: optionalFrontMatterValue(overrides, existingFm, "worktreeBaseBranch"),
        targetBranch: optionalStringValue(overrides, existingFm, "targetBranch"),
        deliveryBranch: optionalStringValue(overrides, existingFm, "deliveryBranch"),
        validatedCommit: optionalFrontMatterValue(overrides, existingFm, "validatedCommit"),
        worktreeStatus: normalizeWorktreeStatus(
            Object.hasOwn(overrides, "worktreeStatus") ? overrides.worktreeStatus : existingFm.worktreeStatus,
        ),
        heldFromStatus: Object.hasOwn(overrides, "heldFromStatus")
            ? normalizePlanStatusForOptionalHold(overrides.heldFromStatus)
            : normalizePlanStatusForOptionalHold(existingFm.heldFromStatus),
        heldAt: optionalFrontMatterValue(overrides, existingFm, "heldAt"),
        holdReason: optionalFrontMatterValue(overrides, existingFm, "holdReason"),
        holdStalenessBaseline: optionalFrontMatterValue(overrides, existingFm, "holdStalenessBaseline"),
        archivedAt: optionalFrontMatterValue(overrides, existingFm, "archivedAt"),
        archiveReason: optionalFrontMatterValue(overrides, existingFm, "archiveReason"),
        archivedFromStatus: Object.hasOwn(overrides, "archivedFromStatus")
            ? normalizePlanStatusForOptionalHold(overrides.archivedFromStatus)
            : normalizePlanStatusForOptionalHold(existingFm.archivedFromStatus),
        archivedFromPath: optionalFrontMatterValue(overrides, existingFm, "archivedFromPath"),
        restoredAt: optionalFrontMatterValue(overrides, existingFm, "restoredAt"),
        restoredFromPath: optionalFrontMatterValue(overrides, existingFm, "restoredFromPath"),
    };
    if (fm.classification !== "PROJECT") delete fm.type;
    Object.assign(fm, normalizeCollaborationFrontMatter({ ...existingFm, ...overrides }));
    for (const key of OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS) {
        delete /** @type {Record<string, unknown>} */ (fm)[key];
    }
    delete /** @type {Record<string, unknown>} */ (fm).collaborationMode;
    assertExecutionPolicyWriteAllowed(overrides, fm);

    return joinFrontMatterAndBody(formatFrontMatter(fm), body);
}

/**
 * Parse front matter from a plan file. Returns defaults if missing.
 *
 * @param {string} markdown
 * @param {{ missingOrigin?: string }} [opts]
 * @returns {{ attrs: PlanFrontMatter, body: string }}
 */
export function parsePlanFrontMatter(markdown, opts = {}) {
    const missingOrigin = opts.missingOrigin || DEFAULT_FRONT_MATTER.origin;
    if (/^(<<<<<<<|=======|>>>>>>>)\s/m.test(markdown)) {
        throw new Error("Plan contains unresolved merge conflict markers.");
    }

    if (!hasFrontMatter(markdown)) {
        return {
            attrs: {
                ...DEFAULT_FRONT_MATTER,
                summary: summarizePlanBody(markdown),
                createdAt: new Date().toISOString(),
                origin: /** @type {"internal"|"external"} */ (missingOrigin),
            },
            body: markdown,
        };
    }
    const { attrs, body } = extractYaml(markdown);
    const collaborationAttrs = normalizeCollaborationFrontMatter(attrs);
    const sourceAttrs = { ...attrs };
    for (const key of OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS) delete sourceAttrs[key];
    for (const key of Object.values(COLLABORATION_FRONT_MATTER_KEYS)) {
        delete sourceAttrs[key];
    }
    delete sourceAttrs.collaborationMode;
    delete sourceAttrs.type;
    return {
        attrs: {
            ...sourceAttrs,
            planId: normalizePlanId(attrs.planId),
            classification: normalizePlanClassification(attrs.classification || DEFAULT_FRONT_MATTER.classification),
            ...(attrs.classification === "PROJECT" && attrs.type !== undefined ? { type: String(attrs.type) } : {}),
            workKind: normalizeWorkKind(attrs.workKind),
            complexity: attrs.complexity || DEFAULT_FRONT_MATTER.complexity,
            summary: summarizePlanBody(body) || attrs.summary || DEFAULT_FRONT_MATTER.summary,
            affectedPaths: normalizeStringList(attrs.affectedPaths) || DEFAULT_FRONT_MATTER.affectedPaths,
            tickets: normalizeTicketReferences(attrs.tickets),
            supersedes: normalizeSupersedes(attrs.supersedes),
            planDeviations: normalizePlanDeviations(attrs.planDeviations),
            executionAgent: Object.hasOwn(attrs, "executionAgent") ? attrs.executionAgent ?? undefined : undefined,
            collaborationRecommendation: Object.hasOwn(attrs, "collaborationRecommendation")
                ? attrs.collaborationRecommendation ?? undefined
                : undefined,
            frontend: normalizeOptionalBoolean(attrs.frontend),
            devServerCommand: typeof attrs.devServerCommand === "string"
                ? attrs.devServerCommand
                : attrs.devServerCommand === null
                ? null
                : undefined,
            devServerUrl: typeof attrs.devServerUrl === "string"
                ? attrs.devServerUrl
                : attrs.devServerUrl === null
                ? null
                : undefined,
            devServerHmr: attrs.devServerHmr === null ? null : normalizeOptionalBoolean(attrs.devServerHmr),
            createdAt: attrs.createdAt || DEFAULT_FRONT_MATTER.createdAt,
            updatedAt: attrs.updatedAt,
            status: normalizePlanStatus(attrs.status),
            origin: attrs.origin || missingOrigin,
            parentPlan: typeof attrs.parentPlan === "string" ? attrs.parentPlan : undefined,
            order: normalizeNonNegativeInteger(attrs.order),
            dependencies: normalizeStringList(attrs.dependencies),
            failureReason: attrs.failureReason,
            failedAt: attrs.failedAt,
            implementedAt: attrs.implementedAt,
            validatedAt: attrs.validatedAt,
            verifiedAt: attrs.verifiedAt,
            userVerifiedAt: attrs.userVerifiedAt,
            userVerificationNote: typeof attrs.userVerificationNote === "string"
                ? attrs.userVerificationNote
                : undefined,
            closedWithoutVerificationReason: typeof attrs.closedWithoutVerificationReason === "string"
                ? attrs.closedWithoutVerificationReason
                : undefined,
            closedWithoutVerificationAt: typeof attrs.closedWithoutVerificationAt === "string"
                ? attrs.closedWithoutVerificationAt
                : undefined,
            executionReport: typeof attrs.executionReport === "string" ? attrs.executionReport : undefined,
            workRecord: normalizeWorkRecordBacklink(attrs.workRecord),
            humanReviewMode: normalizeHumanReviewMode(attrs.humanReviewMode),
            humanReviewDecision: normalizeHumanReviewDecision(attrs.humanReviewDecision),
            humanReviewedAt: attrs.humanReviewedAt,
            validationPhase: attrs.validationPhase === "mechanical" || attrs.validationPhase === "semantic" ||
                    attrs.validationPhase === "delivery"
                ? attrs.validationPhase
                : undefined,
            validationCheckpoint: attrs.validationCheckpoint && typeof attrs.validationCheckpoint === "object"
                ? attrs.validationCheckpoint
                : attrs.validationCheckpoint === null
                ? null
                : undefined,
            epicCompletionMode: attrs.epicCompletionMode === "done_enough" ? attrs.epicCompletionMode : undefined,
            epicDoneEnoughAt: attrs.epicDoneEnoughAt,
            epicDoneEnoughSummary: attrs.epicDoneEnoughSummary,
            epicBaseCommit: typeof attrs.epicBaseCommit === "string" ? attrs.epicBaseCommit : undefined,
            epicDeliveryTargetBranch: typeof attrs.epicDeliveryTargetBranch === "string"
                ? attrs.epicDeliveryTargetBranch
                : undefined,
            epicIntegrationReport: typeof attrs.epicIntegrationReport === "string"
                ? attrs.epicIntegrationReport
                : undefined,
            executionMode: normalizeExecutionMode(attrs.executionMode),
            deliveryEvidence: normalizeDeliveryEvidence(attrs.deliveryEvidence),
            validatedCommit: typeof attrs.validatedCommit === "string" ? attrs.validatedCommit : undefined,
            executionBaselineTree: attrs.executionBaselineTree,
            worktreeId: attrs.worktreeId,
            worktreePath: attrs.worktreePath,
            worktreeBranch: attrs.worktreeBranch,
            worktreeBaseBranch: attrs.worktreeBaseBranch,
            deliveryBranch: typeof attrs.deliveryBranch === "string" ? attrs.deliveryBranch : undefined,
            targetBranch: typeof attrs.targetBranch === "string"
                ? attrs.targetBranch
                : typeof attrs.worktreeBaseBranch === "string"
                ? attrs.worktreeBaseBranch
                : undefined,
            worktreeStatus: normalizeWorktreeStatus(attrs.worktreeStatus),
            heldFromStatus: normalizePlanStatusForOptionalHold(attrs.heldFromStatus),
            heldAt: attrs.heldAt,
            holdReason: attrs.holdReason,
            holdStalenessBaseline: attrs.holdStalenessBaseline,
            archivedAt: attrs.archivedAt,
            archiveReason: attrs.archiveReason,
            archivedFromStatus: normalizePlanStatusForOptionalHold(attrs.archivedFromStatus),
            archivedFromPath: attrs.archivedFromPath,
            restoredAt: attrs.restoredAt,
            restoredFromPath: attrs.restoredFromPath,
            ...collaborationAttrs,
        },
        body,
    };
}

/** List descriptions are derived from prose, not maintained as a second Plan. @param {string} body */
export function summarizePlanBody(body) {
    const context = /^##\s+Context\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/mi.exec(body)?.[1];
    return (context?.trim().split(/\r?\n\s*\r?\n/)[0] || "").replace(/\s+/g, " ").trim();
}

/** Produce only the human document. Operational fields are accepted for import, never written back. @param {string} markdown */
export function planDocumentMarkdown(markdown) {
    if (!hasFrontMatter(markdown)) return markdown;
    const { attrs } = parsePlanFrontMatter(markdown);
    const raw = extractYaml(markdown).attrs;
    /** @type {Partial<PlanFrontMatter>} */
    const removed = { summary: undefined };
    for (const field of PLAN_RUNTIME_FIELDS) Object.assign(removed, { [field]: undefined });
    if (attrs.targetBranch && raw.targetBranch !== attrs.targetBranch) removed.targetBranch = attrs.targetBranch;
    return mergeFrontMatterText(markdown, removed);
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
    if (/^[a-f0-9]{40,64}:docs\/plans\//.test(filePath)) {
        throw new Error(`Published Plan snapshot is not a writable document path: ${filePath}`);
    }
    const location = planControllerLocation(filePath);
    if (!location) throw new Error(`Not a stored Plan path: ${filePath}`);
    return location.cwd;
}

/** @param {string} filePath @param {PlanFrontMatter} attrs */
async function withControllerMetadata(filePath, attrs) {
    const location = planControllerLocation(filePath);
    if (!location) return { attrs, controllerRevision: 0 };
    const view = await loadControllerView(location.cwd, { planId: attrs.planId, planName: location.planName }, attrs);
    return {
        attrs: await effectivePlanLifecycleAttrs(
            location.cwd,
            attrs,
            view.state,
            attrs.status === "validated"
                ? { planName: location.planName, markdown: await Deno.readTextFile(filePath) }
                : undefined,
        ),
        controllerRevision: view.revision,
    };
}

/**
 * One compatibility boundary for writable and read-only controller-backed reads.
 * @param {string} cwd
 * @param {PlanFrontMatter} attrs
 * @param {import('./shared/workflow/controller-state.ts').WorkflowControllerState & import('./shared/workflow/controller-state.ts').WorkflowWorktreeContext} state
 * @param {{planName: string, markdown: string}} [document]
 * @returns {Promise<PlanFrontMatter>}
 */
async function effectivePlanLifecycleAttrs(cwd, attrs, state, document) {
    const combined = { ...stripRuntimeFields(attrs), ...state };
    // A remote delivery need not move the user's primary checkout. Its durable
    // receipt supplies completion until that checkout catches up.
    if (
        combined.publicationReceipt &&
        !["on_hold", "user_verified", "closed_without_verification"].includes(combined.status)
    ) {
        combined.status = "verified";
    } else if (combined.status === "validated") {
        const pendingAttempt = combined.worktreeId && !combined.verifiedAt;
        const pendingEpic = isProjectPlan(combined) && combined.targetBranch &&
            combined.epicCompletionMode !== "done_enough";
        let delivered = Boolean(combined.verifiedAt || combined.deliveryEvidence?.mode === "non_git_in_place");
        if (!delivered && !pendingAttempt && !pendingEpic && combined.epicCompletionMode !== "done_enough") {
            const { verifyRecordedPublication } = await import("./shared/workflow/validation-merge-verification.ts");
            delivered = (await verifyRecordedPublication(cwd, combined, document).catch(() => ({ published: false })))
                .published;
        }
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
 * @typedef {Object} SplitPlanBody
 * @property {string} frontMatterBlock
 * @property {string} body
 */

/**
 * Split raw markdown into the exact leading front matter block and body.
 * @param {string} markdown
 * @returns {SplitPlanBody}
 */
export function splitPlanMarkdownBody(markdown) {
    if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
        throw new Error("Plan body editing requires a valid leading front matter block.");
    }

    let lineStart = markdown.startsWith("---\r\n") ? 5 : 4;
    while (lineStart <= markdown.length) {
        const nextLf = markdown.indexOf("\n", lineStart);
        const lineEnd = nextLf === -1 ? markdown.length : nextLf;
        const rawLine = markdown.slice(lineStart, lineEnd);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "---") {
            const bodyStart = nextLf === -1 ? markdown.length : nextLf + 1;
            return {
                frontMatterBlock: markdown.slice(0, bodyStart),
                body: markdown.slice(bodyStart),
            };
        }
        if (nextLf === -1) break;
        lineStart = nextLf + 1;
    }

    throw new Error("Plan body editing requires a closed leading front matter block.");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} line
 * @param {string} key
 * @returns {boolean}
 */
function isTopLevelYamlKeyLine(line, key) {
    return line.startsWith(`${key}:`) || line.startsWith(`${key} :`);
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isAnyTopLevelYamlKeyLine(line) {
    return /^[^\s#][^:]*\s*:/.test(line);
}

/**
 * Remove a top-level YAML key and any indented/list continuation lines from a front matter body.
 * @param {string[]} lines
 * @param {string} key
 * @returns {string[]}
 */
function removeTopLevelYamlKey(lines, key) {
    /** @type {string[]} */
    const kept = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!isTopLevelYamlKeyLine(line, key)) {
            kept.push(line);
            continue;
        }

        index++;
        while (index < lines.length && !isAnyTopLevelYamlKeyLine(lines[index])) index++;
        index--;
    }
    return kept;
}

/**
 * Build YAML lines for only the provided override fields.
 * @param {Partial<PlanFrontMatter>} overrides
 * @returns {string[]}
 */
function formatFrontMatterOverrideLines(overrides) {
    /** @type {string[]} */
    const lines = [];
    for (const key of PLAN_FRONT_MATTER_KEY_ORDER) {
        if (Object.hasOwn(overrides, key)) {
            appendYamlField(lines, key, /** @type {Record<string, unknown>} */ (overrides)[key]);
        }
    }
    for (const key of Object.keys(overrides).filter((key) => !KNOWN_FRONT_MATTER_KEYS.has(key)).sort()) {
        appendYamlField(lines, key, /** @type {Record<string, unknown>} */ (overrides)[key]);
    }
    return lines;
}

/**
 * Update only selected front matter fields while preserving untouched YAML text and body bytes.
 * @param {string} markdown
 * @param {Partial<PlanFrontMatter>} overrides
 * @returns {string}
 */
export function mergeFrontMatterText(markdown, overrides) {
    if (!hasFrontMatter(markdown)) return injectFrontMatter(markdown, overrides);

    const { frontMatterBlock, body } = splitPlanMarkdownBody(markdown);
    const eol = frontMatterBlock.includes("\r\n") ? "\r\n" : "\n";
    const lines = frontMatterBlock.replace(/\r?\n$/, "").split(/\r?\n/);
    const closingIndex = lines.length - 1;
    let innerLines = lines.slice(1, closingIndex);
    for (const key of PLAN_FRONT_MATTER_KEY_ORDER) {
        if (Object.hasOwn(overrides, key)) innerLines = removeTopLevelYamlKey(innerLines, key);
    }
    const orderedKeys = /** @type {readonly string[]} */ (PLAN_FRONT_MATTER_KEY_ORDER);
    for (const key of Object.keys(overrides)) {
        if (!orderedKeys.includes(key)) innerLines = removeTopLevelYamlKey(innerLines, key);
    }

    const overrideLines = formatFrontMatterOverrideLines(overrides);
    const mergedLines = ["---", ...innerLines, ...overrideLines, "---"];
    const frontMatterTerminator = frontMatterBlock.endsWith("\r\n")
        ? "\r\n"
        : frontMatterBlock.endsWith("\n")
        ? "\n"
        : "";
    return `${mergedLines.join(eol)}${frontMatterTerminator}${body}`;
}

/**
 * @param {string} body
 * @returns {Promise<string>}
 */
export async function hashPlanBody(body) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

export class PlanFrontMatterParseError extends Error {
    /**
     * @param {string} path
     * @param {unknown} cause
     */
    constructor(path, cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Plan Front Matter could not be parsed in ${path}: ${detail}`);
        this.name = "PlanFrontMatterParseError";
        this.path = path;
        this.cause = cause;
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

/** @param {string} text */
export async function getPlanRevisionForText(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Revision of the Front Matter block alone.
 *
 * RunWield owns Plan Front Matter; the user owns the body and may edit it with
 * any tool, at any time, without telling RunWield. A whole-file revision cannot
 * tell those two apart, so lifecycle preconditions that use it reject a Plan
 * whose body someone legitimately rewrote. This token isolates the half RunWield
 * actually owns, so "did the metadata I read change?" can be answered without
 * caring what happened to the prose.
 *
 * Returns undefined when the text has no closed leading Front Matter block —
 * there is no metadata to compare, and callers must fall back to whole-file
 * comparison rather than treat an unparseable file as unchanged.
 *
 * @param {string} text
 * @returns {Promise<string | undefined>}
 */
export async function getPlanFrontMatterRevisionForText(text) {
    try {
        return await getPlanRevisionForText(splitPlanMarkdownBody(text).frontMatterBlock);
    } catch {
        return undefined;
    }
}

/** @param {string} path */
async function syncDirectory(path) {
    try {
        const dir = await Deno.open(path, { read: true });
        try {
            await dir.sync();
        } finally {
            dir.close();
        }
    } catch {
        // Directory fsync is unavailable on some platforms/filesystems; atomic rename still protects torn writes.
    }
}

/**
 * @param {string} path
 * @param {string} content
 */
export async function atomicWriteTextFile(path, content) {
    await Deno.mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
    let file;
    try {
        file = await Deno.open(tmp, { createNew: true, write: true });
        await file.write(new TextEncoder().encode(content));
        await file.sync();
        file.close();
        file = undefined;
        await Deno.rename(tmp, path);
        await syncDirectory(dirname(path));
    } catch (error) {
        if (file) file.close();
        await Deno.remove(tmp).catch(() => {});
        throw error;
    }
}

/**
 * Write text only when the target path is still absent. Unlike atomicWriteTextFile,
 * this never renames over a concurrently-created file, preserving external
 * evidence for callers that need create-if-absent semantics.
 * @param {string} path
 * @param {string} content
 */
export async function atomicWriteTextFileIfAbsent(path, content) {
    const parent = dirname(path);
    await Deno.mkdir(parent, { recursive: true });
    const temporaryPath = await Deno.makeTempFile({ dir: parent, prefix: ".rw-create-", suffix: ".tmp" });
    let file;
    try {
        file = await Deno.open(temporaryPath, { write: true, truncate: true });
        await file.write(new TextEncoder().encode(content));
        await file.sync();
        file.close();
        file = undefined;
        // Linking a complete same-filesystem file publishes all bytes at once and
        // still fails when another writer already owns the target path.
        await Deno.link(temporaryPath, path);
        await syncDirectory(parent);
    } catch (error) {
        if (file) file.close();
        throw error;
    } finally {
        await Deno.remove(temporaryPath).catch(() => {});
    }
}

/** @param {string} value */
function lockSafeSegment(value) {
    return String(value || "plan").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plan";
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
    await Deno.mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + PLAN_LOCK_WAIT_TIMEOUT_MS;
    const token = crypto.randomUUID();
    while (true) {
        try {
            const file = await Deno.open(lockPath, { createNew: true, read: true, write: true });
            try {
                file.lockSync(true);
                const writeHeartbeat = async () => {
                    await file.truncate(0);
                    await file.seek(0, Deno.SeekMode.Start);
                    await file.write(
                        new TextEncoder().encode(
                            // The hostname makes the pid meaningful: a waiter can ask the
                            // operating system whether this exact holder is still alive
                            // instead of waiting out a timeout after a crash.
                            JSON.stringify({
                                token,
                                pid: Deno.pid,
                                hostname: getLockHostname(),
                                updatedAtMs: Date.now(),
                            }),
                        ),
                    );
                    await file.sync();
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
            if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
            const snapshot = await readLockFileSnapshot(lockPath);
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
            const abandoned = Deno.build.os !== "windows" &&
                Date.now() - Math.max(snapshot.mtime, snapshot.updatedAt || 0) > PLAN_LOCK_ABANDONED_MS;
            const stale = abandoned || await isLockHolderGone(snapshot.text);
            if (stale && await removeLockFileIfSnapshotMatches(lockPath, snapshot)) {
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
    const layout = await enterProjectRuntime(cwd);
    const key = `${resolve(cwd)}:${lockSafeSegment(planName)}`;
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
    const layout = await enterProjectRuntime(cwd);
    const key = `${resolve(cwd)}:catalog`;
    return await withProcessAwarePlanLock(
        key,
        layout.selected.planCatalogLockPath,
        fn,
    );
}

/** Read one Plan document without controller imports or writes.
 * @param {string} filePath
 */
export async function inspectPlanFileStrict(filePath) {
    const result = await loadPlanFileStrict(filePath, true);
    if (result.kind !== "loaded" || !("attrs" in result)) return result;
    const location = planControllerLocation(filePath);
    if (!location) return { ...result, pendingControllerRepairs: [] };
    const view = await inspectControllerView(
        location.cwd,
        { planId: result.attrs.planId, planName: location.planName },
        result.attrs,
    );
    return {
        ...result,
        attrs: await effectivePlanLifecycleAttrs(location.cwd, result.attrs, view.state, {
            planName: location.planName,
            markdown: result.markdown,
        }),
        controllerRevision: view.revision,
        pendingControllerRepairs: view.pendingRepairs,
    };
}

/**
 * @param {string} filePath
 * @param {boolean} [documentOnly]
 * @returns {Promise<{ kind: "loaded", path: string, markdown: string, attrs: PlanFrontMatter, controllerRevision: number, body: string, revision: string, frontMatterRevision: string|undefined, hasFrontMatter: boolean } | { kind: "not_found", path: string } | { kind: "malformed", path: string, markdown: string, error: PlanFrontMatterParseError, revision: string } | { kind: "not_file", path: string, message: string } | { kind: "unreadable", path: string, error: Error }>}
 */
export async function loadPlanFileStrict(filePath, documentOnly = false) {
    let stat;
    try {
        stat = await Deno.lstat(filePath);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return { kind: "not_found", path: filePath };
        return { kind: "unreadable", path: filePath, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (!stat.isFile) {
        return { kind: "not_file", path: filePath, message: `Plan path is not a regular file: ${filePath}` };
    }
    try {
        const markdown = await Deno.readTextFile(filePath);
        const revision = await getPlanRevisionForText(markdown);
        let parsed;
        try {
            parsed = parsePlanFrontMatter(markdown);
        } catch (error) {
            return {
                kind: "malformed",
                path: filePath,
                markdown,
                revision,
                error: new PlanFrontMatterParseError(filePath, error),
            };
        }
        const { attrs, body } = parsed;
        const frontMatterRevision = await getPlanFrontMatterRevisionForText(markdown);
        rememberFrontMatterRevision(revision, frontMatterRevision);
        // A Plan file with no Front Matter at all is not a broken Plan — it is a
        // markdown file the user put in docs/plans/ that RunWield has not onboarded.
        // Parsing yields defaults so reads never fail, but the distinction has to
        // survive: only a deliberate onboarding may write metadata into it.
        return {
            kind: "loaded",
            path: filePath,
            markdown,
            ...(documentOnly ? { attrs, controllerRevision: 0 } : await withControllerMetadata(filePath, attrs)),
            body,
            revision,
            frontMatterRevision,
            hasFrontMatter: hasFrontMatter(markdown),
        };
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
 * Front Matter revision for each whole-file Plan revision this process has seen.
 *
 * Both tokens are content hashes, so this mapping is immutable: a given whole-file
 * revision always had exactly one Front Matter block. That makes it safe to cache
 * and to trust later, which is what lets an operation holding only a whole-file
 * token ask the question it actually cares about — "did the metadata change, or
 * did the user just rewrite the prose?" — without every caller having to thread a
 * second token through.
 *
 * Bounded and in-process. A token this process never read is simply unknown, and
 * unknown falls back to strict whole-file comparison.
 *
 * @type {Map<string, string>}
 */
const frontMatterRevisionsByPlanRevision = new Map();

const KNOWN_REVISION_LIMIT = 1024;

/** @param {string} revision @param {string|undefined} frontMatterRevision */
function rememberFrontMatterRevision(revision, frontMatterRevision) {
    if (!frontMatterRevision) return;
    frontMatterRevisionsByPlanRevision.delete(revision);
    frontMatterRevisionsByPlanRevision.set(revision, frontMatterRevision);
    while (frontMatterRevisionsByPlanRevision.size > KNOWN_REVISION_LIMIT) {
        const oldest = frontMatterRevisionsByPlanRevision.keys().next();
        if (oldest.done) break;
        frontMatterRevisionsByPlanRevision.delete(oldest.value);
    }
}

/**
 * The Front Matter revision belonging to a whole-file Plan revision, when this
 * process has seen those exact bytes.
 *
 * @param {string|undefined} revision
 * @returns {string | undefined}
 */
export function getKnownFrontMatterRevision(revision) {
    return revision ? frontMatterRevisionsByPlanRevision.get(revision) : undefined;
}

/**
 * Load a plan with typed fail-closed outcomes.
 * @param {string} cwd
 * @param {string} planName
 * @returns {Promise<Awaited<ReturnType<typeof loadPlanFileStrict>>>}
 */
export async function loadPlanStrict(cwd, planName) {
    const { name, filePath } = getStoredPlanLocation(cwd, planName);
    if (isEpicArtifactPlanName(name)) return { kind: "not_found", path: filePath };
    return await loadPlanFileStrict(filePath);
}

/** Read raw Plan facts without controller imports or cleanup.
 * @param {string} cwd
 * @param {string} planName
 */
export async function inspectPlanStrict(cwd, planName) {
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
    return await withPlanLock(
        cwd,
        planName,
        async () => await writePlanMarkdownWithRevision(filePath, nextMarkdown, expectedRevision),
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
    return frontMatter.split("\n").some((line) =>
        /^\s*["']?collaborationState["']?\s*:\s*["']?remote_canonical["']?(?:\s+#.*)?\s*$/.test(line)
    );
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
 * @param {number | undefined} sequence
 * @returns {string}
 */
function formatChildSequencePrefix(sequence) {
    if (sequence === undefined) return "";
    if (!Number.isInteger(sequence) || sequence < 0) {
        throw new Error(`Child plan sequence must be a non-negative integer: ${sequence}`);
    }
    return `${String(sequence).padStart(2, "0")}-`;
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
 * @param {ChildFeaturePlanDescriptor} child
 * @returns {string}
 */
function buildChildPlanNameSegment(child) {
    const slug = slugifyPlanTitle(child.title);
    if (!slug) throw new Error(`Child plan title must produce a valid plan name: ${child.title}`);
    return `${formatChildSequencePrefix(child.order)}${slug}`;
}

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
    const { name: parentPlanName, segments: parentSegments } = canonicalizeStoredPlanName(epicPlanName);
    if (parentSegments.length !== 1) {
        throw new Error(`Parent Epic plan name must be a top-level plan: ${epicPlanName}`);
    }
    if (!Array.isArray(children)) throw new Error("Child plans must be an array");

    /** @type {Array<{ child: ChildFeaturePlanDescriptor, name: string, filePath: string }>} */
    const validatedChildren = [];
    const seen = new Set();

    for (const rawChild of children) {
        const child = validateChildFeaturePlanDescriptor(rawChild);
        const childSegment = buildChildPlanNameSegment(child);
        const childPlanName = `${parentPlanName}/${childSegment}`;
        const { name, filePath, segments } = getStoredPlanLocation(cwd, childPlanName);
        if (segments.length !== 2 || segments[0] !== parentPlanName) {
            throw new Error(`Invalid child plan name: ${childPlanName}`);
        }
        if (seen.has(name)) throw new Error(`Duplicate child plan name: ${name}`);
        seen.add(name);
        const policy = resolvePlanExecutionPolicy({
            classification: ROUTING_INTENT_PLANNED_CHANGE,
            executionAgent: child.executionAgent,
            collaborationRecommendation: child.collaborationRecommendation,
            frontend: child.frontend,
        });
        if (!policy.ok) throw new Error(`Invalid child plan execution policy for ${child.title}: ${policy.error}`);
        validatedChildren.push({ child, name, filePath });
    }

    /** @type {Map<string, { action: "created" | "updated", expectedRevision?: string }>} */
    const writePreconditions = new Map();
    for (const { name, filePath } of validatedChildren) {
        let action = /** @type {"created" | "updated"} */ ("created");
        /** @type {string | undefined} */
        let childExpectedRevision = options.expectedRevisions?.[name] || options.expectedRevision;
        const existingChild = await loadPlanFileStrict(filePath);
        if (existingChild.kind === "loaded") {
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
        writePreconditions.set(name, { action, expectedRevision: childExpectedRevision });
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
        const workKind = normalizeWorkKind(child.workKind);
        if (workKind) metadata.workKind = workKind;
        const policyResult = resolvePlanExecutionPolicy({
            classification: ROUTING_INTENT_PLANNED_CHANGE,
            executionAgent: child.executionAgent,
            collaborationRecommendation: child.collaborationRecommendation,
            frontend: child.frontend,
        });
        if (!policyResult.ok) throw new Error(policyResult.error);
        const devServerCommand = typeof child.devServerCommand === "string"
            ? child.devServerCommand
            : child.devServerCommand === null
            ? null
            : undefined;
        const devServerUrl = typeof child.devServerUrl === "string"
            ? child.devServerUrl
            : child.devServerUrl === null
            ? null
            : undefined;
        const devServerHmr = child.devServerHmr === null ? null : normalizeOptionalBoolean(child.devServerHmr);
        const worktreeBaseBranch = typeof child.targetBranch === "string"
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
                const existing = parsePlanFrontMatter(await Deno.readTextFile(filePath)).attrs;
                const tickets = normalizeTicketReferences(existing.tickets);
                if (tickets) metadata.tickets = tickets;
            } catch {
                // Best-effort preservation; savePlan will surface unreadable-file errors.
            }
        }
        const path = await savePlan(cwd, name, child.content, {
            ...metadata,
            summary: child.summary,
            dependencies,
            origin: "internal",
        }, { ...options, expectedRevision: childExpectedRevision });
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
    assertNotReservedEpicArtifactPlanName(planName);
    return await withPlanCatalogLock(cwd, async () =>
        await withPlanLock(cwd, planName, async () => {
            const dir = await ensurePlansDir(cwd);
            const { filePath, segments } = getStoredPlanLocation(cwd, planName);
            const existing = await loadPlanFileStrict(filePath);
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
                await Deno.mkdir(join(dir, ...segments.slice(0, -1)), { recursive: true });
            }
            if (existing.kind === "loaded" && options.expectedRevision === undefined) {
                throw new StalePlanWriteError("required", existing.revision);
            }
            const withFm = injectFrontMatter(content, fmOverrides);
            const documentAttrs = parsePlanFrontMatter(withFm).attrs;
            if (existing.kind === "loaded" && existing.revision !== options.expectedRevision) {
                throw new StalePlanWriteError(options.expectedRevision || "required", existing.revision);
            }
            // Import once from the authoritative copy; an ordinary document save
            // can never overwrite workflow state with an old in-memory snapshot.
            const controller = await loadControllerView(cwd, { planName, planId: documentAttrs.planId }, documentAttrs);
            // Normalizing legacy CI status removes its phase from Markdown. Keep
            // that already-passed gate durably before replacing the old document.
            // Other saves still cannot overwrite controller state from a snapshot.
            if (
                existing.kind === "loaded" && getDeclaredPlanStatus(existing.markdown) === "validated_ci" &&
                documentAttrs.status === "implemented" && controller.state.validationPhase === undefined
            ) {
                await writeControllerState(cwd, { planName, planId: documentAttrs.planId }, {
                    validationPhase: "semantic",
                }, {
                    expectedRevision: controller.revision,
                });
            }
            if (existing.kind === "not_found") {
                await atomicWriteTextFileIfAbsent(filePath, planDocumentMarkdown(withFm));
                await requestWorkspaceSearchRefresh(resolvePrimaryCheckoutRoot(cwd));
            } else {
                await writePlanMarkdownWithRevision(filePath, withFm, options.expectedRevision);
            }
            return filePath;
        }));
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
    const loaded = await loadPlan(cwd, planName);
    if (!loaded) throw new Error(`Failed to create pulled Plan: ${planName}`);
    return { planName, path, attrs: loaded.attrs, body: loaded.body, markdown: loaded.markdown };
}

/**
 * Load a plan by name from the plans directory.
 *
 * @param {string} cwd
 * @param {string} planName - Filename without .md
 * @returns {Promise<{ path: string, markdown: string, attrs: PlanFrontMatter, controllerRevision: number, body: string, revision: string, frontMatterRevision?: string, hasFrontMatter?: boolean } | null>}
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
    const markdown = await Deno.readTextFile(absolutePath);
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
export async function updatePlanStatus(
    cwd,
    planName,
    status,
    recoveryAttrs = {},
    options = {},
) {
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
export async function updatePlanFrontMatter(
    cwd,
    planName,
    updates,
    recoveryAttrs = {},
    options = {},
) {
    return await withPlanLock(cwd, planName, async () => {
        const result = await loadPlanStrict(cwd, planName);
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
            /** @type {Record<string, unknown>} */ (normalizedOverrides)[key] =
                /** @type {Record<string, unknown>} */ (normalizedAttrs)[key];
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
        return (await withControllerMetadata(result.path, parsePlanFrontMatter(withFm).attrs)).attrs;
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
    cwd = (await resolveWorkflowPlanLocation(cwd, planName)).documentRoot;
    return await withPlanLock(cwd, planName, async () => {
        const plan = await loadPlan(cwd, planName);
        if (!plan) throw new Error(`Plan not found: ${planName}`);
        const hasControlledBodyWrite = typeof options.body === "string";
        const nextBody = hasControlledBodyWrite ? /** @type {string} */ (options.body) : plan.body;
        const collaborationUpdates = normalizeCollaborationFrontMatter(updates);
        if (!hasControlledBodyWrite) {
            delete collaborationUpdates.collaborationBodyHash;
        }
        const planMetadataUpdates = pickKnownPlanFrontMatter(updates);
        for (
            const key of [
                "collaborationState",
                "collaborationServerUrl",
                "collaborationSpaceId",
                "collaborationRevision",
                "collaborationBodyHash",
                "collaborationSyncedAt",
            ]
        ) {
            delete /** @type {Record<string, unknown>} */ (planMetadataUpdates)[key];
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
        return (await withControllerMetadata(plan.path, parsePlanFrontMatter(planDocumentMarkdown(markdown)).attrs))
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
    if (collaborationLockBypass !== COLLABORATION_LOCK_BYPASS.unshare) {
        throw new Error("Clearing collaboration metadata requires the unshare collaboration lock bypass.");
    }
    cwd = (await resolveWorkflowPlanLocation(cwd, planName)).documentRoot;
    return await withPlanLock(cwd, planName, async () => {
        const plan = await loadPlan(cwd, planName);
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
        return (await withControllerMetadata(plan.path, parsePlanFrontMatter(planDocumentMarkdown(markdown)).attrs))
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
 * @property {string} [body] - Parsed markdown body when loaded by identity helpers.
 * @property {string} [markdown] - Full markdown when loaded by identity helpers.
 */

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
 * @param {Array<{ name: string, path: string, attrs: PlanFrontMatter }>} results
 * @param {PlanParseIssue[]} [parseIssues]
 * @param {boolean} [documentOnly] Read file metadata without entering runtime storage.
 * @returns {Promise<void>}
 */
async function collectPlans(dir, prefix, results, parseIssues, documentOnly = false) {
    for await (const entry of Deno.readDir(dir)) {
        const entryPath = join(dir, entry.name);
        const name = [...prefix, entry.name.replace(/\.md$/, "")].join("/");
        if (entry.isDirectory) {
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
        if (!entry.isFile) {
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
            const markdown = await Deno.readTextFile(entryPath);
            try {
                const { attrs } = parsePlanFrontMatter(markdown);
                const current = documentOnly ? { attrs } : await withControllerMetadata(entryPath, attrs);
                results.push({ name, path: entryPath, attrs: current.attrs });
            } catch (error) {
                if (error instanceof ProjectRuntimeEntryRefusedError) throw error;
                const wrapped = new PlanFrontMatterParseError(entryPath, error);
                parseIssues?.push({ name, path: entryPath, message: formatErrorMessage(error), error: wrapped });
            }
        } catch (error) {
            parseIssues?.push({ name, path: entryPath, message: formatErrorMessage(error), error });
        }
    }
}

/**
 * Compare plans in the canonical order exposed to plan-list consumers.
 *
 * @template {{ name: string, attrs: PlanFrontMatter }} T
 * @param {T} a
 * @param {T} b
 * @returns {number}
 */
export function comparePlansForList(a, b) {
    const statusDelta = (PLAN_LIST_STATUS_ORDER.get(a.attrs.status) ?? PLAN_LIST_STATUS_ORDER.size) -
        (PLAN_LIST_STATUS_ORDER.get(b.attrs.status) ?? PLAN_LIST_STATUS_ORDER.size);
    if (statusDelta !== 0) return statusDelta;

    const classificationDelta =
        (PLAN_LIST_CLASSIFICATION_ORDER.get(normalizePlanClassification(a.attrs.classification)) ??
            PLAN_LIST_CLASSIFICATION_ORDER.size) -
        (PLAN_LIST_CLASSIFICATION_ORDER.get(normalizePlanClassification(b.attrs.classification)) ??
            PLAN_LIST_CLASSIFICATION_ORDER.size);
    if (classificationDelta !== 0) return classificationDelta;

    return a.name.localeCompare(b.name);
}

/**
 * List all saved plans in the project's plans directory in canonical UI order.
 *
 * @param {string} cwd
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter }>>}
 */
export async function listPlans(cwd) {
    return await listPlansWithTargetChildren(cwd, null);
}

/**
 * List saved plans, reading target-branch children only for `onlyEpic` when it
 * is given. Reading an Epic's target branch fetches it and reads every Plan on
 * it, so a lookup scoped to one Epic must not pay that for every other Epic.
 *
 * @param {string} cwd
 * @param {string | null} onlyEpic
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter }>>}
 */
async function listPlansWithTargetChildren(cwd, onlyEpic) {
    return await withProjectRuntimeReadScope(async () => {
        const dir = getPlansDir(cwd);
        /** @type {Array<{ name: string, path: string, attrs: PlanFrontMatter }>} */
        const results = [];
        /** @type {PlanParseIssue[]} */
        const parseIssues = [];
        try {
            await collectPlans(dir, [], results, parseIssues);
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        for (const projectPlan of [...results]) {
            const targetBranch = typeof projectPlan.attrs.targetBranch === "string"
                ? projectPlan.attrs.targetBranch.trim()
                : "";
            if (!targetBranch || !isProjectPlan(projectPlan.attrs)) continue;
            if (onlyEpic !== null && projectPlan.name !== onlyEpic) continue;
            let targetChildren;
            try {
                targetChildren = await findTargetBranchPlansByParent(cwd, targetBranch, projectPlan.name);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (
                    message.includes("Target branch does not exist") ||
                    message.includes("Could not refresh target branch")
                ) continue;
                throw error;
            }
            for (const child of targetChildren) {
                const index = results.findIndex((item) =>
                    item.name === child.name || Boolean(child.attrs.planId && item.attrs.planId === child.attrs.planId)
                );
                if (
                    index >= 0 && results[index].name === child.name && results[index].attrs.planId &&
                    child.attrs.planId &&
                    results[index].attrs.planId !== child.attrs.planId
                ) {
                    throw new Error(
                        `Target Plan ${child.name} has a different Plan ID. Your files have not been changed.`,
                    );
                }
                const item = { name: child.name, path: child.path, attrs: child.attrs };
                if (index < 0) results.push(item);
                else results[index] = item;
            }
        }
        const attempts = await listControllerDocumentWorktrees(cwd);
        for (const attempt of attempts) {
            if (attempts.filter((entry) => entry.planName === attempt.planName).length !== 1) continue;
            const execution = await loadPlan(attempt.path, attempt.planName);
            if (!execution) {
                const archived = await loadArchivedPlanByName(attempt.path, attempt.planName);
                if (archived && (!attempt.planId || archived.attrs.planId === attempt.planId)) {
                    const index = results.findIndex((item) =>
                        item.name === attempt.planName ||
                        Boolean(attempt.planId && item.attrs.planId === attempt.planId)
                    );
                    if (index >= 0) results.splice(index, 1);
                    const issueIndex = parseIssues.findIndex((issue) => issue.name === attempt.planName);
                    if (issueIndex >= 0) parseIssues.splice(issueIndex, 1);
                    continue;
                }
                throw new Error(
                    `The execution Plan is missing at ${attempt.path}/docs/plans/${attempt.planName}.md. Restore that file before editing or continuing this Plan; the primary copy will not be used.`,
                );
            }
            if (attempt.planId && execution.attrs.planId && execution.attrs.planId !== attempt.planId) {
                throw new Error(
                    `The execution directory contains a different Plan at ${execution.path}. Your files have not been changed.`,
                );
            }
            const index = results.findIndex((item) =>
                item.name === attempt.planName ||
                Boolean(attempt.planId && item.attrs.planId === attempt.planId)
            );
            const item = { name: attempt.planName, path: execution.path, attrs: execution.attrs };
            if (index < 0) results.push(item);
            else results[index] = item;
            const issueIndex = parseIssues.findIndex((issue) => issue.name === attempt.planName);
            if (issueIndex >= 0) parseIssues.splice(issueIndex, 1);
        }
        if (parseIssues.length > 0) {
            const issue = parseIssues[0];
            if (issue.error instanceof Error) throw issue.error;
            throw new PlanFileIssueError(issue.path, "malformed", issue.message);
        }
        return results.sort(comparePlansForList);
    });
}

/**
 * List local Plan documents for selection. Deliberately does not enter runtime
 * storage, fetch Git refs, repair worktrees, or adopt external Markdown files.
 * Loading the selected Plan is a separate command phase.
 * @param {string} cwd
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter }>>}
 */
export async function listPlanDocuments(cwd) {
    /** @type {Array<{ name: string, path: string, attrs: PlanFrontMatter }>} */
    const plans = [];
    /** @type {PlanParseIssue[]} */
    const issues = [];
    try {
        await collectPlans(getPlansDir(cwd), [], plans, issues, true);
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    for (const issue of issues) {
        if (issue.error instanceof Error) throw issue.error;
        throw new PlanFileIssueError(issue.path, "malformed", issue.message);
    }
    return plans.sort(comparePlansForList);
}

const ARCHIVED_DIR_NAME = "archived";
const TERMINAL_ARCHIVABLE_STATUSES = new Set(["validated", "verified", "user_verified", "closed_without_verification"]);
const RECOVERABLE_WORKTREE_STATUSES = new Set(["active", "execution_failed", "validation_failed", "merge_conflict"]);

/**
 * @param {string | undefined | null} status
 * @returns {boolean}
 */
export function isTerminalArchivableStatus(status) {
    return Boolean(status) && TERMINAL_ARCHIVABLE_STATUSES.has(String(status));
}

/**
 * @param {string | undefined | null} worktreeStatus
 * @returns {boolean}
 */
export function isRecoverableWorktreeStatus(worktreeStatus) {
    return Boolean(worktreeStatus) && RECOVERABLE_WORKTREE_STATUSES.has(String(worktreeStatus));
}

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
        const stat = await Deno.stat(path);
        return stat.isFile;
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
        return { name, ...byName };
    }

    const planId = normalizePlanId(planNameOrId);
    if (planId) {
        const matches = (await listPlans(cwd)).filter((plan) => plan.attrs.planId === planId);
        if (matches.length > 1) {
            throw new Error(`Duplicate planId values found for ${planId}; repair plan front matter before continuing.`);
        }
        if (matches.length === 1) {
            const loaded = await loadPlan(getPlanDocumentRoot(matches[0].path), matches[0].name);
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
    return await withPlanCatalogLock(cwd, async () =>
        await withPlanLock(cwd, source.name, async () => {
            const lockedSource = await resolveActivePlanNameOrId(cwd, source.name);
            if (await getPlanRevisionForText(lockedSource.markdown) !== await getPlanRevisionForText(source.markdown)) {
                throw new StalePlanWriteError(
                    await getPlanRevisionForText(source.markdown),
                    await getPlanRevisionForText(lockedSource.markdown),
                );
            }
            await Deno.mkdir(join(getArchivedPlansDir(cwd), ...destination.segments.slice(0, -1)), { recursive: true });
            await atomicWriteTextFileIfAbsent(destination.filePath, markdown);
            /** @type {MoveEpicArtifactResult[]} */
            let movedArtifacts = [];
            try {
                movedArtifacts = source.attrs.classification === "PROJECT" && source.name.split("/").length === 1
                    ? await moveEpicArtifactsToArchive(cwd, source.name)
                    : [];
                await Deno.remove(source.path);
                await syncDirectory(dirname(source.path));
                await syncDirectory(dirname(destination.filePath));
                for (const artifact of movedArtifacts) await syncDirectory(dirname(artifact.toPath));
            } catch (error) {
                for (const artifact of movedArtifacts.toReversed()) {
                    await Deno.rename(artifact.toPath, artifact.fromPath).catch(() => {});
                }
                await Deno.remove(destination.filePath).catch(() => {});
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
        }));
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

    const plans = await listPlans(cwd);
    /** @type {Map<string, Array<{ name: string, path: string, attrs: PlanFrontMatter }>>} */
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
    const dir = getArchivedPlansDir(cwd);
    /** @type {Array<{ name: string, path: string, attrs: PlanFrontMatter }>} */
    const results = [];
    /** @type {PlanParseIssue[]} */
    const parseIssues = [];
    try {
        await collectPlans(dir, [], results, parseIssues);
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const attempts = await listControllerDocumentWorktrees(cwd);
    for (const attempt of attempts) {
        if (attempts.filter((entry) => entry.planName === attempt.planName).length !== 1) continue;
        const archived = await loadArchivedPlanByName(attempt.path, attempt.planName);
        if (!archived || (attempt.planId && archived.attrs.planId !== attempt.planId)) continue;
        const index = results.findIndex((plan) => plan.name === attempt.planName);
        const item = { name: attempt.planName, path: archived.path, attrs: archived.attrs };
        if (index < 0) results.push(item);
        else results[index] = item;
    }
    for (const issue of parseIssues) {
        console.warn(`Skipping malformed archived Plan ${projectRelativePath(cwd, issue.path)}: ${issue.message}`);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name)).map((plan) => ({
        name: plan.name,
        planName: plan.name,
        relativePath: projectRelativePath(cwd, plan.path),
        path: plan.path,
        attrs: plan.attrs,
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
    const location = getArchivedPlanLocation(cwd, archivedPlanName);
    if (location.segments.length !== 1) {
        throw new Error(`Archived Plan prune target must be top-level: ${archivedPlanName}`);
    }
    const directoryPath = join(getArchivedPlansDir(cwd), location.name);

    return await withPlanCatalogLock(cwd, async () => {
        const removedPaths = [];
        let planStat;
        try {
            planStat = await Deno.stat(location.filePath);
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
                throw new Error(`Archived Plan not found: ${location.name}`);
            }
            throw error;
        }
        if (!planStat.isFile) {
            throw new Error(`Archived Plan is not a file: ${projectRelativePath(cwd, location.filePath)}`);
        }

        let directoryExists = false;
        const directoryEntries = [];
        try {
            const directoryStat = await Deno.stat(directoryPath);
            if (!directoryStat.isDirectory) {
                throw new Error(
                    `Refusing to prune ${location.name}: archived Plan directory path is not a directory ${
                        projectRelativePath(cwd, directoryPath)
                    }`,
                );
            }
            directoryExists = true;
            for await (const entry of Deno.readDir(directoryPath)) {
                const entryPath = join(directoryPath, entry.name);
                if (!entry.isFile || !entry.name.endsWith(".md")) {
                    throw new Error(
                        `Refusing to prune ${location.name}: archived Plan directory contains non-markdown entry ${
                            projectRelativePath(cwd, entryPath)
                        }`,
                    );
                }
                directoryEntries.push(entryPath);
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }

        await Deno.remove(location.filePath);
        removedPaths.push(projectRelativePath(cwd, location.filePath));
        if (directoryExists) {
            await Deno.remove(directoryPath, { recursive: true });
            removedPaths.push(...directoryEntries.map((entryPath) => projectRelativePath(cwd, entryPath)));
        }
        await syncDirectory(dirname(location.filePath));
        if (directoryExists) await syncDirectory(dirname(directoryPath));
        return removedPaths.sort((a, b) => a.localeCompare(b));
    });
}

/**
 * @param {string} cwd
 * @param {string} archivedPlanName
 * @returns {Promise<{ name: string, path: string, markdown: string, attrs: PlanFrontMatter, body: string } | null>}
 */
async function loadArchivedPlanByName(cwd, archivedPlanName) {
    const { name, filePath } = getArchivedPlanLocation(cwd, archivedPlanName);
    let markdown;
    try {
        markdown = await Deno.readTextFile(filePath);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
    }

    try {
        const { attrs, body } = parsePlanFrontMatter(markdown);
        const current = await withControllerMetadata(filePath, attrs);
        return { name, path: filePath, markdown, attrs: current.attrs, body };
    } catch (error) {
        throw new Error(
            `Malformed archived Plan ${projectRelativePath(cwd, filePath)}: ${formatErrorMessage(error)}`,
        );
    }
}

/**
 * Load an archived Plan by archived name/path or durable planId.
 * @param {string} cwd
 * @param {string} archivedPlanNameOrId
 * @returns {Promise<{ name: string, path: string, markdown: string, attrs: PlanFrontMatter, body: string } | null>}
 */
export async function loadArchivedPlan(cwd, archivedPlanNameOrId) {
    const name = getArchivedPlanLocation(cwd, archivedPlanNameOrId).name;
    const attempts = (await listControllerDocumentWorktrees(cwd)).filter((entry) => entry.planName === name);
    if (attempts.length === 1) {
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
    const plan = await loadArchivedPlan(cwd, archivedPlanNameOrId);
    if (!plan) throw new Error(`Archived Plan not found: ${archivedPlanNameOrId}`);
    const attrs = { ...plan.attrs, ...updates, updatedAt: updates.updatedAt ?? new Date().toISOString() };
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
    const archived = await resolveArchivedPlanNameOrId(cwd, archivedPlanNameOrId);
    cwd = getPlanDocumentRoot(archived.path);
    const destination = getStoredPlanLocation(cwd, options.to || archived.name);
    if (destination.segments[0] === ARCHIVED_DIR_NAME) {
        throw new Error("Restore destination must be an active Plan name, not archived/...");
    }
    if (await fileExists(destination.filePath)) {
        throw new Error(`Active Plan already exists: ${projectRelativePath(cwd, destination.filePath)}`);
    }

    const now = options.now || new Date().toISOString();
    const markdown = planDocumentMarkdown(mergeFrontMatterText(archived.markdown, {
        archivedAt: undefined,
        archiveReason: undefined,
        archivedFromStatus: undefined,
        archivedFromPath: undefined,
        restoredAt: now,
        restoredFromPath: projectRelativePath(cwd, archived.path),
        updatedAt: now,
    }));
    return await withPlanCatalogLock(cwd, async () =>
        await withPlanLock(cwd, destination.name, async () => {
            const renamedAttempt = destination.name !== archived.name
                ? (await listControllerDocumentWorktrees(cwd)).find((entry) =>
                    entry.planName === archived.name && resolve(entry.path) === resolve(cwd) &&
                    entry.planId === archived.attrs.planId
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
                await getPlanRevisionForText(lockedArchived.markdown) !==
                    await getPlanRevisionForText(archived.markdown)
            ) {
                throw new StalePlanWriteError(
                    await getPlanRevisionForText(archived.markdown),
                    await getPlanRevisionForText(lockedArchived.markdown),
                );
            }
            if (await fileExists(destination.filePath)) {
                throw new Error(`Active Plan already exists: ${projectRelativePath(cwd, destination.filePath)}`);
            }
            await Deno.mkdir(join(getPlansDir(cwd), ...destination.segments.slice(0, -1)), { recursive: true });
            await atomicWriteTextFileIfAbsent(destination.filePath, markdown);
            /** @type {MoveEpicArtifactResult[]} */
            let movedArtifacts = [];
            let renamed = false;
            let sourceRemoved = false;
            try {
                movedArtifacts = archived.attrs.classification === "PROJECT" && archived.name.split("/").length === 1
                    ? await moveEpicArtifactsFromArchive(cwd, archived.name)
                    : [];
                await syncDirectory(dirname(destination.filePath));
                if (renamedAttempt) {
                    await renameRestoredPlanEntry(cwd, renamedAttempt.id, archived.name, destination.name);
                    renamed = true;
                }
                await Deno.remove(archived.path);
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
                    await Deno.rename(artifact.toPath, artifact.fromPath).catch(() => {});
                }
                await Deno.remove(destination.filePath).catch(() => {});
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
        }));
}

/**
 * Compare Epic child plans by explicit order first, then canonical name.
 *
 * @template {{ name: string, attrs: PlanFrontMatter }} T
 * @param {T} a
 * @param {T} b
 * @returns {number}
 */
export function compareChildPlansByOrder(a, b) {
    const aOrder = a.attrs.order;
    const bOrder = b.attrs.order;
    if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrder !== undefined && bOrder === undefined) return -1;
    if (aOrder === undefined && bOrder !== undefined) return 1;
    return a.name.localeCompare(b.name);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isHiddenPlanName(name) {
    return HIDDEN_PLAN_DIRS.has(name.split("/")[0] || "");
}

/**
 * @param {Array<{ name: string, path: string, attrs: PlanFrontMatter }>} plans
 * @returns {Map<string, Array<{ name: string, path: string, attrs: PlanFrontMatter }>>}
 */
function groupExistingPlanIds(plans) {
    /** @type {Map<string, Array<{ name: string, path: string, attrs: PlanFrontMatter }>>} */
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
    const details = duplicates.map(([planId, plans]) => `${planId}: ${plans.map((plan) => plan.name).join(", ")}`).join(
        "; ",
    );
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
        const plan = await loadPlan(cwd, name);
        if (!plan) throw new Error(`Plan not found: ${planName}`);
        if (isHiddenPlanName(name)) {
            throw new Error(`Plan is archived or hidden and cannot be assigned a planId: ${name}`);
        }

        let reservedPlanIds = options.reservedPlanIds;
        if (!reservedPlanIds) {
            const plans = await listPlans(cwd);
            const byId = groupExistingPlanIds(plans);
            assertNoDuplicatePlanIds(byId);
            reservedPlanIds = new Set(byId.keys());
        }
        const idGenerator = options.idGenerator || (() => crypto.randomUUID());
        let planId = normalizePlanId(plan.attrs.planId);
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
            do {
                planId = normalizePlanId(idGenerator());
            } while (!planId || reservedPlanIds.has(planId));
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
    const { name } = canonicalizeStoredPlanName(planName);
    const existing = await loadPlan(cwd, name);
    if (!existing) throw new Error(`Plan not found: ${planName}`);
    if (existing.hasFrontMatter) {
        return {
            resource: await ensurePlanIdentity(cwd, name, { idGenerator: options.idGenerator }),
            onboarded: false,
        };
    }

    const fileCreatedAt = await Deno.stat(existing.path)
        .then((info) => info.birthtime || info.mtime || null)
        .catch(() => null);
    const now = options.now ? options.now() : new Date();
    return await withPlanCatalogLock(cwd, async () => {
        const resource = await withPlanLock(cwd, name, async () => {
            const plan = await loadPlan(cwd, name);
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
 * List non-archived Plans as durable resources.
 *
 * Listing does not write. `backfillMissing` used to default to `true`, which
 * made every caller that merely read the catalog mint Plan IDs as a side
 * effect — including registry reads taken from inside a lifecycle transaction,
 * which rewrote Front Matter the transaction had already snapshotted and made
 * execution abort with "the Plan changed". Plan identity is assigned once, by
 * the creation and execution paths that call `ensurePlanIdentity` deliberately;
 * healing older Plans is `wld plans doctor --repair`'s job. Opt in explicitly.
 *
 * @param {string} cwd
 * @param {{ backfillMissing?: boolean, idGenerator?: () => string }} [options]
 * @returns {Promise<PlanResource[]>}
 */
export async function listPlanResources(cwd, options = {}) {
    const backfillMissing = options.backfillMissing === true;
    const read = async () => {
        const plans = await listPlans(cwd);
        const byId = groupExistingPlanIds(plans);
        assertNoDuplicatePlanIds(byId);
        const reservedPlanIds = new Set(byId.keys());

        /** @type {PlanResource[]} */
        const resources = [];
        for (const plan of plans) {
            if (plan.attrs.planId || !backfillMissing) {
                const loaded = await loadPlanFileStrict(plan.path);
                if (loaded.kind !== "loaded") continue;
                resources.push({
                    planName: plan.name,
                    name: plan.name,
                    relativePath: `${PLANS_DIR_NAME}/${plan.name}.md`,
                    path: loaded.path,
                    planId: loaded.attrs.planId || "",
                    attrs: loaded.attrs,
                    body: loaded.body,
                    markdown: loaded.markdown,
                    revision: loaded.revision,
                });
                continue;
            }

            const resource = await ensurePlanIdentityLocked(cwd, plan.name, {
                idGenerator: options.idGenerator,
                reservedPlanIds,
            });
            reservedPlanIds.add(resource.planId);
            resources.push(resource);
        }

        return resources;
    };
    // Dashboard/search reads must not serialize publication behind a full catalog
    // scan. Only identity backfills mutate the catalog and need its writer lock.
    return await withProjectRuntimeReadScope(() => backfillMissing ? withPlanCatalogLock(cwd, read) : read());
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
function stripSequencePrefix(value) {
    const stripped = value.replace(/^\d{2}-/, "");
    return stripped === value ? undefined : stripped;
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
    if (matches.length === 0) throw new Error(`Plan not found for planId: ${normalized}`);
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
        // Target-branch list entries can use a Git revision:path reference, not a
        // filesystem path. Prefer the saved local child in the selected document
        // worktree when it has the same identity.
        const local = !isAbsolute(matches[0].path) && resolvePrimaryCheckoutRoot(cwd) !== cwd
            ? await loadPlanStrict(cwd, matches[0].name)
            : null;
        const loaded = local?.kind === "loaded" && local.attrs.planId === matches[0].attrs.planId
            ? local
            : await loadPlanFileStrict(matches[0].path);
        if (loaded.kind !== "loaded") {
            if (loaded.kind === "malformed") throw loaded.error;
            throw new Error(`Plan not found for planId: ${normalized}`);
        }
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
    const resource = await findPlanById(cwd, planId);
    if (isProjectPlan(resource.attrs)) {
        throw new Error("Epic Plan bodies are not editable in the workspace body editor.");
    }
    const markdown = await Deno.readTextFile(resource.path);
    parsePlanFrontMatter(markdown);
    const { body } = splitPlanMarkdownBody(markdown);
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
    return await withPlanCatalogLock(cwd, async () => {
        const resource = await findPlanById(cwd, planId);
        return await withPlanLock(getPlanDocumentRoot(resource.path), resource.planName || resource.name, async () => {
            const selected = await findPlanById(cwd, planId);
            if (selected.path !== resource.path) throw new StalePlanWriteError(resource.revision, selected.revision);
            if (isProjectPlan(resource.attrs)) {
                throw new Error("Epic Plan bodies are not editable in the workspace body editor.");
            }
            const result = await loadPlanFileStrict(resource.path);
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
 * @returns {Promise<Array<{ name: string, path: string, attrs: PlanFrontMatter }>>}
 */
export async function findPlansByParent(cwd, parentPlan) {
    const { name } = canonicalizeStoredPlanName(parentPlan);
    const plans = await listPlansWithTargetChildren(cwd, name);
    return plans.filter((plan) => plan.attrs.parentPlan === name).sort(compareChildPlansByOrder);
}

/**
 * Resolve child FEATURE dependencies against already-loaded sibling summaries.
 *
 * Supported dependency identifiers are either the canonical child plan name
 * (`epic/01-first`) or the sibling child segment (`01-first`). If an exact
 * dependency is not found, the resolver also accepts the unprefixed sibling
 * form (`first`) when exactly one matching two-digit sequence-prefixed sibling
 * (`01-first`) exists.
 *
 * @param {string} parentPlan
 * @param {unknown} dependencies
 * @param {Array<{ name: string, planName?: string, planId?: string, path?: string, attrs?: any, status?: string }>} siblings
 * @returns {Array<{ dependency: string, planId?: string, planName?: string, path?: string, status?: string, state: "verified" | "user_verified" | "unverified" | "missing" }>}
 */
export function resolveSiblingChildPlanDependencyStates(parentPlan, dependencies, siblings) {
    const { name: parentPlanName } = canonicalizeStoredPlanName(parentPlan);
    const dependencyNames = normalizeStringList(dependencies) || [];
    if (dependencyNames.length === 0) return [];

    const byName = new Map(siblings.map((plan) => [plan.name, plan]));
    const byId = Map.groupBy(
        siblings.filter((plan) => plan.planId || plan.attrs?.planId),
        (plan) => plan.planId || plan.attrs?.planId,
    );
    /** @type {Map<string, Array<{ name: string, planName?: string, planId?: string, path?: string, attrs?: any, status?: string }>>} */
    const byUnprefixedName = new Map();
    for (const sibling of siblings) {
        const segments = sibling.name.split("/");
        const segment = segments.at(-1) || sibling.name;
        const unprefixed = stripSequencePrefix(segment);
        if (!unprefixed) continue;
        const alias = `${segments.slice(0, -1).join("/")}/${unprefixed}`.replace(/^\//, "");
        const entries = byUnprefixedName.get(alias) || [];
        entries.push(sibling);
        byUnprefixedName.set(alias, entries);
    }

    return dependencyNames.map((rawDependency) => {
        const dependency = String(rawDependency).trim();
        if (!dependency) return { dependency, state: /** @type {const} */ ("missing") };

        let candidateName;
        try {
            const canonical = canonicalizeStoredPlanName(dependency).name;
            candidateName = canonical.includes("/") ? canonical : `${parentPlanName}/${canonical}`;
        } catch {
            return { dependency, state: /** @type {const} */ ("missing") };
        }

        const identityMatches = byId.get(dependency);
        if (identityMatches && identityMatches.length !== 1) {
            return { dependency, state: /** @type {const} */ ("missing") };
        }
        let sibling = identityMatches?.[0] || byName.get(candidateName);
        if (!sibling) {
            const fallbackMatches = byUnprefixedName.get(candidateName) || [];
            sibling = fallbackMatches.length === 1 ? fallbackMatches[0] : undefined;
        }
        if (!sibling) return { dependency, state: /** @type {const} */ ("missing") };
        const status = sibling.status || sibling.attrs?.status;
        const resolved = {
            dependency,
            planId: sibling.planId || sibling.attrs?.planId,
            planName: sibling.planName || sibling.name,
            path: sibling.path,
            status,
        };
        return {
            ...resolved,
            state: isRunWieldVerifiedStatus(status)
                ? /** @type {const} */ ("verified")
                : isUserVerifiedStatus(status)
                ? /** @type {const} */ ("user_verified")
                : /** @type {const} */ ("unverified"),
        };
    });
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
 * @param {{ attrs: PlanFrontMatter }} plan
 * @returns {boolean}
 */
export function isChildFeaturePlan(plan) {
    return isChildPlannedChangePlan(plan);
}

/** @param {{ attrs: Partial<PlanFrontMatter> }} plan */
export function isChildPlannedChangePlan(plan) {
    return isPlannedChangeClassification(plan.attrs.classification) && typeof plan.attrs.parentPlan === "string" &&
        plan.attrs.parentPlan.trim().length > 0;
}

/**
 * Same Epic rule used by the Plan Lifecycle module, kept here cycle-free.
 *
 * @param {PlanFrontMatterInput | undefined} attrs
 * @returns {boolean}
 */

/**
 * @template {{ name: string, attrs: PlanFrontMatter }} T
 * @param {T[]} plans
 * @returns {{ epics: T[], childrenByParent: Map<string, T[]>, standalone: T[], orphanChildren: T[] }}
 */
export function groupPlanHierarchy(plans) {
    const epics = plans.filter((plan) => isProjectPlan(plan.attrs));
    const epicNames = new Set(epics.map((plan) => plan.name));
    /** @type {Map<string, T[]>} */
    const childrenByParent = new Map();
    /** @type {T[]} */
    const standalone = [];
    /** @type {T[]} */
    const orphanChildren = [];

    for (const plan of plans) {
        if (isProjectPlan(plan.attrs)) continue;

        if (isChildFeaturePlan(plan)) {
            const parentPlan = plan.attrs.parentPlan || "";
            if (epicNames.has(parentPlan)) {
                const children = childrenByParent.get(parentPlan) || [];
                children.push(plan);
                childrenByParent.set(parentPlan, children);
            } else {
                orphanChildren.push(plan);
            }
            continue;
        }

        standalone.push(plan);
    }

    for (const children of childrenByParent.values()) children.sort(compareChildPlansByOrder);
    orphanChildren.sort(compareChildPlansByOrder);

    return { epics, childrenByParent, standalone, orphanChildren };
}

/**
 * @param {Array<{ attrs?: any, status?: string }>} children
 * @returns {{ verified: number, userVerified: number, completed: number, active: number, failed: number, onHold: number, remaining: number, total: number, byStatus: Record<string, number> }}
 */
export function countChildPlanProgress(children) {
    /** @type {Record<string, number>} */
    const byStatus = {};
    for (const child of children) {
        const status = child.status || child.attrs?.status || "draft";
        byStatus[status] = (byStatus[status] || 0) + 1;
    }
    const verified = (byStatus.validated || 0) + (byStatus.verified || 0);
    const userVerified = byStatus.user_verified || 0;
    const completed = verified + userVerified;
    const active = (byStatus.in_progress || 0) + (byStatus.implemented || 0);
    const failed = byStatus.failed || 0;
    const onHold = byStatus.on_hold || 0;
    const total = children.length;
    const remaining = total - completed - active - failed - onHold;
    return { verified, userVerified, completed, active, failed, onHold, remaining, total, byStatus };
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
 * @returns {Promise<{ path: string, markdown: string, attrs: PlanFrontMatter, body: string, revision: string, planName: string, hasFrontMatter?: boolean }>}
 */
export async function resolvePlan(cwd, arg) {
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

    throw new Error(
        `Plan not found: ${arg}. Use '${CLI_BIN} plans' to list available plans.`,
    );
}
