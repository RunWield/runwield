import {
    workRecordFiles,
    type ListWorkRecordsOptions,
    type WriteWorkRecordOptions,
} from "@runwield/plans/work-record-files";
import type { WorkRecordFrontMatter, WorkRecordResource } from "@runwield/plans/work-records";
import {
    readOwnedWorkRecord as readWorkRecord,
    listOwnedWorkRecords as listWorkRecords,
    readLocalHomeStore,
    withLocalProjectAction,
} from "../../plan-store/index.ts";
import { ownedWorkRecordFiles, withWorkRecordMutation } from "./owner.ts";
import { requestWorkspaceSearchRefresh } from "../workspace-search-refresh.ts";

export { readWorkRecord, listWorkRecords };

function localFiles(cwd: string) {
    return ownedWorkRecordFiles() ?? workRecordFiles.forCheckout(cwd);
}

export async function readLocalWorkRecord(cwd: string, fileName: string): Promise<WorkRecordResource> {
    const owned = ownedWorkRecordFiles();
    if (owned) return await owned.read(fileName);
    return await readLocalHomeStore(
        cwd,
        () => localFiles(cwd).read(fileName),
        () => {
            throw new Error(`Work Record not found: ${fileName}`);
        },
    );
}

export async function listLocalWorkRecords(
    cwd: string,
    options: ListWorkRecordsOptions = {},
): Promise<WorkRecordResource[]> {
    const owned = ownedWorkRecordFiles();
    if (owned) return await owned.list(options);
    return await readLocalHomeStore(
        cwd,
        () => localFiles(cwd).list({ createDir: false }),
        () => [],
    );
}

export async function findWorkRecordById(cwd: string, recordId: string): Promise<WorkRecordResource | null> {
    const identity = String(recordId).toLowerCase();
    const records = await listWorkRecords(cwd, { createDir: false });
    return records.find((record) => record.attrs.recordId.toLowerCase() === identity) || null;
}

export async function writeWorkRecord(
    cwd: string,
    attrs: WorkRecordFrontMatter,
    body: string,
    options: WriteWorkRecordOptions = {},
): Promise<WorkRecordResource> {
    return await withLocalProjectAction(cwd, () =>
        withWorkRecordMutation(async () => {
            const record = await localFiles(cwd).create(attrs, body, options);
            await requestWorkspaceSearchRefresh(cwd);
            return record;
        }),
    );
}

export async function replaceWorkRecord(
    cwd: string,
    current: WorkRecordResource,
    markdown: string,
): Promise<WorkRecordResource> {
    return await withLocalProjectAction(cwd, () =>
        withWorkRecordMutation(async () => {
            const record = await localFiles(cwd).replace(current, markdown);
            await requestWorkspaceSearchRefresh(cwd);
            return record;
        }),
    );
}

export async function deleteWorkRecord(cwd: string, current: WorkRecordResource): Promise<void> {
    await withLocalProjectAction(cwd, () =>
        withWorkRecordMutation(async () => {
            await localFiles(cwd).delete(current);
            await requestWorkspaceSearchRefresh(cwd);
        }),
    );
}
