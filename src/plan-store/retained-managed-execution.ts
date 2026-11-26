/** Retained execution ownership is separate from canonical Plan catalog membership. */
import { projects, type HomeProjectOwner } from "@runwield/projects";
import { join, dirname } from "node:path";
import fs from "node:fs/promises";
import type { ManagedRuntimeTransfer } from "../shared/project-runtime-managed.ts";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { operationHash } from "./operation-receipts.ts";
import type { ControllerRecord } from "./controllers.ts";
import type { WorktreeRegistryEntry } from "../shared/worktree-registry.ts";
import { ensurePrivateDir, writeJsonAtomically, writeTextAtomically } from "../shared/private-json-file.ts";
import { assertPublicationAttempt, type PublicationAttempt } from "@runwield/workflow/publication";
import { recoverLegacyPlanControllers } from "./runtime-recovery.ts";

export interface RetainedManagedExecution {
    projectId: string;
    repositoryId: string;
    personalOwner: string;
    checkoutId: string;
    planId: string;
    planName: string;
    attempt: WorktreeRegistryEntry;
    controller: ControllerRecord;
    cleanupComplete?: boolean;
    abandonmentComplete?: boolean;
}
interface RetainedExecutionBinding extends Omit<RetainedManagedExecution, "controller"> {
    version: 1;
    transferId: string;
}
function root(owner: HomeProjectOwner): string {
    projects.home.assertStoreIdentity(owner);
    return join(
        owner.executionAccountHome,
        ".wld",
        "projects",
        owner.projectId,
        "internal",
        "retained-executions",
        owner.repositoryId,
    );
}
export function parseRetainedManagedController(text: string): ControllerRecord | undefined {
    try {
        const record: ControllerRecord = JSON.parse(text);
        return record.version === 1 &&
            Number.isSafeInteger(record.revision) &&
            record.revision >= 0 &&
            typeof record.planName === "string" &&
            record.state &&
            typeof record.state === "object" &&
            !Array.isArray(record.state)
            ? record
            : undefined;
    } catch {
        return undefined;
    }
}
/** Inspect identities before source retirement; malformed bytes stay preserved but never become authority. */
export function managedRuntimeContinuations(transfer: ManagedRuntimeTransfer): RetainedManagedExecution[] {
    const continuations: RetainedManagedExecution[] = [];
    for (const file of transfer.files) {
        if (!file.name.startsWith("controller/plans/") || !file.name.endsWith(".json")) continue;
        const controller = parseRetainedManagedController(Buffer.from(file.bytes, "base64").toString("utf8"));
        if (!controller) continue;
        const matching = transfer.attempts.filter(
            ({ checkoutId, layout, entry }) =>
                checkoutId === file.checkoutId &&
                layout === file.layout &&
                (controller.planId ? entry.planId === controller.planId : entry.planName === controller.planName) &&
                !["validated", "abandoned"].includes(entry.status),
        );
        if (!matching.length) {
            if (controller.recovery?.worktreeId || controller.state.documentWorktreeId)
                throw new Error("Retained controller has no matching execution registry owner.");
            continue;
        }
        if (matching.length !== 1) throw new Error("Retained execution ownership is ambiguous; preserve its sources.");
        const attempt = matching[0].entry;
        if (
            !attempt.planId ||
            attempt.planName !== controller.planName ||
            (controller.state.documentWorktreeId && controller.state.documentWorktreeId !== attempt.id) ||
            (controller.recovery?.worktreeId && controller.recovery.worktreeId !== attempt.id) ||
            (controller.state.validationCheckpoint && controller.state.validationCheckpoint.attemptId !== attempt.id)
        )
            throw new Error("Retained controller belongs to another execution attempt.");
        continuations.push({
            projectId: transfer.projectId,
            repositoryId: transfer.repositoryId,
            personalOwner: transfer.personalOwner,
            checkoutId: file.checkoutId,
            planId: attempt.planId,
            planName: controller.planName,
            attempt,
            controller: { ...controller, planId: attempt.planId },
        });
    }
    const identities = continuations.map((entry) => `${entry.checkoutId}/${entry.attempt.id}`);
    if (new Set(identities).size !== identities.length)
        throw new Error("Retained execution has conflicting controller sources.");
    return continuations;
}
function sameRetainedExecution(left: RetainedExecutionBinding, right: RetainedManagedExecution): boolean {
    return (
        left.projectId === right.projectId &&
        left.repositoryId === right.repositoryId &&
        left.planId === right.planId &&
        left.planName === right.planName &&
        left.personalOwner === right.personalOwner &&
        left.checkoutId === right.checkoutId &&
        (
            ["id", "planId", "planName", "path", "branch", "baseBranch", "baseRef", "baseCommit", "baseTree"] as const
        ).every((field) => left.attempt[field] === right.attempt[field])
    );
}
/** Validate against earlier generations before acknowledging bytes that permit source retirement. */
export async function validateManagedRuntimeContinuations(
    owner: HomeProjectOwner,
    transfer: ManagedRuntimeTransfer,
): Promise<void> {
    for (const continuation of managedRuntimeContinuations(transfer)) {
        const path = join(
            root(owner),
            operationHash(`${continuation.checkoutId}/${continuation.attempt.id}`),
            "binding.json",
        );
        await assertManagedRuntimePath(path, owner.executionAccountHome);
        const prior: RetainedExecutionBinding | undefined = await fs
            .readFile(path, "utf8")
            .then((text) => JSON.parse(text))
            .catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            });
        if (prior && !sameRetainedExecution(prior, continuation))
            throw new Error("Retained execution ownership changed before source retirement.");
    }
}
/** Activation reuses native controller reconciliation and preserves immutable transfer bytes. */
export async function activateManagedRuntimeContinuations(
    owner: HomeProjectOwner,
    transfer: ManagedRuntimeTransfer,
): Promise<void> {
    await validateManagedRuntimeContinuations(owner, transfer);
    for (const continuation of managedRuntimeContinuations(transfer)) {
        const directory = join(root(owner), operationHash(`${continuation.checkoutId}/${continuation.attempt.id}`));
        await assertManagedRuntimePath(directory, owner.executionAccountHome);
        ensurePrivateDir(directory);
        const staging = join(directory, "activation", `${transfer.transferId}.json`);
        const destination = join(directory, "controller.json");
        writeTextAtomically(staging, `${JSON.stringify(continuation.controller, null, 2)}\n`);
        await recoverLegacyPlanControllers({ source: staging, destination, archiveRoot: join(directory, "recovered") });
        const { controller: _controller, ...identity } = continuation;
        const binding: RetainedExecutionBinding = { ...identity, version: 1, transferId: transfer.transferId };
        const path = join(directory, "binding.json");
        const prior: RetainedExecutionBinding | undefined = await fs
            .readFile(path, "utf8")
            .then((text) => JSON.parse(text))
            .catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            });
        if (prior && !sameRetainedExecution(prior, continuation))
            throw new Error("Retained execution ownership changed during activation.");
        if (!prior) writeJsonAtomically(path, binding);
    }
}
export async function readRetainedManagedExecution(
    owner: HomeProjectOwner,
    reference: string,
    attemptId?: string,
): Promise<RetainedManagedExecution | undefined> {
    const directory = root(owner);
    await assertManagedRuntimePath(directory, owner.executionAccountHome);
    const entries = await fs.readdir(directory).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    });
    const matches: RetainedManagedExecution[] = [];
    for (const entry of entries) {
        if (!/^[a-f0-9]{64}$/.test(entry)) continue;
        const path = join(directory, entry, "binding.json");
        await assertManagedRuntimePath(path, owner.executionAccountHome);
        const binding: RetainedExecutionBinding = JSON.parse(await fs.readFile(path, "utf8"));
        if (
            binding.projectId !== owner.projectId ||
            binding.repositoryId !== owner.repositoryId ||
            binding.personalOwner !== owner.personalOwner.identity
        )
            throw new Error("Retained execution belongs to another owner.");
        if (![binding.planId, binding.planName].includes(reference) || (attemptId && binding.attempt.id !== attemptId))
            continue;
        const controllerPath = join(dirname(path), "controller.json");
        await assertManagedRuntimePath(controllerPath, owner.executionAccountHome);
        const controller = parseRetainedManagedController(await fs.readFile(controllerPath, "utf8"));
        if (!controller || controller.planId !== binding.planId || controller.planName !== binding.planName)
            throw new Error("Retained execution controller is unavailable.");
        const cleanupPath = join(dirname(path), "cleanup.json");
        await assertManagedRuntimePath(cleanupPath, owner.executionAccountHome);
        const cleanup: PublicationAttempt | undefined = await fs
            .readFile(cleanupPath, "utf8")
            .then((text) => JSON.parse(text))
            .catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            });
        if (cleanup) {
            assertPublicationAttempt(cleanup);
            if (
                cleanup.phase !== "cleanup_complete" ||
                cleanup.planId !== binding.planId ||
                cleanup.planName !== binding.planName ||
                cleanup.attemptId !== binding.attempt.id ||
                cleanup.executionCwd !== binding.attempt.path ||
                cleanup.executionBranch !== binding.attempt.branch
            )
                throw new Error("Retained cleanup proof belongs to another execution.");
        }
        const abandonmentPath = join(dirname(path), "abandonment.json");
        await assertManagedRuntimePath(abandonmentPath, owner.executionAccountHome);
        const abandonment: RetainedAbandonment | undefined = await fs
            .readFile(abandonmentPath, "utf8")
            .then((text) => JSON.parse(text))
            .catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
                throw error;
            });
        if (
            abandonment &&
            (abandonment.planId !== binding.planId ||
                abandonment.proof.request.planId !== binding.planId ||
                abandonment.proof.request.attemptId !== binding.attempt.id ||
                abandonment.proof.request.projectId !== binding.projectId ||
                abandonment.proof.request.repositoryId !== binding.repositoryId ||
                abandonment.proof.request.personalOwner !== binding.personalOwner ||
                abandonment.proof.request.planName !== binding.planName ||
                abandonment.proof.entry.planId !== binding.planId ||
                abandonment.proof.entry.planName !== binding.planName ||
                abandonment.proof.request.purpose !== "abandoned" ||
                abandonment.proof.entry.id !== binding.attempt.id ||
                abandonment.proof.entry.path !== binding.attempt.path ||
                abandonment.proof.entry.branch !== binding.attempt.branch ||
                abandonment.proof.entry.status !== "abandoned")
        )
            throw new Error("Retained abandonment belongs to another execution.");
        const cleanupComplete = Boolean(cleanup);
        matches.push({
            ...binding,
            controller,
            cleanupComplete,
            abandonmentComplete: Boolean(abandonment && !controller.state.documentWorktreeId && !controller.recovery),
        });
    }
    if (matches.length > 1) throw new Error("Retained execution ownership is ambiguous.");
    return matches[0];
}

export interface RetainedControllerCheckpoint {
    operationId: string;
    planId: string;
    attemptId: string;
    expectedRevision: string;
    updates: import("@runwield/plans/controller-state").WorkflowControllerState;
    options: import("./controllers.ts").ControllerWriteOptions;
}
/** A retained execution writes only its admitted laptop controller under a native owner lock. */
export async function checkpointRetainedManagedExecution(
    owner: HomeProjectOwner,
    checkpoint: RetainedControllerCheckpoint,
    launch?: import("../shared/remote/project-store-launch.ts").ManagedProjectStoreLaunch,
    signal?: AbortSignal,
) {
    const { openNativeFileLock } = await import("../shared/native-file-lock.ts");
    const { recoverOperationEffect, runReceiptedOperation, operationDigest, commitOperationEffect } =
        await import("./operation-receipts.ts");
    const { pickControllerState, CONTROLLER_STATE_FIELDS } = await import("@runwield/plans/controller-state");
    const { StaleControllerWriteError } = await import("./controllers.ts");
    const directory = root(owner);
    await assertManagedRuntimePath(directory, owner.executionAccountHome);
    ensurePrivateDir(directory);
    const lock = openNativeFileLock(join(directory, "controller-writes.lock"));
    await lock.lock(true);
    try {
        recoverOperationEffect(directory, directory);
        return await runReceiptedOperation(
            directory,
            checkpoint.operationId,
            operationDigest(
                JSON.stringify({
                    projectId: owner.projectId,
                    repositoryId: owner.repositoryId,
                    personalOwner: owner.personalOwner.identity,
                    checkpoint,
                }),
            ),
            checkpoint.planId,
            async () => {
                let retained = await readRetainedManagedExecution(owner, checkpoint.planId, checkpoint.attemptId);
                if (!retained) throw new Error("Retained execution is unavailable.");
                const path = join(
                    directory,
                    operationHash(`${retained.checkoutId}/${retained.attempt.id}`),
                    "controller.json",
                );
                await assertManagedRuntimePath(path, owner.executionAccountHome);
                const controllerLock = openNativeFileLock(`${path}.lock`);
                await controllerLock.lock(true);
                try {
                    retained = await readRetainedManagedExecution(owner, checkpoint.planId, checkpoint.attemptId);
                    if (!retained) throw new Error("Retained execution is unavailable.");
                    const before = retained.controller;
                    if (
                        operationHash(JSON.stringify(before)) !== checkpoint.expectedRevision ||
                        (checkpoint.options.expectedRevision !== undefined &&
                            checkpoint.options.expectedRevision !== before.revision)
                    )
                        throw new StaleControllerWriteError();
                    if (
                        Object.keys(checkpoint.updates).some(
                            (key) => !CONTROLLER_STATE_FIELDS.some((field) => field === key),
                        )
                    )
                        throw new Error("Unsupported retained execution checkpoint.");
                    if (
                        (checkpoint.updates.documentWorktreeId &&
                            checkpoint.updates.documentWorktreeId !== retained.attempt.id) ||
                        (checkpoint.updates.validationCheckpoint &&
                            checkpoint.updates.validationCheckpoint.attemptId !== retained.attempt.id) ||
                        (checkpoint.options.recovery?.worktreeId &&
                            checkpoint.options.recovery.worktreeId !== retained.attempt.id)
                    )
                        throw new Error("Controller checkpoint belongs to another execution attempt.");
                    if (checkpoint.updates.documentWorktreeId && !before.state.documentWorktreeId) {
                        if (!launch) throw new Error("Reselecting retained execution requires its trusted launcher.");
                        const proof = await (
                            await import("../shared/remote/project-store-launch.ts")
                        ).proveManagedExecutionRecovery(
                            launch,
                            {
                                projectId: owner.projectId,
                                repositoryId: owner.repositoryId,
                                personalOwner: owner.personalOwner.identity,
                                planId: retained.planId,
                                planName: retained.planName,
                                attemptId: retained.attempt.id,
                                purpose: "active",
                            },
                            signal,
                        );
                        if (
                            proof.entry.path !== retained.attempt.path ||
                            proof.entry.branch !== retained.attempt.branch
                        )
                            throw new Error("Retained recovery changed execution identity.");
                    }
                    if (
                        before.state.documentWorktreeId &&
                        Object.hasOwn(checkpoint.updates, "documentWorktreeId") &&
                        !checkpoint.updates.documentWorktreeId &&
                        !before.state.verifiedAt
                    ) {
                        if (!launch) throw new Error("Retained abandonment requires its trusted launcher.");
                        const proof = await (
                            await import("../shared/remote/project-store-launch.ts")
                        ).proveManagedExecutionRecovery(
                            launch,
                            {
                                projectId: owner.projectId,
                                repositoryId: owner.repositoryId,
                                personalOwner: owner.personalOwner.identity,
                                planId: retained.planId,
                                planName: retained.planName,
                                attemptId: retained.attempt.id,
                                purpose: "abandoned",
                            },
                            signal,
                        );
                        if (
                            proof.entry.path !== retained.attempt.path ||
                            proof.entry.branch !== retained.attempt.branch
                        )
                            throw new Error("Retained abandonment changed execution identity.");
                    }
                    if (
                        ["verifiedAt", "publicationReceipt", "deliveryEvidence", "recordingSource"].some((key) =>
                            Object.entries(checkpoint.updates).some(([field, value]) => field === key && value != null),
                        )
                    ) {
                        if (!launch) throw new Error("Retained publication requires its trusted execution launcher.");
                        const { proveManagedRetainedPublication } =
                            await import("../shared/remote/project-store-launch.ts");
                        const proofPath = join(
                            directory,
                            operationHash(`${retained.checkoutId}/${retained.attempt.id}`),
                            "verified-publication.json",
                        );
                        await assertManagedRuntimePath(proofPath, owner.executionAccountHome);
                        const previous: PublicationAttempt | undefined = await fs
                            .readFile(proofPath, "utf8")
                            .then((text) => JSON.parse(text))
                            .catch((error) => {
                                if (error instanceof Error && "code" in error && error.code === "ENOENT")
                                    return undefined;
                                throw error;
                            });
                        const candidateOnly =
                            !checkpoint.updates.verifiedAt &&
                            !checkpoint.updates.publicationReceipt &&
                            !checkpoint.updates.recordingSource;
                        const proof = await proveManagedRetainedPublication(
                            launch,
                            retained,
                            previous,
                            signal,
                            candidateOnly,
                        );
                        const receipt = checkpoint.updates.publicationReceipt;
                        const recording = checkpoint.updates.recordingSource;
                        const delivery = checkpoint.updates.deliveryEvidence;
                        if (
                            (receipt &&
                                (receipt.validatedCommit !== proof.validatedCommit ||
                                    receipt.publishedCommit !== proof.publishedCommit ||
                                    receipt.targetBranch !== proof.targetBranch)) ||
                            (recording &&
                                (recording.planId !== retained.planId ||
                                    recording.planName !== retained.planName ||
                                    ![proof.publishedCommit, proof.artifactCommit, proof.validatedCommit].includes(
                                        recording.commit,
                                    ))) ||
                            (delivery &&
                                (delivery.mode !== "worktree_merge" ||
                                    delivery.executionCommit !== proof.validatedCommit ||
                                    delivery.targetBranch !== proof.targetBranch))
                        )
                            throw new Error("Retained publication checkpoint contradicts its Git proof.");
                        if (!candidateOnly) writeJsonAtomically(proofPath, proof);
                    }
                    if (checkpoint.options.initializeOnly) return { revision: checkpoint.expectedRevision };
                    const recovery =
                        checkpoint.options.recovery === undefined ? before.recovery : checkpoint.options.recovery;
                    const controller: ControllerRecord = {
                        version: 1,
                        revision: before.revision + 1,
                        planId: retained.planId,
                        planName: retained.planName,
                        state: { ...before.state, ...pickControllerState(checkpoint.updates) },
                        ...(recovery ? { recovery } : {}),
                    };
                    const text = `${JSON.stringify(controller, null, 2)}\n`;
                    const revision = operationHash(JSON.stringify(controller));
                    if (
                        !commitOperationEffect(
                            path,
                            await fs.readFile(path, "utf8"),
                            text,
                            revision,
                            undefined,
                            undefined,
                            path,
                        )
                    )
                        throw new Error("Controller write lost its operation receipt.");
                    return { revision };
                } finally {
                    controllerLock.close();
                }
            },
        );
    } finally {
        lock.close();
    }
}

export interface RetainedCleanupRequest {
    operationId: string;
    planId: string;
    attemptId: string;
    expectedRevision: string;
}
/** Retire an original attempt only after the trusted host confirms both delivery and Git cleanup. */
export async function settleRetainedManagedCleanup(
    owner: HomeProjectOwner,
    request: RetainedCleanupRequest,
    launch: import("../shared/remote/project-store-launch.ts").ManagedProjectStoreLaunch,
    signal?: AbortSignal,
) {
    const { openNativeFileLock } = await import("../shared/native-file-lock.ts");
    const { recoverOperationEffect, runReceiptedOperation, operationDigest, commitOperationEffect } =
        await import("./operation-receipts.ts");
    const directory = root(owner);
    await assertManagedRuntimePath(directory, owner.executionAccountHome);
    ensurePrivateDir(directory);
    const lock = openNativeFileLock(join(directory, "controller-writes.lock"));
    await lock.lock(true);
    try {
        recoverOperationEffect(directory, directory);
        return await runReceiptedOperation(
            directory,
            request.operationId,
            operationDigest(JSON.stringify({ owner, request })),
            request.planId,
            async () => {
                const execution = await readRetainedManagedExecution(owner, request.planId, request.attemptId);
                if (!execution) throw new Error("Retained execution is unavailable.");
                const destination = join(
                    directory,
                    operationHash(`${execution.checkoutId}/${execution.attempt.id}`),
                    "cleanup.json",
                );
                await assertManagedRuntimePath(destination, owner.executionAccountHome);
                if (execution.cleanupComplete)
                    return { revision: operationHash(await fs.readFile(destination, "utf8")) };
                if (operationHash(JSON.stringify(execution.controller)) !== request.expectedRevision)
                    throw new Error("Retained controller changed before cleanup settlement.");
                const { proveManagedRetainedPublication } = await import("../shared/remote/project-store-launch.ts");
                const proof = await proveManagedRetainedPublication(launch, execution, undefined, signal, false, true);
                const warning = await (
                    await import("./retained-recording.ts")
                ).settleRetainedRecord(owner, launch, execution.planId, signal);
                if (warning) throw new Error(warning);
                const text = `${JSON.stringify(proof, null, 2)}\n`;
                const revision = operationHash(text);
                if (!commitOperationEffect(destination, null, text, revision, undefined, undefined, destination))
                    throw new Error("Retained cleanup lost its operation receipt.");
                return { revision };
            },
        );
    } finally {
        lock.close();
    }
}

interface RetainedAbandonment {
    planId: string;
    proof: import("../shared/workflow/execution-recovery-proof.ts").ExecutionRecoveryEvidence;
}
export async function settleRetainedManagedAbandonment(
    owner: HomeProjectOwner,
    request: RetainedCleanupRequest,
    launch: import("../shared/remote/project-store-launch.ts").ManagedProjectStoreLaunch,
    signal?: AbortSignal,
) {
    const { openNativeFileLock } = await import("../shared/native-file-lock.ts");
    const { recoverOperationEffect, runReceiptedOperation, operationDigest, commitOperationEffect } =
        await import("./operation-receipts.ts");
    const directory = root(owner);
    await assertManagedRuntimePath(directory, owner.executionAccountHome);
    ensurePrivateDir(directory);
    const lock = openNativeFileLock(join(directory, "controller-writes.lock"));
    await lock.lock(true);
    try {
        recoverOperationEffect(directory, directory);
        return await runReceiptedOperation(
            directory,
            request.operationId,
            operationDigest(JSON.stringify({ owner, request })),
            request.planId,
            async () => {
                const execution = await readRetainedManagedExecution(owner, request.planId, request.attemptId);
                if (!execution || execution.cleanupComplete)
                    throw new Error("Retained abandonment names another or completed execution.");
                const destination = join(
                    directory,
                    operationHash(`${execution.checkoutId}/${execution.attempt.id}`),
                    "abandonment.json",
                );
                await assertManagedRuntimePath(destination, owner.executionAccountHome);
                if (execution.abandonmentComplete)
                    return { revision: operationHash(await fs.readFile(destination, "utf8")) };
                if (
                    operationHash(JSON.stringify(execution.controller)) !== request.expectedRevision ||
                    execution.controller.state.documentWorktreeId ||
                    execution.controller.recovery
                )
                    throw new Error("Retained execution remains selected or changed before abandonment.");
                const proof = await (
                    await import("../shared/remote/project-store-launch.ts")
                ).proveManagedExecutionRecovery(
                    launch,
                    {
                        projectId: owner.projectId,
                        repositoryId: owner.repositoryId,
                        personalOwner: owner.personalOwner.identity,
                        planId: execution.planId,
                        planName: execution.planName,
                        attemptId: execution.attempt.id,
                        purpose: "abandoned",
                    },
                    signal,
                );
                if (proof.entry.path !== execution.attempt.path || proof.entry.branch !== execution.attempt.branch)
                    throw new Error("Retained abandonment changed execution identity.");
                const text = `${JSON.stringify({ planId: execution.planId, proof } satisfies RetainedAbandonment)}\n`;
                const revision = operationHash(text);
                if (!commitOperationEffect(destination, null, text, revision, undefined, undefined, destination))
                    throw new Error("Retained abandonment lost its receipt.");
                return { revision };
            },
        );
    } finally {
        lock.close();
    }
}
