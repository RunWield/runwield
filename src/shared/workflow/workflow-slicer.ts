// @ts-nocheck: Callback parameters and result shapes are implicit.
/**
 * @module shared/workflow/workflow-slicer
 * Slicer pseudo-agent orchestration for PROJECT plans.
 */

import { dirname } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { AGENTS, isPlannedChangeClassification, SUBAGENTS } from "../../constants.ts";
import {
    findPlansByParent,
    loadPlan,
    finalizePlanDecomposition,
    materializePlanChildren,
} from "../../plan-store/index.ts";
import { emitSystemStatus } from "../session/session-runtime-events.ts";
import { runActiveAgentTurn, switchActiveAgent } from "../session/agent-switching.ts";
import { agentRegistry } from "../session/agent-registry.ts";
import { buildSlicerRequest } from "./workflow-prompts.ts";
import { isEpicPlan } from "@runwield/plans/format";
import { ensureEpicBranch } from "./epic-branch.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TriageMeta } from "../../tools/plan-written.ts";
import type { HostedSession } from "../session/hosted-session.ts";

const definition = toolRegistry.get("slicer_finalize_decomposition").definition;

export interface RunSlicerAgentOptions {
    planName: string;
    triageMeta?: TriageMeta;
    reviewFeedback?: string;
    reviewImages?: Array<{ base64: string; mimeType: string }>;
    hostedSession: HostedSession;
    sessionManager?: SessionManager;
}

export interface RunSlicerAgentResult {
    ok: boolean;
    error?: string;
}

export interface OpenSlicerDecompositionOptions {
    planName: string;
    planPath: string;
    triageMeta?: TriageMeta;
    hostedSession: HostedSession;
    sessionManager?: SessionManager;
}

export type OpenSlicerDecompositionResult =
    { ok: true; slicerInvoked: boolean } | { ok: false; error: string; stage: "slicer" | "validation" };

export const __dirname = dirname(fromFileUrl(import.meta.url));
const SLICER_CONTEXT_BOUNDARY_SUMMARY = [
    "Slicer phase context boundary.",
    "Earlier Router, Architect, and other-agent conversation was intentionally omitted.",
    "Use the next user message as the authoritative Epic handoff, then rely only on repository evidence and subsequent Slicer/user messages.",
].join(" ");

/** @param {unknown} entry */
function isActiveSlicerContextBoundary(entry) {
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "compaction") return false;
    if (!("details" in entry) || !entry.details || typeof entry.details !== "object") return false;
    return (
        "kind" in entry.details &&
        entry.details.kind === "agent_context_boundary" &&
        "agentName" in entry.details &&
        entry.details.agentName === AGENTS.SLICER
    );
}

/**
 * Start a persisted Slicer-only model-context phase inside the existing session.
 * The prior transcript remains stored and renderable, while Pi's compaction-aware
 * context begins at this boundary for root rebuilds and resumed turns.
 *
 * @param {Object} opts
 * @param {string} opts.planName
 * @param {import('../session/hosted-session.ts').HostedSession} opts.hostedSession
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined} opts.sessionManager
 * @returns {{ manager: import('@earendil-works/pi-coding-agent').SessionManager, previousLeafId: string | null } | null}
 */
export function beginSlicerContextPhase({ planName, hostedSession, sessionManager }) {
    const manager =
        sessionManager ||
        /** @type {import('@earendil-works/pi-coding-agent').SessionManager | null} */ hostedSession.getRootSessionManager?.() ||
        null;
    if (!manager || typeof manager.appendCompaction !== "function") return null;
    const alreadyInSlicerPhase = manager.buildContextEntries?.().some(isActiveSlicerContextBoundary);
    if (hostedSession.getRootAgentName() === AGENTS.SLICER && alreadyInSlicerPhase) return null;
    const existingMessages = manager.buildSessionContext?.().messages;
    if (!Array.isArray(existingMessages) || existingMessages.length === 0) return null;

    const previousLeafId = manager.getLeafId?.() || null;
    const rootSession = /** @type {any} */ hostedSession.getRootAgentSession?.();
    const usage = rootSession?.getContextUsage?.();
    const tokensBefore = typeof usage?.tokens === "number" ? usage.tokens : 0;
    manager.appendCompaction(
        SLICER_CONTEXT_BOUNDARY_SUMMARY,
        "",
        tokensBefore,
        { kind: "agent_context_boundary", agentName: AGENTS.SLICER, planName },
        false,
    );
    return { manager, previousLeafId };
}

/**
 * @param {{ manager: import('@earendil-works/pi-coding-agent').SessionManager, previousLeafId: string | null } | null} boundary
 */
function restoreFailedSlicerContextPhase(boundary) {
    if (!boundary) return;
    if (boundary.previousLeafId) boundary.manager.branch?.(boundary.previousLeafId);
    else boundary.manager.resetLeaf?.();
}

/**
 * Materialize a Slicer decomposition draft into child planned change plan files.
 *
 * @param {Object} opts
 * @param {string} opts.cwd - Project root.
 * @param {string} opts.epicPlanName - Parent Epic plan name.
 * @param {import('../../plan-store/index.ts').ChildFeaturePlanDescriptor[]} opts.children
 * @param {string} [opts.parentTargetBranch]
 * @param {import('../../plan-store/index.ts').PlanWriteOptions} [opts.writeOptions]
 * @returns {ReturnType<typeof materializePlanChildren>}
 */
export async function materializeSlicerDraft(
    options: import("../../plan-store/index.ts").MaterializePlanChildrenOptions,
) {
    return await materializePlanChildren(options);
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatToolError(text) {
    return `Slicer tool failed: ${text}`;
}

/**
 * @param {Object} opts
 * @param {string} opts.planName
 * @param {string} [opts.cwd]
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition}
 */
export function createSlicerFinalizeTool({ planName, cwd }) {
    if (!cwd) throw new Error("createSlicerFinalizeTool: cwd is required");
    return defineTool({
        ...definition,
        async execute(_toolCallId, params) {
            try {
                if (!String(params.confirmation || "").trim()) {
                    throw new Error("Explicit user confirmation is required to finalize decomposition.");
                }
                const result = await finalizePlanDecomposition(cwd, planName, params.children || []);
                const branchSummary = await prepareEpicBranchSummary(cwd, planName);
                if (result.alreadyReady) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${result.writeSummary}\nEpic already ready_for_work with ${result.children.length} child planned change plan(s).${branchSummary}`,
                            },
                        ],
                        details: {
                            status: "ready_for_work",
                            children: result.childNames,
                            writeResults: result.writeResults,
                            error: "",
                        },
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `${result.writeSummary}\nFinalized Epic decomposition: ${planName} is ready_for_work.${branchSummary}`,
                        },
                    ],
                    details: {
                        status: result.updated.status,
                        children: result.childNames,
                        writeResults: result.writeResults,
                        error: "",
                    },
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: formatToolError(message) }],
                    details: { status: "error", children: [], writeResults: [], error: message },
                };
            }
        },
    });
}

/**
 * Create the Epic branch and put the new child drafts on it right after
 * decomposition. An Epic the author did not name a branch for gets
 * `epic/<epic-name>`, recorded only once the branch exists. A failure here does
 * not undo the decomposition: loading the Epic or continuing to its first child
 * prepares the branch again.
 *
 * @param {string} cwd
 * @param {string} planName
 * @returns {Promise<string>}
 */
async function prepareEpicBranchSummary(cwd, planName) {
    try {
        const branch = await ensureEpicBranch(cwd, planName);
        if (branch.kind !== "ready") return "";
        const seeded = branch.seededChildren?.length
            ? ` ${branch.seededChildren.length} child draft(s) are on it.`
            : "";
        return `\nEpic branch: ${branch.branch}${
            branch.created ? " (created from the latest primary branch)" : ""
        }.${seeded}`;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `\nThe Epic branch is not ready yet: ${message}`;
    }
}

/**
 * @param {{ name: string, attrs: import('../../plan-store/index.ts').PlanFrontMatter }} child
 * @returns {{ name: string, order: number | undefined, status: string | undefined, summary: string | undefined, workKind: string | undefined, dependencies: string[], affectedPaths: string[], tickets?: import('@runwield/plans/format').TicketReference[] }}
 */
function summarizeChild(child) {
    return {
        name: child.name,
        order: child.attrs.order,
        status: child.attrs.status,
        summary: child.attrs.summary,
        workKind: child.attrs.workKind,
        dependencies: Array.isArray(child.attrs.dependencies) ? child.attrs.dependencies : [],
        affectedPaths: Array.isArray(child.attrs.affectedPaths) ? child.attrs.affectedPaths : [],
        tickets: Array.isArray(child.attrs.tickets) ? child.attrs.tickets : undefined,
    };
}

/**
 * @param {string} planName
 * @param {string} cwd
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition[]}
 */
function createSlicerCustomTools(planName, cwd) {
    return [createSlicerFinalizeTool({ planName, cwd })];
}

/**
 * Run the interactive slicer agent against an Epic plan.
 *
 * @param {Object} opts
 * @param {string} opts.planName
 * @param {import('../../tools/plan-written.ts').TriageMeta} [opts.triageMeta]
 * @param {string} [opts.reviewFeedback]
 * @param {Array<{base64: string, mimeType: string}>} [opts.reviewImages]
 * @param {import('../session/hosted-session.ts').HostedSession} opts.hostedSession
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} [opts.sessionManager]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runSlicerAgent({
    planName,
    triageMeta,
    reviewFeedback,
    reviewImages,
    hostedSession,
    sessionManager,
}: RunSlicerAgentOptions): Promise<RunSlicerAgentResult> {
    if (!hostedSession) throw new Error("runSlicerAgent: hostedSession is required");
    const projectRoot = hostedSession.cwd;
    const slicerDisplay = agentRegistry.isolated.displayNameFallback(SUBAGENTS.SLICER);
    const previousAgentName = hostedSession.getRootAgentName();
    let boundary = null;

    try {
        const epic = await loadPlan(projectRoot, planName);
        if (!epic) throw new Error(`Epic plan not found: ${planName}`);
        if (!isEpicPlan(epic.attrs)) throw new Error(`Plan is not a PROJECT Epic: ${planName}`);
        const children = (await findPlansByParent(projectRoot, planName))
            .filter((child) => isPlannedChangeClassification(child.attrs.classification))
            .map(summarizeChild);
        boundary = beginSlicerContextPhase({ planName, hostedSession, sessionManager });

        const slicerRequest = buildSlicerRequest({
            planName,
            epicMarkdown: epic.markdown,
            epicBody: epic.body,
            epicAttrs: epic.attrs,
            triageMeta,
            children,
            reviewFeedback,
        });
        const slicerSessionManager = boundary?.manager || sessionManager;
        hostedSession.setWorkflowPlanName(planName);
        const planId = typeof epic.attrs.planId === "string" ? epic.attrs.planId : "";
        if (planId && hostedSession.getManagedOperationCapability?.()) {
            hostedSession.recordPlanAssociation({ planId, planName, purpose: "planning" });
        }
        const slicerCustomTools = createSlicerCustomTools(planName, projectRoot);
        await runActiveAgentTurn({
            hostedSession,
            agentName: AGENTS.SLICER,
            userRequest: slicerRequest,
            images: reviewImages,
            sessionManager: slicerSessionManager,
            subAgentDefinition: { id: SUBAGENTS.SLICER },
            customTools: slicerCustomTools,
        });
        return { ok: true };
    } catch (e) {
        console.error("[RunWield] slicer_agent_failed", e);
        restoreFailedSlicerContextPhase(boundary);
        if (previousAgentName && hostedSession.getRootAgentName() !== previousAgentName) {
            await switchActiveAgent(hostedSession, { agentName: previousAgentName });
        }
        const error = e instanceof Error ? e.message : String(e);
        emitSystemStatus(hostedSession, `${slicerDisplay} failed: ${error}`, {
            level: "error",
            header: "RunWield",
        });
        return { ok: false, error };
    }
}

/**
 * Ensure a PROJECT plan enters interactive decomposition after approval.
 *
 * Every PROJECT plan is an Epic container; no inline task-table compatibility
 * path remains.
 *
 * @param {Object} opts
 * @param {string} opts.planName
 * @param {string} opts.planPath - Absolute path to the plan markdown file.
 * @param {import('../../tools/plan-written.ts').TriageMeta} [opts.triageMeta]
 * @param {import('../session/hosted-session.ts').HostedSession} opts.hostedSession
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} [opts.sessionManager]
 * @returns {Promise<{ ok: true, slicerInvoked: boolean } | { ok: false, error: string, stage: "slicer" | "validation" }>}
 */
export async function openSlicerDecomposition({
    planName,
    planPath: _planPath,
    triageMeta,
    hostedSession,
    sessionManager,
}: OpenSlicerDecompositionOptions): Promise<OpenSlicerDecompositionResult> {
    if (!hostedSession) throw new Error("openSlicerDecomposition: hostedSession is required");

    /**
     * @param {import('../../tools/plan-written.ts').TriageMeta | undefined} meta
     * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
     */
    async function invokeSlicer(meta): Promise<{ ok: true } | { ok: false; error: string }> {
        try {
            const result = await runSlicerAgent({ planName, triageMeta: meta, hostedSession, sessionManager });
            if (!result.ok) return { ok: false, error: result.error || "slicer failed" };
            return { ok: true };
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            return { ok: false, error };
        }
    }

    // Epic — invoke interactive slicer
    if (triageMeta && isEpicPlan({ ...triageMeta })) {
        const result = await invokeSlicer(triageMeta);
        if (!result.ok) return { ok: false, error: result.error, stage: "slicer" };
        return { ok: true, slicerInvoked: true };
    }

    // Read and parse plan file
    let currentPlan;
    try {
        const loaded = await loadPlan(hostedSession.cwd, planName);
        currentPlan = loaded ? { attrs: loaded.attrs, body: loaded.body } : undefined;
    } catch {
        // fall through to validation / error below
    }

    // Epic — invoke interactive slicer
    if (currentPlan && isEpicPlan(currentPlan.attrs)) {
        const result = await invokeSlicer(currentPlan.attrs);
        if (!result.ok) return { ok: false, error: result.error, stage: "slicer" };
        return { ok: true, slicerInvoked: true };
    }

    const result = await invokeSlicer(triageMeta || currentPlan?.attrs);
    if (!result.ok) return { ok: false, error: result.error, stage: "slicer" };
    return { ok: true, slicerInvoked: true };
}
