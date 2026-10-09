/**
 * @module cmd/load-plan/plan-epic-children
 * Reading an Epic's child Plans: counting, labelling, and gating on them.
 *
 * The Epic flow itself lives in load-plan/index.ts; everything here answers
 * questions about the children rather than driving the Epic.
 */

import { isPlannedChangeClassification } from "../../constants.js";
import { resolveSiblingChildPlanDependencies as resolveSiblingChildPlanDependenciesFn } from "../../plan-store.js";
import { isInValidation } from "../../shared/workflow/plan-lifecycle.js";
import { buildPlanSummary, type SummarisablePlan } from "../../shared/plan-presentation.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { SelectOption, UiAPI } from "../../ui/tui/types.js";

/** Tallies used by the Epic progress views. */
export interface EpicChildCounts {
    total: number;
    verified: number;
    userVerified: number;
    completed: number;
    active: number;
    remaining: number;
    failed: number;
    onHold: number;
}

/** One unmet dependency in the child-dependency warning. */
export interface UnmetChildDependency {
    dependency: string;
    planName?: string;
    status?: string;
    state: "verified" | "user_verified" | "unverified" | "missing";
}

/** A prompt option describing a Plan. Shaped for `uiAPI.promptSelect`. */
export interface PlanSelectOption extends SelectOption {
    value: string;
    label: string;
    description?: string;
}

/**
 * A Plan from a catalogue listing, where Front Matter may be partially read.
 *
 * Distinct from {@link EpicChildPlan}: the child views read status and
 * classification as given, while a listing only promises a name.
 */
export interface ListedPlan {
    name: string;
    attrs: Partial<PlanFrontMatter>;
}

/** A Plan the Epic views need identity and Front Matter for. */
export interface EpicPlanRef {
    planName: string;
    attrs: PlanFrontMatter;
}

/** A child Plan as the Epic views listed it. */
export interface EpicChildPlan {
    name: string;
    path?: string;
    attrs: PlanFrontMatter;
}

/**
 * @param {import('../../plan-store.js').PlanFrontMatter} attrs
 * @returns {boolean}
 */
export function isDecomposedEpicStatus(attrs: PlanFrontMatter): boolean {
    return attrs.status === "ready_for_decomposition" || attrs.status === "ready_for_work" ||
        attrs.status === "implemented" ||
        (["reviewed", "validated", "verified", "closed_without_verification"].includes(attrs.status) &&
            attrs.epicCompletionMode === "done_enough");
}

/**
 * @param {{ name: string, attrs: import('../../plan-store.js').PlanFrontMatter }} child
 * @returns {string}
 */
export function formatChildPlanLabel(child: EpicChildPlan): string {
    const order = child.attrs.order !== undefined ? `${String(child.attrs.order).padStart(2, "0")}. ` : "";
    const summary = child.attrs.summary ? ` — ${child.attrs.summary}` : "";
    const dependencies = Array.isArray(child.attrs.dependencies) && child.attrs.dependencies.length > 0
        ? ` — deps: ${child.attrs.dependencies.join(", ")}`
        : "";
    return `${order}${child.name} [${child.attrs.status}]${summary}${dependencies}`;
}

/**
 * @param {{ name: string, attrs: import('../../plan-store.js').PlanFrontMatter }} child
 * @returns {string | undefined}
 */
export function formatChildPlanDescription(child: EpicChildPlan): string | undefined {
    const parts = [];
    if (child.attrs.summary) parts.push(child.attrs.summary);
    if (Array.isArray(child.attrs.dependencies) && child.attrs.dependencies.length > 0) {
        parts.push(`Dependencies: ${child.attrs.dependencies.join(", ")}`);
    }
    return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * @param {{ name: string, attrs: import('../../plan-store.js').PlanFrontMatter }} child
 * @returns {string}
 */
export function formatNextChildLabel(child: EpicChildPlan): string {
    const order = child.attrs.order !== undefined ? `${String(child.attrs.order).padStart(2, "0")}. ` : "";
    const summary = child.attrs.summary || child.name;
    return `Execute next incomplete child Planned Change: ${order}${summary} [${child.attrs.status}]`;
}

/**
 * @param {{ attrs: import('../../plan-store.js').PlanFrontMatter }} child
 * @returns {boolean}
 */
export function isActionableNextChild(child: EpicChildPlan): boolean {
    return child.attrs.status !== "validated" && child.attrs.status !== "verified" &&
        child.attrs.status !== "user_verified" &&
        child.attrs.status !== "closed_without_verification";
}

/**
 * @param {{ name: string, attrs: Partial<import('../../plan-store.js').PlanFrontMatter> }} plan
 * @returns {{ value: string, label: string, description: string }}
 */
export function formatTopLevelPlanOption(plan: ListedPlan): PlanSelectOption {
    const summary = plan.attrs.summary ? ` — ${plan.attrs.summary}` : "";
    const descriptionType = plan.attrs.classification;
    return {
        value: plan.name,
        label: `${plan.name}${summary}`,
        description: `${descriptionType} - ${plan.attrs.status}`,
    };
}

/**
 * @param {Array<{ attrs: import('../../plan-store.js').PlanFrontMatter }>} children
 * @returns {{ total: number, verified: number, userVerified: number, completed: number, active: number, remaining: number, failed: number, onHold: number }}
 */
export function countEpicChildStatuses(children: EpicChildPlan[]): EpicChildCounts {
    /** @type {{ total: number, verified: number, userVerified: number, completed: number, active: number, remaining: number, failed: number, onHold: number }} */
    const counts = {
        total: children.length,
        verified: 0,
        userVerified: 0,
        completed: 0,
        active: 0,
        remaining: 0,
        failed: 0,
        onHold: 0,
    };
    for (const child of children) {
        const status = child.attrs.status;
        if (status === "validated" || status === "verified") counts.verified += 1;
        else if (status === "user_verified") counts.userVerified += 1;
        else if (status === "in_progress" || isInValidation(status)) counts.active += 1;
        else if (status === "failed") counts.failed += 1;
        else if (status === "on_hold") counts.onHold += 1;
        else if (["draft", "approved", "ready_for_work", "ready_for_decomposition", "feedback"].includes(status)) {
            counts.remaining += 1;
        }
    }
    counts.completed = counts.verified + counts.userVerified;
    return counts;
}

/**
 * @param {Array<{ attrs: import('../../plan-store.js').PlanFrontMatter }>} children
 * @returns {string}
 */
export function formatEpicProgressSummary(children: EpicChildPlan[]): string {
    const counts = countEpicChildStatuses(children);
    const label = counts.total === 1 ? "child Planned Change" : "child Planned Changes";
    const parts = [
        `Progress: ${counts.verified} RunWield verified / ${counts.userVerified} User Verified / ${counts.total} ${label}`,
        `${counts.active} active/implemented`,
        `${counts.remaining} remaining`,
    ];
    if (counts.onHold > 0) parts.push(`${counts.onHold} on hold`);
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    return parts.join(" — ");
}

/**
 * @param {Array<{ name: string, attrs: import('../../plan-store.js').PlanFrontMatter }>} children
 * @returns {string}
 */
export function formatEpicChildFeatureList(children: EpicChildPlan[]): string {
    if (children.length === 0) return "Child Plans:\n  (none)";
    return [
        "Child Plans:",
        ...children.map((child) => `  - ${formatChildPlanLabel(child)}`),
    ].join("\n");
}

/**
 * @param {{ attrs: import('../../plan-store.js').PlanFrontMatter, body: string, markdown: string }} plan
 * @param {Array<{ name: string, attrs: import('../../plan-store.js').PlanFrontMatter }>} children
 * @returns {string}
 */
export function buildEpicPlanSummary(plan: SummarisablePlan, children: EpicChildPlan[]): string {
    const sections = [buildPlanSummary(plan)];
    if (children.length > 0) sections.push(`Epic child progress:\n${formatEpicProgressSummary(children)}`);
    sections.push(formatEpicChildFeatureList(children));
    return sections.join("\n\n");
}

/**
 * @param {Array<{ attrs: import('../../plan-store.js').PlanFrontMatter }>} children
 * @returns {string}
 */
export function buildEpicDoneEnoughSummary(children: EpicChildPlan[]): string {
    const counts = countEpicChildStatuses(children);
    const failed = counts.failed > 0 ? `, ${counts.failed} failed` : "";
    return `Done enough for now: ${counts.verified} RunWield verified and ${counts.userVerified} User Verified of ${counts.total} child Plan${
        counts.total === 1 ? "" : "s"
    }, ${counts.active} active/implemented, ${counts.remaining} remaining${failed}.`;
}

/**
 * @param {{ attrs: import('../../plan-store.js').PlanFrontMatter }} plan
 * @returns {boolean}
 */
export function isDoneEnoughEpic(plan: { attrs: PlanFrontMatter }): boolean {
    return plan.attrs.epicCompletionMode === "done_enough";
}

/**
 * @param {Array<{ dependency: string, planName?: string, status?: string, state: "verified" | "user_verified" | "unverified" | "missing" }>} unmetDependencies
 * @returns {string}
 */
export function formatDependencyWarning(unmetDependencies: UnmetChildDependency[]): string {
    return [
        "This child Planned Change declares dependencies that are not verified:",
        "",
        ...unmetDependencies.map((dependency) => {
            if (dependency.state === "missing") return `  - ${dependency.dependency}: missing`;
            return `  - ${dependency.planName || dependency.dependency}: ${dependency.status || "unknown"}`;
        }),
    ].join("\n");
}

/**
 * @param {string} projectRoot
 * @param {{ planName: string, attrs: import('../../plan-store.js').PlanFrontMatter }} plan
 * @param {import('../../ui/tui/types.js').UiAPI} uiAPI
 * @param {typeof resolveSiblingChildPlanDependenciesFn} resolveSiblingChildPlanDependencies
 * @returns {Promise<boolean>}
 */
export async function confirmChildFeatureDependencies(
    projectRoot: string,
    plan: EpicPlanRef,
    uiAPI: UiAPI,
    resolveSiblingChildPlanDependencies: typeof resolveSiblingChildPlanDependenciesFn,
): Promise<boolean> {
    if (!isPlannedChangeClassification(plan.attrs.classification) || !plan.attrs.parentPlan) return true;
    const dependencies = Array.isArray(plan.attrs.dependencies) ? plan.attrs.dependencies : [];
    if (dependencies.length === 0) return true;

    const dependencyStates = await resolveSiblingChildPlanDependencies(
        projectRoot,
        plan.attrs.parentPlan,
        dependencies,
    );
    const unmetDependencies = dependencyStates.filter((dependency) =>
        dependency.state !== "verified" && dependency.state !== "user_verified"
    );
    if (unmetDependencies.length === 0) return true;

    uiAPI.appendSystemMessage(formatDependencyWarning(unmetDependencies), true, "RunWield");
    const answer = await uiAPI.promptSelect(`Proceed with "${plan.planName}" anyway?`, [
        { value: "proceed", label: "Proceed anyway" },
        { value: "cancel", label: "Cancel" },
    ]);
    if (answer === "proceed") return true;
    uiAPI.appendSystemMessage("Plan load canceled.", false, "RunWield");
    return false;
}
