// @ts-nocheck: structural TypeScript migration; public shapes are tightened below while legacy tool schemas retain inference.
/**
 * @module shared/workflow/workflow-slicer
 * Slicer pseudo-agent orchestration for PROJECT plans.
 */

import { dirname, fromFileUrl } from "@std/path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { AGENTS, isPlannedChangeClassification, SUBAGENTS } from "../../constants.js";
import {
    findPlansByParent,
    loadPlan,
    parsePlanFrontMatter,
    saveChildFeaturePlans,
    withPlanCatalogLock,
    writePlanMarkdownWithRevision,
} from "../../plan-store.js";
import { emitSystemStatus } from "../session/session-runtime-events.js";
import { runActiveAgentTurn, switchActiveAgent } from "../session/agent-switching.js";
import { SUBAGENT_DEFINITIONS } from "../session/subagent-definitions.ts";
import { buildSlicerRequest } from "./workflow-prompts.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { isEpicPlan } from "../project-plan.ts";
import { runEpicDecompositionFinalizeTransition } from "./state-transition.ts";
import { ensureEpicBranch } from "./epic-branch.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TriageMeta } from "../../tools/plan-written.ts";
import type { HostedSession } from "../session/hosted-session.js";

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
    | { ok: true; slicerInvoked: boolean }
    | { ok: false; error: string; stage: "slicer" | "validation" };

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
    return "kind" in entry.details && entry.details.kind === "agent_context_boundary" &&
        "agentName" in entry.details && entry.details.agentName === AGENTS.SLICER;
}

/**
 * Start a persisted Slicer-only model-context phase inside the existing session.
 * The prior transcript remains stored and renderable, while Pi's compaction-aware
 * context begins at this boundary for root rebuilds and resumed turns.
 *
 * @param {Object} opts
 * @param {string} opts.planName
 * @param {import('../session/hosted-session.js').HostedSession} opts.hostedSession
 * @param {import('@earendil-works/pi-coding-agent').SessionManager | undefined} opts.sessionManager
 * @returns {{ manager: import('@earendil-works/pi-coding-agent').SessionManager, previousLeafId: string | null } | null}
 */
export function beginSlicerContextPhase({ planName, hostedSession, sessionManager }) {
    const manager = sessionManager ||
        /** @type {import('@earendil-works/pi-coding-agent').SessionManager | null} */ (
            hostedSession.getRootSessionManager?.() || null
        );
    if (!manager || typeof manager.appendCompaction !== "function") return null;
    const alreadyInSlicerPhase = manager.buildContextEntries?.().some(isActiveSlicerContextBoundary);
    if (hostedSession.getRootAgentName() === AGENTS.SLICER && alreadyInSlicerPhase) return null;
    const existingMessages = manager.buildSessionContext?.().messages;
    if (!Array.isArray(existingMessages) || existingMessages.length === 0) return null;

    const previousLeafId = manager.getLeafId?.() || null;
    const rootSession = /** @type {any} */ (hostedSession.getRootAgentSession?.());
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

const TICKET_REFERENCE_SCHEMA = Type.Object({
    url: Type.String({ description: "User-identified external Ticket URL." }),
});

const CHILD_DESCRIPTOR_SCHEMA = Type.Object({
    title: Type.String({ description: "Child planned change title." }),
    order: Type.Number({ description: "1-based integer execution order from the agreed slice sequence." }),
    summary: Type.String({ description: "Brief child planned change summary." }),
    dependencies: Type.Array(Type.String(), { description: "Child plan dependencies, if any." }),
    affectedPaths: Type.Array(Type.String(), { description: "Expected affected paths." }),
    tickets: Type.Optional(Type.Array(TICKET_REFERENCE_SCHEMA, {
        description:
            "Direct child Ticket References only when the user identified those URLs as Tickets. Omit to preserve existing child references; [] clears direct child references.",
    })),
    executionAgent: Type.Union([
        Type.Literal("engineer"),
        Type.Literal("frontend-engineer"),
    ], { description: "Canonical owner; Frontend Engineer is browser-rendered UI only." }),
    collaborationRecommendation: Type.Union([
        Type.Literal("pair"),
        Type.Literal("autonomous"),
    ], {
        description:
            "Suggested execution style. Use pair when live user judgment between increments is worth the interruptions; otherwise autonomous.",
    }),
    devServerCommand: Type.Optional(Type.String({
        description: "Dev or preview command to run for browser verification, if known.",
    })),
    devServerUrl: Type.Optional(Type.String({
        description: "Local URL to open for browser verification, if known.",
    })),
    devServerHmr: Type.Optional(Type.Boolean({
        description: "Whether the dev server is expected to support hot module reload.",
    })),
    targetBranch: Type.Optional(Type.Union([
        Type.String({
            description: "Target branch this child planned change should execute from and merge back into.",
        }),
        Type.Null({ description: "Do not inherit the parent Epic target branch for this child planned change." }),
    ])),
    workKind: Type.Optional(Type.Union([
        Type.Literal("BUG_FIX"),
        Type.Literal("FEATURE"),
        Type.Literal("REFACTOR"),
        Type.Literal("MAINTENANCE"),
        Type.Literal("DOCUMENTATION"),
    ], {
        description:
            "Child Work Kind. Set for new child planned changes based on the work's nature, including DOCUMENTATION for documentation creation or substantial documentation updates; omit only to preserve an existing child draft's Work Kind.",
    })),
    content: Type.String({
        description:
            "Child planned change plan markdown body without YAML front matter. A seed shaped like a Plan: the whole body in canonical planner sections, carrying the boundary and its intent. Planner elaborates executable detail before execution, so do not invent implementation steps or verification you would be guessing at.",
    }),
});

/**
 * Materialize a Slicer decomposition draft into child planned change plan files.
 *
 * @param {Object} opts
 * @param {string} opts.cwd - Project root.
 * @param {string} opts.epicPlanName - Parent Epic plan name.
 * @param {import('../../plan-store.js').ChildFeaturePlanDescriptor[]} opts.children
 * @param {string} [opts.parentTargetBranch]
 * @param {import('../../plan-store.js').PlanWriteOptions} [opts.writeOptions]
 * @returns {ReturnType<typeof saveChildFeaturePlans>}
 */
export async function materializeSlicerDraft(
    { cwd, epicPlanName, children, parentTargetBranch, writeOptions },
) {
    const inheritedChildren = parentTargetBranch
        ? children.map((child) =>
            Object.hasOwn(child, "targetBranch") ? child : { ...child, targetBranch: parentTargetBranch }
        )
        : children;
    return await saveChildFeaturePlans(cwd, epicPlanName, inheritedChildren, writeOptions);
}

/**
 * @param {string} text
 * @returns {string}
 */
function formatToolError(text) {
    return `Slicer tool failed: ${text}`;
}

/** @param {string} title */
function slicerChildSlug(title) {
    return String(title || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** @param {number | undefined} order */
function slicerChildOrderPrefix(order) {
    if (order === undefined) return "";
    if (!Number.isInteger(order) || order < 0) {
        throw new Error(`Child plan sequence must be a non-negative integer: ${order}`);
    }
    return `${String(order).padStart(2, "0")}-`;
}

/** @param {string} epicPlanName @param {import('../../plan-store.js').ChildFeaturePlanDescriptor} child */
function slicerChildPlanName(epicPlanName, child) {
    const slug = slicerChildSlug(child.title);
    if (!slug) throw new Error(`Child plan title must produce a valid plan name: ${child.title}`);
    return `${epicPlanName}/${slicerChildOrderPrefix(child.order)}${slug}`;
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
        name: "slicer_finalize_decomposition",
        label: "Finalize Epic Decomposition",
        description:
            "Materialize child planned change draft plans and finalize the current Epic decomposition after explicit user confirmation.",
        parameters: Type.Object({
            children: Type.Optional(Type.Array(CHILD_DESCRIPTOR_SCHEMA, {
                description: "Child planned change plan descriptors to create or update before finalizing.",
            })),
            confirmation: Type.String({
                description: "A short statement that the user explicitly confirmed finalizing decomposition.",
            }),
        }),
        async execute(_toolCallId, params) {
            try {
                if (!String(params.confirmation || "").trim()) {
                    throw new Error("Explicit user confirmation is required to finalize decomposition.");
                }
                const runFinalizeBody = async () => {
                    const epic = await loadPlan(cwd, planName);
                    if (!epic) throw new Error(`Epic plan not found: ${planName}`);
                    if (!isEpicPlan(epic.attrs)) throw new Error(`Plan is not a PROJECT Epic: ${planName}`);
                    if (epic.attrs.status === "draft") throw new Error("Draft Epics cannot be finalized.");
                    if (
                        epic.attrs.status !== "approved" && epic.attrs.status !== "ready_for_decomposition" &&
                        epic.attrs.status !== "ready_for_work"
                    ) {
                        throw new Error(
                            `Cannot finalize Epic from status "${epic.attrs.status}". Expected approved or ready_for_decomposition.`,
                        );
                    }
                    const childDescriptors = /** @type {import('../../plan-store.js').ChildFeaturePlanDescriptor[]} */
                        (params.children || []);
                    const beforeChildren = await findPlansByParent(cwd, planName);
                    /** @type {Array<{ name: string, path: string, markdown: string, revision: string }>} */
                    const beforeSnapshots = [];
                    for (const child of beforeChildren) {
                        const loadedChild = await loadPlan(cwd, child.name);
                        if (
                            loadedChild?.path && typeof loadedChild.markdown === "string" &&
                            typeof loadedChild.revision === "string"
                        ) {
                            beforeSnapshots.push({
                                name: child.name,
                                path: loadedChild.path,
                                markdown: loadedChild.markdown,
                                revision: loadedChild.revision,
                            });
                        }
                    }
                    /** @type {Awaited<ReturnType<typeof materializeSlicerDraft>>} */
                    const writeResults = [];
                    /** @type {Map<string, string>} */
                    const stagedWriteRevisions = new Map();
                    try {
                        const plannedChildNames = childDescriptors.map((child) => slicerChildPlanName(planName, child));
                        return await (async () => {
                            const lockedEpic = await loadPlan(cwd, planName);
                            if (!lockedEpic) throw new Error(`Epic plan not found while finalizing: ${planName}`);
                            if (lockedEpic.revision !== epic.revision) {
                                throw new Error(`Epic plan changed while finalizing decomposition: ${planName}`);
                            }
                            const beforeNames = new Set(beforeSnapshots.map((snapshot) => snapshot.name));
                            const expectedRevisions = Object.fromEntries(
                                beforeSnapshots.map((snapshot) => [snapshot.name, snapshot.revision]),
                            );
                            for (const snapshot of beforeSnapshots) {
                                const lockedChild = await loadPlan(cwd, snapshot.name);
                                if (!lockedChild || lockedChild.revision !== snapshot.revision) {
                                    throw new Error(
                                        `Child plan changed while finalizing decomposition: ${snapshot.name}`,
                                    );
                                }
                            }
                            for (const childName of plannedChildNames) {
                                if (beforeNames.has(childName)) continue;
                                const unexpectedChild = await loadPlan(cwd, childName);
                                if (unexpectedChild) {
                                    throw new Error(
                                        `Child plan was created concurrently while finalizing decomposition: ${childName}`,
                                    );
                                }
                            }
                            /** @param {import('../../plan-store.js').SavedChildFeaturePlan} writeResult */
                            const captureWrittenChild = async (writeResult) => {
                                writeResults.push(writeResult);
                                const staged = await loadPlan(cwd, writeResult.name);
                                if (staged?.revision) stagedWriteRevisions.set(writeResult.name, staged.revision);
                            };
                            if (childDescriptors.length > 0) {
                                const returnedWriteResults = await materializeSlicerDraft({
                                    cwd,
                                    epicPlanName: planName,
                                    children: childDescriptors,
                                    parentTargetBranch: epic.attrs.targetBranch || undefined,
                                    writeOptions: {
                                        expectedRevisions,
                                        onChildPlanWritten: captureWrittenChild,
                                    },
                                });
                                for (const writeResult of returnedWriteResults) {
                                    if (writeResults.some((captured) => captured.name === writeResult.name)) continue;
                                    writeResults.push(writeResult);
                                    const staged = await loadPlan(cwd, writeResult.name);
                                    if (staged?.revision) stagedWriteRevisions.set(writeResult.name, staged.revision);
                                }
                            }

                            const children = (await findPlansByParent(cwd, planName)).filter((child) =>
                                isPlannedChangeClassification(child.attrs.classification)
                            );
                            if (children.length === 0) {
                                throw new Error(
                                    "At least one child planned change plan is required to finalize decomposition.",
                                );
                            }

                            const childNames = children.map((child) => child.name);
                            const writeSummary = writeResults.length === 0
                                ? "No child planned change drafts were written."
                                : writeResults.map((writeResult) => `${writeResult.action}: ${writeResult.name}`).join(
                                    "\n",
                                );

                            if (epic.attrs.status === "ready_for_work") {
                                return {
                                    updated: epic.attrs,
                                    children,
                                    childNames,
                                    writeResults,
                                    writeSummary,
                                    alreadyReady: true,
                                };
                            }

                            const updated = await recordPlanEvent({
                                cwd,
                                planName,
                                event: "decomposition_finalized",
                                currentStatus:
                                    /** @type {import('./plan-lifecycle.js').PlanStatus} */ (epic.attrs.status),
                                details: { triageMeta: epic.attrs },
                            });
                            return { updated, children, childNames, writeResults, writeSummary, alreadyReady: false };
                        })();
                    } catch (error) {
                        const createdResults = writeResults.filter((writeResult) =>
                            writeResult.action === "created" && typeof writeResult.path === "string"
                        );
                        for (const writeResult of createdResults) {
                            const stagedRevision = stagedWriteRevisions.get(writeResult.name);
                            const current = await loadPlan(cwd, writeResult.name).catch(() => null);
                            if (!stagedRevision || !current || current.revision !== stagedRevision) continue;
                            await Deno.remove(writeResult.path).catch(() => {});
                        }
                        for (const snapshot of beforeSnapshots) {
                            const stagedRevision = stagedWriteRevisions.get(snapshot.name);
                            const current = await loadPlan(cwd, snapshot.name).catch(() => null);
                            if (!current) {
                                await Deno.writeTextFile(snapshot.path, snapshot.markdown, { createNew: true });
                                continue;
                            }
                            if (!stagedRevision) continue;
                            await writePlanMarkdownWithRevision(snapshot.path, snapshot.markdown, stagedRevision);
                        }
                        throw error;
                    }
                };
                const result = /** @type {any} */ (await (withPlanCatalogLock(cwd, async () => {
                    const childDescriptors = /** @type {import('../../plan-store.js').ChildFeaturePlanDescriptor[]} */
                        (params.children || []);
                    const plannedChildNames = childDescriptors.map((child) => slicerChildPlanName(planName, child));
                    const existingChildNames = (await findPlansByParent(cwd, planName)).map((child) => child.name);
                    const transition = await runEpicDecompositionFinalizeTransition({
                        projectRoot: cwd,
                        planName,
                        resources: [
                            { kind: "catalog" },
                            { kind: "plan", id: planName },
                            ...existingChildNames.map((name) => ({
                                kind: /** @type {const} */ ("plan"),
                                id: name,
                            })),
                            ...plannedChildNames.map((name) => ({ kind: /** @type {const} */ ("plan"), id: name })),
                        ],
                        finalize: async () => await runFinalizeBody(),
                    });
                    if (transition.status !== "committed") {
                        throw new Error(
                            transition.message || `Epic decomposition transaction failed for ${planName}.`,
                        );
                    }
                    return transition.value;
                })));
                const branchSummary = await prepareEpicBranchSummary(cwd, planName);
                if (result.alreadyReady) {
                    return {
                        content: [{
                            type: "text",
                            text:
                                `${result.writeSummary}\nEpic already ready_for_work with ${result.children.length} child planned change plan(s).${branchSummary}`,
                        }],
                        details: {
                            status: "ready_for_work",
                            children: result.childNames,
                            writeResults: result.writeResults,
                            error: "",
                        },
                    };
                }
                return {
                    content: [{
                        type: "text",
                        text:
                            `${result.writeSummary}\nFinalized Epic decomposition: ${planName} is ready_for_work.${branchSummary}`,
                    }],
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
 * @param {{ name: string, attrs: import('../../plan-store.js').PlanFrontMatter }} child
 * @returns {{ name: string, order: number | undefined, status: string | undefined, summary: string | undefined, workKind: string | undefined, dependencies: string[], affectedPaths: string[], tickets?: import('../ticket-references.js').TicketReference[] }}
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
 * @param {import('../session/hosted-session.js').HostedSession} opts.hostedSession
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
    const slicerDisplay = SUBAGENT_DEFINITIONS[SUBAGENTS.SLICER].displayNameFallback;
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
 * @param {import('../session/hosted-session.js').HostedSession} opts.hostedSession
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} [opts.sessionManager]
 * @returns {Promise<{ ok: true, slicerInvoked: boolean } | { ok: false, error: string, stage: "slicer" | "validation" }>}
 */
export async function openSlicerDecomposition(
    { planName, planPath, triageMeta, hostedSession, sessionManager }: OpenSlicerDecompositionOptions,
): Promise<OpenSlicerDecompositionResult> {
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
    let currentMd = "";
    let currentPlan;
    try {
        currentMd = await Deno.readTextFile(planPath);
        currentPlan = parsePlanFrontMatter(currentMd);
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
