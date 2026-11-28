import { canonicalizeStoredPlanName } from "@runwield/plans/format";
import type { ProjectPlanDocument } from "@runwield/plans/store";
import { enterProjectRuntime } from "@runwield/project-runtime/layout";
import type { PlanAuthoringInput } from "@runwield/plans/store";
import { withLocalPlanWorkflow } from "./access.ts";
import { savePlanDefinition, type PlanDefinitionChanges } from "./definition.ts";
import { recordPlanEvent, type RecordPlanEventRequest } from "./events.ts";
import { resolveWorkflowPlanLocation } from "./location.ts";
import { admitPlanStoreForCheckout, openPlanStoreForCheckout, planDocumentsForCheckout } from "./project-plans.ts";
import { validatedRetainedCheckoutSource } from "@runwield/plans/retained-checkout";

type SubmissionPlan = NonNullable<Awaited<ReturnType<typeof resolveWorkflowPlanLocation>>["plan"]>;
type DefinitionSnapshot = Pick<SubmissionPlan, "attrs" | "revision">;
type ReviewSnapshot = Pick<RecordPlanEventRequest, "planName" | "currentStatus"> &
    Required<Pick<RecordPlanEventRequest, "expectedPlanId" | "expectedRevision">>;

export interface PlanSubmissionOptions {
    expectedPlanId?: string;
    expectedProjectId?: string;
    requirePlanningStarted?: boolean;
    prepareAuthor?: () => Omit<PlanAuthoringInput, "planName">;
}

export interface PlanSubmissionDocument {
    cwd: string;
    documentRoot: string;
    plan: SubmissionPlan;
    planId?: string;
    saveDefinition(changes: PlanDefinitionChanges, before?: DefinitionSnapshot): Promise<void>;
    reopenReview(snapshot: ReviewSnapshot): Promise<void>;
}

/** Author through the canonical owner, then review or submit in the selected Plan's workflow. */
export async function withPlanSubmission<Result>(
    cwd: string,
    reference: string,
    options: PlanSubmissionOptions,
    run: (document: PlanSubmissionDocument) => Promise<Result>,
): Promise<Result | undefined> {
    const { name } = canonicalizeStoredPlanName(reference);
    const retained = validatedRetainedCheckoutSource(cwd);
    let store = retained ? undefined : openPlanStoreForCheckout(cwd);
    const { expectedPlanId, expectedProjectId } = options;
    if (expectedProjectId && expectedProjectId !== (retained?.projectId ?? store?.projectId))
        throw new Error("Plan authoring belongs to another Session Project.");

    let current: ProjectPlanDocument | undefined;
    if (options.requirePlanningStarted) {
        const checkPlanning = async (root: string) => {
            const planning = await resolveWorkflowPlanLocation(root, name, { readOnly: true, loadFromTarget: true });
            if (planning.planningNotStarted) throw new Error(`Start planning ${name} first. Nothing was changed.`);
        };
        if (store) current = await store.resolveAuthoredPlan(name, expectedPlanId);
        if (store && current) await store.withWorkflow(current.planId, name, checkPlanning);
        else if (retained && (await planDocumentsForCheckout(cwd).load(name))) await checkPlanning(cwd);
        else if (expectedPlanId && !retained)
            throw new Error("The bound Plan identity changed. Nothing was submitted.");
    }

    if (options.prepareAuthor) {
        const input = options.prepareAuthor();
        if (retained) throw new Error("Plan authoring requires the canonical Project owner.");
        store ??= await admitPlanStoreForCheckout(cwd);
        current = await store.author({ ...input, planName: name }, current?.planId ?? expectedPlanId);
    } else if (!options.requirePlanningStarted) {
        current = await store?.resolveAuthoredPlan(name, expectedPlanId);
    }

    const useDocument = async (root: string) => {
        const { documentRoot, plan } = await resolveWorkflowPlanLocation(root, name);
        if (!plan) return undefined;
        const boundPlanId = current?.planId ?? expectedPlanId;
        if (boundPlanId && plan.attrs.planId !== boundPlanId) throw new Error("The bound Plan identity changed.");
        const planId = boundPlanId ?? plan.attrs.planId;
        const retainedDocument = validatedRetainedCheckoutSource(documentRoot);
        return await run({
            cwd: root,
            documentRoot,
            plan,
            planId,
            async saveDefinition(changes, before = plan) {
                if (planId && before.attrs.planId !== planId) throw new Error("The bound Plan identity changed.");
                if (retainedDocument) await enterProjectRuntime(cwd);
                await savePlanDefinition(documentRoot, name, changes, {
                    expectedPlanId: before.attrs.planId,
                    expectedRevision: before.revision,
                });
            },
            async reopenReview(snapshot) {
                const reopen = () => recordPlanEvent({ cwd: documentRoot, event: "review_reopened", ...snapshot });
                if (retainedDocument || snapshot.planName === name) await reopen();
                else await withLocalPlanWorkflow(documentRoot, snapshot.planName, reopen, snapshot.expectedPlanId);
            },
        });
    };
    if (store && current) return await store.withWorkflow(current.planId, name, useDocument);
    return retained ? await useDocument(cwd) : undefined;
}
