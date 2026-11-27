import type { WorkRecordCreationOperation } from "@runwield/plans/work-record-files";
import { requestWorkspaceSearchRefresh } from "../shared/workspace-search-refresh.ts";
import { requireOwnedWorkRecordFiles } from "../shared/work-records/owner.ts";
import type { CreateProjectWorkRecord, ProjectWorkRecord } from "@runwield/plans/store";
import { projects } from "@runwield/projects";
import { listOwnedWorkRecords } from "./recording.ts";
import { hasRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
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

/** The caller has already bound this operation to the admitted personal store. */
export async function createLocalProjectWorkRecord(
    cwd: string,
    input: CreateProjectWorkRecord,
    operation?: WorkRecordCreationOperation,
): Promise<ProjectWorkRecord> {
    const files = requireOwnedWorkRecordFiles();
    const { path: _ownerPath, ...document } = operation
        ? await files.createOperationRecord(input, operation)
        : await files.createRecord(input);
    await requestWorkspaceSearchRefresh(cwd);
    return document;
}

export function readLocalProjectWorkRecordCreation(operation: WorkRecordCreationOperation) {
    return requireOwnedWorkRecordFiles().readOperationRecord(operation);
}
