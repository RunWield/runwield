/**
 * Server-only Plan adapter for the read-only Workspace.
 */

import {
    countChildPlanProgress,
    findPlanById,
    findPlanEvidenceById,
    groupPlanHierarchy,
    isChildFeaturePlan,
    isProjectPlan,
    listPlanResources,
    loadPlanBodyById,
    resolveSiblingChildPlanDependencyStates,
    savePlanBodyById,
    StalePlanBodyError,
} from "../../../plan-store.js";
import {
    ACTIVE_PLAN_STATUSES,
    buildPlanEventUpdates,
    CLOSED_PLAN_STATUSES,
    getPlanLifecycleActionMetadata,
    ON_HOLD_PLAN_STATUSES,
    PLAN_STATUSES,
} from "../../../shared/workflow/plan-lifecycle.js";
import {
    isSharedPlanLocked,
    SHARED_PLAN_LOCK_REPAIR,
    SharedPlanLockError,
} from "../../../shared/collaboration/lock.ts";
import { getWorktreeStatus, inspectExecutionWorktreeMergeRisk } from "../../../shared/worktree.js";
import {
    autoGenerateWorkRecordForCompletedPlan,
    formatWorkRecordAutoGenerationResult,
} from "../../../shared/work-records/auto-generation.js";
import { executePlanAction, loadPlanActionEvidence } from "../../../shared/workflow/plan-actions.ts";
import { PLAN_LIFECYCLE_ACTIONS } from "../constants.ts";

/** @typedef {{ reviewOnly?: boolean }} WorkspacePlanDetailOptions */

export const ACTIVE_STATUSES = ACTIVE_PLAN_STATUSES;
export const CLOSED_STATUSES = CLOSED_PLAN_STATUSES;
export const ON_HOLD_STATUSES = ON_HOLD_PLAN_STATUSES;

export const STATUS_META = {
    draft: {
        status: "draft",
        label: "Draft",
        description: "Plans still being shaped.",
    },
    feedback: {
        status: "feedback",
        label: "Feedback",
        description: "Plans waiting on review or revisions.",
    },
    approved: {
        status: "approved",
        label: "Approved",
        description: "Approved work not yet queued for execution.",
    },
    ready_for_decomposition: {
        status: "ready_for_decomposition",
        label: "Ready for Decomposition",
        description: "Epics ready for child Planned Change slicing.",
    },
    ready_for_work: {
        status: "ready_for_work",
        label: "Ready for Work",
        description: "Executable work ready for an agent.",
    },
    in_progress: {
        status: "in_progress",
        label: "In Progress",
        description: "Work currently underway or reserved.",
    },
    failed: {
        status: "failed",
        label: "Failed",
        description: "Work that needs recovery attention.",
    },
    implemented: {
        status: "implemented",
        label: "Implemented",
        description: "Implemented work awaiting validation or closure.",
    },
    validated_ci: {
        status: "validated_ci",
        label: "Implemented",
        description: "Tests and CI passed; AI review is next.",
    },
    reviewed: {
        status: "reviewed",
        label: "Reviewed",
        description: "AI review passed; code review or delivery is next.",
    },
    validated: {
        status: "validated",
        label: "Verified",
        description: "Legacy name for verified delivery.",
    },
    verified: {
        status: "verified",
        label: "Verified",
        description: "Reviewed work delivered to its target branch, or verified in place for a non-Git project.",
    },
    user_verified: {
        status: "user_verified",
        label: "User Verified",
        description: "Work verified by the user without RunWield Workflow Validation proof.",
    },
    closed_without_verification: {
        status: "closed_without_verification",
        label: "Closed without Verification",
        description: "Work manually accepted or ended without Workflow Validation.",
    },
    on_hold: {
        status: "on_hold",
        label: "On Hold",
        description: "Paused work that should stay out of active planning.",
    },
};

export const ACTION_META = {
    [PLAN_LIFECYCLE_ACTIONS.MOVE_STATUS]: {
        action: PLAN_LIFECYCLE_ACTIONS.MOVE_STATUS,
        label: "Move status",
        description: "Move among manual board statuses through Plan Lifecycle.",
    },
    [PLAN_LIFECYCLE_ACTIONS.USER_VERIFY]: {
        action: PLAN_LIFECYCLE_ACTIONS.USER_VERIFY,
        label: "Mark as User Verified",
        description: "Record user attestation without setting verifiedAt or Delivery Evidence.",
    },
    [PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION]: {
        action: PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION,
        label: "Close without verification",
        description: "Terminally close without setting verifiedAt.",
    },
    [PLAN_LIFECYCLE_ACTIONS.PUT_ON_HOLD]: {
        action: PLAN_LIFECYCLE_ACTIONS.PUT_ON_HOLD,
        label: "Put on hold",
        description: "Pause this Plan without mutating child Plans.",
    },
    [PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD]: {
        action: PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD,
        label: "Resume from hold",
        description: "Resume to the recorded heldFromStatus after Resume Check.",
    },
    [PLAN_LIFECYCLE_ACTIONS.RESET_TO_DRAFT]: {
        action: PLAN_LIFECYCLE_ACTIONS.RESET_TO_DRAFT,
        label: "Reset status to draft",
        description:
            "Clear hold/worktree/recovery metadata after any physical worktree attempt is explicitly resolved.",
    },
};

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const BOARD_SCREENS = {
    active: {
        id: "active",
        path: "/",
        title: "Plan Board",
        eyebrow: "Workspace view",
        description: "Active work grouped by RunWield Plan Status.",
        statuses: ACTIVE_STATUSES,
    },
    closed: {
        id: "closed",
        path: "/closed",
        title: "Closed Plans",
        eyebrow: "Plan Board",
        description: "Terminal Plans separated from day-to-day planning.",
        statuses: CLOSED_STATUSES,
    },
    onHold: {
        id: "onHold",
        path: "/on-hold",
        title: "On Hold",
        eyebrow: "Plan Board",
        description: "Paused Plans that are neither active nor complete.",
        statuses: ON_HOLD_STATUSES,
    },
};

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? /** @type {Record<string, unknown>} */ (value)
        : {};
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function workspaceSafeFrontMatter(value) {
    const frontMatter = { ...safeObject(value) };
    delete frontMatter.worktreePath;
    if (frontMatter.classification !== "PROJECT") delete frontMatter.type;
    return frontMatter;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * @param {string} status
 * @returns {boolean}
 */
function isKnownStatus(status) {
    return PLAN_STATUSES.includes(/** @type {any} */ (status));
}

/**
 * @param {string} status
 */
function statusOption(status) {
    const meta = /** @type {any} */ (STATUS_META)[status] || { status, label: status, description: "" };
    return { status, label: meta.label, description: meta.description };
}

/**
 * @param {string} message
 * @param {string[]} [sensitivePaths]
 */
function sanitizeWorkspaceMessage(message, sensitivePaths = []) {
    let sanitized = message;
    for (const sensitivePath of sensitivePaths.filter(Boolean)) {
        sanitized = sanitized.split(sensitivePath).join("[workspace path]");
    }
    return sanitized.replace(/(?:[A-Za-z]:)?[\\/][^\s"'`<>)]*/g, "[workspace path]");
}

/**
 * @param {string[]} messages
 * @param {string[]} sensitivePaths
 */
function sanitizeWorkspaceMessages(messages, sensitivePaths) {
    return messages.map((message) => sanitizeWorkspaceMessage(message, sensitivePaths));
}

/**
 * @param {Record<string, unknown>} attrs
 */
function lifecycleActionsForAttrs(attrs) {
    const status = String(attrs.status || "draft");
    const metadata = getPlanLifecycleActionMetadata(/** @type {any} */ (status), attrs);
    return {
        metadata: ACTION_META,
        allowedManualTargetStatuses: metadata.allowedManualTargetStatuses,
        manualTargetOptions: metadata.allowedManualTargetStatuses.map(statusOption),
        canCloseWithoutVerification: metadata.canCloseWithoutVerification,
        canUserVerify: metadata.canUserVerify,
        canPutOnHold: metadata.canPutOnHold,
        canResumeFromHold: metadata.canResumeFromHold,
        canResetToDraft: metadata.canResetToDraft,
        blockedReasons: metadata.blockedReasons,
        terminalMessage: CLOSED_STATUSES.includes(/** @type {any} */ (status))
            ? "Closed Plans are complete. Reopen or revise the Plan before making changes."
            : "",
        holdMessage: status === "on_hold" ? "On-hold Plans can be resumed or reset to draft." : "",
        dnd: {
            cardId: `plan-${String(attrs.planId || "")}`,
            allowedTargetStatuses: metadata.allowedManualTargetStatuses,
        },
    };
}

/**
 * @param {any} resource
 * @returns {any}
 */
export function serializePlanSummary(resource) {
    const attrs = workspaceSafeFrontMatter(resource.attrs);
    const status = String(attrs.status || "draft");
    attrs.planId = resource.planId;
    return {
        planId: resource.planId,
        revision: resource.revision || "",
        planName: resource.planName || resource.name,
        name: resource.planName || resource.name,
        attrs,
        relativePath: resource.relativePath,
        status,
        statusLabel: statusOption(status).label,
        actions: lifecycleActionsForAttrs(attrs),
        classification: attrs.classification || "PLANNED_CHANGE",
        title: attrs.title || resource.planName || resource.name,
        summary: attrs.summary || "",
        complexity: attrs.complexity || "",
        createdAt: attrs.createdAt || "",
        parentPlan: attrs.parentPlan || "",
        dependsOn: stringArray(attrs.dependencies).length
            ? stringArray(attrs.dependencies)
            : stringArray(attrs.dependsOn),
        dependencies: stringArray(attrs.dependencies),
        worktreeStatus: attrs.worktreeStatus || "",
        worktreeBranch: attrs.worktreeBranch || "",
        humanReviewMode: attrs.humanReviewMode || "",
        closedWithoutVerificationReason: attrs.closedWithoutVerificationReason || "",
        userVerifiedAt: attrs.userVerifiedAt || "",
        userVerificationNote: attrs.userVerificationNote || "",
        workRecord: attrs.workRecord || null,
        heldFromStatus: attrs.heldFromStatus || "",
        heldAt: attrs.heldAt || "",
        holdReason: attrs.holdReason || "",
        failureReason: attrs.failureReason || "",
        failedAt: attrs.failedAt || "",
        epicCompletionMode: attrs.epicCompletionMode || "",
        epicDoneEnoughSummary: attrs.epicDoneEnoughSummary || "",
        epicDoneEnoughAt: attrs.epicDoneEnoughAt || "",
        doneEnough: attrs.epicCompletionMode === "done_enough",
        isEpic: isProjectPlan(attrs),
        isChild: isChildFeaturePlan(resource),
        hierarchyRole: isProjectPlan(attrs) ? "epic" : isChildFeaturePlan(resource) ? "child" : "top-level",
        parentResolved: !isChildFeaturePlan(resource),
        parentPlanId: "",
        orphanReason: "",
        dependencyStates: [],
        blockedByDependencies: false,
        missingDependencyCount: 0,
        unverifiedDependencyCount: 0,
    };
}

/**
 * @param {any[]} plans
 */
function annotatePlanHierarchy(plans) {
    const epicsByName = new Map(plans.filter((plan) => plan.isEpic).map((plan) => [plan.name, plan]));
    return plans.map((plan) => {
        const parentEpic = plan.isChild ? epicsByName.get(plan.parentPlan) : undefined;
        const hierarchyRole = plan.isEpic
            ? "epic"
            : plan.isChild && !parentEpic
            ? "orphan-child"
            : plan.isChild
            ? "child"
            : "top-level";
        return {
            ...plan,
            hierarchyRole,
            parentResolved: plan.isChild ? Boolean(parentEpic) : true,
            parentPlanId: parentEpic?.planId || "",
            orphanReason: plan.isChild && !parentEpic
                ? `parentPlan \"${plan.parentPlan}\" does not match a loaded PROJECT Epic.`
                : "",
        };
    });
}

/**
 * @param {any[]} plans
 */
function enrichPlanSetDependencies(plans) {
    const byParent = new Map();
    for (const plan of plans.filter((item) => item.isChild)) {
        const siblings = byParent.get(plan.parentPlan) || [];
        siblings.push(plan);
        byParent.set(plan.parentPlan, siblings);
    }
    return plans.map((plan) => {
        if (!plan.isChild) return plan;
        const dependencySource = plan.parentResolved ? byParent.get(plan.parentPlan) || [] : [];
        return enrichChildrenWithDependencies([plan], plan.parentPlan, dependencySource)[0];
    });
}

/**
 * @param {any[]} children
 * @param {string} parentPlanName
 * @param {any[]} [dependencySource]
 */
function enrichChildrenWithDependencies(children, parentPlanName, dependencySource = children) {
    return children.map((child) => {
        const dependencyStates = resolveSiblingChildPlanDependencyStates(
            parentPlanName,
            child.dependsOn,
            dependencySource,
        );
        const missingDependencyCount = dependencyStates.filter((entry) => entry.state === "missing").length;
        const unverifiedDependencyCount = dependencyStates.filter((entry) => entry.state === "unverified").length;
        return {
            ...child,
            dependencyStates,
            blockedByDependencies: missingDependencyCount + unverifiedDependencyCount > 0,
            missingDependencyCount,
            unverifiedDependencyCount,
        };
    });
}

/**
 * @param {any[]} plans
 * @param {string} status
 */
function topLevelCardsForStatus(plans, status) {
    return plans.filter((plan) =>
        String(plan.status) === status && (plan.isEpic || plan.hierarchyRole === "top-level")
    );
}

/**
 * @param {any[]} plans
 * @param {string} status
 */
function orphanCardsForStatus(plans, status) {
    return plans.filter((plan) => String(plan.status) === status && plan.hierarchyRole === "orphan-child");
}

/**
 * @param {any[]} children
 */
function childHealth(children) {
    return {
        failed: children.filter((child) => child.status === "failed"),
        held: children.filter((child) => child.status === "on_hold"),
        blocked: children.filter((child) => child.blockedByDependencies),
        missingDependencies: children.filter((child) => child.missingDependencyCount > 0),
        implemented: children.filter((child) =>
            child.status === "implemented" || child.status === "validated_ci" || child.status === "reviewed"
        ),
    };
}

/**
 * @param {any[]} plans
 * @param {string[]} statuses
 * @param {{ topLevelOnly?: boolean }} [options]
 */
function columnsForStatuses(plans, statuses, options = {}) {
    return statuses.map((status) => {
        const cards = options.topLevelOnly
            ? topLevelCardsForStatus(plans, status)
            : plans.filter((plan) => String(plan.status) === status && plan.hierarchyRole !== "orphan-child");
        const orphanChildren = orphanCardsForStatus(plans, status);
        const meta = /** @type {any} */ (STATUS_META)[status] || {
            status,
            label: status,
            description: "",
        };
        return {
            ...meta,
            cards,
            orphanChildren,
            count: cards.length,
            repairCount: orphanChildren.length,
        };
    });
}

/**
 * @param {any[]} plans
 * @param {keyof typeof BOARD_SCREENS} screenId
 */
export function buildBoardScreen(plans, screenId) {
    const screen = BOARD_SCREENS[screenId];
    const hierarchy = /** @type {any} */ (groupPlanHierarchy(/** @type {any} */ (plans)));
    const childrenByParent = hierarchy.childrenByParent;
    const enrichedPlans = plans.map((plan) => {
        if (!plan.isEpic) return plan;
        const children = enrichChildrenWithDependencies(childrenByParent.get(plan.name) || [], plan.name);
        return {
            ...plan,
            childProgress: countChildPlanProgress(children),
            childHealth: childHealth(children),
            childCount: children.length,
        };
    });
    return {
        ...screen,
        columns: columnsForStatuses(enrichedPlans, screen.statuses, { topLevelOnly: true }),
        orphanChildren: screen.statuses.flatMap((status) => orphanCardsForStatus(enrichedPlans, status)),
    };
}

/**
 * @param {any[]} plans
 */
export function buildWorkspaceBoard(plans) {
    return {
        active: buildBoardScreen(plans, "active"),
        closed: buildBoardScreen(plans, "closed"),
        onHold: buildBoardScreen(plans, "onHold"),
    };
}

/**
 * @param {any} resource
 * @param {any[]} [plans]
 */
export function serializePlanDetail(resource, plans) {
    const summary = plans?.find((plan) => plan.planId === resource.planId) || serializePlanSummary(resource);
    return {
        ...summary,
        frontMatter: workspaceSafeFrontMatter(resource.attrs),
        body: resource.body || "",
        bodyHash: resource.bodyHash || "",
        revision: resource.revision || summary.revision || "",
        workspaceKey: resource.workspaceKey || "",
        capabilities: resource.capabilities || { bodyEditing: false },
        markdown: resource.markdown || "",
        readOnly: true,
    };
}

/**
 * @param {any} epic
 * @param {any[]} plans
 */
function serializeEpicDetail(epic, plans) {
    const hierarchy = /** @type {any} */ (groupPlanHierarchy(/** @type {any} */ (plans)));
    const children = enrichChildrenWithDependencies(hierarchy.childrenByParent.get(epic.name) || [], epic.name);
    return {
        ...epic,
        detailKind: "epic",
        childProgress: countChildPlanProgress(children),
        childHealth: childHealth(children),
        childColumns: columnsForStatuses(children, [...ACTIVE_STATUSES, ...CLOSED_STATUSES, ...ON_HOLD_STATUSES]),
        children,
    };
}

/**
 * @param {any} plan
 * @param {any[]} plans
 */
function serializeNonEpicDetail(plan, plans) {
    if (!plan.isChild) return { ...plan, detailKind: "plan", inheritedEpicTickets: [] };
    const parentEpic = plans.find((candidate) => candidate.name === plan.parentPlan && candidate.isEpic);
    const siblings = plans.filter((candidate) => candidate.parentPlan === plan.parentPlan && candidate.isChild);
    const dependencySource = plan.parentResolved ? siblings : [];
    const dependencyStates = resolveSiblingChildPlanDependencyStates(plan.parentPlan, plan.dependsOn, dependencySource);
    const missingDependencyCount = dependencyStates.filter((entry) => entry.state === "missing").length;
    const unverifiedDependencyCount = dependencyStates.filter((entry) => entry.state === "unverified").length;
    return {
        ...plan,
        dependencyStates,
        blockedByDependencies: missingDependencyCount + unverifiedDependencyCount > 0,
        missingDependencyCount,
        unverifiedDependencyCount,
        inheritedEpicTickets: Array.isArray(parentEpic?.attrs?.tickets) ? parentEpic.attrs.tickets : [],
        detailKind: "plan",
    };
}

/**
 * @param {unknown} error
 * @returns {{ error: string, repair: string, blockedReason?: string }}
 */
export function serializePlanError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SharedPlanLockError) {
        return { error: message, blockedReason: error.blockedReason, repair: error.repair };
    }
    const repair = message.includes("Duplicate planId") || message.includes("duplicate")
        ? "Repair duplicate planId values in Plan front matter so each non-archived Plan has a unique planId."
        : "Check Plan front matter and ensure the requested planId belongs to a non-archived Plan in this checkout.";
    return { error: message, repair };
}

/**
 * @param {string} cwd
 */
export async function loadPlanSummaries(cwd) {
    const resources = await listPlanResources(cwd);
    return enrichPlanSetDependencies(annotatePlanHierarchy(resources.map(serializePlanSummary)));
}

/**
 * @param {string} cwd
 * @param {string} planId
 */
export async function loadPlanDetail(cwd, planId) {
    const resource = await findPlanById(cwd, planId);
    const summaries = await loadPlanSummaries(cwd);
    return serializePlanDetail(resource, summaries);
}

/**
 * @param {string} cwd
 * @param {string} planId
 * @param {WorkspacePlanDetailOptions} [options]
 */
export async function loadWorkspaceDetail(cwd, planId, options = {}) {
    // Review needs one document, not board dependencies, lifecycle controls, or catalog writes.
    const baseResource = options.reviewOnly ? await findPlanEvidenceById(cwd, planId) : await findPlanById(cwd, planId);
    const { assertAuthorizedPlanPath } = await import("./project-artifacts.ts");
    await assertAuthorizedPlanPath(cwd, baseResource.path, baseResource.planName);
    if (options.reviewOnly) return { ...serializePlanDetail(baseResource), path: baseResource.path };
    const resource = isProjectPlan(baseResource.attrs) ? baseResource : await loadPlanBodyById(cwd, planId);
    const summaries = await loadPlanSummaries(cwd);
    return projectWorkspaceDetail({
        ...resource,
        workspaceKey: await sha256Hex(cwd),
        capabilities: { bodyEditing: !isProjectPlan(resource.attrs) },
    }, summaries);
}

/**
 * Project a Plan resource through the same detail shape used by production and
 * the dev-only in-memory Workspace.
 *
 * @param {any} resource
 * @param {any[]} plans
 */
export function projectWorkspaceDetail(resource, plans) {
    const detail = serializePlanDetail(resource, plans);
    return detail.isEpic ? serializeEpicDetail(detail, plans) : serializeNonEpicDetail(detail, plans);
}

/**
 * @param {string} cwd
 * @param {string} planId
 * @param {string} body
 * @param {string} expectedBodyHash
 * @param {string} expectedRevision
 */
export async function saveWorkspacePlanBody(cwd, planId, body, expectedBodyHash, expectedRevision) {
    if (!expectedRevision) throw new Error("Workspace body save requires expectedRevision.");
    const saved = await savePlanBodyById(cwd, planId, body, expectedBodyHash, { expectedRevision });
    const summaries = await loadPlanSummaries(cwd);
    return projectWorkspaceDetail({
        ...saved,
        workspaceKey: await sha256Hex(cwd),
        capabilities: { bodyEditing: true },
    }, summaries);
}

/**
 * @typedef {Object} ResumeCheck
 * @property {boolean} ok
 * @property {string[]} warnings
 * @property {string[]} failures
 * @property {string} message
 */

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} attrs
 * @returns {Promise<ResumeCheck>}
 */
export async function runWorkspaceResumeCheck(cwd, attrs) {
    if (attrs.status !== "on_hold" || !attrs.heldFromStatus) {
        return {
            ok: false,
            warnings: [],
            failures: ["Resume from hold requires status on_hold and heldFromStatus metadata."],
            message: "Resume Check failed.",
        };
    }
    /** @type {string[]} */
    const warnings = [];
    /** @type {string[]} */
    const failures = [];
    const worktreePath = typeof attrs.worktreePath === "string" ? attrs.worktreePath : "";
    const worktreeBranch = typeof attrs.worktreeBranch === "string" ? attrs.worktreeBranch : "";
    const baseline = typeof attrs.holdStalenessBaseline === "string" ? attrs.holdStalenessBaseline : "";

    if (!worktreePath && !worktreeBranch && !baseline) {
        return {
            ok: true,
            warnings,
            failures,
            message: "Resume Check passed; there was no recorded worktree or staleness state to inspect.",
        };
    }

    if (worktreePath) {
        try {
            const status = await getWorktreeStatus({
                projectRoot: cwd,
                path: worktreePath,
                branch: worktreeBranch,
                baseTree: baseline,
            });
            if (!status.exists) failures.push("Recorded worktree path is missing.");
            if (status.exists && worktreeBranch && !status.branch) {
                failures.push("Recorded worktree branch could not be determined for verification.");
            }
            if (worktreeBranch && status.branch && status.branch !== worktreeBranch) {
                failures.push(
                    `Recorded worktree branch ${worktreeBranch} does not match current branch ${status.branch}.`,
                );
            }
            if (status.exists && !status.clean) warnings.push("Recorded worktree has uncommitted changes.");
        } catch {
            failures.push("Could not inspect recorded worktree status.");
        }
    }

    if (worktreeBranch) {
        const risk = await inspectExecutionWorktreeMergeRisk({ projectRoot: cwd, branch: worktreeBranch });
        const sensitivePaths = [cwd, worktreePath];
        warnings.push(...sanitizeWorkspaceMessages(risk.warnings, sensitivePaths));
        failures.push(...sanitizeWorkspaceMessages(risk.failures, sensitivePaths));
    }

    if (baseline) {
        warnings.push(
            "Recorded hold staleness baseline exists, but Workspace cannot fully prove affected-path freshness yet.",
        );
    }

    return {
        ok: failures.length === 0,
        warnings,
        failures,
        message: failures.length
            ? "Resume Check failed."
            : warnings.length
            ? "Resume Check needs confirmation."
            : "Resume Check passed.",
    };
}

/**
 * @param {unknown} payload
 * @param {{ requireRevision?: boolean }} [options]
 */
function validateLifecycleActionPayload(payload, options = {}) {
    const body = safeObject(payload);
    const action = typeof body.action === "string" ? body.action : "";
    if (!Object.values(PLAN_LIFECYCLE_ACTIONS).includes(/** @type {any} */ (action))) {
        throw new Error("Unknown lifecycle action.");
    }
    if (options.requireRevision && typeof body.expectedRevision !== "string") {
        throw new Error("Workspace lifecycle action requires expectedRevision.");
    }
    if (action === PLAN_LIFECYCLE_ACTIONS.MOVE_STATUS) {
        const targetStatus = typeof body.targetStatus === "string" ? body.targetStatus : "";
        if (!targetStatus || !isKnownStatus(targetStatus)) throw new Error("Unknown or missing targetStatus.");
    }
    if (action === PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION) {
        const reason = typeof body.closedWithoutVerificationReason === "string"
            ? body.closedWithoutVerificationReason.trim()
            : "";
        if (!reason) throw new Error("A close-without-verification reason is required.");
        body.closedWithoutVerificationReason = reason;
    }
    if (action === PLAN_LIFECYCLE_ACTIONS.USER_VERIFY) {
        const note = typeof body.userVerificationNote === "string" ? body.userVerificationNote.trim() : "";
        if (!note) throw new Error("A User Verification note is required.");
        body.userVerificationNote = note;
    }
    return body;
}

/**
 * Apply a Workspace lifecycle action to an already-loaded Plan without writing
 * its markdown file. This is intentionally limited to the Astro dev server;
 * production continues through recordPlanEvent and the canonical Plan store.
 *
 * @param {any} plan
 * @param {unknown} payload
 */
export function applyWorkspaceLifecycleActionInMemory(plan, payload) {
    const request = validateLifecycleActionPayload(payload);
    const attrs = { ...safeObject(plan.attrs), ...safeObject(plan.frontMatter) };
    const currentStatus = /** @type {any} */ (String(attrs.status || plan.status || "draft"));
    const action = String(request.action);
    const metadata = getPlanLifecycleActionMetadata(currentStatus, attrs);
    /** @type {any} */
    const details = { triageMeta: attrs };
    /** @type {any} */
    let event = "manual_status_change";
    let message = "Plan lifecycle action applied.";

    if (action === PLAN_LIFECYCLE_ACTIONS.MOVE_STATUS) {
        const targetStatus = String(request.targetStatus);
        if (!metadata.allowedManualTargetStatuses.includes(/** @type {any} */ (targetStatus))) {
            throw new Error(metadata.blockedReasons.move_status || `Manual move to ${targetStatus} is blocked.`);
        }
        details.manualTargetStatus = targetStatus;
        message = `Plan moved to ${statusOption(targetStatus).label}.`;
    } else if (action === PLAN_LIFECYCLE_ACTIONS.USER_VERIFY) {
        if (!metadata.canUserVerify) throw new Error(metadata.blockedReasons.user_verify);
        event = "manual_user_verified";
        details.userVerificationNote = request.userVerificationNote;
        message = "Plan marked User Verified. RunWield Workflow Validation was not claimed.";
    } else if (action === PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION) {
        if (!metadata.canCloseWithoutVerification) throw new Error(metadata.blockedReasons.close_without_verification);
        event = "manual_closed_without_verification";
        details.closedWithoutVerificationReason = request.closedWithoutVerificationReason;
        message = "Plan closed without Workflow Validation.";
    } else if (action === PLAN_LIFECYCLE_ACTIONS.PUT_ON_HOLD) {
        if (!metadata.canPutOnHold) throw new Error(metadata.blockedReasons.put_on_hold);
        event = "plan_held";
        if (typeof request.holdReason === "string") details.holdReason = request.holdReason;
        details.heldFromStatus = currentStatus;
        details.holdStalenessBaseline = typeof attrs.executionBaselineTree === "string"
            ? attrs.executionBaselineTree
            : undefined;
        message = attrs.classification === "PROJECT"
            ? "Epic put on hold. Child Plan statuses were not changed."
            : "Plan put on hold.";
    } else if (action === PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD) {
        if (!metadata.canResumeFromHold) throw new Error(metadata.blockedReasons.resume_from_hold);
        event = "hold_resumed";
        details.heldFromStatus = attrs.heldFromStatus;
        message = `Plan resumed to ${statusOption(String(attrs.heldFromStatus)).label}.`;
    } else if (action === PLAN_LIFECYCLE_ACTIONS.RESET_TO_DRAFT) {
        if (!metadata.canResetToDraft) throw new Error(metadata.blockedReasons.reset_to_draft);
        if (attrs.worktreeStatus && !["merged", "abandoned", "none"].includes(String(attrs.worktreeStatus))) {
            throw new Error("Reset to draft is blocked until the recorded worktree attempt is abandoned or settled.");
        }
        event = "hold_reset_to_draft";
        message = "Held Plan reset to draft after worktree attempt resolution.";
    }

    const nextAttrs = buildPlanEventUpdates(event, currentStatus, details);
    const nextSummary = serializePlanSummary({
        planId: plan.planId,
        planName: plan.planName || plan.name,
        name: plan.planName || plan.name,
        relativePath: plan.relativePath,
        attrs: nextAttrs,
    });
    return {
        plan: {
            ...plan,
            ...nextSummary,
            attrs: nextAttrs,
            frontMatter: nextAttrs,
        },
        message,
    };
}

/**
 * @typedef {Object} WorkspaceLifecycleActionOptions
 * @property {import('../../../shared/work-records/mnemoteca-port.ts').WorkRecordMnemotecaPort} mnemotecaPort
 */

/**
 * @param {string} cwd
 * @param {string} planId
 * @param {unknown} payload
 * @param {WorkspaceLifecycleActionOptions} options
 */
export async function applyWorkspaceLifecycleAction(cwd, planId, payload, options) {
    const request = validateLifecycleActionPayload(payload, { requireRevision: true });
    const evidenceResult = await loadPlanActionEvidence(cwd, planId);
    if (evidenceResult.kind !== "success") throw new Error(evidenceResult.message);
    const resource = await findPlanById(cwd, planId);
    const attrs = safeObject(resource.attrs);
    if (isSharedPlanLocked(attrs)) {
        const lockError = new SharedPlanLockError(attrs);
        return {
            blocked: true,
            status: 409,
            body: { error: lockError.message, blockedReason: lockError.blockedReason, repair: SHARED_PLAN_LOCK_REPAIR },
        };
    }
    let resumeCheck = null;
    const action = String(request.action);
    if (action === PLAN_LIFECYCLE_ACTIONS.RESUME_FROM_HOLD) {
        resumeCheck = await runWorkspaceResumeCheck(cwd, attrs);
        if (resumeCheck.failures.length) {
            return {
                blocked: true,
                status: 409,
                body: { error: resumeCheck.message, resumeCheck, blockedReason: resumeCheck.failures.join(" ") },
            };
        }
        if (resumeCheck.warnings.length && request.acceptResumeWarnings !== true) {
            return {
                blocked: true,
                status: 409,
                body: { error: resumeCheck.message, resumeCheck, requiresConfirmation: true },
            };
        }
    }
    const result = await executePlanAction(cwd, {
        planId,
        expectedRevision: String(request.expectedRevision),
        expectedStatus: evidenceResult.evidence.status,
        expectedWorktree: evidenceResult.evidence.worktree,
        action: /** @type {import('../../../shared/workflow/plan-actions.ts').PlanActionName} */ (action),
        targetStatus: typeof request.targetStatus === "string" ? request.targetStatus : undefined,
        holdReason: typeof request.holdReason === "string" ? request.holdReason : undefined,
        acceptResumeWarnings: request.acceptResumeWarnings === true,
        userVerificationNote: typeof request.userVerificationNote === "string"
            ? request.userVerificationNote
            : undefined,
        closedWithoutVerificationReason: typeof request.closedWithoutVerificationReason === "string"
            ? request.closedWithoutVerificationReason
            : undefined,
    });
    if (result.kind === "refresh_required") {
        return { blocked: true, status: 409, body: { error: result.message, result } };
    }
    if (result.kind === "recovery_required") {
        return { blocked: true, status: 409, body: { error: result.message, result } };
    }
    if (result.kind !== "success") throw new Error(result.message);
    let message = result.message;
    if (action === PLAN_LIFECYCLE_ACTIONS.CLOSE_WITHOUT_VERIFICATION || action === PLAN_LIFECYCLE_ACTIONS.USER_VERIFY) {
        let workRecordResult;
        try {
            workRecordResult = await autoGenerateWorkRecordForCompletedPlan({
                cwd,
                planName: result.evidence.planName,
                mnemotecaPort: options.mnemotecaPort,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            workRecordResult = {
                status: /** @type {const} */ ("failed"),
                planName: result.evidence.planName,
                error: reason,
                message: formatWorkRecordAutoGenerationResult({
                    status: "failed",
                    planName: result.evidence.planName,
                    error: reason,
                    message: "",
                }),
            };
        }
        message = `${message} ${workRecordResult.message}`;
    }
    return {
        blocked: false,
        body: {
            plan: await loadWorkspaceDetail(cwd, planId),
            board: await loadBoard(cwd),
            actions: ACTION_META,
            message,
            ...(resumeCheck ? { resumeCheck } : {}),
        },
    };
}

export { StalePlanBodyError };

/**
 * @param {any[]} plans
 * @param {string[]} statuses
 */
function hierarchyForPlans(plans, statuses) {
    const hierarchy = /** @type {any} */ (groupPlanHierarchy(/** @type {any} */ (plans)));
    const allowed = new Set(statuses);
    const hasAllowedStatus = (/** @type {any} */ plan) => allowed.has(String(plan.status));
    return {
        epics: hierarchy.epics
            .map((/** @type {any} */ epic) => {
                const allChildren = enrichChildrenWithDependencies(
                    hierarchy.childrenByParent.get(epic.name) || [],
                    epic.name,
                );
                const children = allChildren.filter(hasAllowedStatus);
                return {
                    ...epic,
                    childProgress: countChildPlanProgress(allChildren),
                    childHealth: childHealth(allChildren),
                    children,
                };
            })
            .filter((/** @type {any} */ epic) => hasAllowedStatus(epic) || epic.children.length > 0),
        standalone: hierarchy.standalone.filter(hasAllowedStatus),
        orphanChildren: hierarchy.orphanChildren.filter(hasAllowedStatus),
    };
}

/**
 * @param {any[]} plans
 */
export function buildBoardGroups(plans) {
    return {
        active: hierarchyForPlans(plans, ACTIVE_STATUSES),
        closed: hierarchyForPlans(plans, CLOSED_STATUSES),
        onHold: hierarchyForPlans(plans, ON_HOLD_STATUSES),
    };
}

/**
 * @param {string} cwd
 */
export async function loadBoard(cwd) {
    const plans = await loadPlanSummaries(cwd);
    return { plans, groups: buildBoardGroups(plans), screens: buildWorkspaceBoard(plans) };
}

/**
 * @param {string} cwd
 */
export function workspaceMetadata(cwd) {
    return {
        projectName: cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd,
        readOnly: true,
        supportedViews: ["active", "closed", "on-hold"],
        statuses: {
            active: ACTIVE_STATUSES,
            closed: CLOSED_STATUSES,
            onHold: ON_HOLD_STATUSES,
        },
        capabilities: {
            board: true,
            detail: true,
            epicDetail: true,
            markdownView: true,
            mutations: true,
            lifecycleActions: true,
            dragDrop: true,
            bodyEditing: true,
        },
    };
}
