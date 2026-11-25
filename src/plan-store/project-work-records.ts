import type { ProjectWorkRecord } from "@runwield/plans/store";
import { projects } from "@runwield/projects";
import { listOwnedWorkRecords } from "./recording.ts";
import { hasRetainedCheckoutSource } from "./retained-source.ts";
import { capturePackageWorkflowAccess } from "./workflows.ts";

export async function listProjectWorkRecords(cwd: string): Promise<ProjectWorkRecord[]> {
    const list = () => listOwnedWorkRecords(cwd, { createDir: false });
    // A registered Workspace read may already have entered the canonical owner's scope.
    const resources =
        !projects.home.current() && hasRetainedCheckoutSource(cwd)
            ? await capturePackageWorkflowAccess({ preserveSelection: false })(undefined, list)
            : await list();
    return resources.map(({ path: _ownerPath, ...document }) => document);
}

export function selectProjectWorkRecord(
    records: readonly ProjectWorkRecord[],
    recordId: string,
): ProjectWorkRecord | null {
    const id = recordId.toLowerCase();
    const matches = records.filter((record) => record.attrs.recordId.toLowerCase() === id);
    if (matches.length > 1) throw new Error(`Ambiguous Work Record ID: ${recordId}`);
    return matches[0] ?? null;
}
