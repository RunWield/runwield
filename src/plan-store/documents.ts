import { StalePlanWriteError } from "@runwield/plans/store";
import {
    projectPlanDocuments,
    type PlanDocumentView,
    type PreparedPlanDocumentEdit,
} from "@runwield/plans/project-plan-documents";
import {
    assertSharedPlanWriteAllowed,
    isSharedPlanLocked,
    type CollaborationWriteOptions,
} from "@runwield/plans/collaboration-lock";
import { managedPlanStoreActive, readManagedDocument, saveManagedDocument, saveManagedProse } from "./managed.ts";
import { currentPackageProject, currentPackageSelection } from "./workflows.ts";

export async function saveReviewedPlanDocument(planName: string, before: string, after: string): Promise<void> {
    const owner = currentPackageProject();
    if (!owner) throw new Error("Package authority requires explicit admission.");
    await projectPlanDocuments
        .forOwner(owner)
        .saveReviewedPlanDocument(planName, before, after, currentPackageSelection());
}

export async function readPlanDocuments(planId: string, name = "context.md"): Promise<PlanDocumentView> {
    if (managedPlanStoreActive()) return await readManagedDocument(planId, name);
    const owner = currentPackageProject();
    if (!owner) throw new Error("Package authority requires explicit admission.");
    return await projectPlanDocuments.forOwner(owner).readPlanDocuments(planId, name);
}

export async function savePlanDocumentBatch(edits: PreparedPlanDocumentEdit[]): Promise<void> {
    const owner = currentPackageProject();
    if (!owner) throw new Error("A document batch requires an admitted Project and edits.");
    await projectPlanDocuments.forOwner(owner).savePlanDocumentBatch(edits);
}

export async function savePlanDocument(
    planId: string,
    name: string,
    revision: string,
    body: string,
    options: CollaborationWriteOptions = {},
): Promise<PlanDocumentView> {
    if (managedPlanStoreActive()) return await saveManagedDocument(planId, name, revision, body);
    const owner = currentPackageProject();
    if (!owner) throw new Error("Plan document access requires Project admission.");
    return await projectPlanDocuments.forOwner(owner).savePlanDocument(planId, name, revision, body, options);
}

export async function readPlanDocumentLink(planId: string, target: string): Promise<PlanDocumentView | null> {
    const owner = currentPackageProject();
    if (!owner) return null;
    const link = await projectPlanDocuments.forOwner(owner).resolvePlanDocumentLink(planId, target);
    return link ? await readPlanDocuments(link.planId, link.resource) : null;
}

export interface PlanDocumentIdentity {
    planId: string;
    planName: string;
}
/** Read one Plan resource through its admitted source, including retained execution documents. */
export async function readPlanResource(cwd: string, identity: PlanDocumentIdentity, resource = "context.md") {
    if (managedPlanStoreActive()) return await readManagedDocument(identity.planId, resource, cwd);
    const { readLocalHomeStore } = await import("./access.ts");
    return await readLocalHomeStore(
        cwd,
        async () => {
            if (currentPackageProject()) return await readPlanDocuments(identity.planId, resource);
            if (resource !== "context.md") throw new Error("This Plan has no separate document.");
            const { loadPlan } = await import("../plan-store.ts");
            const plan = await loadPlan(cwd, identity.planName);
            if (!plan || plan.attrs.planId !== identity.planId) throw new Error("The selected Plan is unavailable.");
            return {
                planId: identity.planId,
                planName: identity.planName,
                resource: "context.md",
                revision: plan.revision,
                body: plan.body,
                writable: !isSharedPlanLocked(plan.attrs),
                documents: [{ name: "context.md", role: "context" }],
            };
        },
        () => {
            throw new Error("The selected Plan is unavailable.");
        },
    );
}

/** Replace prose against an observed revision while preserving all owner metadata. */
export async function savePlanProse(cwd: string, name: string, body: string, expectedRevision: string) {
    if (managedPlanStoreActive()) return await saveManagedProse(cwd, name, body, expectedRevision);
    const { loadPlan, writePlanMarkdownWithRevisionLocked } = await import("../plan-store.ts");
    const { withLocalPlanWorkflow } = await import("./access.ts");
    const { splitPlanMarkdownBody } = await import("@runwield/plans/format");
    return await withLocalPlanWorkflow(cwd, name, async () => {
        const current = await loadPlan(cwd, name);
        if (!current || current.revision !== expectedRevision)
            throw new StalePlanWriteError(expectedRevision, current?.revision || "missing");
        assertSharedPlanWriteAllowed(current.attrs);
        const prefix = currentPackageProject() ? "" : splitPlanMarkdownBody(current.markdown).frontMatterBlock;
        const markdown = prefix ? `${prefix}${body}` : body;
        return await writePlanMarkdownWithRevisionLocked(cwd, name, current.path, markdown, expectedRevision);
    });
}

/** Preserve the selected draft when planning obtains a retained writable checkout. */
export async function preparePlanRepairDraft(cwd: string, name: string) {
    const { resolveWorkflowPlanLocation } = await import("./location.ts");
    const { prepareSessionPlanningWorktree } = await import("../shared/workflow/session-planning-worktree.ts");
    const { writePlanMarkdownWithRevisionLocked, loadPlan } = await import("../plan-store.ts");
    const source = await resolveWorkflowPlanLocation(cwd, name, { readOnly: true });
    if (!source.planningNotStarted) return source;
    const writable = await prepareSessionPlanningWorktree(cwd, name);
    if (source.plan && !source.publishedSnapshot && writable.plan) {
        await writePlanMarkdownWithRevisionLocked(
            writable.documentRoot,
            name,
            writable.plan.path,
            source.plan.markdown,
            writable.plan.revision,
        );
        writable.plan = await loadPlan(writable.documentRoot, name);
    }
    return writable;
}
