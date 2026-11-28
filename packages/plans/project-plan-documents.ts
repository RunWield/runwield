import { posix } from "node:path";
import type { ProjectStoreIdentity } from "@runwield/projects";
import {
    assertSharedPlanWriteAllowed,
    isSharedPlanLocked,
    type CollaborationWriteOptions,
} from "./collaboration-lock.ts";
import { decodePackageMarkdown, isEpicArtifactName } from "./format.ts";
import { packageDocumentText, type PackageResourceRole } from "./package-data.ts";
import {
    commitPlanPackageBatch,
    listPlanPackages,
    packageDocumentContent,
    packageWorkflowRevision,
    savePlanPackageDocument,
    type PlanPackageBatchWrite,
} from "./package-storage.ts";
import { projectPlanFiles, type PackageReadSelection } from "./project-plan-files.ts";
import { StalePlanWriteError } from "./store-errors.ts";

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

export interface PreparedPlanDocumentEdit {
    planId: string;
    resource: string;
    expectedRevision: string;
    body: string;
}

/** Canonical document operations for an admitted personal Project owner. */
function forOwner(owner: ProjectStoreIdentity) {
    const files = projectPlanFiles.forOwner(owner);

    /** Save an edit against the exact context shown by a retained review. Storage checks stay with the owner. */
    async function saveReviewedPlanDocument(
        planName: string,
        before: string,
        after: string,
        selection?: PackageReadSelection,
    ): Promise<void> {
        await files.withFamilyLocks(
            [planName],
            async () => {
                const plan = await files.select(planName, selection);
                if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
                    throw new Error("This Plan package is archived.");
                assertSharedPlanWriteAllowed(await files.readController(plan));
                const document = plan.documents.find((entry) => entry.name === "context.md")!;
                if (new TextDecoder().decode(document.bytes) !== before)
                    throw new Error(`Plan ${planName} changed before saving review edits.`);
                if (after !== before)
                    await savePlanPackageDocument(owner, plan.metadata.planId, "context.md", document.hash, after);
            },
            selection,
        );
    }

    /** Document identity is resolved inside the admitted Project, never from a host path. */
    async function readPlanDocuments(planId: string, name = "context.md"): Promise<PlanDocumentView> {
        const plan = await files.select({ planId });
        const content = packageDocumentContent(plan, name);
        if (!content) throw new Error("Plan document not found.");
        const controller = await files.readController(plan);
        return {
            planId: plan.metadata.planId,
            planName: plan.metadata.name,
            resource: name,
            revision: content.revision,
            metadataRevision: plan.metadata.revision,
            body: content.body,
            writable:
                (!plan.metadata.archive || Boolean(plan.metadata.archive.restoredAt)) &&
                !isSharedPlanLocked(controller),
            documents: plan.documents.map((entry) => ({ name: entry.name, role: entry.role })),
        };
    }

    /** Validate all selected generations before publishing prose and review state together. */
    async function savePlanDocumentBatch(edits: PreparedPlanDocumentEdit[]): Promise<void> {
        if (!edits.length) throw new Error("A document batch requires an admitted Project and edits.");
        const grouped = Map.groupBy(edits, (edit) => edit.planId);
        await files.withFamilyLocks(
            [...grouped.keys()].map((planId) => ({ planId })),
            async () => {
                const writes: PlanPackageBatchWrite[] = [];
                for (const [planId, changes] of grouped) {
                    const plan = await files.select({ planId });
                    if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
                        throw new Error("This Plan package is archived.");
                    assertSharedPlanWriteAllowed(await files.readController(plan));
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
                    const review = await files.prepareReviewInvalidation(plan, {
                        kind: "edit",
                        documents: changed,
                    });
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

    async function savePlanDocument(
        planId: string,
        name: string,
        revision: string,
        body: string,
        options: CollaborationWriteOptions = {},
    ): Promise<PlanDocumentView> {
        return await files.withFamilyLocks([{ planId }], async () => {
            const plan = await files.select({ planId });
            const document = plan.documents.find((entry) => entry.name === name);
            if (!document) throw new Error("Plan document not found.");
            const currentRevision = packageWorkflowRevision(plan);
            if (currentRevision !== revision) throw new StalePlanWriteError(revision, currentRevision);
            if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
                throw new Error("This Plan package is archived.");
            assertSharedPlanWriteAllowed(await files.readController(plan), options);
            const previous = isEpicArtifactName(document.name)
                ? decodePackageMarkdown(document.bytes)
                : new TextDecoder().decode(document.bytes);
            if (previous !== body) {
                const changed = await files.prepareReviewInvalidation(plan, {
                    kind: "edit",
                    documents: [{ previous, next: body }],
                });
                if (changed) {
                    const documents = packageDocumentText(plan.documents);
                    await commitPlanPackageBatch(owner, [
                        {
                            before: { metadata: plan.metadata, documents },
                            metadata: { ...plan.metadata, ...changed, revision: plan.metadata.revision + 1 },
                            documents: { ...documents, [document.name]: body },
                        },
                    ]);
                } else {
                    await savePlanPackageDocument(owner, planId, document.name, document.hash, body);
                }
            }
            return await readPlanDocuments(planId, name);
        });
    }

    /** Resolve a Markdown link against its admitted document, preserving repository containment for other files. */
    async function resolvePlanDocumentLink(planId: string, target: string) {
        const plan = await files.select({ planId });
        const name = target.split("#")[0];
        if (plan.documents.some((document) => document.name === name)) return { planId, resource: name };
        if (name.startsWith("/") || name.includes("\\") || /^[a-z]+:/i.test(name))
            throw new Error("Document link is outside this Project.");
        const resolved = posix.normalize(posix.join(posix.dirname(plan.metadata.name), name));
        if (resolved === ".." || resolved.startsWith("../")) return null;
        const catalog = await listPlanPackages(owner);
        const linked = catalog.packages.find((entry) => `${entry.metadata.name}.md` === resolved);
        return linked ? { planId: linked.metadata.planId, resource: "context.md" } : null;
    }

    return {
        readPlanDocuments,
        savePlanDocument,
        savePlanDocumentBatch,
        saveReviewedPlanDocument,
        resolvePlanDocumentLink,
    };
}

export const projectPlanDocuments = { forOwner };
