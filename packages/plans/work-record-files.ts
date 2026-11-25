import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { join } from "node:path";
import {
    canonicalFiles,
    canonicalFileName,
    type ListWorkRecordsOptions,
    type WriteWorkRecordOptions,
    CHECKOUT_RECORD_DIRECTORY,
} from "./work-records/canonical-files.ts";
import type { WorkRecordFrontMatter, WorkRecordResource } from "./work-records/documents.ts";
import { retainedFiles } from "./work-records/retained-files.ts";

export { WorkRecordReadError } from "./work-records/canonical-files.ts";
export type { ListWorkRecordsOptions, WriteWorkRecordOptions } from "./work-records/canonical-files.ts";
export type { RecordingPreparation, WorkRecordLocation, WorkRecordLocations } from "./work-records/retained-files.ts";

function forOwner(owner: ProjectStoreIdentity) {
    if (owner.personalOwner.kind !== "execution-account")
        throw new Error("Work Records require a locally admitted personal owner.");
    const identity = structuredClone(owner);
    const home = identity.executionAccountHome;
    const root = join(home, ".wld", "projects", identity.projectId);
    const records = join(root, "work-records");
    const internal = join(root, "internal", "work-records");
    const retained = retainedFiles(identity, internal);
    const canonical = canonicalFiles(root, records, home);
    return {
        get layout() {
            projects.home.assertStoreIdentity(identity);
            return { root, records, internal };
        },
        async read(fileName: string) {
            projects.home.assertStoreIdentity(identity);
            return await canonical.read(fileName);
        },
        async list(options?: ListWorkRecordsOptions) {
            projects.home.assertStoreIdentity(identity);
            return await canonical.list(options);
        },
        async create(attrs: WorkRecordFrontMatter, body: string, options?: WriteWorkRecordOptions) {
            return await retained.mutate(async () => {
                const pending = await canonical.prepareCreation(attrs, body, options);
                await retained.forgetLocations(pending.recordId);
                return await pending.publish();
            });
        },
        async replace(current: WorkRecordResource, markdown: string) {
            return await retained.mutate(() => canonical.replace(current, markdown));
        },
        async delete(current: WorkRecordResource) {
            return await retained.mutate(() => canonical.delete(current));
        },
        ...retained,
    };
}

function forCheckout(cwd: string) {
    const directory = join(cwd, CHECKOUT_RECORD_DIRECTORY);
    const canonical = canonicalFiles(cwd, directory);
    return {
        read: canonical.read,
        list: canonical.list,
        create: canonical.create,
        replace: canonical.replace,
        delete: canonical.delete,
    };
}

export const workRecordFiles = { forOwner, forCheckout, fileName: canonicalFileName };
