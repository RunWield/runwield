import { plans } from "@runwield/plans";
import { hashPlanBody } from "@runwield/plans/format";
import { PlanNotFoundError, StalePlanBodyError, StalePlanWriteError } from "../plan-store.ts";
import { currentManagedRetainedExecution } from "./managed.ts";
import { openPlanStoreForCheckout, planDocumentsForCheckout, readProjectPlanDisplayCatalog } from "./project-plans.ts";
import { savePlanBodyById } from "./queries.ts";
import { hasRetainedCheckoutSource } from "./retained-source.ts";

interface CheckoutPlanBodyEdit {
    body: string;
    expectedBodyHash: string;
    expectedRevision: string;
}

function usesRetainedCheckout(cwd: string): boolean {
    return Boolean(currentManagedRetainedExecution()) || hasRetainedCheckoutSource(cwd);
}

/** Browse the selected Plan source without admitting a new Project. */
export async function readCheckoutPlanDisplayCatalog(cwd: string) {
    if (usesRetainedCheckout(cwd)) return await readProjectPlanDisplayCatalog(cwd);
    const store = openPlanStoreForCheckout(cwd);
    return store ? await store.list() : { resources: [], diagnostics: [] };
}

/** Edit using the revision and body hash observed together by the checkout client. */
export async function editCheckoutPlanBody(cwd: string, planId: string, edit: CheckoutPlanBodyEdit) {
    const { body, expectedBodyHash, expectedRevision } = edit;
    if (!expectedRevision) throw new Error("Plan body save requires expectedRevision.");
    if (usesRetainedCheckout(cwd)) {
        const resource = await savePlanBodyById(cwd, planId, body, expectedBodyHash, { expectedRevision });
        return { resource, resources: await planDocumentsForCheckout(cwd).resources() };
    }
    const store = openPlanStoreForCheckout(cwd);
    if (!store) throw new PlanNotFoundError(planId);
    if (!plans.identity.isValid(planId)) throw new Error("Plan body save requires a durable Plan ID.");
    const current = await store.read(planId);
    if (current.revision !== expectedRevision) throw new StalePlanWriteError(expectedRevision, current.revision);
    const currentBodyHash = await hashPlanBody(current.body);
    if (currentBodyHash !== expectedBodyHash) throw new StalePlanBodyError(expectedBodyHash, currentBodyHash);
    const saved = await store.editBody(planId, { body, expectedRevision });
    const { resources } = await store.list();
    return {
        resource: { ...saved, markdown: saved.body, bodyHash: await hashPlanBody(saved.body) },
        resources,
    };
}
