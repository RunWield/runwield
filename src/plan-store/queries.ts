import { join } from "node:path";
import { mergeFrontMatterText } from "../plan-format.ts";
import {
    loadPlan as loadLocalPlan,
    listPlans as listLocalPlans,
    loadPlanStrict as loadLocalPlanStrict,
    inspectPlanStrict as inspectLocalPlanStrict,
    type PlanListEntry,
} from "../plan-store.ts";
import { managedPlanStoreActive, readManagedPlan, listManagedPlans } from "./managed.ts";
import { inspectLocalHomeStore } from "./access.ts";
import { packageDocumentText, packageWorkflowRevision, readPlanPackage } from "./packages.ts";
export async function loadPlan(cwd: string, name: string) {
    return managedPlanStoreActive() ? await readManagedPlan(cwd, name) : await loadLocalPlan(cwd, name);
}
export async function listPlans(cwd: string) {
    return managedPlanStoreActive() ? await listManagedPlans(cwd) : await listLocalPlans(cwd);
}

export async function loadPlanStrict(cwd: string, name: string): ReturnType<typeof loadLocalPlanStrict> {
    if (!managedPlanStoreActive()) return await loadLocalPlanStrict(cwd, name);
    const plan = await readManagedPlan(cwd, name);
    return plan
        ? {
              ...plan,
              kind: "loaded",
              frontMatterRevision: plan.frontMatterRevision,
              hasFrontMatter: plan.hasFrontMatter ?? false,
          }
        : { kind: "not_found", path: name };
}
export async function inspectPlanStrict(cwd: string, name: string): ReturnType<typeof inspectLocalPlanStrict> {
    return managedPlanStoreActive() ? await loadPlanStrict(cwd, name) : await inspectLocalPlanStrict(cwd, name);
}

export async function findPlanEvidenceById(
    cwd: string,
    planId: string,
): ReturnType<typeof import("../plan-store.ts").findPlanEvidenceById> {
    if (managedPlanStoreActive()) return await (await import("./managed.ts")).readManagedPlanResource(cwd, planId);
    return await (await import("../plan-store.ts")).findPlanEvidenceById(cwd, planId);
}
export async function findPlanById(
    cwd: string,
    planId: string,
): ReturnType<typeof import("../plan-store.ts").findPlanById> {
    if (managedPlanStoreActive()) return await findPlanEvidenceById(cwd, planId);
    return await (await import("../plan-store.ts")).findPlanById(cwd, planId);
}
export async function loadPlanBodyById(
    cwd: string,
    planId: string,
): ReturnType<typeof import("../plan-store.ts").loadPlanBodyById> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.ts")).loadPlanBodyById(cwd, planId);
    const resource = await findPlanById(cwd, planId);
    const { hashPlanBody } = await import("../plan-format.ts");
    return { ...resource, body: resource.markdown, bodyHash: await hashPlanBody(resource.markdown) };
}

export async function readPlanResourceCatalog(
    cwd: string,
): ReturnType<typeof import("../plan-store.ts").readPlanResourceCatalog> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).readManagedResourceCatalog(cwd)
        : await (await import("../plan-store.ts")).readPlanResourceCatalog(cwd);
}
export async function listPlanResources(cwd: string): ReturnType<typeof import("../plan-store.ts").listPlanResources> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.ts")).listPlanResources(cwd);
    const catalog = await readPlanResourceCatalog(cwd);
    if (catalog.diagnostics.length) throw new Error(catalog.diagnostics[0].message);
    return catalog.resources;
}
export async function listPlanDocuments(cwd: string): ReturnType<typeof import("../plan-store.ts").listPlanDocuments> {
    return managedPlanStoreActive()
        ? await listManagedPlans(cwd, true)
        : await (await import("../plan-store.ts")).listPlanDocuments(cwd);
}
/** Read the body for one menu entry without entering a workflow or resolving its execution checkout. */
export async function readPlanMenuDocument(cwd: string, entry: Pick<PlanListEntry, "name" | "attrs">) {
    if (managedPlanStoreActive()) {
        const plan = await readManagedPlan(cwd, entry.attrs.planId || entry.name);
        if (!plan) throw new Error(`Plan not found: ${entry.name}`);
        return { ...plan, planName: entry.name };
    }
    const owner = inspectLocalHomeStore(cwd);
    if (owner.kind !== "local") throw new Error("No saved Plan store for this Project.");
    const plan = await readPlanPackage(owner.identity, { name: entry.name, planId: entry.attrs.planId });
    if (plan.kind !== "loaded") throw new Error(plan.message);
    if (plan.metadata.archive && !plan.metadata.archive.restoredAt)
        throw new Error(`This Plan is archived: ${entry.name}`);
    const body = packageDocumentText(plan.documents)["context.md"];
    const attrs = entry.attrs;
    return {
        planName: entry.name,
        path: join(plan.path, "context.md"),
        body,
        markdown: mergeFrontMatterText(body, attrs),
        attrs,
        revision: packageWorkflowRevision(plan),
    };
}
export async function resolvePlan(
    cwd: string,
    reference: string,
): ReturnType<typeof import("../plan-store.ts").resolvePlan> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.ts")).resolvePlan(cwd, reference);
    const { selectManagedPlan } = await import("./managed.ts");
    const selected = await selectManagedPlan(cwd, reference);
    const plan = await readManagedPlan(cwd, selected.planId);
    if (!plan) throw new Error(`Plan not found: ${reference}`);
    return { ...plan, planName: selected.planName };
}
export async function findPlansByParent(
    cwd: string,
    parentPlan: string,
): ReturnType<typeof import("../plan-store.ts").findPlansByParent> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.ts")).findPlansByParent(cwd, parentPlan);
    const { selectManagedPlan } = await import("./managed.ts");
    const selected = await selectManagedPlan(cwd, parentPlan);
    return (await listPlans(cwd)).filter(
        (plan) => plan.attrs.parentPlan === selected.planName || plan.attrs.parentPlan === selected.planId,
    );
}
export async function savePlanBodyById(
    ...args: Parameters<typeof import("../plan-store.ts").savePlanBodyById>
): ReturnType<typeof import("../plan-store.ts").savePlanBodyById> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.ts")).savePlanBodyById(...args);
    const [cwd, planId, body, expectedBodyHash, options = {}] = args;
    const current = await loadPlanBodyById(cwd, planId);
    const { StalePlanBodyError, StalePlanWriteError } = await import("../plan-store.ts");
    if (current.bodyHash !== expectedBodyHash) throw new StalePlanBodyError(expectedBodyHash, current.bodyHash);
    if (options.expectedRevision !== current.revision)
        throw new StalePlanWriteError(options.expectedRevision || "required", current.revision);
    const { savePlanProse } = await import("./documents.ts");
    await savePlanProse(cwd, current.planName, body, current.revision);
    return await loadPlanBodyById(cwd, planId);
}

export async function listArchivedPlans(cwd: string): ReturnType<typeof import("../plan-store.ts").listArchivedPlans> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).listManagedArchives(cwd)
        : await (await import("../plan-store.ts")).listArchivedPlans(cwd);
}
export async function loadArchivedPlan(
    cwd: string,
    reference: string,
): ReturnType<typeof import("../plan-store.ts").loadArchivedPlan> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).readManagedArchive(cwd, reference)
        : await (await import("../plan-store.ts")).loadArchivedPlan(cwd, reference);
}
export async function archivePlan(
    ...args: Parameters<typeof import("../plan-store.ts").archivePlan>
): ReturnType<typeof import("../plan-store.ts").archivePlan> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).archiveManagedPlan(args[0], args[1], args[2] || {})
        : await (await import("../plan-store.ts")).archivePlan(...args);
}
export async function restoreArchivedPlan(
    ...args: Parameters<typeof import("../plan-store.ts").restoreArchivedPlan>
): ReturnType<typeof import("../plan-store.ts").restoreArchivedPlan> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).restoreManagedPlan(args[0], args[1], args[2]?.to)
        : await (await import("../plan-store.ts")).restoreArchivedPlan(...args);
}
export async function deleteArchivedPlanUnit(
    ...args: Parameters<typeof import("../plan-store.ts").deleteArchivedPlanUnit>
): ReturnType<typeof import("../plan-store.ts").deleteArchivedPlanUnit> {
    if (managedPlanStoreActive()) throw new Error("Pruning home Plans requires a confirmed retention preview.");
    return await (await import("../plan-store.ts")).deleteArchivedPlanUnit(...args);
}

export async function ensurePlanIdentity(
    cwd: string,
    name: string,
    options: Parameters<typeof import("../plan-store.ts").ensurePlanIdentity>[2] = {},
) {
    if (!managedPlanStoreActive())
        return await (await import("../plan-store.ts")).ensurePlanIdentity(cwd, name, options);
    const selected = await (await import("./managed.ts")).selectManagedPlan(cwd, name);
    return await findPlanEvidenceById(cwd, selected.planId);
}
