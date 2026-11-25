import { dirname, join } from "node:path";
import type { ProjectWorkRecord, ProjectWorkRecords } from "@runwield/plans/store";
import { parseProjectId, type ProjectRegistry } from "@runwield/projects";
import { readLocalHomeStore } from "./access.ts";
import { openPlanStoreForCheckout, openProjectPlanStore } from "./project-plans.ts";
import { managedDocumentRoot, managedPlanStoreActive } from "./managed.ts";
import { workRecordOwnerLayout } from "../shared/work-records/owner.ts";
import { validatedRetainedCheckoutSource } from "./retained-source.ts";
import { listProjectWorkRecords, selectProjectWorkRecord } from "./project-work-records.ts";

/** Resolve passive Work Record evidence at a checkout entry point. */
export function workRecordsForCheckout(root: string): ProjectWorkRecords {
    const retained = validatedRetainedCheckoutSource(root);
    if (!retained) {
        const store = openPlanStoreForCheckout(root);
        if (store) return store.workRecords;
        return { list: () => Promise.resolve([]), read: () => Promise.resolve(null) };
    }
    const list = () => {
        if (validatedRetainedCheckoutSource(root) !== retained)
            throw new Error("Work Record authority changed. Reopen the Project.");
        return listProjectWorkRecords(root);
    };
    return { list, read: async (id) => selectProjectWorkRecord(await list(), id) };
}

/** Resolve Workspace Work Records through the active Project registration. */
export function registeredWorkRecords(reference: string, registry: ProjectRegistry): ProjectWorkRecords {
    const projectId = parseProjectId(reference);
    if (!projectId) throw new Error("Project not found.");
    return openProjectPlanStore(projectId, { registry }).workRecords;
}

/** Display a canonical path only where the checkout host can address it. */
export function workRecordDisplayPath(root: string, record: ProjectWorkRecord): string {
    if (validatedRetainedCheckoutSource(root)) return record.relativePath;
    if (managedPlanStoreActive()) return join(dirname(managedDocumentRoot(root)), record.relativePath);
    const owner = workRecordOwnerLayout();
    return owner ? join(owner.root, record.relativePath) : record.relativePath;
}

/** Keep an app read and its local presentation in the same owner scope. */
export async function withWorkRecordReadScope<T>(
    root: string,
    read: () => Promise<T>,
    empty: () => T | Promise<T>,
): Promise<T> {
    if (managedPlanStoreActive()) return await read();
    return await readLocalHomeStore(root, read, empty);
}
