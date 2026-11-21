/** Original family controllers stay with the admitted laptop owner during legacy continuation. */
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { HomeProjectOwner } from "../shared/project-identity.ts";
import type { WorktreeRegistryEntry } from "../shared/worktree-registry.ts";
import type { ManagedRuntimeTransfer } from "../shared/project-runtime-managed.ts";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { parsePlanFrontMatter, canonicalizeStoredPlanName } from "../plan-format.ts";
import { getStoredPlanPath } from "../plan-store.ts";
import {
    pickControllerState,
    CONTROLLER_STATE_FIELDS,
    type WorkflowControllerState,
} from "../shared/workflow/controller-state.ts";
import type { ControllerRecord, ControllerWriteOptions } from "./controllers.ts";
import { readControllerRecordAtPath } from "./controllers.ts";
import {
    readRetainedManagedExecution,
    parseRetainedManagedController,
    checkpointRetainedManagedExecution,
} from "./retained-managed-execution.ts";
import { ensurePrivateDir, writeTextAtomically } from "../shared/private-json-file.ts";
import { recoverLegacyPlanControllers } from "./runtime-recovery.ts";
import {
    operationHash,
    operationDigest,
    runReceiptedOperation,
    recoverOperationEffect,
    commitOperationEffect,
} from "./operation-receipts.ts";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
import type { ManagedProjectStoreLaunch } from "../shared/remote/project-store-launch.ts";
export interface RetainedFamilyIdentity {
    planName: string;
    planId?: string;
}
export interface RetainedFamilyMember {
    planName: string;
    planId: string;
    state: WorkflowControllerState;
}
export interface RetainedFamilyRequest {
    executionPlanId: string;
    attemptId: string;
    member: RetainedFamilyIdentity;
}
export interface RetainedFamilyCheckpoint extends RetainedFamilyRequest {
    operationId: string;
    updates: WorkflowControllerState;
    options: ControllerWriteOptions;
}
function directory(owner: HomeProjectOwner) {
    return join(
        owner.executionAccountHome,
        ".wld",
        "projects",
        owner.projectId,
        "internal",
        "retained-family",
        owner.repositoryId,
    );
}
/** This private execution probe reads original document identities, never a mounted personal store. */
export async function inspectRetainedFamilyMember(
    attempt: WorktreeRegistryEntry,
    requested: RetainedFamilyIdentity,
): Promise<RetainedFamilyMember | null> {
    const read = async (name: string) => {
        if (canonicalizeStoredPlanName(name).name !== name) throw new Error("Retained family name is invalid.");
        const path = getStoredPlanPath(attempt.path, name);
        let cursor = attempt.path;
        for (const segment of path.slice(attempt.path.length + 1).split("/")) {
            cursor = join(cursor, segment);
            if ((await lstat(cursor)).isSymbolicLink())
                throw new Error("Retained family document contains a symbolic link.");
        }
        return parsePlanFrontMatter(await readFile(path, "utf8")).attrs;
    };
    const source = await read(attempt.planName);
    const member = await read(requested.planName);
    if (source.planId !== attempt.planId || !member.planId || (requested.planId && member.planId !== requested.planId))
        throw new Error("Retained family document changed identity.");
    if (!(source.parentPlan === requested.planName || (source.parentPlan && member.parentPlan === source.parentPlan)))
        return null;
    return { planName: requested.planName, planId: member.planId, state: pickControllerState(member) };
}
export async function activateManagedFamilyControllers(
    owner: HomeProjectOwner,
    transfer: ManagedRuntimeTransfer,
): Promise<void> {
    const root = directory(owner);
    await assertManagedRuntimePath(root, owner.executionAccountHome);
    for (const file of transfer.files) {
        if (!file.name.startsWith("controller/plans/") || !file.name.endsWith(".json")) continue;
        const record = parseRetainedManagedController(Buffer.from(file.bytes, "base64").toString("utf8"));
        if (!record?.planId) continue;
        // Executing Plans already have their exact attempt-bound controller authority.
        if (await readRetainedManagedExecution(owner, record.planId)) continue;
        const staging = join(
            root,
            "activation",
            `${operationHash(`${transfer.transferId}/${file.checkoutId}/${file.name}`)}.json`,
        );
        const destination = join(root, `${encodeURIComponent(record.planId)}.json`);
        await assertManagedRuntimePath(destination, owner.executionAccountHome);
        writeTextAtomically(staging, `${JSON.stringify(record, null, 2)}\n`);
        await recoverLegacyPlanControllers({ source: staging, destination, archiveRoot: join(root, "recovered") });
    }
}
async function admittedMember(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    request: RetainedFamilyRequest,
    signal?: AbortSignal,
) {
    const execution = await readRetainedManagedExecution(owner, request.executionPlanId, request.attemptId);
    if (!execution || execution.cleanupComplete || execution.abandonmentComplete)
        throw new Error("Original family execution is unavailable.");
    const member = await (
        await import("../shared/remote/project-store-launch.ts")
    ).proveManagedRetainedFamily(launch, execution, request.member, signal);
    if (!member) return null;
    const otherExecution = await readRetainedManagedExecution(owner, member.planId);
    if (otherExecution && otherExecution.planName !== member.planName)
        throw new Error("Retained family member changed its admitted name.");
    return member;
}
export async function readManagedFamilyController(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    request: RetainedFamilyRequest,
    signal?: AbortSignal,
): Promise<ControllerRecord | null> {
    const member = await admittedMember(owner, launch, request, signal);
    if (!member) return null;
    const retained = await readRetainedManagedExecution(owner, member.planId);
    if (retained) return retained.controller;
    await assertManagedRuntimePath(
        join(directory(owner), `${encodeURIComponent(member.planId)}.json`),
        owner.executionAccountHome,
    );
    return await readControllerRecordAtPath(directory(owner), member);
}
export async function checkpointManagedFamilyController(
    owner: HomeProjectOwner,
    launch: ManagedProjectStoreLaunch,
    request: RetainedFamilyCheckpoint,
    signal?: AbortSignal,
) {
    const root = directory(owner);
    await assertManagedRuntimePath(root, owner.executionAccountHome);
    ensurePrivateDir(root);
    const lock = openNativeFileLock(join(root, "family-writes.lock"));
    await lock.lock(true);
    try {
        recoverOperationEffect(root, root);
        const member = await admittedMember(owner, launch, request, signal);
        if (!member) throw new Error("Family checkpoint names an unrelated Plan.");
        const retained = await readRetainedManagedExecution(owner, member.planId);
        if (retained)
            return await checkpointRetainedManagedExecution(
                owner,
                {
                    operationId: request.operationId,
                    planId: retained.planId,
                    attemptId: retained.attempt.id,
                    expectedRevision: operationHash(JSON.stringify(retained.controller)),
                    updates: request.updates,
                    options: request.options,
                },
                launch,
                signal,
            );
        return await runReceiptedOperation(
            root,
            request.operationId,
            operationDigest(JSON.stringify(request)),
            member.planId,
            async () => {
                const before = await readControllerRecordAtPath(root, member);
                if (
                    request.options.expectedRevision !== undefined &&
                    request.options.expectedRevision !== (before?.revision ?? 0)
                )
                    throw new Error("Retained family controller changed.");
                if (
                    Object.keys(request.updates).some(
                        (key) => !CONTROLLER_STATE_FIELDS.some((field) => field === key),
                    ) ||
                    request.options.recovery ||
                    [
                        "documentWorktreeId",
                        "validationCheckpoint",
                        "deliveryEvidence",
                        "publicationReceipt",
                        "verifiedAt",
                        "recordingSource",
                    ].some((key) =>
                        Object.entries(request.updates).some(([field, value]) => field === key && value != null),
                    )
                )
                    throw new Error("Family checkpoint requires its own execution evidence.");
                if (before && request.options.initializeOnly)
                    return { revision: operationHash(JSON.stringify(before)) };
                const controller: ControllerRecord = {
                    version: 1,
                    planId: member.planId,
                    planName: member.planName,
                    revision: (before?.revision ?? 0) + 1,
                    state: { ...(before?.state || member.state), ...pickControllerState(request.updates) },
                };
                const path = join(root, `${encodeURIComponent(member.planId)}.json`);
                await assertManagedRuntimePath(path, owner.executionAccountHome);
                const prior = before ? await readFile(path, "utf8") : null;
                const revision = operationHash(JSON.stringify(controller));
                if (
                    !commitOperationEffect(
                        path,
                        prior,
                        `${JSON.stringify(controller, null, 2)}\n`,
                        revision,
                        undefined,
                        undefined,
                        path,
                    )
                )
                    throw new Error("Family controller lost its retained operation.");
                return { revision };
            },
        );
    } finally {
        lock.close();
    }
}
