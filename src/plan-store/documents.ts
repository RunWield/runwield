import { sameReviewedMarkdown } from "./review.ts";
import { managedPlanStoreActive, readManagedDocument, saveManagedDocument, saveManagedProse } from "./managed.ts";
import { posix } from "node:path";
import {
    currentPackageProject,
    selectedPackage,
    packageWorkflowRevision,
    packageController,
    packageWorkflowLocks,
    reopenedPackageReview,
} from "./workflows.ts";
import {
    savePlanPackageDocument,
    commitPlanPackageBatch,
    packageDocumentText,
    listPlanPackages,
    type PackageResourceRole,
    type LoadedPlanPackage,
    type PlanPackageBatchWrite,
} from "./packages.ts";
import {
    assertSharedPlanWriteAllowed,
    isSharedPlanLocked,
    type CollaborationWriteOptions,
} from "../shared/collaboration/lock.ts";
import { StalePlanWriteError } from "../plan-store.ts";

/** Save an edit against the exact context shown by a retained review. Storage checks stay with the owner. */
export async function saveReviewedPlanDocument(planName: string, before: string, after: string): Promise<void> {
    await packageWorkflowLocks([planName], async () => {
        const plan = await selectedPackage(planName);
        if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
            throw new Error("This Plan package is archived.");
        assertSharedPlanWriteAllowed(await packageController(plan));
        const document = plan.documents.find((entry) => entry.name === "context.md")!;
        if (new TextDecoder().decode(document.bytes) !== before)
            throw new Error(`Plan ${planName} changed before saving review edits.`);
        if (after !== before)
            await savePlanPackageDocument(
                currentPackageProject()!,
                plan.metadata.planId,
                "context.md",
                document.hash,
                after,
            );
    });
}

export interface PlanDocumentView {
    planId: string;
    planName: string;
    resource: string;
    revision: string;
    metadataRevision: number;
    body: string;
    writable: boolean;
    documents: Array<{ name: string; role: PackageResourceRole }>;
}

/** Document identity is resolved inside the admitted Project, never from a host path. */
export async function readPlanDocuments(planId: string, name: string = "context.md"): Promise<PlanDocumentView> {
    if (managedPlanStoreActive()) return await readManagedDocument(planId, name);
    const plan = await selectedPackage({ planId });
    const document = plan.documents.find((entry) => entry.name === name);
    if (!document) throw new Error("Plan document not found.");
    const controller = await packageController(plan);
    return {
        planId: plan.metadata.planId,
        planName: plan.metadata.name,
        resource: document.name,
        revision: packageWorkflowRevision(plan),
        metadataRevision: plan.metadata.revision,
        body: new TextDecoder().decode(document.bytes),
        writable:
            (!plan.metadata.archive || Boolean(plan.metadata.archive.restoredAt)) && !isSharedPlanLocked(controller),
        documents: plan.documents.map((entry) => ({ name: entry.name, role: entry.role })),
    };
}

/** Derive review and execution metadata for an atomic change to the reviewed documents. */
export async function reviewUpdateForDocumentChanges(
    plan: LoadedPlanPackage,
    changes: Array<{ previous: string; next: string }>,
) {
    if (changes.every(({ previous, next }) => sameReviewedMarkdown(previous, next))) return;
    return await reopenedPackageReview(plan);
}

export interface PreparedPlanDocumentEdit {
    planId: string;
    resource: string;
    expectedRevision: string;
    body: string;
}

/** Validate all selected generations before publishing prose and review state together. */
export async function savePlanDocumentBatch(edits: PreparedPlanDocumentEdit[]) {
    const owner = currentPackageProject();
    if (!owner || !edits.length) throw new Error("A document batch requires an admitted Project and edits.");
    const grouped = Map.groupBy(edits, (edit) => edit.planId);
    await packageWorkflowLocks(
        [...grouped.keys()].map((planId) => ({ planId })),
        async () => {
            const writes: PlanPackageBatchWrite[] = [];
            for (const [planId, changes] of grouped) {
                const plan = await selectedPackage({ planId });
                if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
                    throw new Error("This Plan package is archived.");
                assertSharedPlanWriteAllowed(await packageController(plan));
                const revision = packageWorkflowRevision(plan);
                const previous = packageDocumentText(plan.documents);
                const documents = { ...previous };
                const changed = [];
                const seen = new Set<string>();
                for (const edit of changes) {
                    if (edit.expectedRevision !== revision)
                        throw new StalePlanWriteError(edit.expectedRevision, revision);
                    const doc = plan.documents.find((item) => item.name === edit.resource);
                    if (!doc || seen.has(doc.name)) throw new Error("Unknown or duplicate Plan document.");
                    if (/^\ufeff?---\s*\r?\n/.test(edit.body))
                        throw new Error("Live Plan documents must not contain YAML front matter.");
                    seen.add(doc.name);
                    changed.push({ previous: previous[doc.name]!, next: edit.body });
                    documents[doc.name] = edit.body;
                }
                const review = await reviewUpdateForDocumentChanges(plan, changed);
                writes.push({
                    before: { metadata: plan.metadata, documents: previous },
                    metadata: { ...plan.metadata, ...review, revision: plan.metadata.revision + 1 },
                    documents,
                });
            }
            await commitPlanPackageBatch(owner, writes);
        },
    );
}

export async function savePlanDocument(
    planId: string,
    name: string,
    revision: string,
    body: string,
    options: CollaborationWriteOptions = {},
): Promise<PlanDocumentView> {
    if (managedPlanStoreActive()) return await saveManagedDocument(planId, name, revision, body);
    return await packageWorkflowLocks([{ planId }], async () => {
        const selection = currentPackageProject();
        if (!selection) throw new Error("Plan document access requires Project admission.");
        const plan = await selectedPackage({ planId });
        const document = plan.documents.find((entry) => entry.name === name);
        if (!document) throw new Error("Plan document not found.");
        const currentRevision = packageWorkflowRevision(plan);
        if (currentRevision !== revision) throw new StalePlanWriteError(revision, currentRevision);
        if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
            throw new Error("This Plan package is archived.");
        assertSharedPlanWriteAllowed(await packageController(plan), options);
        const previous = new TextDecoder().decode(document.bytes);
        if (previous !== body) {
            const changed = await reviewUpdateForDocumentChanges(plan, [{ previous, next: body }]);
            if (changed) {
                const documents = packageDocumentText(plan.documents);
                await commitPlanPackageBatch(selection, [
                    {
                        before: { metadata: plan.metadata, documents },
                        metadata: { ...plan.metadata, ...changed, revision: plan.metadata.revision + 1 },
                        documents: { ...documents, [document.name]: body },
                    },
                ]);
            } else {
                await savePlanPackageDocument(selection, planId, document.name, document.hash, body);
            }
        }
        return await readPlanDocuments(planId, name);
    });
}

/** Resolve a Markdown link against its admitted document, preserving repository containment for other files. */
export async function readPlanDocumentLink(planId: string, target: string) {
    if (!currentPackageProject()) return null;
    const plan = await selectedPackage({ planId });
    const name = target.split("#")[0];
    if (plan.documents.some((document) => document.name === name)) return await readPlanDocuments(planId, name);
    if (name.startsWith("/") || name.includes("\\") || /^[a-z]+:/i.test(name))
        throw new Error("Document link is outside this Project.");
    const resolved = posix.normalize(posix.join(posix.dirname(plan.metadata.name), name));
    if (resolved === ".." || resolved.startsWith("../")) return null;
    const selection = currentPackageProject()!;
    const catalog = await listPlanPackages(selection);
    const linked = catalog.packages.find((entry) => `${entry.metadata.name}.md` === resolved);
    return linked ? await readPlanDocuments(linked.metadata.planId) : null;
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
