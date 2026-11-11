import { posix } from "node:path";
import {
    currentPackageProject,
    selectedPackage,
    packageWorkflowRevision,
    packageController,
    packageWorkflowLocks,
} from "./package-workflow.ts";
import { savePlanPackageDocument, listPlanPackages } from "../plan-package-store.ts";
import { assertSharedPlanWriteAllowed, isSharedPlanLocked } from "../collaboration/lock.ts";
import { StalePlanWriteError } from "../../plan-store.js";

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
