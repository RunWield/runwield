import type { HostRecorderState } from "./validation-checkpoint.ts";
import { projects, type ProjectStoreIdentity } from "@runwield/projects";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { CreateProjectWorkRecord, ProjectWorkRecords } from "./store.ts";
import {
    canonicalFiles,
    canonicalFileName,
    type ListWorkRecordsOptions,
    type WriteWorkRecordOptions,
    CHECKOUT_RECORD_DIRECTORY,
} from "./work-records/canonical-files.ts";
import { creationReceipts, type WorkRecordCreationOperation } from "./work-records/creation-receipts.ts";
import {
    documents,
    isWorkRecordId,
    type ProjectWorkRecord,
    type WorkRecordFrontMatter,
    type WorkRecordResource,
} from "./work-records/documents.ts";
import { retainedFiles } from "./work-records/retained-files.ts";

export { WorkRecordReadError } from "./work-records/canonical-files.ts";
export type { ListWorkRecordsOptions, WriteWorkRecordOptions } from "./work-records/canonical-files.ts";
export type { WorkRecordCreationOperation } from "./work-records/creation-receipts.ts";
export type { RecordingPreparation, WorkRecordLocation, WorkRecordLocations } from "./work-records/retained-files.ts";

type WorkRecordCreationFields = Omit<WorkRecordFrontMatter, "recordId">;
type WorkRecordCreationOptions = Pick<WriteWorkRecordOptions, "fileName">;

interface RecordingPublication {
    record: WorkRecordResource;
    disposition: "created" | "existing";
}

export interface WorkRecordCreation {
    readonly recordId: string;
    create(
        attrs: WorkRecordCreationFields,
        body: string,
        options?: WorkRecordCreationOptions,
    ): Promise<RecordingPublication>;
}

/** Filesystem Work Record collection for an admitted personal owner. */
export interface OwnedProjectWorkRecords extends ProjectWorkRecords {
    /** Create once for a retained request and return its saved document on retry. */
    createOperationRecord(
        input: CreateProjectWorkRecord,
        operation: WorkRecordCreationOperation,
    ): Promise<ProjectWorkRecord>;
    /** Read the original creation result from its completed receipt, even after changes to the record. */
    readOperationRecord(operation: WorkRecordCreationOperation): Promise<ProjectWorkRecord | null>;
}

const creationFields = new Set<keyof CreateProjectWorkRecord>([
    "body",
    "status",
    "scope",
    "workKind",
    "origin",
    "completionMode",
    "createdAt",
    "tickets",
    "supersedes",
    "supersessionProposal",
    "provenance",
]);

export function validateWorkRecordCreation(input: CreateProjectWorkRecord): void {
    for (const field of Object.keys(input))
        if (!creationFields.has(field as keyof CreateProjectWorkRecord))
            throw new Error(`Work Record creation cannot set protected field: ${field}`);
    if (typeof input.body !== "string" || /^\s*\ufeff?---\s*\r?\n/.test(input.body))
        throw new Error("Work Record creation requires a Markdown body without front matter.");
    if (
        input.createdAt !== undefined &&
        (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt)))
    )
        throw new Error("Work Record creation requires a valid createdAt timestamp.");
}

function recordingCreation(
    recordId: string,
    publish: (...args: Parameters<ReturnType<typeof canonicalFiles>["restoreRecord"]>) => Promise<RecordingPublication>,
): WorkRecordCreation {
    if (!isWorkRecordId(recordId)) throw new Error("Invalid Work Record identity.");
    return {
        recordId,
        async create(attrs, body, options) {
            return await publish({ ...attrs, recordId }, body, { fileName: options?.fileName });
        },
    };
}

async function existingRecording(canonical: ReturnType<typeof canonicalFiles>, attrs: WorkRecordFrontMatter) {
    const sameId = (await canonical.list({ createDir: false })).filter(
        (record) => record.attrs.recordId.toLowerCase() === attrs.recordId.toLowerCase(),
    );
    const record = sameId[0];
    if (!record) return undefined;
    const sourcePlans = attrs.provenance?.sourcePlans ?? [];
    const retainedPlans = record.attrs.provenance?.sourcePlans ?? [];
    if (
        sameId.length > 1 ||
        record.attrs.origin !== "internal" ||
        (record.attrs.status !== "approved" &&
            !(attrs.status === "pending_verification" && record.attrs.status === "pending_verification")) ||
        record.attrs.scope !== attrs.scope ||
        record.attrs.completionMode !== attrs.completionMode ||
        record.attrs.archivedAt ||
        record.attrs.supersededBy ||
        !sourcePlans.length ||
        sourcePlans.length !== retainedPlans.length ||
        sourcePlans.some((id) => !retainedPlans.includes(id))
    )
        throw new Error("Reserved Work Record identity belongs to a different recording.");
    return record;
}

function authoredRecord(input: CreateProjectWorkRecord) {
    validateWorkRecordCreation(input);
    const { body, createdAt, ...metadata } = input;
    const date = createdAt === undefined ? new Date() : new Date(createdAt);
    const attrs: WorkRecordFrontMatter = {
        ...metadata,
        kind: "work_record",
        recordId: randomUUID(),
        createdAt: date.toISOString(),
    };
    const title = body.trimStart().match(/^#\s+(.+)$/m)?.[1] || attrs.recordId;
    return { attrs, body, fileName: canonicalFileName(title, date) };
}

async function listDocuments(canonical: ReturnType<typeof canonicalFiles>): Promise<ProjectWorkRecord[]> {
    return (await canonical.list({ createDir: false })).map(documents.toProjectDocument);
}

/** Open the filesystem driver for an admitted personal Project owner. */
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
    const receipts = creationReceipts(home, internal);

    async function recoverCreation() {
        const pending = await receipts.readPending();
        if (!pending) return;
        if (!(await receipts.readCompleted(pending))) {
            const intended = await canonical.decode(pending.fileName, pending.markdown);
            const existing = (await canonical.list({ createDir: false })).filter(
                (record) => record.attrs.recordId.toLowerCase() === intended.attrs.recordId.toLowerCase(),
            );
            if (existing.length > 1 || (existing[0] && existing[0].markdown !== intended.markdown))
                throw new Error("Canonical Work Record conflicts with retained creation evidence.");
            const record = existing[0] ?? (await publishRestored(intended.attrs, intended.body, pending));
            await receipts.settle(pending, basename(record.path));
        }
        await receipts.clearPending();
    }

    async function mutateCanonical<Result>(action: () => Promise<Result>): Promise<Result> {
        return await retained.mutate(async () => {
            // Settle a published creation before another writer can change or delete its file.
            await recoverCreation();
            return await action();
        });
    }

    async function publishRestored(attrs: WorkRecordFrontMatter, body: string, options?: WriteWorkRecordOptions) {
        const pending = await canonical.prepareCreation(attrs, body, options);
        await retained.forgetLocations(pending.recordId);
        return await pending.publish();
    }

    async function restoreRecord(attrs: WorkRecordFrontMatter, body: string, options?: WriteWorkRecordOptions) {
        return await mutateCanonical(() => publishRestored(attrs, body, options));
    }

    async function publishRecording(
        attrs: WorkRecordFrontMatter,
        body: string,
        options?: WriteWorkRecordOptions,
    ): Promise<RecordingPublication> {
        return await mutateCanonical(async () => {
            const existing = await existingRecording(canonical, attrs);
            return existing
                ? { record: existing, disposition: "existing" }
                : { record: await publishRestored(attrs, body, options), disposition: "created" };
        });
    }

    async function readOperationRecord(operation: WorkRecordCreationOperation): Promise<ProjectWorkRecord | null> {
        projects.home.assertStoreIdentity(identity);
        const receipt = await receipts.readCompleted(operation);
        return receipt && documents.toProjectDocument(await canonical.decode(receipt.fileName, receipt.markdown));
    }

    async function listProjectDocuments(): Promise<ProjectWorkRecord[]> {
        projects.home.assertStoreIdentity(identity);
        return await listDocuments(canonical);
    }

    const workRecords: OwnedProjectWorkRecords = {
        list: listProjectDocuments,
        async read(recordId) {
            return documents.findById(await listProjectDocuments(), recordId);
        },
        async create(input) {
            const { attrs, body, fileName } = authoredRecord(input);
            const record = await mutateCanonical(() => publishRestored(attrs, body, { fileName }));
            return documents.toProjectDocument(record);
        },
        async createOperationRecord(input, operation) {
            return await mutateCanonical(async () => {
                const prior = await readOperationRecord(operation);
                if (prior) return prior;
                const { attrs, body, fileName } = authoredRecord(input);
                const pending = await canonical.prepareCreation(attrs, body, { fileName });
                const receipt = await receipts.retainPending(operation, fileName, pending.record.markdown);
                await retained.forgetLocations(pending.recordId);
                const record = await pending.publish();
                await receipts.settle(receipt, basename(record.path));
                await receipts.clearPending();
                return documents.toProjectDocument(record);
            });
        },
        readOperationRecord,
    };

    return {
        workRecords,
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
        async readRecordingCreation(attemptId: string) {
            return (await retained.readRecordingCreation(attemptId))?.recordId ?? null;
        },
        restoreRecordingCheckpoint(attemptId: string, checkpoint: HostRecorderState) {
            return retained.reserveRecordingCreation(attemptId, checkpoint.recordId);
        },
        async beginRecordingCreation(attemptId: string) {
            const preparation = await retained.reserveRecordingCreation(attemptId);
            return recordingCreation(preparation.recordId, publishRecording);
        },
        async resumePreparedRecordingCreation(attemptId: string) {
            const preparation = await retained.readPreparation(attemptId);
            if (!preparation) throw new Error("Recording preparation is missing.");
            return recordingCreation(preparation.recordId, publishRecording);
        },
        reservePreparation(attemptId: string) {
            return retained.reservePreparation(attemptId);
        },
        restorePreparationCheckpoint(attemptId: string, checkpoint: HostRecorderState) {
            return retained.reservePreparation(attemptId, checkpoint.recordId);
        },
        restoreRecord,
        async replace(current: WorkRecordResource, markdown: string) {
            return await mutateCanonical(() => canonical.replace(current, markdown));
        },
        async delete(current: WorkRecordResource) {
            return await mutateCanonical(() => canonical.delete(current));
        },
        mutate: mutateCanonical,
        readLocations: retained.readLocations,
        retainLocation: retained.retainLocation,
        forgetLocations: retained.forgetLocations,
        readPreparation: retained.readPreparation,
        writePreparation: retained.writePreparation,
        listPreparationAttempts: retained.listPreparationAttempts,
    };
}

/** Open checkout files for the host's retained checkout routes. */
function forCheckout(cwd: string) {
    const directory = join(cwd, CHECKOUT_RECORD_DIRECTORY);
    const canonical = canonicalFiles(cwd, directory);

    function checkoutRetainedFiles() {
        const inspected = projects.checkout.inspect(cwd);
        if (inspected.kind !== "existing") throw new Error("Work Record creation requires an admitted checkout.");
        const identity = inspected.identity;
        const internal = join(
            identity.executionAccountHome,
            ".wld",
            "projects",
            identity.projectId,
            "internal",
            "work-records",
            "retained-checkouts",
            identity.checkoutId,
        );
        return retainedFiles(identity, internal);
    }

    const workRecords: Pick<ProjectWorkRecords, "list" | "read"> = {
        list: () => listDocuments(canonical),
        async read(recordId) {
            return documents.findById(await listDocuments(canonical), recordId);
        },
    };

    return {
        workRecords,
        read: canonical.read,
        list: canonical.list,
        async readRecordingCreation(attemptId: string) {
            return (await checkoutRetainedFiles().readRecordingCreation(attemptId))?.recordId ?? null;
        },
        restoreRecordingCheckpoint(attemptId: string, checkpoint: HostRecorderState) {
            return checkoutRetainedFiles().reserveRecordingCreation(attemptId, checkpoint.recordId);
        },
        async beginRecordingCreation(attemptId: string) {
            const retained = checkoutRetainedFiles();
            const preparation = await retained.reserveRecordingCreation(attemptId);
            return recordingCreation(preparation.recordId, (attrs, body, options) =>
                retained.mutate(async () => {
                    const existing = await existingRecording(canonical, attrs);
                    return existing
                        ? { record: existing, disposition: "existing" }
                        : { record: await canonical.restoreRecord(attrs, body, options), disposition: "created" };
                }),
            );
        },
        restoreRecord: canonical.restoreRecord,
        replace: canonical.replace,
        delete: canonical.delete,
    };
}

/** Open Work Record storage or derive a canonical Markdown filename. */
export const workRecordFiles = { forOwner, forCheckout, fileName: canonicalFileName };
