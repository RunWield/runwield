import {
    loadPlan as loadLocalPlan,
    listPlans as listLocalPlans,
    loadPlanStrict as loadLocalPlanStrict,
    inspectPlanStrict as inspectLocalPlanStrict,
} from "../plan-store.js";
import { managedPlanStoreActive, readManagedPlan, listManagedPlans } from "./managed.ts";
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
): ReturnType<typeof import("../plan-store.js").findPlanEvidenceById> {
    if (managedPlanStoreActive()) return await (await import("./managed.ts")).readManagedPlanResource(cwd, planId);
    return await (await import("../plan-store.js")).findPlanEvidenceById(cwd, planId);
}
export async function findPlanById(
    cwd: string,
    planId: string,
): ReturnType<typeof import("../plan-store.js").findPlanById> {
    if (managedPlanStoreActive()) return await findPlanEvidenceById(cwd, planId);
    return await (await import("../plan-store.js")).findPlanById(cwd, planId);
}
export async function loadPlanBodyById(
    cwd: string,
    planId: string,
): ReturnType<typeof import("../plan-store.js").loadPlanBodyById> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.js")).loadPlanBodyById(cwd, planId);
    const resource = await findPlanById(cwd, planId);
    const { hashPlanBody } = await import("../plan-format.ts");
    return { ...resource, body: resource.markdown, bodyHash: await hashPlanBody(resource.markdown) };
}

export async function readPlanResourceCatalog(
    cwd: string,
): ReturnType<typeof import("../plan-store.js").readPlanResourceCatalog> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).readManagedResourceCatalog(cwd)
        : await (await import("../plan-store.js")).readPlanResourceCatalog(cwd);
}
export async function listPlanResources(cwd: string): ReturnType<typeof import("../plan-store.js").listPlanResources> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.js")).listPlanResources(cwd);
    const catalog = await readPlanResourceCatalog(cwd);
    if (catalog.diagnostics.length) throw new Error(catalog.diagnostics[0].message);
    return catalog.resources;
}
export async function listPlanDocuments(cwd: string): ReturnType<typeof import("../plan-store.js").listPlanDocuments> {
    return managedPlanStoreActive()
        ? await listPlans(cwd)
        : await (await import("../plan-store.js")).listPlanDocuments(cwd);
}
export async function resolvePlan(
    cwd: string,
    reference: string,
): ReturnType<typeof import("../plan-store.js").resolvePlan> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.js")).resolvePlan(cwd, reference);
    const { selectManagedPlan } = await import("./managed.ts");
    const selected = await selectManagedPlan(cwd, reference);
    const plan = await readManagedPlan(cwd, selected.planId);
    if (!plan) throw new Error(`Plan not found: ${reference}`);
    return { ...plan, planName: selected.planName };
}
export async function findPlansByParent(
    cwd: string,
    parentPlan: string,
): ReturnType<typeof import("../plan-store.js").findPlansByParent> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.js")).findPlansByParent(cwd, parentPlan);
    const { selectManagedPlan } = await import("./managed.ts");
    const selected = await selectManagedPlan(cwd, parentPlan);
    return (await listPlans(cwd)).filter(
        (plan) => plan.attrs.parentPlan === selected.planName || plan.attrs.parentPlan === selected.planId,
    );
}
export async function savePlanBodyById(
    ...args: Parameters<typeof import("../plan-store.js").savePlanBodyById>
): ReturnType<typeof import("../plan-store.js").savePlanBodyById> {
    if (!managedPlanStoreActive()) return await (await import("../plan-store.js")).savePlanBodyById(...args);
    const [cwd, planId, body, expectedBodyHash, options = {}] = args;
    const current = await loadPlanBodyById(cwd, planId);
    const { StalePlanBodyError, StalePlanWriteError } = await import("../plan-store.js");
    if (current.bodyHash !== expectedBodyHash) throw new StalePlanBodyError(expectedBodyHash, current.bodyHash);
    if (options.expectedRevision !== current.revision)
        throw new StalePlanWriteError(options.expectedRevision || "required", current.revision);
    const { savePlanProse } = await import("./documents.ts");
    await savePlanProse(cwd, current.planName, body, current.revision);
    return await loadPlanBodyById(cwd, planId);
}

export async function listArchivedPlans(cwd: string): ReturnType<typeof import("../plan-store.js").listArchivedPlans> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).listManagedArchives(cwd)
        : await (await import("../plan-store.js")).listArchivedPlans(cwd);
}
export async function loadArchivedPlan(
    cwd: string,
    reference: string,
): ReturnType<typeof import("../plan-store.js").loadArchivedPlan> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).readManagedArchive(cwd, reference)
        : await (await import("../plan-store.js")).loadArchivedPlan(cwd, reference);
}
export async function archivePlan(
    ...args: Parameters<typeof import("../plan-store.js").archivePlan>
): ReturnType<typeof import("../plan-store.js").archivePlan> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).archiveManagedPlan(args[0], args[1], args[2] || {})
        : await (await import("../plan-store.js")).archivePlan(...args);
}
export async function restoreArchivedPlan(
    ...args: Parameters<typeof import("../plan-store.js").restoreArchivedPlan>
): ReturnType<typeof import("../plan-store.js").restoreArchivedPlan> {
    return managedPlanStoreActive()
        ? await (await import("./managed.ts")).restoreManagedPlan(args[0], args[1], args[2]?.to)
        : await (await import("../plan-store.js")).restoreArchivedPlan(...args);
}
export async function deleteArchivedPlanUnit(
    ...args: Parameters<typeof import("../plan-store.js").deleteArchivedPlanUnit>
): ReturnType<typeof import("../plan-store.js").deleteArchivedPlanUnit> {
    if (managedPlanStoreActive())
        throw new Error("Personal Plan history retention is not enabled; archived home packages remain available.");
    return await (await import("../plan-store.js")).deleteArchivedPlanUnit(...args);
}

export async function ensurePlanIdentity(
    cwd: string,
    name: string,
    options: Parameters<typeof import("../plan-store.js").ensurePlanIdentity>[2] = {},
) {
    if (!managedPlanStoreActive())
        return await (await import("../plan-store.js")).ensurePlanIdentity(cwd, name, options);
    const selected = await (await import("./managed.ts")).selectManagedPlan(cwd, name);
    return await findPlanEvidenceById(cwd, selected.planId);
}
