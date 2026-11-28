import { plans, type PlanEvent, type PlanEventDetails, type PlanFrontMatter, type PlanId } from "@runwield/plans";
import type {
    ApplyBasicProjectPlanEvent,
    ApplyProjectPlanReviewEvent,
    BasicPlanEvent,
    ProjectPlanLifecycle,
    ProjectPlanReviewEventResult,
    PlanReviewVersion,
} from "@runwield/plans/lifecycle";
import type { ProjectPlanDocument, ProjectPlanStoreOptions } from "@runwield/plans/store";
import type { ProjectId } from "@runwield/projects";
import { resolveWorkflowPlanLocation } from "./location.ts";
import { hasCanonicalPlanAccess, selectPlanAccess, withPlanAccess } from "./handles.ts";
import { archiveSavedPlan, restoreSavedPlan } from "./archiving.ts";
import { bindCheckoutPlanLifecycle, bindProjectPlanStore } from "./project-binding.ts";
import { recordPlanEvent, recordProjectPlanEvent, type RecordPlanEventRequest } from "./events.ts";
import {
    applyProjectPlanReviewEvent,
    applyRetainedPlanReviewConversation,
    presentPlanReviewResult,
} from "./lifecycle-review.ts";
import type { SequenceReviewDecision } from "./sequence-review.ts";
import {
    checkRevision,
    readActiveProjectPlan,
    readArchivedProjectPlan,
    requirePlanId,
    requireRevision,
} from "./project-plans.ts";

type ReviewEvent = ApplyProjectPlanReviewEvent["event"];
export interface WorkflowPlanEvent extends Omit<RecordPlanEventRequest, "event" | "packageSelection"> {
    event: BasicPlanEvent;
}

function isReviewEvent(event: PlanEvent): event is ReviewEvent {
    return event === "review_approved" || event === "review_feedback";
}

function isReviewRequest(
    request: ApplyBasicProjectPlanEvent | ApplyProjectPlanReviewEvent,
): request is ApplyProjectPlanReviewEvent {
    return isReviewEvent(request.event);
}

function basicEventDetails(details: PlanEventDetails = {}): PlanEventDetails {
    const { triageMeta: _metadata, now: _clock, ...input } = details;
    return input;
}

/** Apply a named transition inside the Workflow's selected execution or retained checkout. */
export async function applyWorkflowPlanEvent({
    cwd,
    planName,
    event,
    currentStatus,
    details,
    expectedRevision,
    expectedPlanId,
}: WorkflowPlanEvent) {
    if (isReviewEvent(event)) throw new Error("A review decision requires its displayed Plan version.");
    return await recordPlanEvent({ cwd, planName, event, currentStatus, details, expectedRevision, expectedPlanId });
}

export interface ObservedCheckoutPlan {
    planName: string;
    planId?: string;
    revision: string;
    status: PlanFrontMatter["status"];
}
interface LoadedCheckoutPlan {
    planName: string;
    attrs: Pick<PlanFrontMatter, "status" | "planId">;
    revision?: string;
}

/** Take the version used by the action before opening its confirmation. */
export async function observeCheckoutPlan(cwd: string, plan: LoadedCheckoutPlan): Promise<ObservedCheckoutPlan> {
    let revision = plan.revision;
    let planId = plan.attrs.planId;
    if (!revision) {
        const { plan: current } = await resolveWorkflowPlanLocation(cwd, plan.planName, { readOnly: true });
        if (!current || current.attrs.status !== plan.attrs.status || (planId && current.attrs.planId !== planId))
            throw new Error("The selected Plan changed. Reload it before applying this action.");
        revision = current.revision;
        planId = current.attrs.planId;
    }
    requireRevision(revision);
    return { planName: plan.planName, planId, revision, status: plan.attrs.status };
}

/** Check the user's observed revision in its original canonical or retained source. */
export async function applyObservedPlanEvent(
    cwd: string,
    observed: ObservedCheckoutPlan,
    event: BasicPlanEvent,
    details?: PlanEventDetails,
): Promise<PlanFrontMatter> {
    requireRevision(observed.revision);
    const planId = plans.identity.parse(observed.planId);
    const apply = async () => {
        const lifecycle = hasCanonicalPlanAccess() && openPlanLifecycleForCheckout(cwd);
        if (planId && lifecycle)
            return (await lifecycle.applyEvent(planId, { event, expectedRevision: observed.revision, details })).attrs;
        return await applyWorkflowPlanEvent({
            cwd,
            planName: observed.planName,
            currentStatus: observed.status,
            expectedPlanId: observed.planId,
            expectedRevision: observed.revision,
            event,
            details,
        });
    };
    if (hasCanonicalPlanAccess()) return await apply();
    const access = planId && (await selectPlanAccess(cwd, observed.planName, planId));
    return access ? await withPlanAccess(cwd, access, apply, observed.planName) : await apply();
}

function applyBoundReviewEvent(
    projectId: ProjectId,
    run: ReturnType<typeof bindProjectPlanStore>,
    planId: PlanId,
    request: ApplyProjectPlanReviewEvent,
    disposition?: "prepare_execution",
) {
    return run(
        (cwd) => applyProjectPlanReviewEvent(projectId, cwd, requirePlanId(planId), request, disposition),
        "retained",
    );
}

/** Apply the bound decision and retain the controller revision needed by the current Attached round. */
export async function applyAttachedPlanReview(cwd: string, planId: PlanId, request: ApplyProjectPlanReviewEvent) {
    const binding = bindCheckoutPlanLifecycle(cwd);
    if (!binding) throw new Error("The review Project is no longer available.");
    return await applyBoundReviewEvent(binding.projectId, binding.run, planId, request, "prepare_execution");
}

/** A Sequence handoff uses the Plan attributes retained with the committed group decision. */
export async function applySequencePlanReviewForWorkflow(
    cwd: string,
    displayedVersion: PlanReviewVersion,
    decision: SequenceReviewDecision,
) {
    const binding = bindCheckoutPlanLifecycle(cwd);
    if (!binding) throw new Error("The review Project is no longer available.");
    if (decision.conversationTurn)
        return await binding.run(
            (root) => applyRetainedPlanReviewConversation(root, displayedVersion, decision),
            "retained",
        );
    return await applyBoundReviewEvent(binding.projectId, binding.run, displayedVersion.planId, {
        ...decision,
        event: decision.approved === true ? "review_approved" : "review_feedback",
        displayedVersion,
    });
}

/** Open without admitting a new Project or changing its Plan owner. */
export function openProjectPlanLifecycle(
    projectId: ProjectId,
    options: ProjectPlanStoreOptions = {},
): ProjectPlanLifecycle {
    return projectPlanLifecycle(projectId, bindProjectPlanStore(projectId, options));
}

function projectPlanLifecycle(
    projectId: ProjectId,
    run: ReturnType<typeof bindProjectPlanStore>,
): ProjectPlanLifecycle {
    function applyEvent(planId: PlanId, request: ApplyBasicProjectPlanEvent): Promise<ProjectPlanDocument>;
    function applyEvent(planId: PlanId, request: ApplyProjectPlanReviewEvent): Promise<ProjectPlanReviewEventResult>;
    async function applyEvent(id: PlanId, request: ApplyBasicProjectPlanEvent | ApplyProjectPlanReviewEvent) {
        if (isReviewRequest(request)) {
            return presentPlanReviewResult(await applyBoundReviewEvent(projectId, run, id, request));
        }
        const planId = requirePlanId(id);
        return await run(async (cwd) => {
            requireRevision(request.expectedRevision);
            const current = await readActiveProjectPlan(cwd, planId);
            checkRevision(request.expectedRevision, current.revision);
            return await recordProjectPlanEvent({
                cwd,
                planName: current.name,
                expectedPlanId: planId,
                event: request.event,
                expectedRevision: request.expectedRevision,
                details: basicEventDetails(request.details),
            });
        });
    }
    return {
        projectId,
        applyEvent,
        archive: (id, options) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(options.expectedRevision);
                const current = await readActiveProjectPlan(cwd, planId);
                checkRevision(options.expectedRevision, current.revision);
                const { document } = await archiveSavedPlan(cwd, current.name, {
                    expectedPlanId: planId,
                    expectedRevision: options.expectedRevision,
                    reason: options.reason,
                    force: options.force,
                });
                if (!document) throw new Error("Archive did not return its committed Project Plan.");
                return document;
            }),
        restore: (id, expectedRevision) =>
            run(async (cwd) => {
                const planId = requirePlanId(id);
                requireRevision(expectedRevision);
                const current = await readArchivedProjectPlan(cwd, planId);
                checkRevision(expectedRevision, current.revision);
                const { document } = await restoreSavedPlan(cwd, planId, undefined, expectedRevision);
                if (!document) throw new Error("Restore did not return its committed Project Plan.");
                return document;
            }),
    };
}

/** Use the checkout's existing admission without creating a Project. */
export function openPlanLifecycleForCheckout(cwd: string): ProjectPlanLifecycle | undefined {
    const binding = bindCheckoutPlanLifecycle(cwd);
    return binding && projectPlanLifecycle(binding.projectId, binding.run);
}
