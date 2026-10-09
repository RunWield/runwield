import { isSequencePlan, projectPlanType } from "../shared/project-plan.ts";
import { applySequenceReviewDecision, prepareSequenceReview } from "../shared/workflow/sequence-review.ts";
import type { SequenceReviewDecision, SequenceReviewDocument } from "../shared/workflow/sequence-review.ts";
/**
 * @module plan-written
 * Custom tool for planning agents to declare a plan and
 * run the review-and-approve lifecycle.
 *
 * createPlanWrittenTool captures hosted-session context and triage metadata at session-start
 * time. The tool runs review inside execute, but does NOT execute the plan — that's
 * the orchestrator's job after the planning
 * session ends. The outcome (`approved_execute`, `approved_decompose`, `saved`, `feedback`, `canceled`,
 * `repair_required`) is returned via `details.outcome` so the orchestrator can
 * dispatch the next agent, while `feedback` and `repair_required` keep the planner
 * in-session to iterate.
 */

import { rememberPlannedVerificationCommand } from "../shared/workflow/planned-verification-command.ts";
import { join, toFileUrl } from "@std/path";
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { CLI_BIN, normalizePlanClassification, normalizeWorkKind, PLANS_DIR_NAME } from "../constants.js";
import { ensurePlanIdentity, loadPlan, resolvePlanExecutionPolicy, updatePlanFrontMatter } from "../plan-store.js";
import { assertNotReservedEpicArtifactPlanName } from "../shared/epic-artifacts.ts";
import { recordPlanEvent } from "../shared/workflow/plan-lifecycle.js";
import { loadPlanActionEvidence } from "../shared/workflow/plan-actions.ts";
import { resolveWorkflowPlanLocation } from "../shared/workflow/plan-location.ts";
import { normalizePlanApprovalAction, PLAN_APPROVAL_ACTIONS } from "../shared/workflow/plan-approval.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.js";
import {
    emitHostedSessionRuntimeEvent,
    emitSystemStatus,
    RuntimeEventTypes,
} from "../shared/session/session-runtime-events.js";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../shared/session/session-runtime-interactions.js";
import {
    appendSessionCompleteGuidance,
    requestPlanReviewRetryConfirmation,
    requestRecoverablePlanReview,
    SESSION_COMPLETE_GUIDANCE,
} from "../shared/workflow/plan-review-recovery.js";
import { publishWorkflowToolEvent } from "../shared/workflow/workflow-tool-events.ts";
import type { HostedSession } from "../shared/session/hosted-session.js";
import type { PlanFrontMatter } from "../plan-store.js";

export interface TriageMeta extends Partial<PlanFrontMatter> {
    classification?: "QUICK_FIX" | "PLANNED_CHANGE" | "FEATURE" | "PROJECT";
    workKind?: "BUG_FIX" | "FEATURE" | "REFACTOR" | "MAINTENANCE" | "DOCUMENTATION";
    complexity?: "LOW" | "MEDIUM" | "HIGH";
}

interface ReviewImage {
    base64: string;
    mimeType: string;
}

interface PlanReviewVersion {
    plan: string;
    timestamp: string;
}

type ExecutionAgent = "engineer" | "frontend-engineer";
type CollaborationRecommendation = "autonomous" | "pair";

/** Execution policy the planning agent declares through the tool rather than hand-writing into Front Matter. */
interface ExecutionPolicyInput {
    executionAgent?: ExecutionAgent;
    collaborationRecommendation?: CollaborationRecommendation;
}

interface ToolResultDetails extends ExecutionPolicyInput {
    planName?: string;
    outcome?: string;
    reason?: string;
    triageMeta?: TriageMeta;
    feedback?: string;
    imageCount?: number;
    reviewUrl?: string;
    planPath?: string;
    planFileUrl?: string;
    remoteReview?: boolean;
    reviewerUrl?: string;
    spaceId?: string;
    serverUrl?: string;
    revision?: string | number;
    reused?: boolean;
    approved?: boolean;
    approvalAction?: string;
    planAttrs?: TriageMeta;
}

interface PlanReviewMeta {
    approved?: boolean;
    feedback?: string;
    images?: ReviewImage[];
    approvalAction?: string;
    planAttrs?: TriageMeta;
    revision?: string | number;
    remoteReview?: boolean;
    reviewerUrl?: string;
    spaceId?: string;
    serverUrl?: string;
    reused?: boolean;
    cancellationReason?: string;
    sequenceDecision?: SequenceReviewDecision;
}

interface PlanWrittenOptions {
    triageMeta?: TriageMeta;
    agentName?: string;
    hostedSession?: HostedSession;
}

type ToolResult = AgentToolResult<ToolResultDetails | null>;
type InteractionMeta = NonNullable<Awaited<ReturnType<typeof requestHostedSessionInteraction>>["_meta"]>;

function parsePlanReviewMeta(meta: InteractionMeta | undefined): PlanReviewMeta {
    const source = meta || {};
    return {
        approved: source.approved === true,
        feedback: typeof source.feedback === "string" ? source.feedback : undefined,
        images: Array.isArray(source.images) ? source.images as ReviewImage[] : undefined,
        approvalAction: typeof source.approvalAction === "string" ? source.approvalAction : undefined,
        planAttrs: source.planAttrs && typeof source.planAttrs === "object"
            ? source.planAttrs as TriageMeta
            : undefined,
        revision: typeof source.revision === "string" || typeof source.revision === "number"
            ? source.revision
            : undefined,
        remoteReview: source.remoteReview === true,
        reviewerUrl: typeof source.reviewerUrl === "string" ? source.reviewerUrl : undefined,
        spaceId: typeof source.spaceId === "string" ? source.spaceId : undefined,
        serverUrl: typeof source.serverUrl === "string" ? source.serverUrl : undefined,
        reused: typeof source.reused === "boolean" ? source.reused : undefined,
        sequenceDecision: source.sequenceDecision as SequenceReviewDecision | undefined,
        cancellationReason: typeof source.cancellationReason === "string" ? source.cancellationReason : undefined,
    };
}

const TOOL_PARAMS = Type.Object({
    verificationCommand: Type.Optional(Type.Object({
        command: Type.String({
            description: "Exact full-project verification command, not a focused diagnostic or quoted example.",
        }),
        intent: Type.Union([Type.Literal("discovered"), Type.Literal("user_selected")], {
            description:
                "discovered fills missing configuration only. user_selected is for the user's explicit full-project command, including deliberate replacement of a saved command.",
        }),
    })),
    planName: Type.String({
        description: "Plan filename without extension (kebab-case preferred), e.g. implement-memory-system",
    }),
    plans: Type.Optional(Type.Array(
        Type.Object({
            planName: Type.String({
                description: "Child Plan name or ID, in declared execution order. Write every child first.",
            }),
            executionAgent: Type.Optional(Type.Union([Type.Literal("engineer"), Type.Literal("frontend-engineer")])),
            collaborationRecommendation: Type.Optional(Type.Union([Type.Literal("autonomous"), Type.Literal("pair")])),
        }),
        {
            minItems: 1,
            description:
                "Complete child set for a PROJECT type: sequence. Omit when resuming to load its saved children.",
        },
    )),
    executionAgent: Type.Optional(Type.Union([
        Type.Literal("engineer"),
        Type.Literal("frontend-engineer"),
    ], {
        description:
            "Canonical execution owner. Use frontend-engineer only when the planned change's primary outcome is materially visual or interactive browser UI; otherwise engineer, including TUI work and incidental frontend-file edits. Omit to default to engineer. PROJECT Epics are non-executable and must omit this.",
    })),
    collaborationRecommendation: Type.Optional(Type.Union([
        Type.Literal("autonomous"),
        Type.Literal("pair"),
    ], {
        description:
            "Suggested execution style. Use pair when live user judgment between increments is worth the interruptions, otherwise omit or use autonomous. PROJECT Epics are non-executable and must omit this.",
    })),
});

/**
 * Build the planner/architect revision request after the user submits feedback
 * via the review UI. Surfaced as the plan_written tool result so the agent can
 * revise in-session.
 *
 * @param {{ round: number, planName: string, feedback: string | undefined }} opts
 * @returns {string}
 */
function buildFeedbackRequestText(
    { round, planName, feedback }: { round: number; planName: string; feedback?: string },
): string {
    return [
        `## Plan Review Feedback (Round ${round})`,
        "",
        `The user provided feedback on docs/plans/${planName}.md:`,
        "",
        feedback || "(no specific feedback provided)",
    ].join("\n");
}

function textResult(
    text: string,
    details: ToolResultDetails | null = null,
    terminate = false,
    images: ReviewImage[] = [],
): ToolResult {
    const result: ToolResult = {
        content: [
            { type: "text" as const, text },
            ...images.map(toToolImageContent),
        ],
        details: details ?? null,
    };
    if (terminate) result.terminate = true;
    return result;
}

/**
 * @param {{ planName: string, status: string, reviewUrl?: string }} opts
 * @returns {string}
 */
function buildPlanWrittenToolOutput(
    { planName, status, reviewUrl }: { planName: string; status: string; reviewUrl?: string },
): string {
    const planDisplayPath = `${PLANS_DIR_NAME}/${planName}.md`;
    const lines = [
        `Plan name: ${planDisplayPath}`,
    ];
    if (reviewUrl) lines.push(`Review Plan: \x1b]8;;${reviewUrl}\x07${reviewUrl}\x1b]8;;\x07`);
    lines.push(
        `Status: ${status}`,
    );
    return `${lines.join("\n")}\n`;
}

function emitToolUpdate(onUpdate: ((result: ToolResult) => void) | undefined, result: ToolResult): void {
    if (typeof onUpdate !== "function") return;
    try {
        onUpdate(result);
    } catch {
        // Tool-block progress is best-effort; the final tool result remains authoritative.
    }
}

/**
 * @param {{base64: string, mimeType: string}} image
 * @returns {{type: "image", data: string, mimeType: string}}
 */
function toToolImageContent(image: ReviewImage) {
    return { type: "image" as const, data: image.base64, mimeType: image.mimeType };
}

/**
 * Collect the execution policy the agent declared on this call. Omitted fields are
 * absent rather than null so an existing Front Matter value is preserved, matching
 * how the Slicer's child descriptors treat omitted policy.
 */
function collectExecutionPolicyOverrides(params: ExecutionPolicyInput): ExecutionPolicyInput {
    const overrides: ExecutionPolicyInput = {};
    if (params.executionAgent !== undefined) overrides.executionAgent = params.executionAgent;
    if (params.collaborationRecommendation !== undefined) {
        overrides.collaborationRecommendation = params.collaborationRecommendation;
    }
    return overrides;
}

/** @param {{ feedback?: string, images?: Array<{ base64: string, mimeType: string }> }} reviewResult */
function reviewContextDetails(reviewResult: Pick<PlanReviewMeta, "feedback" | "images">) {
    return {
        ...(reviewResult.feedback && { feedback: reviewResult.feedback }),
        imageCount: reviewResult.images?.length || 0,
    };
}

/**
 * Resolve effective triage metadata. Prefer explicit triageMeta passed at
 * factory creation; otherwise fall back to the plan's persisted front matter.
 *
 * @param {TriageMeta | undefined} triageMeta
 * @param {string} planName
 * @param {string} cwd
 * @returns {Promise<TriageMeta>}
 */
async function resolveTriageMeta(
    triageMeta: TriageMeta | undefined,
    planName: string,
    cwd: string,
): Promise<TriageMeta> {
    let meta = triageMeta || {};
    try {
        const plan = await loadPlan(cwd, planName);
        if (plan?.attrs) {
            const planAttrs: TriageMeta = { ...plan.attrs };
            if (planAttrs.workKind === undefined || planAttrs.workKind === null) delete planAttrs.workKind;
            meta = { ...triageMeta, ...planAttrs, type: plan.attrs.type };
        }
    } catch {
        /* ignore */
    }
    return {
        ...meta,
        classification: normalizePlanClassification(meta.classification),
        workKind: normalizeWorkKind(meta.workKind),
    };
}

/**
 * Create the plan_written tool with lifecycle context captured at session start.
 *
 * @param {{
 *   triageMeta?: TriageMeta,
 *   agentName?: string,
 *   hostedSession?: import('../shared/session/hosted-session.js').HostedSession,
 * }} opts
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition}
 */
export function createPlanWrittenTool({ triageMeta, agentName = "planner", hostedSession }: PlanWrittenOptions = {}) {
    if (!hostedSession) throw new Error("createPlanWrittenTool: hostedSession is required");
    const cwd = hostedSession.cwd;
    const reviewPlanVersions = new Map<string, PlanReviewVersion[]>();
    return defineTool({
        name: "plan_written",
        label: "Plan Written",
        description: "Declare the plan filename you created in docs/plans/ and submit it for user review. " +
            "Triggers review and (on approval) a save-vs-execute/decompose prompt. Execution or Slicer dispatch runs " +
            "after your turn ends — the workflow dispatcher picks it up from this tool's outcome. " +
            "Call this once after writing the plan; the user reviews it in a browser UI. " +
            "If the user submits feedback instead of approving, the tool result contains that feedback so you can " +
            "revise in this same session. For a PROJECT with type: sequence, submit its complete child list in plans; " +
            "all documents open together and approval executes the children in order. A later submission may name only the container.",
        parameters: TOOL_PARAMS,
        async execute(toolCallId, params, _signal, onUpdate, _ctx) {
            const publishAcceptedPlanOutcome = (details: ToolResultDetails, images: ReviewImage[] = []) => {
                if (!details.outcome) return;
                if (details.outcome === "repair_required") return;
                const eventPlanName = String(details.planName || "").trim().replace(/^docs\/plans\//i, "").replace(
                    /\.md$/i,
                    "",
                ).trim();
                publishWorkflowToolEvent({
                    hostedSession,
                    toolCallId,
                    kind: "plan_written",
                    payload: {
                        outcome: details.outcome as
                            | "approved_execute"
                            | "approved_decompose"
                            | "saved"
                            | "feedback"
                            | "canceled"
                            | "repair_required"
                            | "no_call",
                        planName: eventPlanName,
                        triageMeta: details.triageMeta,
                        feedback: details.feedback,
                        images,
                    },
                });
            };
            const planName = String(params.planName || "").trim().replace(/^docs\/plans\//i, "").replace(/\.md$/i, "")
                .trim();

            if (!planName) {
                return textResult(
                    "plan_written: planName is empty. Provide the plan filename (without .md) and call again.",
                );
            }
            try {
                assertNotReservedEpicArtifactPlanName(planName);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                return textResult(`plan_written: ${reason}`, {
                    ...params,
                    outcome: "repair_required",
                    planName,
                    reason: "reserved_epic_artifact",
                }, false);
            }

            if (!cwd) throw new Error("plan_written: cwd or hostedSession cwd is required");
            const location = await resolveWorkflowPlanLocation(cwd, planName);
            const reviewCwd = location.plan ? location.documentRoot : cwd;
            const planPath = location.plan?.path || join(reviewCwd, PLANS_DIR_NAME, `${planName}.md`);
            try {
                const stat = await Deno.stat(planPath);
                if (!stat.isFile) {
                    return textResult(
                        `plan_written: docs/plans/${planName}.md is not a file. Write the plan markdown first, then call plan_written again.`,
                    );
                }
            } catch {
                return textResult(
                    `plan_written: docs/plans/${planName}.md not found. Write the plan first using the write tool, then call plan_written.`,
                );
            }

            try {
                hostedSession?.setWorkflowPlanName?.(planName);
            } catch (_e) {
                // Footer-context persistence is fail-open and must not block Plan review.
            }

            let effectiveMeta = await resolveTriageMeta(triageMeta, planName, reviewCwd);
            let sequenceDocuments: SequenceReviewDocument[] | undefined;
            try {
                projectPlanType(effectiveMeta);
                if (isSequencePlan(effectiveMeta)) {
                    sequenceDocuments = await prepareSequenceReview(reviewCwd, planName, params.plans);
                    effectiveMeta = { ...effectiveMeta, ...sequenceDocuments[0].frontmatter };
                } else if (params.plans) {
                    throw new Error("Multiple Plans require a PROJECT container with type: sequence.");
                }
            } catch (error) {
                return textResult(`plan_written: ${error instanceof Error ? error.message : String(error)}`, {
                    outcome: "repair_required",
                    planName,
                    reason: "invalid_sequence",
                });
            }
            const policyOverrides = collectExecutionPolicyOverrides(params);
            effectiveMeta = { ...effectiveMeta, ...policyOverrides };
            try {
                hostedSession?.setWorkflowExecutionContext?.({ planName, triageMeta: effectiveMeta });
            } catch (_e) {
                // Workflow-context persistence is fail-open and must not block Plan review.
            }
            // Resolve policy before anything is persisted, so a Plan rejected for repair
            // still has the Front Matter it arrived with.
            const policy = resolvePlanExecutionPolicy(effectiveMeta);
            if (!policy.ok && policy.reason !== "project_epic") {
                emitSystemStatus(hostedSession, `Plan policy invalid: ${policy.error}`, {
                    level: "error",
                    header: "RunWield",
                });
                const repairHint = Object.keys(policyOverrides).length > 0
                    ? "Call plan_written again with corrected executionAgent/collaborationRecommendation arguments."
                    : `Fix the execution policy in docs/plans/${planName}.md and call plan_written again.`;
                return textResult(
                    `plan_written: ${policy.error}\n\n${repairHint}`,
                    {
                        ...params,
                        outcome: "repair_required",
                        planName,
                        triageMeta: effectiveMeta,
                        reason: policy.reason,
                    },
                    false,
                );
            }

            if (params.verificationCommand) {
                await rememberPlannedVerificationCommand(reviewCwd, params.verificationCommand);
            }

            if (Object.keys(policyOverrides).length > 0) {
                const loadedPlan = await loadPlan(reviewCwd, planName);
                if (!loadedPlan?.revision) {
                    return textResult(
                        `plan_written: could not load docs/plans/${planName}.md for execution-policy persistence. Call plan_written again after saving the Plan.`,
                        { ...params, outcome: "repair_required", planName, reason: "plan_load_failed" },
                        false,
                    );
                }
                await updatePlanFrontMatter(
                    reviewCwd,
                    planName,
                    policyOverrides,
                    {},
                    { expectedRevision: loadedPlan.revision },
                );
            }

            let reviewContainerPlanId = "";
            let planAssociationFailure = "";
            const appendPlanAssociationFailure = (text: string) =>
                planAssociationFailure ? `${text}\n\n${planAssociationFailure}` : text;
            try {
                const identified = await ensurePlanIdentity(reviewCwd, planName);
                const identifiedAttrs: TriageMeta = { ...identified.attrs };
                if (identifiedAttrs.workKind === undefined || identifiedAttrs.workKind === null) {
                    delete identifiedAttrs.workKind;
                }
                effectiveMeta = { ...effectiveMeta, ...identifiedAttrs };
                const planId = typeof effectiveMeta.planId === "string" ? effectiveMeta.planId : "";
                if (!planId) throw new Error("Plan identity is missing after identity repair");
                reviewContainerPlanId = planId;
                hostedSession.recordPlanAssociation({ planId, planName, purpose: "planning" });
            } catch (error) {
                planAssociationFailure = `Plan Association was not recorded: ${
                    error instanceof Error ? error.message : String(error)
                }`;
                emitSystemStatus(
                    hostedSession,
                    planAssociationFailure,
                    { level: "warning", header: "RunWield" },
                );
            }

            const managedCapability = hostedSession.getManagedOperationCapability?.() || null;
            if (managedCapability) {
                managedCapability.registerArtifact({
                    kind: "plan",
                    path: `${PLANS_DIR_NAME}/${planName}.md`,
                    title: planName.replaceAll("-", " "),
                    registeredBy: agentName,
                });
            }

            const planDetails = {
                planName,
                planPath,
                planFileUrl: toFileUrl(planPath).href,
                triageMeta: effectiveMeta,
            };
            let reviewUrl = "";
            const updateToolBlock = (status: string) => {
                emitToolUpdate(
                    onUpdate,
                    textResult(
                        buildPlanWrittenToolOutput({
                            planName,
                            status,
                            reviewUrl,
                        }),
                        { ...planDetails, ...(reviewUrl && { reviewUrl }) },
                    ),
                );
            };
            const onReviewServerOutput = () => {
                updateToolBlock("Waiting for plan review decision.");
            };
            const onReviewSurfaceReady = (surface: { url: string }) => {
                reviewUrl = surface.url;
                updateToolBlock("Waiting for plan review decision.");
            };

            updateToolBlock("Opening browser review UI.");

            function recordWorkflowMetricFn(metric: Parameters<typeof recordWorkflowMetric>[0]) {
                return recordWorkflowMetric(metric, cwd);
            }

            const initialReviewEvidence = await loadPlanActionEvidence(
                location.registryRoot,
                String(effectiveMeta.planId || ""),
            );
            const canonicalReviewEvidence = initialReviewEvidence.kind === "success"
                ? initialReviewEvidence.evidence
                : null;
            const currentReviewPlan = await Deno.readTextFile(planPath);
            const planVersions = reviewPlanVersions.get(planName) ?? [];
            if (planVersions.at(-1)?.plan !== currentReviewPlan) {
                planVersions.push({ plan: currentReviewPlan, timestamp: new Date().toISOString() });
                reviewPlanVersions.set(planName, planVersions);
            }
            const previousPlan = planVersions.length > 1 ? planVersions.at(-2)?.plan : undefined;

            if (sequenceDocuments) {
                for (const document of sequenceDocuments) {
                    const versions = reviewPlanVersions.get(document.planId) ?? [];
                    if (versions.at(-1)?.plan !== document.plan) {
                        versions.push({ plan: document.plan, timestamp: new Date().toISOString() });
                    }
                    reviewPlanVersions.set(document.planId, versions);
                    document.planVersions = versions.map((version) => ({ ...version }));
                    try {
                        hostedSession.recordPlanAssociation({
                            planId: document.planId,
                            planName: document.planName,
                            purpose: "review",
                        });
                    } catch (error) {
                        emitSystemStatus(
                            hostedSession,
                            `Plan Association was not recorded for ${document.planName}: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                            { level: "warning", header: "RunWield" },
                        );
                    }
                    managedCapability?.registerArtifact({
                        kind: "plan",
                        path: `${PLANS_DIR_NAME}/${document.planName}.md`,
                        title: document.planName,
                        registeredBy: agentName,
                    });
                }
            }
            const recoverableReview = await requestRecoverablePlanReview({
                requestReview: () =>
                    requestHostedSessionInteraction(
                        hostedSession,
                        {
                            type: RuntimeInteractionTypes.PLAN_REVIEW,
                            prompt: `Review plan "${planName}"`,
                            _meta: {
                                cwd: reviewCwd,
                                planId: canonicalReviewEvidence?.planId || effectiveMeta.planId,
                                planName: canonicalReviewEvidence?.planName || planName,
                                reviewContainerPlanId,
                                reviewContainerPlanName: planName,
                                planningAgentName: agentName,
                                planPath,
                                sequenceDocuments,
                                classification: effectiveMeta.classification,
                                expectedRevision: canonicalReviewEvidence?.revision,
                                expectedStatus: canonicalReviewEvidence?.status,
                                expectedWorktree: canonicalReviewEvidence?.worktree,
                                previousPlan,
                                planVersions: planVersions.map((entry) => ({ ...entry })),
                                triageMeta: effectiveMeta,
                                onOutput: onReviewServerOutput,
                                onSurfaceReady: onReviewSurfaceReady,
                            },
                        },
                        undefined,
                        hostedSession.getManagedOperationCapability?.() || null,
                    ),
                requestRetry: (details) =>
                    requestPlanReviewRetryConfirmation(hostedSession, requestHostedSessionInteraction, details),
                onUnanswered: ({ reason }) => {
                    reviewUrl = "";
                    updateToolBlock(`Plan review ended without an answer (${reason}). Asking whether to review again.`);
                },
            });
            if (recoverableReview.kind === "complete") {
                reviewUrl = "";
                updateToolBlock("Plan review ended without an answer and was not reopened.");
                emitSystemStatus(hostedSession, SESSION_COMPLETE_GUIDANCE, { header: "RunWield" });
                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "review_outcome",
                    agentName,
                    planName,
                    details: {
                        outcome: "canceled",
                        classification: effectiveMeta.classification,
                        reason: recoverableReview.reason,
                    },
                });
                const details = { ...params, outcome: "canceled" as const, reason: recoverableReview.reason };
                publishAcceptedPlanOutcome(details);
                return textResult(
                    appendPlanAssociationFailure(
                        `${SESSION_COMPLETE_GUIDANCE}\n\nYour role as ${agentName} is complete. Do not generate any further text.`,
                    ),
                    details,
                    true,
                );
            }
            const reviewResponse = recoverableReview.response;
            reviewUrl = "";
            updateToolBlock("Plan review decision received.");
            const reviewMeta = parsePlanReviewMeta(reviewResponse._meta);
            if (
                sequenceDocuments && reviewMeta.sequenceDecision &&
                reviewResponse.outcome !== RuntimeInteractionOutcomes.CANCELED
            ) {
                const accepted = await applySequenceReviewDecision({
                    cwd: reviewCwd,
                    documents: sequenceDocuments,
                    decision: reviewMeta.sequenceDecision,
                    hostedSession,
                    toolCallId,
                });
                if (accepted.cancellationReason) {
                    return textResult(accepted.feedback || "Refresh the Sequence review.", {
                        outcome: "repair_required",
                        planName,
                        reason: accepted.cancellationReason === "sequence_handoff_failed"
                            ? accepted.cancellationReason
                            : "sequence_review_changed",
                    });
                }
                const outcome = accepted.workflowOutcome!;
                return textResult(
                    accepted.approved
                        ? accepted.approvalAction === "run"
                            ? `Sequence approved. Starting ${outcome.planName}.`
                            : "Sequence approved and saved for later execution."
                        : buildFeedbackRequestText({ round: 1, planName, feedback: accepted.feedback }),
                    { ...outcome, approvalAction: accepted.approvalAction },
                    accepted.approved,
                );
            }
            if (sequenceDocuments && reviewMeta.approved) {
                return textResult(
                    "The review response omitted the Sequence's child decisions. Reopen the complete review.",
                    {
                        outcome: "repair_required",
                        planName,
                        reason: "incomplete_sequence_review",
                    },
                );
            }
            const reviewResult = {
                canceled: reviewResponse.outcome === RuntimeInteractionOutcomes.CANCELED,
                approved: reviewMeta.approved === true,
                feedback: reviewMeta.feedback,
                images: reviewMeta.images,
                approvalAction: reviewMeta.approvalAction,
                planAttrs: reviewMeta.planAttrs,
                revision: typeof reviewMeta.revision === "string" ? reviewMeta.revision : undefined,
                cancellationReason: reviewMeta.cancellationReason,
            };

            if (reviewMeta.remoteReview === true) {
                const message = reviewResponse.message || `Plan "${planName}" saved for remote review.`;
                if (reviewMeta.reviewerUrl) {
                    emitHostedSessionRuntimeEvent(hostedSession, {
                        type: RuntimeEventTypes.PLAN_REVIEW_LINK,
                        planName,
                        reviewerUrl: reviewMeta.reviewerUrl,
                        spaceId: reviewMeta.spaceId,
                        serverUrl: reviewMeta.serverUrl,
                        revision: typeof reviewMeta.revision === "number" ? reviewMeta.revision : undefined,
                        reused: reviewMeta.reused,
                        message,
                    });
                }
                emitSystemStatus(hostedSession, message, { header: "RunWield" });
                const details = {
                    ...params,
                    outcome: "saved" as const,
                    planName,
                    triageMeta: effectiveMeta,
                    remoteReview: true,
                    ...reviewMeta,
                };
                publishAcceptedPlanOutcome(details, reviewMeta.images);
                return textResult(
                    appendPlanAssociationFailure(message),
                    details,
                    true,
                );
            }

            if (reviewResult.canceled) {
                const canceledMessage = reviewResult.cancellationReason === "stale_plan_review"
                    ? reviewResult.feedback ||
                        "The Plan changed while review was open. Open the current Plan and review it again."
                    : "Plan review canceled. Returning control to user.";
                emitSystemStatus(hostedSession, canceledMessage, {
                    header: "RunWield",
                });
                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "review_outcome",
                    agentName,
                    planName,
                    details: { outcome: "canceled", classification: effectiveMeta.classification },
                });
                const details = { ...params, outcome: "canceled" as const };
                publishAcceptedPlanOutcome(details);
                return textResult(
                    appendPlanAssociationFailure(canceledMessage),
                    details,
                    true,
                );
            }

            if (reviewResult.cancellationReason === "stale_plan_review") {
                const message = reviewResult.feedback ||
                    "The Plan changed while review was open. Open the current Plan and review it again.";
                emitSystemStatus(hostedSession, message, { header: "RunWield" });
                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "review_outcome",
                    agentName,
                    planName,
                    details: { outcome: "canceled", classification: effectiveMeta.classification },
                });
                const details = {
                    ...params,
                    outcome: "canceled" as const,
                    planName,
                    reason: "stale_plan_review",
                };
                publishAcceptedPlanOutcome(details);
                return textResult(appendPlanAssociationFailure(message), details, true);
            }

            if (!reviewResult.approved) {
                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "review_outcome",
                    agentName,
                    planName,
                    details: { outcome: "feedback", classification: effectiveMeta.classification },
                });
                const details = {
                    ...params,
                    outcome: "feedback" as const,
                    planName,
                    ...reviewContextDetails(reviewResult),
                };
                publishAcceptedPlanOutcome(details, reviewResult.images);
                return textResult(
                    appendPlanAssociationFailure(buildFeedbackRequestText({
                        round: 1,
                        planName,
                        feedback: reviewResult.feedback,
                    })),
                    details,
                    false,
                    reviewResult.images,
                );
            }

            const reviewPlanAttrs: TriageMeta = { ...(reviewResult.planAttrs || {}) };
            if (reviewPlanAttrs.workKind === undefined || reviewPlanAttrs.workKind === null) {
                delete reviewPlanAttrs.workKind;
            }
            const approvedBase: TriageMeta = { ...effectiveMeta, ...reviewPlanAttrs };
            const approvedMeta: TriageMeta = {
                ...approvedBase,
                classification: normalizePlanClassification(approvedBase.classification),
                workKind: normalizeWorkKind(approvedBase.workKind),
            };
            const action = normalizePlanApprovalAction({
                classification: approvedMeta.classification,
                type: approvedMeta.type,
                action: reviewResult.approvalAction,
            });

            if (approvedMeta.classification === "PROJECT") {
                const projectMeta = { ...approvedMeta };
                await recordPlanEvent({
                    cwd: reviewCwd,
                    planName,
                    event: "epic_readiness_passed",
                    currentStatus: "approved",
                    details: { triageMeta: projectMeta },
                    expectedRevision: reviewResult.revision,
                });
                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "readiness_outcome",
                    agentName,
                    planName,
                    details: { outcome: "passed", classification: "PROJECT", lifecycleEvent: "epic_readiness_passed" },
                });
                emitSystemStatus(
                    hostedSession,
                    `PROJECT plan ready for decomposition or child plan selection: ${planName}`,
                    { header: "RunWield" },
                );

                if (action !== PLAN_APPROVAL_ACTIONS.DECOMPOSE) {
                    await recordWorkflowMetricFn({
                        category: "planning",
                        event: "review_outcome",
                        agentName,
                        planName,
                        details: { outcome: "saved", classification: "PROJECT", approvalAction: action },
                    });
                    emitSystemStatus(
                        hostedSession,
                        appendSessionCompleteGuidance(
                            `Plan saved. Resume later with: ${CLI_BIN} load-plan ${planName}`,
                        ),
                        { header: "RunWield" },
                    );
                    const savedFeedbackSuffix = reviewResult.feedback
                        ? `\n\nFeedback/annotations from review: ${reviewResult.feedback}`
                        : "";
                    return textResult(
                        appendPlanAssociationFailure(appendSessionCompleteGuidance(
                            `Plan "${planName}" approved and saved for later decomposition. Your role as ${agentName} is complete. Do not generate any further text.${savedFeedbackSuffix}`,
                        )),
                        {
                            ...params,
                            outcome: "saved",
                            planName,
                            triageMeta: projectMeta,
                            ...reviewContextDetails(reviewResult),
                        },
                        true,
                        reviewResult.images,
                    );
                }

                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "review_outcome",
                    agentName,
                    planName,
                    details: {
                        outcome: "approved_decompose",
                        classification: "PROJECT",
                        approvalAction: action,
                    },
                });
                const slicerFeedbackSuffix = reviewResult.feedback
                    ? `\n\nFeedback/annotations from review: ${reviewResult.feedback}`
                    : "";
                const details = {
                    ...params,
                    outcome: "approved_decompose",
                    planName,
                    triageMeta: projectMeta,
                    ...reviewContextDetails(reviewResult),
                };
                publishAcceptedPlanOutcome(details, reviewResult.images);
                return textResult(
                    appendPlanAssociationFailure(
                        `PROJECT Epic "${planName}" approved for Slicer decomposition. ${slicerFeedbackSuffix}`,
                    ),
                    details,
                    true,
                    reviewResult.images,
                );
            }

            await recordPlanEvent({
                cwd: reviewCwd,
                planName,
                event: "readiness_passed",
                currentStatus: "approved",
                details: { triageMeta: approvedMeta },
                expectedRevision: reviewResult.revision,
            });
            await recordWorkflowMetricFn({
                category: "planning",
                event: "readiness_outcome",
                agentName,
                planName,
                details: {
                    outcome: "passed",
                    classification: approvedMeta.classification,
                    lifecycleEvent: "readiness_passed",
                },
            });

            if (action !== PLAN_APPROVAL_ACTIONS.RUN) {
                await recordWorkflowMetricFn({
                    category: "planning",
                    event: "review_outcome",
                    agentName,
                    planName,
                    details: { outcome: "saved", classification: approvedMeta.classification, approvalAction: action },
                });
                emitSystemStatus(
                    hostedSession,
                    appendSessionCompleteGuidance(`Plan saved. Resume later with: ${CLI_BIN} resume ${planName}`),
                    { header: "RunWield" },
                );
                const savedFeedbackSuffix = reviewResult.feedback
                    ? `\n\nFeedback/annotations from review: ${reviewResult.feedback}`
                    : "";
                const details = {
                    ...params,
                    outcome: "saved",
                    planName,
                    triageMeta: approvedMeta,
                    ...reviewContextDetails(reviewResult),
                };
                publishAcceptedPlanOutcome(details, reviewResult.images);
                return textResult(
                    appendPlanAssociationFailure(appendSessionCompleteGuidance(
                        `Plan "${planName}" approved and saved for later execution. Your role as ${agentName} is complete. Do not generate any further text.${savedFeedbackSuffix}`,
                    )),
                    details,
                    true,
                    reviewResult.images,
                );
            }

            await recordWorkflowMetricFn({
                category: "planning",
                event: "review_outcome",
                agentName,
                planName,
                details: {
                    outcome: "approved_execute",
                    classification: approvedMeta.classification,
                    approvalAction: action,
                },
            });
            const execFeedbackSuffix = reviewResult.feedback
                ? `\n\nFeedback/annotations from review: ${reviewResult.feedback}`
                : "";
            const details = {
                ...params,
                outcome: "approved_execute",
                planName,
                triageMeta: approvedMeta,
                ...reviewContextDetails(reviewResult),
            };
            publishAcceptedPlanOutcome(details, reviewResult.images);
            return textResult(
                appendPlanAssociationFailure(`Plan "${planName}" approved for execution.${execFeedbackSuffix}`),
                details,
                true,
                reviewResult.images,
            );
        },
    });
}
