import { planSessionArtifactAlias } from "../plan-store/index.ts";
import { withPlanSubmission, type PlanSubmissionDocument, type PlanSubmissionOptions } from "../plan-store/index.ts";
import { buildPlanConversationRequest } from "../shared/workflow/plan-review-conversation.ts";
import { reviewSourceStillMatches } from "../plan-store/index.ts";
import {
    isSequencePlan,
    parsePlanFrontMatter,
    projectPlanType,
    planDocumentMarkdown,
    planArtifactReference,
    resolvePlanExecutionPolicy,
    assertNotReservedEpicArtifactPlanName,
    canonicalizeStoredPlanName,
} from "@runwield/plans/format";
import { applySequenceReviewDecision, prepareSequenceReview } from "../plan-store/index.ts";
import type { SequenceReviewDecision, SequenceReviewDocument } from "../plan-store/index.ts";
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

import { pathToFileURL as toFileUrl } from "node:url";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { toolRegistry, type PlanWrittenExecutionPolicy } from "@runwield/tools";
import { CLI_BIN } from "../constants.ts";
import { ensurePlanIdentity, planDocumentsForCheckout } from "../plan-store/index.ts";
import { recordPlanEvent } from "../plan-store/index.ts";
import { loadPlanActionEvidence } from "../shared/workflow/plan-actions.ts";
import { normalizePlanApprovalAction, PLAN_APPROVAL_ACTIONS } from "../shared/workflow/plan-approval.ts";
import { recordWorkflowMetric } from "../shared/workflow/metrics.ts";
import {
    emitHostedSessionRuntimeEvent,
    emitSystemStatus,
    requestHostedSessionInteraction,
} from "@runwield/session-runtime/host";
import { RuntimeEventTypes } from "@runwield/session-runtime/events";
import { RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "@runwield/session-runtime/interactions";
import {
    appendSessionCompleteGuidance,
    requestPlanReviewRetryConfirmation,
    requestRecoverablePlanReview,
    SESSION_COMPLETE_GUIDANCE,
} from "../shared/workflow/plan-review-recovery.ts";
import { workflowEvents } from "@runwield/workflow/events";
import type { HostedSession } from "@runwield/session-runtime/host";
import type { TriageMeta } from "@runwield/workflow/state";

const planWritten = toolRegistry.get("plan_written");
const triageReport = toolRegistry.get("triage_report");

interface ReviewImage {
    base64: string;
    mimeType: string;
}

interface PlanReviewVersion {
    plan: string;
    timestamp: string;
}

interface ToolResultDetails extends PlanWrittenExecutionPolicy {
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
    conversationTurn?: boolean;
    approved?: boolean;
    approvalAction?: string;
    planAttrs?: TriageMeta;
}

interface PlanReviewMeta {
    conversationTurn?: boolean;
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

export type PlanWrittenToolResult = AgentToolResult<ToolResultDetails | null>;
type InteractionMeta = NonNullable<Awaited<ReturnType<typeof requestHostedSessionInteraction>>["_meta"]>;

function parsePlanReviewMeta(meta: InteractionMeta | undefined): PlanReviewMeta {
    const source = meta || {};
    return {
        conversationTurn: source.conversationTurn === true,
        approved: source.approved === true,
        feedback: typeof source.feedback === "string" ? source.feedback : undefined,
        images: Array.isArray(source.images) ? (source.images as ReviewImage[]) : undefined,
        approvalAction: typeof source.approvalAction === "string" ? source.approvalAction : undefined,
        planAttrs:
            source.planAttrs && typeof source.planAttrs === "object" ? (source.planAttrs as TriageMeta) : undefined,
        revision:
            typeof source.revision === "string" || typeof source.revision === "number" ? source.revision : undefined,
        remoteReview: source.remoteReview === true,
        reviewerUrl: typeof source.reviewerUrl === "string" ? source.reviewerUrl : undefined,
        spaceId: typeof source.spaceId === "string" ? source.spaceId : undefined,
        serverUrl: typeof source.serverUrl === "string" ? source.serverUrl : undefined,
        reused: typeof source.reused === "boolean" ? source.reused : undefined,
        sequenceDecision: source.sequenceDecision as SequenceReviewDecision | undefined,
        cancellationReason: typeof source.cancellationReason === "string" ? source.cancellationReason : undefined,
    };
}

/**
 * Build the planner/architect revision request after the user submits feedback
 * via the review UI. Surfaced as the plan_written tool result so the agent can
 * revise in-session.
 *
 * @param {{ round: number, planName: string, feedback: string | undefined }} opts
 * @returns {string}
 */
function buildFeedbackRequestText({
    round,
    planName,
    feedback,
}: {
    round: number;
    planName: string;
    feedback?: string;
}): string {
    return [
        `## Plan Review Feedback (Round ${round})`,
        "",
        `The user provided feedback on Plan ${planName}:`,
        "",
        feedback || "(no specific feedback provided)",
    ].join("\n");
}

function textResult(
    text: string,
    details: ToolResultDetails | null = null,
    terminate = false,
    images: ReviewImage[] = [],
): PlanWrittenToolResult {
    const result: PlanWrittenToolResult = {
        content: [{ type: "text" as const, text }, ...images.map(toToolImageContent)],
        details: details ?? null,
    };
    if (terminate) result.terminate = true;
    return result;
}

/**
 * @param {{ planName: string, status: string, reviewUrl?: string }} opts
 * @returns {string}
 */
function buildPlanWrittenToolOutput({
    planName,
    status,
    reviewUrl,
}: {
    planName: string;
    status: string;
    reviewUrl?: string;
}): string {
    const planDisplayPath = planName;
    const lines = [`Plan name: ${planDisplayPath}`];
    if (reviewUrl) lines.push(`Review Plan: \x1b]8;;${reviewUrl}\x07${reviewUrl}\x1b]8;;\x07`);
    lines.push(`Status: ${status}`);
    return `${lines.join("\n")}\n`;
}

function emitToolUpdate(
    onUpdate: ((result: PlanWrittenToolResult) => void) | undefined,
    result: PlanWrittenToolResult,
): void {
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
        const plan = await planDocumentsForCheckout(cwd).load(planName);
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
        classification: meta.classification ?? "PLANNED_CHANGE",
        workKind: triageReport.normalizeWorkKind(meta.workKind),
    };
}

/**
 * Create the plan_written tool with lifecycle context captured at session start.
 *
 * @param {{
 *   triageMeta?: TriageMeta,
 *   agentName?: string,
 *   hostedSession?: import('@runwield/session-runtime/host').HostedSession,
 * }} opts
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition}
 */
export function createPlanWrittenTool({ triageMeta, agentName = "planner", hostedSession }: PlanWrittenOptions = {}) {
    if (!hostedSession) throw new Error("createPlanWrittenTool: hostedSession is required");
    const cwd = hostedSession.cwd;
    const reviewPlanVersions = new Map<string, PlanReviewVersion[]>();
    return defineTool<typeof planWritten.definition.parameters, ToolResultDetails | null>({
        ...planWritten.definition,

        async execute(toolCallId, params, _signal, onUpdate, _ctx) {
            let planName = planWritten.normalizeName(params.planName);

            if (!planName) {
                return textResult(
                    "plan_written: planName is empty. Provide the plan filename (without .md) and call again.",
                );
            }
            try {
                planName = canonicalizeStoredPlanName(planName).name;
                assertNotReservedEpicArtifactPlanName(planName);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                return textResult(
                    `plan_written: ${reason}`,
                    {
                        ...params,
                        outcome: "repair_required",
                        planName,
                        reason: "reserved_epic_artifact",
                    },
                    false,
                );
            }

            hostedSession.getManagedOperationCapability?.()?.assertLive();
            const context = hostedSession.getWorkflowContext?.();
            const contextMarkdown = params.contextMarkdown;
            const submission: PlanSubmissionOptions = {
                expectedPlanId: context?.planName === planName ? context.planId : undefined,
                expectedProjectId: hostedSession.getManagedMetadata?.()?.projectId,
                prepareAuthor:
                    contextMarkdown === undefined
                        ? undefined
                        : () => ({
                              contextMarkdown,
                              validationMarkdown: params.validationMarkdown,
                              expectedRevision: params.expectedRevision,
                              parentPlan: params.parentPlan,
                              dependencies: params.dependencies,
                              definition: {
                                  classification: params.planType
                                      ? "PROJECT"
                                      : params.expectedRevision
                                        ? undefined
                                        : triageMeta?.classification === "PROJECT"
                                          ? "PROJECT"
                                          : "PLANNED_CHANGE",
                                  type: params.planType,
                                  targetBranch: params.targetBranch,
                                  order: params.order,
                                  summary: params.expectedRevision ? undefined : triageMeta?.summary,
                                  workKind: params.expectedRevision ? undefined : triageMeta?.workKind,
                                  complexity: params.expectedRevision ? undefined : triageMeta?.complexity,
                                  affectedPaths: params.expectedRevision ? undefined : triageMeta?.affectedPaths,
                                  ...params.definition,
                                  executionAgent: params.executionAgent,
                                  collaborationRecommendation: params.collaborationRecommendation,
                              },
                          }),
            };
            const runReview = async ({
                cwd,
                documentRoot: reviewCwd,
                plan,
                planId: boundPlanId,
                saveDefinition,
                reopenReview,
            }: PlanSubmissionDocument) => {
                const publishAcceptedPlanOutcome = (details: ToolResultDetails, images: ReviewImage[] = []) => {
                    if (!details.outcome) return;
                    if (details.outcome === "repair_required") return;
                    const eventPlanName = planWritten.normalizeName(details.planName);
                    workflowEvents(hostedSession).publish({
                        toolCallId,
                        kind: "plan_written",
                        payload: {
                            outcome: details.outcome as
                                | "approved_execute"
                                | "approved_decompose"
                                | "saved"
                                | "conversation"
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
                const planPath = plan.path;

                hostedSession.getManagedOperationCapability?.()?.assertLive();
                try {
                    hostedSession?.setWorkflowPlanName?.(planName);
                } catch (_e) {
                    // Footer-context persistence is fail-open and must not block Plan review.
                }

                hostedSession.getManagedOperationCapability?.()?.assertLive();

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
                const policyOverrides = planWritten.executionPolicyOverrides(params);
                effectiveMeta = { ...effectiveMeta, ...policyOverrides };
                try {
                    hostedSession?.setWorkflowExecutionContext?.({ planName, triageMeta: effectiveMeta });
                } catch (_e) {
                    // Workflow-context persistence is fail-open and must not block Plan review.
                }
                hostedSession.getManagedOperationCapability?.()?.assertLive();
                // Resolve policy before anything is persisted, so a Plan rejected for repair
                // still has the Front Matter it arrived with.
                const policy = resolvePlanExecutionPolicy(effectiveMeta);
                if (!policy.ok && policy.reason !== "project_epic") {
                    emitSystemStatus(hostedSession, `Plan policy invalid: ${policy.error}`, {
                        level: "error",
                        header: "RunWield",
                    });
                    const repairHint =
                        Object.keys(policyOverrides).length > 0
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
                    const loadedPlan = await planDocumentsForCheckout(reviewCwd).load(planName);
                    if (!loadedPlan?.revision) {
                        return textResult(
                            `plan_written: could not load docs/plans/${planName}.md for execution-policy persistence. Call plan_written again after saving the Plan.`,
                            { ...params, outcome: "repair_required", planName, reason: "plan_load_failed" },
                            false,
                        );
                    }
                    await saveDefinition(policyOverrides, loadedPlan);
                }

                let reviewContainerPlanId = "";
                let planAssociationFailure = "";
                const appendPlanAssociationFailure = (text: string) =>
                    planAssociationFailure ? `${text}\n\n${planAssociationFailure}` : text;
                try {
                    const identified = await ensurePlanIdentity(reviewCwd, planName, { onboardExternal: true });
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
                    emitSystemStatus(hostedSession, planAssociationFailure, { level: "warning", header: "RunWield" });
                }

                const managedCapability = hostedSession.getManagedOperationCapability?.() || null;
                if (managedCapability) {
                    managedCapability.registerArtifact({
                        kind: "plan",
                        path: reviewContainerPlanId
                            ? planArtifactReference(reviewContainerPlanId)
                            : planSessionArtifactAlias(planName),
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

                // Presenting changed meaning cancels an earlier approval. A formatter
                // does not cancel it, and merely reopening the saved review writes nothing.
                for (const document of sequenceDocuments ?? [undefined]) {
                    const name = document?.planName ?? planName;
                    const documents = planDocumentsForCheckout(reviewCwd);
                    const current = document
                        ? {
                              attrs: document.frontmatter,
                              body: document.packageInput ? document.plan : parsePlanFrontMatter(document.plan).body,
                              revision: document.revision,
                          }
                        : await documents.load(name);
                    const planId = document?.planId ?? current?.attrs.planId;
                    const base = planId ? hostedSession.planReviewConversations.getReviewBase(planId) : undefined;
                    if (
                        current &&
                        planId &&
                        base &&
                        ["approved", "ready_for_work", "ready_for_decomposition"].includes(current.attrs.status) &&
                        !reviewSourceStillMatches(current, base.attrs, base.body)
                    ) {
                        await reopenReview({
                            planName: name,
                            expectedPlanId: planId,
                            currentStatus: current.attrs.status,
                            expectedRevision: current.revision,
                        });
                        const updated = await documents.load(name);
                        if (updated?.attrs.planId !== planId) throw new Error(`Plan identity changed: ${name}`);
                        if (name === planName) effectiveMeta = updated.attrs;
                        if (document) {
                            document.plan = document.packageInput
                                ? updated.body
                                : planDocumentMarkdown(updated.markdown);
                            document.frontmatter = updated.attrs;
                            document.revision = updated.revision;
                        }
                    }
                }

                const initialReviewEvidence = await loadPlanActionEvidence(
                    reviewCwd,
                    String(effectiveMeta.planId || ""),
                );
                const canonicalReviewEvidence =
                    initialReviewEvidence.kind === "success" ? initialReviewEvidence.evidence : null;
                const currentReviewPlan = (await planDocumentsForCheckout(reviewCwd).load(planName))?.markdown;
                if (currentReviewPlan === undefined) throw new Error(`Plan not found: ${planName}`);
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
                            path: planArtifactReference(document.planId),
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
                        updateToolBlock(
                            `Plan review ended without an answer (${reason}). Asking whether to review again.`,
                        );
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
                    return textResult(appendPlanAssociationFailure(`${SESSION_COMPLETE_GUIDANCE}`), details, true);
                }
                const reviewResponse = recoverableReview.response;
                reviewUrl = "";
                updateToolBlock("Plan review decision received.");
                const reviewMeta = parsePlanReviewMeta(reviewResponse._meta);
                if (
                    sequenceDocuments &&
                    reviewMeta.sequenceDecision &&
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
                            reason:
                                accepted.cancellationReason === "sequence_handoff_failed"
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
                            : (accepted.conversationTurn ? buildPlanConversationRequest : buildFeedbackRequestText)({
                                  round: 1,
                                  planName,
                                  feedback: accepted.feedback,
                              }),
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
                    conversationTurn: reviewMeta.conversationTurn === true,
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
                    return textResult(appendPlanAssociationFailure(message), details, true);
                }

                if (reviewResult.canceled) {
                    const canceledMessage =
                        reviewResult.cancellationReason === "stale_plan_review"
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
                    return textResult(appendPlanAssociationFailure(canceledMessage), details, true);
                }

                if (reviewResult.cancellationReason === "stale_plan_review") {
                    const message =
                        reviewResult.feedback ||
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
                        details: {
                            outcome: reviewResult.conversationTurn ? "conversation" : "feedback",
                            classification: effectiveMeta.classification,
                        },
                    });
                    const details = {
                        ...params,
                        outcome: reviewResult.conversationTurn ? ("conversation" as const) : ("feedback" as const),
                        planName,
                        ...reviewContextDetails(reviewResult),
                    };
                    publishAcceptedPlanOutcome(details, reviewResult.images);
                    return textResult(
                        appendPlanAssociationFailure(
                            (reviewResult.conversationTurn ? buildPlanConversationRequest : buildFeedbackRequestText)({
                                round: 1,
                                planName,
                                feedback: reviewResult.feedback,
                            }),
                        ),
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
                    classification: approvedBase.classification ?? "PLANNED_CHANGE",
                    workKind: triageReport.normalizeWorkKind(approvedBase.workKind),
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
                        expectedPlanId: boundPlanId,
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
                        details: {
                            outcome: "passed",
                            classification: "PROJECT",
                            lifecycleEvent: "epic_readiness_passed",
                        },
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
                        const details = {
                            ...params,
                            outcome: "saved" as const,
                            planName,
                            triageMeta: projectMeta,
                            ...reviewContextDetails(reviewResult),
                        };
                        publishAcceptedPlanOutcome(details, reviewResult.images);
                        return textResult(
                            appendPlanAssociationFailure(
                                appendSessionCompleteGuidance(
                                    `Plan "${planName}" approved and saved for later decomposition.${savedFeedbackSuffix}`,
                                ),
                            ),
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
                    expectedPlanId: boundPlanId,
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
                        details: {
                            outcome: "saved",
                            classification: approvedMeta.classification,
                            approvalAction: action,
                        },
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
                        appendPlanAssociationFailure(
                            appendSessionCompleteGuidance(
                                `Plan "${planName}" approved and saved for later execution.${savedFeedbackSuffix}`,
                            ),
                        ),
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
            };
            return (
                (await withPlanSubmission(cwd, planName, submission, runReview)) ??
                textResult(
                    `plan_written: Plan ${planName} not found. Create it with plan_written contextMarkdown or import it first.`,
                )
            );
        },
    });
}
