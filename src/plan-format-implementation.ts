import type {
    PlanFrontMatter,
    ExecutionMode,
    DeliveryEvidence,
    PlanExecutionPolicyError,
    PlanExecutionPolicySuccess,
    SplitPlanBody,
    PlanTextLoaded,
    PlanTextMalformed,
} from "./plan-store/index.ts";
import {
    isPlannedChangeClassification,
    normalizePlanClassification,
    normalizeWorkKind,
    PLANS_DIR_NAME,
} from "./plan-format/classification.ts";
import { extractYaml, test as hasFrontMatter } from "./shared/front-matter.ts";
import { normalizeTicketReferences } from "./shared/ticket-references.ts";
import { normalizePlanDeviations } from "./shared/plan-deviations.ts";
import { COLLABORATION_FRONT_MATTER_KEYS, normalizeCollaborationFrontMatter } from "./shared/collaboration/lock.ts";
import { escapeYamlDoubleQuoted } from "./shared/yaml-scalar.ts";
import { PLAN_FRONT_MATTER_KEY_ORDER, PLAN_FRONT_MATTER_KEYS } from "./plan-front-matter.ts";
import { PLAN_RUNTIME_FIELDS } from "./shared/workflow/controller-state.ts";
import { isProjectPlan } from "./shared/project-plan.ts";
import type * as StoredPlanTypes from "./plan-store/index.ts";
type PlanMetadataValue = StoredPlanTypes.PlanFrontMatterInput[string];

/**
 * Canonicalize a stored plan name relative to docs/plans/.
 * @param {string} planName
 * @returns {{ name: string, segments: string[] }}
 */
export function canonicalizeStoredPlanName(planName: string): { name: string; segments: string[] } {
    let normalized = String(planName || "")
        .trim()
        .replaceAll("\\", "/");
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

// ─── Front Matter ─────────────────────────────────────────────────────

/**
 * Default front matter for plans.
 * @type     {PlanFrontMatter}
 */
export const DEFAULT_FRONT_MATTER: PlanFrontMatter = {
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
export const KNOWN_FRONT_MATTER_KEYS: Set<string> = new Set(PLAN_FRONT_MATTER_KEY_ORDER);

export const OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS = Object.freeze([
    "objectiveChecks",
    "objectiveChecksBaseline",
    "objectiveCheckWaivers",
    "validationObjectiveCheckAttempts",
]);

export const HIDDEN_PLAN_DIRS = new Set(["archived"]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedYamlValue(value: PlanMetadataValue): boolean {
    if (value === null) return true;
    if (["string", "number", "boolean"].includes(typeof value)) return true;
    if (Array.isArray(value)) return value.every(isSupportedYamlValue);
    if (value && typeof value === "object") {
        return Object.values(/** @type {Record<string, unknown>} */ value as Record<string, PlanMetadataValue>).every(
            isSupportedYamlValue,
        );
    }
    return false;
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @param {unknown} value
 */
export function appendYamlField(lines: string[], key: string, value: PlanMetadataValue) {
    appendYamlValue(lines, key, value, 0, { emptyArrays: true });
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @param {unknown} value
 * @param {number} indent
 * @param {{ emptyArrays?: boolean }} [options]
 */
export function appendYamlValue(
    lines: string[],
    key: string,
    value: PlanMetadataValue,
    indent: number,
    options: { emptyArrays?: boolean } = {},
) {
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
        const entries = Object.entries(
            /** @type {Record<string, unknown>} */ value as Record<string, PlanMetadataValue>,
        ).filter(([, child]) => {
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
export function appendYamlListItem(
    lines: string[],
    value: PlanMetadataValue,
    indent: number,
    options: { emptyArrays?: boolean },
) {
    const pad = " ".repeat(indent);
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(
            /** @type {Record<string, unknown>} */ value as Record<string, PlanMetadataValue>,
        ).filter(([, child]) => child !== undefined);
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
export function formatFrontMatter(fm: PlanFrontMatter): string {
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

    for (const key of Object.keys(fm)
        .filter((key) => !KNOWN_FRONT_MATTER_KEYS.has(key))
        .sort()) {
        appendYamlField(
            lines,
            key,
            /** @type {Record<string, unknown>} */ (fm as Record<string, PlanMetadataValue>)[key],
        );
    }

    lines.push("---");
    return lines.join("\n");
}

/**
 * @param {string} frontMatter
 * @param {string} body
 * @returns {string}
 */
export function joinFrontMatterAndBody(frontMatter: string, body: string): string {
    const trimmedBody = body.trimStart();
    if (!trimmedBody) return `${frontMatter}\n`;
    return `${frontMatter}\n\n${trimmedBody}`;
}

export const PLAN_STATUSES = new Set([
    "draft",
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

export const PLAN_LIST_STATUS_ORDER = new Map([
    ["failed", 0],
    ["implemented", 1],
    ["validated_ci", 1],
    ["reviewed", 1],
    ["validated", 8],
    ["ready_for_work", 2],
    ["ready_for_decomposition", 3],
    ["draft", 4],
    ["approved", 6],
    ["in_progress", 7],
    ["verified", 8],
    ["user_verified", 9],
    ["closed_without_verification", 10],
    ["on_hold", 10],
]);

export const PLAN_LIST_CLASSIFICATION_ORDER = new Map([
    ["PROJECT", 0],
    ["PLANNED_CHANGE", 1],
    ["FEATURE", 1],
    ["QUICK_FIX", 2],
]);

export const LEGACY_PLAN_STATUSES = new Map([
    ["validated_reviewer", "reviewed"],
    ["completed", "verified"],
    ["feedback", "draft"],
    ["in_review", "draft"],
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
export function canonicalPlanStatus(status: string | undefined): PlanFrontMatter["status"] | undefined {
    const legacy = status ? LEGACY_PLAN_STATUSES.get(status) : undefined;
    if (legacy) return /** @type {PlanFrontMatter["status"]} */ legacy as PlanFrontMatter["status"];
    if (status && PLAN_STATUSES.has(status)) {
        return /** @type {PlanFrontMatter["status"]} */ status as PlanFrontMatter["status"];
    }
    return undefined;
}

/**
 * Read the status exactly as the Plan declares it, before compatibility normalization.
 * @param {string} planContent
 * @returns {string | undefined}
 */
export function getDeclaredPlanStatus(planContent: string): string | undefined {
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
export function normalizePlanStatus(status: string | undefined): PlanFrontMatter["status"] {
    return canonicalPlanStatus(status) || DEFAULT_FRONT_MATTER.status;
}

/** @param {string | undefined | null} status */
export function isRunWieldVerifiedStatus(status: string | undefined | null) {
    return status === "validated" || status === "verified";
}

/** @param {string | undefined | null} status */
export function isUserVerifiedStatus(status: string | undefined | null) {
    return status === "user_verified";
}

/** @param {string | undefined | null} status */
export function isPlanDependencySatisfiedStatus(status: string | undefined | null) {
    return status === "validated" || status === "verified" || status === "user_verified";
}

/** @param {string | undefined | null} status */
export function isCompletedPlanStatus(status: string | undefined | null) {
    return (
        status === "validated" ||
        status === "verified" ||
        status === "user_verified" ||
        status === "closed_without_verification"
    );
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
export function normalizeOptionalBoolean(value: PlanMetadataValue): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
    }
    return undefined;
}

/** @param {unknown} value @returns {"engineer"|"frontend-engineer"|undefined} */
export function normalizeExecutionAgent(value: PlanMetadataValue): "engineer" | "frontend-engineer" | undefined {
    return value === "engineer" || value === "frontend-engineer" ? value : undefined;
}

/** @param {unknown} value @returns {"pair"|"autonomous"|undefined} */
export function normalizeCollaborationMode(value: PlanMetadataValue): "pair" | "autonomous" | undefined {
    return value === "pair" || value === "autonomous" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasExplicitPolicyValue(value: PlanMetadataValue): boolean {
    return value !== undefined && value !== null && value !== "";
}

/**
 * Resolve and validate Plan execution policy without mutating source Front Matter.
 *
 * @param {Partial<PlanFrontMatter>} meta
 * @returns {PlanExecutionPolicySuccess | PlanExecutionPolicyError}
 */
export function resolvePlanExecutionPolicy(
    meta: Partial<PlanFrontMatter>,
): PlanExecutionPolicySuccess | PlanExecutionPolicyError {
    const classification = normalizePlanClassification(meta.classification || DEFAULT_FRONT_MATTER.classification);
    const explicitAgent = hasExplicitPolicyValue(meta.executionAgent);
    const explicitRecommendation = hasExplicitPolicyValue(meta.collaborationRecommendation);
    const validAgent = normalizeExecutionAgent(meta.executionAgent);
    const validRecommendation = normalizeCollaborationMode(meta.collaborationRecommendation);

    if (explicitAgent && !validAgent) {
        return {
            ok: false,
            reason: "invalid_execution_agent",
            error: `Invalid executionAgent: ${String(
                meta.executionAgent,
            )}. Supported values are engineer and frontend-engineer.`,
        };
    }
    if (explicitRecommendation && !validRecommendation) {
        return {
            ok: false,
            reason: "invalid_collaboration_recommendation",
            error: `Invalid collaborationRecommendation: ${String(
                meta.collaborationRecommendation,
            )}. Supported values are autonomous and pair.`,
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
    const executionAgent =
        isPlannedChange && validAgent
            ? validAgent
            : isPlannedChange && meta.frontend === true
              ? "frontend-engineer"
              : "engineer";
    const source =
        isPlannedChange && validAgent
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
export function assertExecutionPolicyWriteAllowed(
    attempted: Partial<PlanFrontMatter>,
    merged: Partial<PlanFrontMatter>,
) {
    const writesPolicy =
        Object.hasOwn(attempted, "executionAgent") ||
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
export function optionalFrontMatterValue(
    overrides: Partial<PlanFrontMatter>,
    existingFm: Partial<PlanFrontMatter>,
    key: keyof PlanFrontMatter,
): string | null | undefined {
    if (Object.hasOwn(overrides, key)) {
        return /** @type {string | null | undefined} */ (overrides[key] ?? undefined) as string | null | undefined;
    }
    return /** @type {string | null | undefined} */ existingFm[key] as string | null | undefined;
}

/**
 * @param {Partial<PlanFrontMatter>} overrides
 * @param {Partial<PlanFrontMatter>} existingFm
 * @param {keyof PlanFrontMatter} key
 * @returns {string | undefined}
 */
export function optionalStringValue(
    overrides: Partial<PlanFrontMatter>,
    existingFm: Partial<PlanFrontMatter>,
    key: keyof PlanFrontMatter,
): string | undefined {
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
export function optionalExecutionPolicyValue(
    overrides: Partial<PlanFrontMatter>,
    existingFm: Partial<PlanFrontMatter>,
    key: keyof PlanFrontMatter,
): PlanMetadataValue {
    if (Object.hasOwn(overrides, key)) return overrides[key] ?? undefined;
    return existingFm[key] ?? undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizePlanId(value: PlanMetadataValue): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
export function normalizeStringList(value: PlanMetadataValue): string[] | undefined {
    return Array.isArray(value) ? value.map(String) : undefined;
}

export const WORK_RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalize optional Work Record supersession IDs without coercing malformed values.
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
export function normalizeSupersedes(value: PlanMetadataValue): string[] | undefined {
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
export function normalizeNonNegativeInteger(value: PlanMetadataValue): number | undefined {
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
export function normalizePlanStatusForOptionalHold(
    status: PlanMetadataValue,
): PlanFrontMatter["status"] | null | undefined {
    if (status === null) return null;
    if (typeof status !== "string") return undefined;
    return canonicalPlanStatus(status);
}

/**
 * @param {unknown} status
 * @returns {PlanFrontMatter["worktreeStatus"]}
 */
export function normalizeWorktreeStatus(status: PlanMetadataValue): PlanFrontMatter["worktreeStatus"] {
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
        return /** @type {PlanFrontMatter["worktreeStatus"]} */ status as PlanFrontMatter["worktreeStatus"];
    }
    return undefined;
}

/**
 * @param {unknown} value
 * @returns {ExecutionMode | undefined}
 */
export function normalizeExecutionMode(value: PlanMetadataValue): ExecutionMode | undefined {
    if (value === "worktree" || value === "non_git_in_place") return value;
    return undefined;
}

/** @param {unknown} value */
export function isShaLike(value: PlanMetadataValue) {
    return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * @param {unknown} value
 * @returns {DeliveryEvidence | undefined}
 */
export function normalizeDeliveryEvidence(value: PlanMetadataValue): DeliveryEvidence | undefined {
    if (value === null) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const evidence = /** @type {Record<string, unknown>} */ value as Record<string, PlanMetadataValue>;
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
export function normalizeHumanReviewMode(mode: PlanMetadataValue): PlanFrontMatter["humanReviewMode"] {
    if (mode === null) return null;
    if (mode === "none" || mode === "ask" || mode === "always") return mode;
    return undefined;
}

/**
 * @param {unknown} decision
 * @returns {PlanFrontMatter["humanReviewDecision"]}
 */
export function normalizeHumanReviewDecision(decision: PlanMetadataValue): PlanFrontMatter["humanReviewDecision"] {
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
export function normalizeWorkRecordBacklink(value: PlanMetadataValue): PlanFrontMatter["workRecord"] {
    if (!value || typeof value !== "object") return undefined;
    const source = /** @type {Record<string, unknown>} */ value as Record<string, PlanMetadataValue>;
    const status = source.status === "generated" || source.status === "failed" ? source.status : undefined;
    const recordId = typeof source.recordId === "string" && source.recordId.trim() ? source.recordId.trim() : undefined;
    const path = typeof source.path === "string" && source.path.trim() ? source.path.trim() : undefined;
    const lastAttemptAt =
        typeof source.lastAttemptAt === "string" && source.lastAttemptAt.trim()
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
export function injectFrontMatter(markdown: string, overrides: Partial<PlanFrontMatter> = {}): string {
    /** @type {Partial<PlanFrontMatter>} */
    let existingFm: Partial<PlanFrontMatter> = {};
    let body = markdown;

    if (hasFrontMatter(markdown)) {
        const { attrs, body: b } = extractYaml(markdown);
        existingFm = attrs || {};
        body = b;
    }

    /** @type {PlanFrontMatter} */
    const fm: PlanFrontMatter = {
        ...existingFm,
        ...overrides,
        planId: Object.hasOwn(overrides, "planId")
            ? normalizePlanId(overrides.planId)
            : normalizePlanId(existingFm.planId),
        classification: normalizePlanClassification(
            overrides.classification ?? existingFm.classification ?? DEFAULT_FRONT_MATTER.classification,
        ),
        workKind: Object.hasOwn(overrides, "workKind")
            ? normalizeWorkKind(overrides.workKind)
            : normalizeWorkKind(existingFm.workKind),
        complexity: overrides.complexity ?? existingFm.complexity ?? DEFAULT_FRONT_MATTER.complexity,
        summary: overrides.summary ?? existingFm.summary ?? DEFAULT_FRONT_MATTER.summary,
        affectedPaths: overrides.affectedPaths ?? existingFm.affectedPaths ?? DEFAULT_FRONT_MATTER.affectedPaths,
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
        createdAt: overrides.createdAt ?? existingFm.createdAt ?? DEFAULT_FRONT_MATTER.createdAt,
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
        epicCompletionMode:
            /** @type {"done_enough" | null | undefined} */ optionalFrontMatterValue(
                overrides,
                existingFm,
                "epicCompletionMode",
            ) === "done_enough"
                ? "done_enough"
                : (undefined as "done_enough" | null | undefined),
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
        delete (/** @type {Record<string, unknown>} */ (fm as Record<string, PlanMetadataValue>)[key]);
    }
    delete (/** @type {Record<string, unknown>} */ (fm as Record<string, PlanMetadataValue>).collaborationMode);
    assertExecutionPolicyWriteAllowed(overrides, fm);

    return joinFrontMatterAndBody(formatFrontMatter(fm), body);
}

/** YAML can decode an unquoted timestamp as a Date. Keep creation age when serializing it again.
 * @param {string | Date | undefined} value
 * @returns {string}
 */
export function normalizeCreatedAt(value: string | Date | undefined): string {
    return value instanceof Date ? value.toISOString() : value || DEFAULT_FRONT_MATTER.createdAt;
}

/**
 * Parse front matter from a plan file. Returns defaults if missing.
 *
 * @param {string} markdown
 * @param {{ missingOrigin?: string }} [opts]
 * @returns {{ attrs: PlanFrontMatter, body: string }}
 */
export function parsePlanFrontMatter(
    markdown: string,
    opts: { missingOrigin?: string } = {},
): { attrs: PlanFrontMatter; body: string } {
    const missingOrigin =
        /** @type {PlanFrontMatter["origin"]} */ opts.missingOrigin ||
        (DEFAULT_FRONT_MATTER.origin as PlanFrontMatter["origin"]);
    if (/^(<<<<<<<|=======|>>>>>>>)\s/m.test(markdown)) {
        throw new Error("Plan contains unresolved merge conflict markers.");
    }

    if (!hasFrontMatter(markdown)) {
        return {
            attrs: {
                ...DEFAULT_FRONT_MATTER,
                summary: summarizePlanBody(markdown),
                createdAt: new Date().toISOString(),
                origin: /** @type {"internal"|"external"} */ missingOrigin as "internal" | "external",
            },
            body: markdown,
        };
    }
    const { attrs, body } = /** @type {import("./shared/front-matter.ts").FrontMatter<PlanFrontMatter>} */ extractYaml(
        markdown,
    ) as import("./shared/front-matter.ts").FrontMatter<PlanFrontMatter>;
    const collaborationAttrs = normalizeCollaborationFrontMatter(attrs);
    const sourceAttrs = { ...attrs };
    for (const key of OBSOLETE_OBJECTIVE_CHECK_FRONT_MATTER_KEYS) Reflect.deleteProperty(sourceAttrs, key);
    for (const key of Object.values(COLLABORATION_FRONT_MATTER_KEYS)) {
        Reflect.deleteProperty(sourceAttrs, key);
    }
    Reflect.deleteProperty(sourceAttrs, "collaborationMode");
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
            executionAgent: Object.hasOwn(attrs, "executionAgent") ? (attrs.executionAgent ?? undefined) : undefined,
            collaborationRecommendation: Object.hasOwn(attrs, "collaborationRecommendation")
                ? (attrs.collaborationRecommendation ?? undefined)
                : undefined,
            frontend: normalizeOptionalBoolean(attrs.frontend),
            devServerCommand:
                typeof attrs.devServerCommand === "string"
                    ? attrs.devServerCommand
                    : attrs.devServerCommand === null
                      ? null
                      : undefined,
            devServerUrl:
                typeof attrs.devServerUrl === "string"
                    ? attrs.devServerUrl
                    : attrs.devServerUrl === null
                      ? null
                      : undefined,
            devServerHmr: attrs.devServerHmr === null ? null : normalizeOptionalBoolean(attrs.devServerHmr),
            createdAt: normalizeCreatedAt(attrs.createdAt),
            updatedAt: attrs.updatedAt,
            status: normalizePlanStatus(attrs.status),
            origin: (attrs.origin || missingOrigin) as PlanFrontMatter["origin"],
            parentPlan: typeof attrs.parentPlan === "string" ? attrs.parentPlan : undefined,
            order: normalizeNonNegativeInteger(attrs.order),
            dependencies: normalizeStringList(attrs.dependencies),
            failureReason: attrs.failureReason,
            failedAt: attrs.failedAt,
            implementedAt: attrs.implementedAt,
            validatedAt: attrs.validatedAt,
            verifiedAt: attrs.verifiedAt,
            userVerifiedAt: attrs.userVerifiedAt,
            userVerificationNote:
                typeof attrs.userVerificationNote === "string" ? attrs.userVerificationNote : undefined,
            closedWithoutVerificationReason:
                typeof attrs.closedWithoutVerificationReason === "string"
                    ? attrs.closedWithoutVerificationReason
                    : undefined,
            closedWithoutVerificationAt:
                typeof attrs.closedWithoutVerificationAt === "string" ? attrs.closedWithoutVerificationAt : undefined,
            executionReport: typeof attrs.executionReport === "string" ? attrs.executionReport : undefined,
            workRecord: normalizeWorkRecordBacklink(attrs.workRecord),
            humanReviewMode: normalizeHumanReviewMode(attrs.humanReviewMode),
            humanReviewDecision: normalizeHumanReviewDecision(attrs.humanReviewDecision),
            humanReviewedAt: attrs.humanReviewedAt,
            validationPhase:
                attrs.validationPhase === "mechanical" ||
                attrs.validationPhase === "semantic" ||
                attrs.validationPhase === "delivery"
                    ? attrs.validationPhase
                    : undefined,
            validationCheckpoint:
                attrs.validationCheckpoint && typeof attrs.validationCheckpoint === "object"
                    ? attrs.validationCheckpoint
                    : attrs.validationCheckpoint === null
                      ? null
                      : undefined,
            epicCompletionMode: attrs.epicCompletionMode === "done_enough" ? attrs.epicCompletionMode : undefined,
            epicDoneEnoughAt: attrs.epicDoneEnoughAt,
            epicDoneEnoughSummary: attrs.epicDoneEnoughSummary,
            epicBaseCommit: typeof attrs.epicBaseCommit === "string" ? attrs.epicBaseCommit : undefined,
            epicDeliveryTargetBranch:
                typeof attrs.epicDeliveryTargetBranch === "string" ? attrs.epicDeliveryTargetBranch : undefined,
            epicIntegrationReport:
                typeof attrs.epicIntegrationReport === "string" ? attrs.epicIntegrationReport : undefined,
            executionMode: normalizeExecutionMode(attrs.executionMode),
            deliveryEvidence: normalizeDeliveryEvidence(attrs.deliveryEvidence),
            validatedCommit: typeof attrs.validatedCommit === "string" ? attrs.validatedCommit : undefined,
            executionBaselineTree: attrs.executionBaselineTree,
            worktreeId: attrs.worktreeId,
            worktreePath: attrs.worktreePath,
            worktreeBranch: attrs.worktreeBranch,
            worktreeBaseBranch: attrs.worktreeBaseBranch,
            deliveryBranch: typeof attrs.deliveryBranch === "string" ? attrs.deliveryBranch : undefined,
            targetBranch:
                typeof attrs.targetBranch === "string"
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
export function summarizePlanBody(body: string) {
    const context = /^##\s+Context\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(body)?.[1];
    return (context?.trim().split(/\r?\n\s*\r?\n/)[0] || "").replace(/\s+/g, " ").trim();
}

/** Produce only the human document. Operational fields are accepted for import, never written back. @param {string} markdown */
export function planDocumentMarkdown(markdown: string) {
    if (!hasFrontMatter(markdown)) return markdown;
    const { attrs } = parsePlanFrontMatter(markdown);
    const raw = extractYaml(markdown).attrs;
    /** @type {Partial<PlanFrontMatter>} */
    const removed: Partial<PlanFrontMatter> = { summary: undefined };
    for (const field of PLAN_RUNTIME_FIELDS) Object.assign(removed, { [field]: undefined });
    if (attrs.targetBranch && raw.targetBranch !== attrs.targetBranch) removed.targetBranch = attrs.targetBranch;
    return mergeFrontMatterText(markdown, removed);
}

/**
 * Split raw markdown into the exact leading front matter block and body.
 * @param {string} markdown
 * @returns {SplitPlanBody}
 */
export function splitPlanMarkdownBody(markdown: string): SplitPlanBody {
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
 * @param {string} line
 * @param {string} key
 * @returns {boolean}
 */
export function isTopLevelYamlKeyLine(line: string, key: string): boolean {
    return line.startsWith(`${key}:`) || line.startsWith(`${key} :`);
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isAnyTopLevelYamlKeyLine(line: string): boolean {
    return /^[^\s#][^:]*\s*:/.test(line);
}

/**
 * Remove a top-level YAML key and any indented/list continuation lines from a front matter body.
 * @param {string[]} lines
 * @param {string} key
 * @returns {string[]}
 */
export function removeTopLevelYamlKey(lines: string[], key: string): string[] {
    /** @type {string[]} */
    const kept: string[] = [];
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
export function formatFrontMatterOverrideLines(overrides: Partial<PlanFrontMatter>): string[] {
    /** @type {string[]} */
    const lines: string[] = [];
    for (const key of PLAN_FRONT_MATTER_KEY_ORDER) {
        if (Object.hasOwn(overrides, key)) {
            appendYamlField(
                lines,
                key,
                /** @type {Record<string, unknown>} */ (overrides as Record<string, PlanMetadataValue>)[key],
            );
        }
    }
    for (const key of Object.keys(overrides)
        .filter((key) => !KNOWN_FRONT_MATTER_KEYS.has(key))
        .sort()) {
        appendYamlField(
            lines,
            key,
            /** @type {Record<string, unknown>} */ (overrides as Record<string, PlanMetadataValue>)[key],
        );
    }
    return lines;
}

/**
 * Update only selected front matter fields while preserving untouched YAML text and body bytes.
 * @param {string} markdown
 * @param {Partial<PlanFrontMatter>} overrides
 * @returns {string}
 */
export function mergeFrontMatterText(markdown: string, overrides: Partial<PlanFrontMatter>): string {
    if (!hasFrontMatter(markdown)) return injectFrontMatter(markdown, overrides);

    const { frontMatterBlock, body } = splitPlanMarkdownBody(markdown);
    const eol = frontMatterBlock.includes("\r\n") ? "\r\n" : "\n";
    const lines = frontMatterBlock.replace(/\r?\n$/, "").split(/\r?\n/);
    const closingIndex = lines.length - 1;
    let innerLines = lines.slice(1, closingIndex);
    for (const key of PLAN_FRONT_MATTER_KEY_ORDER) {
        if (Object.hasOwn(overrides, key)) innerLines = removeTopLevelYamlKey(innerLines, key);
    }
    const orderedKeys = /** @type {readonly string[]} */ PLAN_FRONT_MATTER_KEY_ORDER as readonly string[];
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
export async function hashPlanBody(body: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class PlanFrontMatterParseError extends Error {
    declare path: string;
    /**
     * @param {string} path
     * @param {unknown} cause
     */
    constructor(path: string, cause: PlanMetadataValue) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Plan Front Matter could not be parsed in ${path}: ${detail}`);
        this.name = "PlanFrontMatterParseError";
        this.path = path;
        this.cause = cause;
    }
}

/** @param {string} text */
export async function getPlanRevisionForText(text: string) {
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
export async function getPlanFrontMatterRevisionForText(text: string): Promise<string | undefined> {
    try {
        return await getPlanRevisionForText(splitPlanMarkdownBody(text).frontMatterBlock);
    } catch {
        return undefined;
    }
}

/**
 * Strictly parse document bytes without filesystem or runtime access.
 * @param {string} markdown
 * @param {string} filePath - Diagnostic source, including commit:path snapshots.
 * @returns {Promise<PlanTextLoaded | PlanTextMalformed>}
 */
export async function parsePlanTextStrict(
    markdown: string,
    filePath: string,
): Promise<PlanTextLoaded | PlanTextMalformed> {
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
    const frontMatterRevision = await getPlanFrontMatterRevisionForText(markdown);
    rememberFrontMatterRevision(revision, frontMatterRevision);
    return {
        kind: "loaded",
        path: filePath,
        markdown,
        attrs: parsed.attrs,
        body: parsed.body,
        revision,
        frontMatterRevision,
        hasFrontMatter: hasFrontMatter(markdown),
        controllerRevision: 0,
    };
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
export const frontMatterRevisionsByPlanRevision: Map<string, string> = new Map();

export const KNOWN_REVISION_LIMIT = 1024;

/** @param {string} revision @param {string|undefined} frontMatterRevision */
export function rememberFrontMatterRevision(revision: string, frontMatterRevision: string | undefined) {
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
export function getKnownFrontMatterRevision(revision: string | undefined): string | undefined {
    return revision ? frontMatterRevisionsByPlanRevision.get(revision) : undefined;
}

/**
 * Compare plans in the canonical order exposed to plan-list consumers.
 *
 * @template {{ name: string, attrs: PlanFrontMatter }} T
 * @param {T} a
 * @param {T} b
 * @returns {number}
 */
export function comparePlansForList<T extends { name: string; attrs: PlanFrontMatter }>(a: T, b: T): number {
    const statusDelta =
        (PLAN_LIST_STATUS_ORDER.get(a.attrs.status) ?? PLAN_LIST_STATUS_ORDER.size) -
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

export const TERMINAL_ARCHIVABLE_STATUSES = new Set([
    "validated",
    "verified",
    "user_verified",
    "closed_without_verification",
]);

export const RECOVERABLE_WORKTREE_STATUSES = new Set([
    "active",
    "execution_failed",
    "validation_failed",
    "merge_conflict",
]);

/**
 * @param {string | undefined | null} status
 * @returns {boolean}
 */
export function isTerminalArchivableStatus(status: string | undefined | null): boolean {
    return Boolean(status) && TERMINAL_ARCHIVABLE_STATUSES.has(String(status));
}

/**
 * @param {string | undefined | null} worktreeStatus
 * @returns {boolean}
 */
export function isRecoverableWorktreeStatus(worktreeStatus: string | undefined | null): boolean {
    return Boolean(worktreeStatus) && RECOVERABLE_WORKTREE_STATUSES.has(String(worktreeStatus));
}

/**
 * Compare Epic child plans by explicit order first, then canonical name.
 *
 * @template {{ name: string, attrs: Pick<PlanFrontMatter, "order"> }} T
 * @param {T} a
 * @param {T} b
 * @returns {number}
 */
export function compareChildPlansByOrder<T extends { name: string; attrs: Pick<PlanFrontMatter, "order"> }>(
    a: T,
    b: T,
): number {
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
export function isHiddenPlanName(name: string): boolean {
    return HIDDEN_PLAN_DIRS.has(name.split("/")[0] || "");
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
export function stripSequencePrefix(value: string): string | undefined {
    const stripped = value.replace(/^\d{2}-/, "");
    return stripped === value ? undefined : stripped;
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
 * @param {Array<{ name: string, planName?: string, planId?: string, path?: string, attrs?: PlanProgressAttributes, status?: string }>} siblings
 * @returns {Array<{ dependency: string, planId?: string, planName?: string, path?: string, status?: string, state: "verified" | "user_verified" | "unverified" | "missing" }>}
 */
export interface PlanProgressAttributes {
    planId?: string;
    status?: string;
}
export interface PlanDependencySibling {
    name: string;
    planName?: string;
    planId?: string;
    path?: string;
    attrs?: PlanProgressAttributes;
    status?: string;
}

export function resolveSiblingChildPlanDependencyStates(
    parentPlan: string,
    dependencies: PlanMetadataValue,
    siblings: PlanDependencySibling[],
): Array<{
    dependency: string;
    planId?: string;
    planName?: string;
    path?: string;
    status?: string;
    state: "verified" | "user_verified" | "unverified" | "missing";
}> {
    const { name: parentPlanName } = canonicalizeStoredPlanName(parentPlan);
    const dependencyNames = normalizeStringList(dependencies) || [];
    if (dependencyNames.length === 0) return [];

    const byName = new Map(siblings.map((plan) => [plan.name, plan]));
    const byId = Map.groupBy(
        siblings.filter((plan) => plan.planId || plan.attrs?.planId),
        (plan) => plan.planId || plan.attrs?.planId,
    );
    /** @type {Map<string, Array<{ name: string, planName?: string, planId?: string, path?: string, attrs?: PlanProgressAttributes, status?: string }>>} */
    const byUnprefixedName: Map<string, PlanDependencySibling[]> = new Map();
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
        if (!dependency) return { dependency, state: /** @type {const} */ "missing" as const };

        let candidateName;
        try {
            const canonical = canonicalizeStoredPlanName(dependency).name;
            candidateName = canonical.includes("/") ? canonical : `${parentPlanName}/${canonical}`;
        } catch {
            return { dependency, state: /** @type {const} */ "missing" as const };
        }

        const identityMatches = byId.get(dependency);
        if (identityMatches && identityMatches.length !== 1) {
            return { dependency, state: /** @type {const} */ "missing" as const };
        }
        let sibling = identityMatches?.[0] || byName.get(candidateName);
        if (!sibling) {
            const fallbackMatches = byUnprefixedName.get(candidateName) || [];
            sibling = fallbackMatches.length === 1 ? fallbackMatches[0] : undefined;
        }
        if (!sibling) return { dependency, state: /** @type {const} */ "missing" as const };
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
                ? /** @type {const} */ ("verified" as const)
                : isUserVerifiedStatus(status)
                  ? /** @type {const} */ ("user_verified" as const)
                  : /** @type {const} */ ("unverified" as const),
        };
    });
}

/**
 * @param {{ attrs: PlanFrontMatter }} plan
 * @returns {boolean}
 */
export function isChildFeaturePlan(plan: { attrs: PlanFrontMatter }): boolean {
    return isChildPlannedChangePlan(plan);
}

/** @param {{ attrs: Partial<PlanFrontMatter> }} plan */
export function isChildPlannedChangePlan(plan: { attrs: Partial<PlanFrontMatter> }) {
    return (
        isPlannedChangeClassification(plan.attrs.classification) &&
        typeof plan.attrs.parentPlan === "string" &&
        plan.attrs.parentPlan.trim().length > 0
    );
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
export function groupPlanHierarchy<T extends { name: string; attrs: PlanFrontMatter }>(
    plans: T[],
): { epics: T[]; childrenByParent: Map<string, T[]>; standalone: T[]; orphanChildren: T[] } {
    const epics = plans.filter((plan) => isProjectPlan(plan.attrs));
    const epicNames = new Set(epics.map((plan) => plan.name));
    /** @type {Map<string, T[]>} */
    const childrenByParent: Map<string, T[]> = new Map();
    /** @type {T[]} */
    const standalone: T[] = [];
    /** @type {T[]} */
    const orphanChildren: T[] = [];

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
 * @param {Array<{ attrs?: PlanProgressAttributes, status?: string }>} children
 * @returns {{ verified: number, userVerified: number, completed: number, active: number, failed: number, onHold: number, remaining: number, total: number, byStatus: Record<string, number> }}
 */
export function countChildPlanProgress(children: Array<{ attrs?: PlanProgressAttributes; status?: string }>): {
    verified: number;
    userVerified: number;
    completed: number;
    active: number;
    failed: number;
    onHold: number;
    remaining: number;
    total: number;
    byStatus: Record<string, number>;
} {
    /** @type {Record<string, number>} */
    const byStatus: Record<string, number> = {};
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
