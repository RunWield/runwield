import { withProjectRuntimeReadScope } from "../project-runtime-layout.ts";
import { loadReviewFeedbackImages, type ReviewImageDecision } from "./review-feedback-images.ts";
/** A Sequence review is one decision over an ordinary PROJECT and its complete child set. */
import { join, relative } from "node:path";
import {
    ensurePlanIdentity,
    findPlansByParent,
    getPlanRevisionForText,
    injectFrontMatter,
    loadPlan,
    parsePlanFrontMatter,
    planDocumentMarkdown,
    resolvePlanExecutionPolicy,
    resolveSiblingChildPlanDependencyStates,
    updatePlanFrontMatter,
    writePlanMarkdownWithRevision,
} from "../../plan-store.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import { assertSharedPlanWriteAllowed } from "../collaboration/lock.ts";
import { stripRuntimeFields } from "./controller-state.ts";
import { isSequencePlan } from "../project-plan.ts";
import { buildPlanEventUpdates } from "./plan-lifecycle.js";
import { loadPlanActionEvidence } from "./plan-actions.ts";
import { runSequenceReviewTransition } from "./state-transition.ts";
import { reviewSourceStillMatches } from "./plan-review-actions.ts";
import { publishWorkflowToolEvent } from "./workflow-tool-events.ts";
import type { HostedSession } from "../session/hosted-session.js";
import type { PlanApprovalAction } from "./plan-approval.ts";
import type { PlanWrittenEventPayload } from "./workflow-tool-events.ts";

export interface SequenceChildInput {
    planName: string;
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
}

export interface SequenceReviewDocument {
    planId: string;
    planName: string;
    planPath: string;
    plan: string;
    revision: string;
    frontmatter: PlanFrontMatter;
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
    planVersions?: Array<{ plan: string; timestamp: string }>;
}

export interface SequenceDocumentDecision extends ReviewImageDecision {
    planId: string;
    plan: string;
    feedback?: string;
    executionAgent?: "engineer" | "frontend-engineer";
    collaborationRecommendation?: "autonomous" | "pair";
}

export interface SequenceReviewDecision {
    approved?: boolean;
    approvalAction?: PlanApprovalAction;
    feedback?: string;
    documents?: SequenceDocumentDecision[];
}

export interface SequenceReviewResult {
    approved: boolean;
    feedback?: string;
    revision?: string;
    planAttrs?: PlanFrontMatter;
    approvalAction?: PlanApprovalAction;
    cancellationReason?: string;
    recoveryRequired?: { message: string; entryIds: string[] };
    workflowOutcome?: PlanWrittenEventPayload;
}

type StoredPlan = NonNullable<Awaited<ReturnType<typeof loadPlan>>> & { name: string };
const UNSTARTED = new Set(["draft", "feedback", "approved", "ready_for_work", "ready_for_decomposition"]);

async function requirePlan(cwd: string, name: string): Promise<StoredPlan> {
    const plan = await loadPlan(cwd, name);
    if (!plan) throw new Error(`Plan not found: ${name}. Write every child before submitting the Sequence.`);
    assertSharedPlanWriteAllowed(plan.attrs);
    if (!UNSTARTED.has(plan.attrs.status) || plan.attrs.worktreeId) {
        throw new Error(`Plan ${name} has already started or is on hold. Use its ordinary review/recovery flow.`);
    }
    return { ...plan, name: relative(join(cwd, "docs/plans"), plan.path).replace(/\\/g, "/").replace(/\.md$/, "") };
}

async function sequenceMembers(cwd: string, planName: string): Promise<StoredPlan[]> {
    return await withProjectRuntimeReadScope(async () => {
        const parent = await requirePlan(cwd, planName);
        if (!isSequencePlan(parent.attrs)) throw new Error("Grouped review requires PROJECT type: sequence.");
        const children = await findPlansByParent(cwd, planName);
        if (!children.length) {
            throw new Error("Write every child Plan before submitting the Sequence; it has no children.");
        }
        const members = [parent];
        let previousOrder = 0;
        const identities = new Set<string>(parent.attrs.planId ? [parent.attrs.planId] : []);
        for (const child of children) {
            const plan = await requirePlan(cwd, child.name);
            if (!["PLANNED_CHANGE", "FEATURE"].includes(plan.attrs.classification)) {
                throw new Error(`Sequence child ${child.name} must be a PLANNED_CHANGE, not another PROJECT.`);
            }
            const order = plan.attrs.order;
            if (!Number.isInteger(order) || order === undefined || order <= previousOrder) {
                throw new Error(`Sequence child ${child.name} needs a unique positive order matching execution order.`);
            }
            previousOrder = order;
            if (plan.attrs.planId && identities.has(plan.attrs.planId)) {
                throw new Error("Duplicate Plan ID in Sequence.");
            }
            if (plan.attrs.planId) identities.add(plan.attrs.planId);
            const earlier = new Set(members.slice(1).map((member) => member.name));
            const dependencies = resolveSiblingChildPlanDependencyStates(
                planName,
                plan.attrs.dependencies || [],
                children,
            );
            if (dependencies.some((dependency) => !dependency.planName || !earlier.has(dependency.planName))) {
                throw new Error(
                    `Child ${child.name} has a missing, ambiguous or forward dependency. Depend only on earlier children.`,
                );
            }
            members.push(plan);
        }
        return members;
    });
}

/** Materialize missing identities and declared policy, then freeze the whole review set. */
export async function prepareSequenceReview(
    cwd: string,
    planName: string,
    inputs?: SequenceChildInput[],
): Promise<SequenceReviewDocument[]> {
    const members = await sequenceMembers(cwd, planName);
    if (inputs) {
        if (inputs.length !== members.length - 1) throw new Error("Submit every child of the Sequence exactly once.");
        for (let index = 0; index < inputs.length; index++) {
            const child = await requirePlan(cwd, inputs[index].planName);
            if (child.path !== members[index + 1].path) {
                throw new Error("Submitted children do not match the Sequence's complete execution order.");
            }
            const policy = resolvePlanExecutionPolicy({ ...child.attrs, ...inputs[index] });
            if (!policy.ok) throw new Error(`Invalid policy for ${child.name}: ${policy.error}`);
        }
    }
    for (const [index, member] of members.entries()) {
        const identified = await ensurePlanIdentity(cwd, member.name);
        const input = index > 0 ? inputs?.[index - 1] : undefined;
        if (input?.executionAgent || input?.collaborationRecommendation) {
            await updatePlanFrontMatter(
                cwd,
                member.name,
                {
                    ...(input.executionAgent ? { executionAgent: input.executionAgent } : {}),
                    ...(input.collaborationRecommendation
                        ? { collaborationRecommendation: input.collaborationRecommendation }
                        : {}),
                },
                {},
                { expectedRevision: identified.revision },
            );
        }
    }
    return await snapshotSequenceReview(cwd, planName);
}

export async function snapshotSequenceReview(cwd: string, planName: string): Promise<SequenceReviewDocument[]> {
    return await withProjectRuntimeReadScope(async () => {
        const members = await sequenceMembers(cwd, planName);
        const documents: SequenceReviewDocument[] = [];
        for (const member of members) {
            const evidence = await loadPlanActionEvidence(cwd, member.attrs.planId || member.name);
            if (evidence.kind !== "success") throw new Error(evidence.message);
            if (evidence.evidence.worktree.kind !== "none") {
                throw new Error(`Plan ${member.name} has an execution attempt; use recovery.`);
            }
            const policy = resolvePlanExecutionPolicy(member.attrs);
            if (documents.length && !policy.ok) throw new Error(`Invalid child policy: ${policy.error}`);
            documents.push({
                planId: evidence.evidence.planId,
                planName: member.name,
                planPath: member.path,
                plan: planDocumentMarkdown(member.markdown),
                revision: member.revision,
                frontmatter: member.attrs,
                ...(policy.ok
                    ? {
                        executionAgent: policy.policy.executionAgent,
                        collaborationRecommendation: policy.policy.collaborationRecommendation,
                    }
                    : {}),
            });
        }
        return documents;
    });
}

/** Validate trusted snapshots before a transport acknowledges a group decision; commit checks again under locks. */
export async function validateSequenceReviewDecision(
    cwd: string,
    documents: SequenceReviewDocument[],
    decision: SequenceReviewDecision,
): Promise<void> {
    const current = await snapshotSequenceReview(cwd, documents[0].planName);
    if (current.length !== documents.length || current.some((doc, index) => doc.planId !== documents[index].planId)) {
        throw new Error("Sequence membership or order changed. Refresh the complete review.");
    }
    if (decision.approved && !["run", "later"].includes(decision.approvalAction || "")) {
        throw new Error("Choose Approve & Execute or Approve for Later for this Sequence.");
    }
    if (
        !decision.documents || decision.documents.length !== documents.length ||
        new Set(decision.documents.map((edit) => edit.planId)).size !== documents.length
    ) {
        throw new Error("The review must include the Sequence and every child tab.");
    }
    for (const [index, doc] of current.entries()) {
        const original = documents[index];
        if (
            !reviewSourceStillMatches(
                { attrs: doc.frontmatter, body: parsePlanFrontMatter(doc.plan).body },
                original.frontmatter,
                parsePlanFrontMatter(original.plan).body,
            )
        ) {
            throw new Error(`Plan ${doc.planName} changed while review was open. Refresh the Sequence review.`);
        }
        const edit = decision.documents.find((item) => item.planId === doc.planId);
        if (!edit || typeof edit.plan !== "string") throw new Error(`Missing decision for ${doc.planName}.`);
        if (/^---\r?\n/.test(edit.plan)) {
            const edited = parsePlanFrontMatter(edit.plan).attrs;
            for (
                const key of [
                    "planId",
                    "classification",
                    "type",
                    "parentPlan",
                    "order",
                    "dependencies",
                    "status",
                ] as const
            ) {
                if (JSON.stringify(edited[key]) !== JSON.stringify(original.frontmatter[key])) {
                    throw new Error(
                        `The review cannot change ${key} in ${doc.planName}. Update the saved Plans and resubmit the Sequence.`,
                    );
                }
            }
        }
        if (index > 0) {
            const policy = resolvePlanExecutionPolicy({
                ...doc.frontmatter,
                executionAgent: edit.executionAgent ?? doc.executionAgent,
                collaborationRecommendation: edit.collaborationRecommendation ?? doc.collaborationRecommendation,
            });
            if (!policy.ok) throw new Error(`Invalid policy for ${doc.planName}: ${policy.error}`);
        }
    }
}

interface ApplySequenceReviewOptions {
    cwd: string;
    documents: SequenceReviewDocument[];
    decision: SequenceReviewDecision;
    hostedSession?: HostedSession;
    toolCallId?: string;
}

/** Commit the complete human decision. Tool callers publish a workflow event; direct review continues it inline. */
export async function applySequenceReviewDecision(
    { cwd, documents, decision, hostedSession, toolCallId }: ApplySequenceReviewOptions,
): Promise<SequenceReviewResult> {
    const parent = documents[0];
    if (!parent || !isSequencePlan(parent.frontmatter)) throw new Error("Sequence review has no canonical container.");
    if (decision.approved && decision.approvalAction !== "run" && decision.approvalAction !== "later") {
        return {
            approved: false,
            feedback: "Choose Approve & Execute or Approve for Later.",
            cancellationReason: "stale_plan_review",
        };
    }
    const edits = decision.documents;
    if (
        !edits || edits.length !== documents.length ||
        new Set(edits.map((edit) => edit.planId)).size !== documents.length ||
        edits.some((edit) => !documents.some((doc) => doc.planId === edit.planId) || typeof edit.plan !== "string")
    ) {
        return {
            approved: false,
            feedback: "The review must include the Sequence and every child tab.",
            cancellationReason: "stale_plan_review",
        };
    }
    let outcome: PlanWrittenEventPayload | undefined;
    let result: SequenceReviewResult = { approved: false };
    const transition = await runSequenceReviewTransition({
        projectRoot: cwd,
        planName: parent.planName,
        approved: decision.approved === true,
        planNames: documents.map((doc) => doc.planName),
        decide: async ({ markEffect, registerRollback }) => {
            await validateSequenceReviewDecision(cwd, documents, decision);
            const current = await snapshotSequenceReview(cwd, parent.planName);
            if (
                current.length !== documents.length ||
                current.some((doc, index) => doc.planId !== documents[index].planId)
            ) {
                throw new Error("Sequence membership or order changed. Review the complete current Sequence again.");
            }
            const writes = await Promise.all(current.map(async (doc, index) => {
                const original = documents[index];
                const currentBody = parsePlanFrontMatter(doc.plan).body;
                if (
                    !reviewSourceStillMatches(
                        { attrs: doc.frontmatter, body: currentBody },
                        original.frontmatter,
                        parsePlanFrontMatter(original.plan).body,
                    )
                ) {
                    throw new Error(`Plan ${doc.planName} changed while review was open. Refresh the Sequence review.`);
                }
                const edit = edits.find((item) => item.planId === doc.planId)!;
                const edited = parsePlanFrontMatter(edit.plan);
                // Only document content and explicit execution-policy controls are editable here.
                // Membership, type, lifecycle and identity always come from canonical storage.
                let attrs = {
                    ...doc.frontmatter,
                    ...(/^---\r?\n/.test(edit.plan) ? stripRuntimeFields(edited.attrs) : {}),
                };
                if (index > 0) {
                    const policy = resolvePlanExecutionPolicy({
                        ...attrs,
                        executionAgent: edit.executionAgent ?? doc.executionAgent,
                        collaborationRecommendation: edit.collaborationRecommendation ??
                            doc.collaborationRecommendation,
                    });
                    if (!policy.ok) throw new Error(`Invalid execution policy for ${doc.planName}: ${policy.error}`);
                    attrs = {
                        ...attrs,
                        executionAgent: policy.policy.executionAgent,
                        collaborationRecommendation: policy.policy.collaborationRecommendation,
                    };
                }
                if (attrs.status === "ready_for_work" || attrs.status === "ready_for_decomposition") {
                    attrs = {
                        ...attrs,
                        ...buildPlanEventUpdates("review_reopened", attrs.status, { triageMeta: attrs }),
                    };
                }
                attrs = {
                    ...attrs,
                    ...buildPlanEventUpdates(decision.approved ? "review_approved" : "review_feedback", attrs.status, {
                        triageMeta: attrs,
                    }),
                };
                if (decision.approved) {
                    if (index === 0) {
                        attrs = {
                            ...attrs,
                            ...buildPlanEventUpdates("epic_readiness_passed", attrs.status, { triageMeta: attrs }),
                        };
                        attrs = {
                            ...attrs,
                            ...buildPlanEventUpdates("decomposition_finalized", attrs.status, { triageMeta: attrs }),
                        };
                    } else {
                        attrs = {
                            ...attrs,
                            ...buildPlanEventUpdates("readiness_passed", attrs.status, { triageMeta: attrs }),
                        };
                    }
                }
                const markdown = planDocumentMarkdown(injectFrontMatter(edited.body, attrs));
                return { doc, markdown, attrs, revision: await getPlanRevisionForText(markdown) };
            }));
            // The complete before/after set is durable BEFORE the first member write.
            await markEffect("sequence_review_prepared", {
                plans: writes.map(({ doc, markdown, revision }) => ({
                    planName: doc.planName,
                    before: doc.plan,
                    beforeRevision: doc.revision,
                    after: markdown,
                    afterRevision: revision,
                })),
            });
            for (const write of writes) {
                registerRollback(`Restore ${write.doc.planName}`, async () => {
                    const now = await loadPlan(cwd, write.doc.planName);
                    if (now?.revision === write.doc.revision) return;
                    if (now?.revision !== write.revision) {
                        throw new Error(`New edits in ${write.doc.planName}; preserve them for recovery.`);
                    }
                    await writePlanMarkdownWithRevision(write.doc.planPath, write.doc.plan, write.revision);
                });
                await writePlanMarkdownWithRevision(write.doc.planPath, write.markdown, write.doc.revision);
            }
            const feedback = [
                decision.feedback,
                ...edits.filter((edit) => edit.feedback).map((edit) => {
                    const doc = documents.find((item) => item.planId === edit.planId)!;
                    return `## ${doc.planName} (${doc.planId})\n${edit.feedback}`;
                }),
            ].filter(Boolean).join("\n\n");
            const images = (await Promise.all(edits.map(async (edit) => {
                const attachments = await loadReviewFeedbackImages(edit, cwd);
                return attachments;
            }))).flat();
            const first = writes[1];
            const execute = decision.approved && decision.approvalAction === "run";
            outcome = {
                outcome: execute ? "approved_execute" : decision.approved ? "saved" : "feedback",
                planName: execute ? first.doc.planName : parent.planName,
                triageMeta: execute ? first.attrs : writes[0].attrs,
                feedback,
                ...(images.length ? { images } : {}),
            };
            await markEffect("sequence_review_accepted", { planIds: documents.map((doc) => doc.planId), toolCallId });
            result = {
                approved: decision.approved === true,
                feedback,
                approvalAction: decision.approvalAction,
                revision: writes[0].revision,
                planAttrs: writes[0].attrs,
                workflowOutcome: outcome,
            };
            return { planNames: documents.map((doc) => doc.planName) };
        },
    });
    if (transition.status !== "committed") {
        const feedback = transition.message || "Sequence approval could not finish. Review the current Plans again.";
        return {
            approved: false,
            feedback,
            cancellationReason: "stale_plan_review",
            ...(transition.status === "needs_recovery"
                ? { recoveryRequired: { message: feedback, entryIds: [transition.transitionId] } }
                : {}),
        };
    }
    // Publication wakes live consumers immediately. Only a committed decision may start a child;
    // acceptance or commit failures above must remain fully compensatable without a Session event.
    if (!hostedSession || !toolCallId) return result;
    if (outcome?.outcome === "approved_execute" && outcome.planName) {
        hostedSession.setWorkflowPlanName(outcome.planName);
    }
    try {
        publishWorkflowToolEvent({ hostedSession, toolCallId, kind: "plan_written", payload: outcome! });
    } catch (error) {
        // The documents are already committed. Preserve them so reopening the saved review can retry.
        return {
            ...result,
            cancellationReason: "sequence_handoff_failed",
            feedback:
                `The Sequence decision was saved, but its workflow handoff could not be published. Reopen the saved Sequence to retry. ${
                    error instanceof Error ? error.message : String(error)
                }`,
        };
    }
    return result;
}
