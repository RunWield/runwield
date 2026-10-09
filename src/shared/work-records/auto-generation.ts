/**
 * @module shared/work-records/auto-generation
 * Targeted Work Record auto-generation after terminal Plan outcomes.
 */

import { isPlannedChangeClassification } from "../../constants.js";
import {
    findPlansByParent,
    getPlanDocumentRoot,
    isChildFeaturePlan,
    isProjectPlan,
    listArchivedPlans,
    loadArchivedPlan,
} from "../../plan-store.js";
import { resolveWorkflowPlanLocation } from "../workflow/plan-location.ts";
import { shouldAutoGenerateWorkRecordsOnPlanCompletion } from "../settings.js";
import type { WorkRecordMnemotecaPort } from "./mnemoteca-port.ts";
import {
    attachEpicChildren,
    buildActiveWorkRecordSource,
    evaluateWorkRecordSource,
    generateWorkRecordForSource,
} from "./generation.js";

type WorkRecordSource = import("./generation.js").WorkRecordSource;
type WorkRecordSupersessionCandidate = import("./schema.ts").WorkRecordSupersessionCandidate;

export interface WorkRecordAutoGenerationResult {
    status: "disabled" | "skipped" | "generated" | "linked" | "failed";
    planName: string;
    targetPlanName?: string;
    message: string;
    path?: string;
    recordId?: string;
    reason?: string;
    error?: string;
    indexWarning?: string;
    supersessionProposals?: WorkRecordSupersessionCandidate[];
}

export interface AutoGenerateWorkRecordArgs {
    pendingPublication?: boolean;
    cwd: string;
    planName: string;
    mnemotecaPort: WorkRecordMnemotecaPort;
    signal?: AbortSignal;
}

interface TargetedWorkRecordSource {
    source?: WorkRecordSource;
    skipReason?: string;
    targetPlanName?: string;
}

type WorkRecordParentState = Pick<import("../../plan-store.js").PlanFrontMatter, "status" | "epicCompletionMode">;

/** The parent must be terminal before a child completion can record its Epic. */
export function isTerminalWorkRecordParent(attrs: WorkRecordParentState): boolean {
    return (["verified", "closed_without_verification"].includes(attrs.status) &&
        attrs.epicCompletionMode === "done_enough") ||
        attrs.status === "user_verified";
}

function conciseError(value: Error | string): string {
    const message = value instanceof Error ? value.message : value || "Unknown Work Record generation failure.";
    return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown Work Record generation failure.";
}

async function loadActiveSource(cwd: string, name: string): Promise<WorkRecordSource | null> {
    const { plan } = await resolveWorkflowPlanLocation(cwd, name, { readOnly: true });
    return plan ? buildActiveWorkRecordSource(name, plan) : null;
}

async function withEpicChildren(cwd: string, source: WorkRecordSource): Promise<WorkRecordSource> {
    if (!isProjectPlan(source.attrs)) return source;
    const children: WorkRecordSource[] = [];
    for (const child of await findPlansByParent(cwd, source.name)) {
        const loaded = await loadActiveSource(cwd, child.name);
        if (loaded) children.push(loaded);
    }
    for (const child of await listArchivedPlans(cwd)) {
        if (!isPlannedChangeClassification(child.attrs.classification) || child.attrs.parentPlan !== source.name) {
            continue;
        }
        const loaded = await loadArchivedPlan(cwd, child.name);
        if (!loaded) continue;
        children.push({
            sourceKind: "archived",
            name: child.name,
            relativePath: child.relativePath,
            path: loaded.path,
            planId: loaded.attrs.planId || "",
            attrs: loaded.attrs,
            body: loaded.body,
            markdown: loaded.markdown,
        });
    }
    return attachEpicChildren([source, ...children])[0] || source;
}

/**
 * Resolve a targeted active Plan to the source eligible for automatic generation.
 * Child Plans resolve to their parent Epic and skip quietly until the parent is terminal.
 */
export async function resolveTargetedWorkRecordSource(
    cwd: string,
    planName: string,
    pendingPublication = false,
): Promise<TargetedWorkRecordSource> {
    const source = await loadActiveSource(cwd, planName);
    if (!source) return { skipReason: "plan_not_found", targetPlanName: planName };

    if (isChildFeaturePlan(source)) {
        const parentName = source.attrs.parentPlan || "";
        const parent = parentName ? await loadActiveSource(cwd, parentName) : null;
        if (!parent) return { skipReason: "parent_not_found", targetPlanName: parentName || planName };
        const parentWithChildren = await withEpicChildren(cwd, parent);
        if (
            !isTerminalWorkRecordParent(parentWithChildren.attrs) &&
            !(pendingPublication && parentWithChildren.attrs.status === "reviewed" &&
                parentWithChildren.attrs.epicCompletionMode === "done_enough")
        ) {
            return { skipReason: "parent_not_terminal", targetPlanName: parent.name };
        }
        return { source: parentWithChildren, targetPlanName: parentWithChildren.name };
    }

    return { source: await withEpicChildren(cwd, source), targetPlanName: source.name };
}

function withMessage(result: WorkRecordAutoGenerationResult): WorkRecordAutoGenerationResult {
    return { ...result, message: formatWorkRecordAutoGenerationResult(result) };
}

export function formatWorkRecordAutoGenerationResult(result: WorkRecordAutoGenerationResult): string {
    if (result.status === "disabled") return "Work Record auto-generation disabled by settings.";
    if (result.status === "skipped") {
        if (result.reason === "parent_not_terminal") {
            return "Work Record auto-generation skipped: parent Epic is not terminal yet.";
        }
        return `Work Record auto-generation skipped: ${result.reason || "not eligible"}.`;
    }
    if (result.status === "failed") {
        return `Work Record generation failed for ${result.targetPlanName || result.planName}: ${
            result.error || "unknown error"
        }. Code delivery is unchanged. Retry this Plan with wld wr retry ${
            result.targetPlanName || result.planName
        }. The wld wr backfill command regenerates missing or failed records across completed Plans.`;
    }
    const verb = result.status === "linked" ? "linked" : "generated";
    const warning = result.indexWarning ? ` Warning: ${result.indexWarning}` : "";
    const proposals = result.supersessionProposals?.length
        ? ` Pending supersession proposals: ${
            result.supersessionProposals.map((candidate) => `${candidate.recordId} (${candidate.reason})`).join(", ")
        }. Run wld wr supersede ${result.recordId}.`
        : "";
    return `Work Record ${verb}: ${result.path || result.recordId || "record available"}.${proposals}${warning}`;
}

/** Generate or reconcile a Work Record for the targeted terminal active Plan. */
export function autoGenerateWorkRecordForCompletedPlan(
    args: AutoGenerateWorkRecordArgs,
): Promise<WorkRecordAutoGenerationResult> {
    return generateTargetedWorkRecord(args, true);
}

/** Explicit retry regenerates only this source record; it never re-enters delivery. */
export function retryWorkRecordForPlan(args: AutoGenerateWorkRecordArgs): Promise<WorkRecordAutoGenerationResult> {
    return generateTargetedWorkRecord(args, false);
}

async function generateTargetedWorkRecord(
    { cwd, planName, mnemotecaPort, signal, pendingPublication }: AutoGenerateWorkRecordArgs,
    automatic: boolean,
): Promise<WorkRecordAutoGenerationResult> {
    if (automatic && !shouldAutoGenerateWorkRecordsOnPlanCompletion(cwd)) {
        return withMessage({ status: "disabled", planName, message: "" });
    }

    try {
        const { loadPublishedWorkRecordSource } = await import("./published-source.ts");
        const published = automatic ? null : await loadPublishedWorkRecordSource(cwd, planName);
        const resolved = published
            ? { source: published, targetPlanName: published.name }
            : await resolveTargetedWorkRecordSource(cwd, planName, automatic && pendingPublication);
        if (!resolved.source) {
            return withMessage({
                status: "skipped",
                planName,
                targetPlanName: resolved.targetPlanName,
                reason: resolved.skipReason || "not_found",
                message: "",
            });
        }

        const sourceRoot = getPlanDocumentRoot(resolved.source.path);
        // Store discovery belongs inside generation's failure-persistence boundary.
        // Eligibility alone does not need existing records; generation reconciles them.
        const evaluated = evaluateWorkRecordSource({
            ...resolved.source,
            pendingPublication: Boolean(automatic && pendingPublication && resolved.source.attrs.status === "reviewed"),
        });
        if (evaluated.skipReason) {
            return withMessage({
                status: "skipped",
                planName,
                targetPlanName: evaluated.name,
                reason: evaluated.skipReason,
                message: "",
            });
        }

        const outcome = await generateWorkRecordForSource(sourceRoot, evaluated, {
            mnemotecaPort,
            signal,
        });
        const status = outcome.status === "generated" || outcome.status === "linked" ? outcome.status : "failed";
        return withMessage({
            status,
            planName,
            targetPlanName: outcome.source.name || evaluated.name,
            path: "path" in outcome ? outcome.path : undefined,
            recordId: "recordId" in outcome ? outcome.recordId : undefined,
            error: "error" in outcome ? outcome.error : undefined,
            indexWarning: "indexWarning" in outcome ? outcome.indexWarning : undefined,
            supersessionProposals: "supersessionProposals" in outcome ? outcome.supersessionProposals : undefined,
            message: "",
        });
    } catch (caught) {
        const error = caught instanceof Error ? caught : String(caught);
        return withMessage({ status: "failed", planName, error: conciseError(error), message: "" });
    }
}
