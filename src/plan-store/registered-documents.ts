import { parseProjectId, type ProjectRegistry } from "@runwield/projects";
import { loadPlanActionEvidence } from "../shared/workflow/plan-actions.ts";
import { readPlanRecordingContinuation } from "./continuation.ts";
import { readPlanDocumentLink, readPlanDocuments, savePlanDocument } from "./documents.ts";
import { resolveWorkflowPlanLocation } from "./location.ts";
import { bindProjectPlanStore } from "./project-binding.ts";
import { findPlanById, findPlanEvidenceById, listPlanResources, readPlanResourceCatalog } from "./queries.ts";
import { assertReadablePlanResource, loadPlanDetail } from "./resources.ts";

interface RegisteredDocumentEdit {
    expectedRevision: string;
    body: string;
}

/** Core's registered document operations for consumers that need richer Plan evidence. */
export function openRegisteredPlanDocuments(reference: string, registry: ProjectRegistry) {
    const projectId = parseProjectId(reference);
    if (!projectId) throw new Error("Project not found.");
    const run = bindProjectPlanStore(projectId, { registry });
    return {
        byId: (planId: string) => run((cwd) => findPlanById(cwd, planId), "read"),
        evidenceById: (planId: string) => run((cwd) => findPlanEvidenceById(cwd, planId), "read"),
        actionEvidence: (planId: string) => run((cwd) => loadPlanActionEvidence(cwd, planId), "read"),
        unidentifiedDocument: (name: string) =>
            run(async (cwd) => {
                const resource = (await listPlanResources(cwd)).find(
                    (candidate) => !candidate.planId && candidate.planName === name,
                );
                if (!resource) throw new Error("Plan document not found.");
                await assertReadablePlanResource(cwd, resource);
                return resource;
            }, "read"),
        detail: (planId: string, reviewOnly = false) =>
            run(
                async (cwd) => ({
                    ...(await loadPlanDetail(cwd, planId, reviewOnly)),
                    resources: reviewOnly ? [] : await listPlanResources(cwd),
                }),
                "read",
            ),
        document: (planId: string, name: string) => run(() => readPlanDocuments(planId, name), "read"),
        documentLink: (planId: string, target: string) => run(() => readPlanDocumentLink(planId, target), "read"),
        saveDocument: (planId: string, name: string, edit: RegisteredDocumentEdit) =>
            run(() => savePlanDocument(planId, name, edit.expectedRevision, edit.body)),
        recordingContinuation: (planId: string) => run((cwd) => readPlanRecordingContinuation(cwd, planId), "read"),
        workflowContinuation: (planId: string) =>
            run(async (cwd) => {
                const primary = await findPlanEvidenceById(cwd, planId);
                const { plan } = await resolveWorkflowPlanLocation(cwd, primary.planName, { readOnly: true });
                if (!plan || plan.attrs.planId !== primary.planId)
                    throw new Error("Plan evidence is unavailable. Refresh and try again.");
                return {
                    planId: primary.planId,
                    planName: primary.planName,
                    attrs: plan.attrs,
                    body: plan.markdown || plan.body,
                };
            }, "read"),
        searchResources: () =>
            run(async (cwd) => {
                const resources = (await listPlanResources(cwd)).filter((plan) => plan.planId);
                for (const plan of resources) {
                    if (plan.readAvailability?.kind === "pending") throw new Error(plan.readAvailability.message);
                    await assertReadablePlanResource(cwd, plan);
                }
                return resources;
            }, "read"),
        openSearchCatalog: async () => {
            const catalog = await run(readPlanResourceCatalog, "read");
            return {
                hasDiagnostics: catalog.diagnostics.length > 0,
                read: (planId: string) =>
                    run(async (cwd) => {
                        const plan = catalog.resources.find((candidate) => candidate.planId === planId);
                        if (plan?.readAvailability?.kind === "pending") throw new Error(plan.readAvailability.message);
                        if (plan) await assertReadablePlanResource(cwd, plan);
                        return plan;
                    }, "read"),
            };
        },
    };
}
