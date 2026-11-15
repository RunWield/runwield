import { posix } from "node:path";
import {
    currentPackageProject,
    selectedPackage,
    packageWorkflowRevision,
    packageController,
    packageWorkflowLocks,
} from "./workflows.ts";
import { savePlanPackageDocument, listPlanPackages } from "./packages.ts";
import { assertSharedPlanWriteAllowed, isSharedPlanLocked } from "../shared/collaboration/lock.ts";
import { StalePlanWriteError } from "../plan-store.js";

/** Save an edit against the exact context shown by a retained review. Storage checks stay with the owner. */
export async function saveReviewedPlanDocument(planName: string, before: string, after: string): Promise<void> {
    await packageWorkflowLocks([planName], async () => {
        const plan = await selectedPackage(planName);
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

/** Document identity is resolved inside the admitted Project, never from a host path. */
export async function readPlanDocuments(planId: string, name: string = "context.md") {
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
        writable: !isSharedPlanLocked(controller),
        documents: plan.documents.map((entry) => ({ name: entry.name, role: entry.role })),
    };
}

export async function savePlanDocument(planId: string, name: string, revision: string, body: string) {
    return await packageWorkflowLocks([{ planId }], async () => {
        const selection = currentPackageProject();
        if (!selection) throw new Error("Plan document access requires Project admission.");
        const plan = await selectedPackage({ planId });
        const document = plan.documents.find((entry) => entry.name === name);
        if (!document) throw new Error("Plan document not found.");
        assertSharedPlanWriteAllowed(await packageController(plan));
        const currentRevision = packageWorkflowRevision(plan);
        if (currentRevision !== revision) throw new StalePlanWriteError(revision, currentRevision);
        await savePlanPackageDocument(selection, planId, document.name, document.hash, body);
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
    const { readLocalHomeStore } = await import("./access.ts");
    return await readLocalHomeStore(
        cwd,
        async () => {
            if (currentPackageProject()) return await readPlanDocuments(identity.planId, resource);
            if (resource !== "context.md") throw new Error("This Plan has no separate document.");
            const { loadPlan } = await import("../plan-store.js");
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
    const { loadPlan, writePlanMarkdownWithRevisionLocked } = await import("../plan-store.js");
    const { withLocalPlanWorkflow } = await import("./access.ts");
    const { splitPlanMarkdownBody } = await import("../plan-format.ts");
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
    const { writePlanMarkdownWithRevisionLocked, loadPlan } = await import("../plan-store.js");
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
