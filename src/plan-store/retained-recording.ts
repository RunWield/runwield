/** Recording for an admitted original execution never imports its repository Plan into the catalog. */
import { workRecords, type GeneratedWorkRecordSections } from "@runwield/plans/work-records";
import type { RecordingPreparation } from "@runwield/plans/work-record-files";
import { type HomeProjectOwner } from "@runwield/projects";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import fs from "node:fs/promises";
import type { ManagedProjectStoreLaunch } from "../shared/remote/project-store-launch.ts";
import { readManagedRetainedRecordingProof } from "../shared/remote/project-store-launch.ts";
import { readRetainedManagedExecution, type RetainedManagedExecution } from "./retained-managed-execution.ts";
import { operationHash } from "./operation-receipts.ts";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { writeJsonAtomically } from "../shared/private-json-file.ts";
import { withWorkRecordMutation } from "../shared/work-records/owner.ts";
import {
    readPreparedPackageRecord,
    reservePreparedPackageRecord,
    generatePreparedPackageRecord,
    settlePreparedRecord,
} from "../shared/work-records/package-recording.ts";
import type { WorkRecordSource } from "../shared/work-records/generation.ts";
import type { PublicationAttempt } from "../shared/workflow/publication-attempt.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../shared/work-records/mnemoteca-port.ts";
interface RetainedRecordingIdentity {
    planId: string;
    name: string;
}
interface RetainedRecordingOwner {
    owner: HomeProjectOwner;
    execution: RetainedManagedExecution;
    source: RetainedRecordingIdentity;
}
const recordingOwners = new AsyncLocalStorage<RetainedRecordingOwner>();
function directory(owner: HomeProjectOwner, execution: RetainedManagedExecution): string {
    return join(
        owner.executionAccountHome,
        ".wld",
        "projects",
        owner.projectId,
        "internal",
        "retained-executions",
        owner.repositoryId,
        operationHash(`${execution.checkoutId}/${execution.attempt.id}`),
    );
}
async function readJson<T>(path: string): Promise<T | undefined> {
    const info = await fs.lstat(path).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Retained recording evidence must be a regular file.");
    return await fs
        .readFile(path, "utf8")
        .then((text) => JSON.parse(text))
        .catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
            throw error;
        });
}
export interface RetainedRecordingContext {
    execution: RetainedManagedExecution;
    proof: PublicationAttempt;
    source?: WorkRecordSource;
    preparation?: RecordingPreparation;
    recordCopy?: import("./packages.ts").DeliveryCopy;
}
export async function readRetainedRecordingContext(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    reference: string,
    pendingPublication: boolean,
    signal?: AbortSignal,
): Promise<RetainedRecordingContext | undefined> {
    const execution = await readRetainedManagedExecution(owner, reference);
    if (!execution) return undefined;
    const root = directory(owner, execution);
    await assertManagedRuntimePath(root, owner.executionAccountHome);
    const previous =
        (await readJson<PublicationAttempt>(join(root, "cleanup.json"))) ||
        (await readJson<PublicationAttempt>(join(root, "verified-publication.json")));
    const { proof, sources, recordCopy } = await readManagedRetainedRecordingProof(
        launch,
        execution,
        previous,
        pendingPublication,
        signal,
    );
    const recordingIdentity = await readJson<RetainedRecordingIdentity>(join(root, "record-owner.json"));
    if (
        recordingIdentity &&
        (!sources.workRecordOwner ||
            recordingIdentity.planId !== sources.workRecordOwner.planId ||
            recordingIdentity.name !== sources.workRecordOwner.name)
    )
        throw new Error("Retained recording owner changed after preparation.");
    const workRecord = await readJson<import("@runwield/plans").PlanFrontMatter["workRecord"]>(
        join(root, "record-link.json"),
    );
    const source = sources.workRecordOwner
        ? {
              ...sources.workRecordOwner,
              recordingAttemptId: execution.attempt.id,
              pendingPublication,
              attrs: {
                  ...sources.workRecordOwner.attrs,
                  ...(sources.workRecordOwner.planId === execution.planId ? execution.controller.state : {}),
                  workRecord,
              },
          }
        : undefined;
    return {
        execution,
        proof,
        source,
        recordCopy: recordCopy ?? undefined,
        preparation: (await readPreparedPackageRecord(execution.attempt.id)) ?? undefined,
    };
}
/** The canonical generator records provenance bookkeeping with the same owner as the retained controller. */
export async function recordRetainedRecordingBacklink(
    source: import("./recording.ts").PlanRecordingSource,
    workRecord: import("@runwield/plans").PlanFrontMatter["workRecord"],
): Promise<boolean> {
    const context = recordingOwners.getStore();
    if (!context) return false;
    if (
        source.planId !== context.source.planId ||
        source.name !== context.source.name ||
        source.recordingAttemptId !== context.execution.attempt.id
    )
        throw new Error("Recording backlink changed retained ownership.");
    const path = join(directory(context.owner, context.execution), "record-link.json");
    await assertManagedRuntimePath(path, context.owner.executionAccountHome);
    await withWorkRecordMutation(() => Promise.resolve(writeJsonAtomically(path, workRecord)));
    return true;
}
export async function prepareRetainedRecord(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    reference: string,
    attemptId: string,
    expectedRevision: string,
    pendingPublication: boolean,
    sections: GeneratedWorkRecordSections | null,
    signal?: AbortSignal,
) {
    return await withWorkRecordMutation(async () => {
        const context = await readRetainedRecordingContext(owner, launch, reference, pendingPublication, signal);
        if (!context?.source || context.execution.attempt.id !== attemptId)
            throw new Error("Retained recording source is unavailable or changed.");
        if (operationHash(JSON.stringify(context.execution.controller)) !== expectedRevision)
            throw new Error("Retained recording controller changed before preparation.");
        const identityPath = join(directory(owner, context.execution), "record-owner.json");
        await assertManagedRuntimePath(identityPath, owner.executionAccountHome);
        const sourceIdentity = { planId: context.source.planId, name: context.source.name };
        writeJsonAtomically(identityPath, sourceIdentity);
        const prepared = await reservePreparedPackageRecord(attemptId);
        if (sections) {
            const outcome = await recordingOwners.run(
                { owner, execution: context.execution, source: sourceIdentity },
                () =>
                    generatePreparedPackageRecord(owner.executionAccountHome, context.source!, attemptId, {
                        mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                        runRecorderStep: () => Promise.resolve(sections),
                    }),
            );
            if (outcome.status !== "generated" && outcome.status !== "linked")
                throw new Error("Retained canonical recording remains pending.");
        }
        return { revision: operationHash(JSON.stringify(context.execution.controller)), recordId: prepared.recordId };
    });
}
export async function settleRetainedRecord(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    reference: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    return await withWorkRecordMutation(async () => {
        const context = await readRetainedRecordingContext(owner, launch, reference, false, signal);
        if (!context?.preparation?.record) return undefined;
        if (context.proof.retainedPublicationPolicy?.workRecords) {
            const frozen = context.preparation.record;
            const { approveWorkRecord } = await import("../shared/work-records/lifecycle.ts");
            const parsed = workRecords.documents.parse(frozen.text);
            const expected = workRecords.documents.format(approveWorkRecord(parsed.attrs), parsed.body);
            if (!context.recordCopy || context.recordCopy.path !== frozen.path || context.recordCopy.text !== expected)
                throw new Error("Retained delivered record differs from its canonical preparation.");
            const { retainWorkRecordLocation, workRecordDigest } = await import("../shared/work-records/import.ts");
            await retainWorkRecordLocation(parsed.attrs.recordId, {
                kind: "copy",
                sourcePath: join(launch.cwd, context.recordCopy.path),
                repositoryId: owner.repositoryId,
                repositoryPath: context.recordCopy.path,
                digest: workRecordDigest(context.recordCopy.text),
            });
        }
        return await settlePreparedRecord(
            owner.executionAccountHome,
            {
                attemptId: context.execution.attempt.id,
                repositoryId: owner.repositoryId,
                preparedRecord: context.preparation.record,
                copies: [],
            },
            SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        );
    });
}
