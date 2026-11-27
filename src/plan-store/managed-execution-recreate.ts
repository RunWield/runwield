import { lstat } from "node:fs/promises";
import { projects } from "@runwield/projects";
import { managedExecutionRoot } from "@runwield/plans/managed-project-connection";
import type { WorktreeRegistryEntry } from "@runwield/project-runtime/registry-inspection";

import { managedPlanStoreActive, readManagedExecution } from "./managed.ts";
import { planDocumentsForCheckout } from "./project-plans.ts";
import { restoreRecreatedPlanExecution } from "./recovery.ts";
import {
    getTransitionJournalDir,
    listTransitionRecoveryRecords,
    replayManagedRecreateTransition,
    runRecoveryTransition,
} from "./transitions.ts";
import { assertManagedRuntimePath } from "../shared/project-runtime-managed.ts";
import { findById, updateEntry as updateWorktreeRegistryEntry } from "../shared/worktree-registry.ts";
import {
    createWorktreeGitArtifacts,
    discardWorktreeGitArtifacts,
    validateWorktreeDiscard,
    validateWorktreeRecreation,
} from "../shared/worktree.ts";
import {
    inspectExecutionRecoveryEvidence,
    managedRecreateJournal,
    proveRecreatedExecution,
    proveRetiredExecution,
    readHostRecreationJournal,
    type ManagedRecreateIntent,
    type ManagedRecreateJournal,
    type MarkManagedRecreateEffect,
    type RecoveryJournal,
} from "../shared/workflow/execution-recovery-proof.ts";

export interface ManagedRecreateResult {
    worktree: WorktreeRegistryEntry;
    cleanupMessage: string;
}

async function originalPathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

async function completeManagedRecreation(
    projectRoot: string,
    journal: ManagedRecreateJournal,
    effects: NonNullable<RecoveryJournal["completedEffects"]>,
    markEffect: MarkManagedRecreateEffect,
    mayDiscardOriginal: boolean,
): Promise<ManagedRecreateResult | "confirmation"> {
    const { original, intent, planId, operationId, expectedRevision } = journal;
    const planName = original.planName;
    const effectProof = (name: string) => effects.find((effect) => effect.effect === name)?.proof;
    const handoff = effectProof("recovery_recreate_registry_settled");
    let replacement = await findById(projectRoot, intent.replacementAttemptId);
    let cleanupMessage = "";
    if (!handoff) {
        const current = await planDocumentsForCheckout(projectRoot).load(planName);
        const execution = await readManagedExecution(projectRoot, planId);
        if (
            current?.attrs.planId !== planId ||
            current.revision !== expectedRevision ||
            execution?.attemptId !== original.id
        )
            throw new Error("The Plan or its original reservation changed during worktree recreation.");

        const prior = await findById(projectRoot, original.id);
        if (
            !prior ||
            prior.planId !== planId ||
            prior.planName !== planName ||
            prior.path !== original.path ||
            prior.branch !== original.branch ||
            prior.baseCommit !== original.baseCommit
        )
            throw new Error("The original execution registry changed during worktree recreation.");

        let discarded = effectProof("recovery_discard_registry_settled");
        if (!discarded) {
            const discardedPath = effectProof("recovery_discard_path_removed");
            const originalExists = await originalPathExists(original.path);
            if (replacement || (originalExists && (discardedPath || prior.status === "abandoned")))
                throw new Error("The original checkout or replacement appeared after the recorded discard began.");
            if (originalExists && !mayDiscardOriginal) return "confirmation";
            if (!effects.some((effect) => effect.effect === "recovery_recreate_prepared"))
                await markEffect("recovery_recreate_prepared", { worktreeId: original.id });

            let retained = Boolean(effectProof("recovery_discard_retained"));
            if (!retained && !effectProof("recovery_discard_complete")) {
                for await (const cleanup of discardWorktreeGitArtifacts({ projectRoot, ...original })) {
                    if (cleanup.status === "blocked") throw new Error(cleanup.message);
                    await markEffect(`recovery_discard_${cleanup.status}`, { worktreeId: original.id });
                    retained = cleanup.status === "retained";
                    cleanupMessage = cleanup.message;
                }
            }
            await proveRetiredExecution(projectRoot, original, retained);
            if (prior.status !== "abandoned")
                await updateWorktreeRegistryEntry(projectRoot, original.id, { status: "abandoned" });
            discarded = { worktreeId: original.id, retained };
            await markEffect("recovery_discard_registry_settled", { ...discarded });
        }
        if (discarded.worktreeId !== original.id || typeof discarded.retained !== "boolean")
            throw new Error("The saved worktree discard does not match the original execution.");
        await proveRetiredExecution(projectRoot, original, discarded.retained);
        if ((await findById(projectRoot, original.id))?.status !== "abandoned")
            throw new Error("The original execution registry is still live.");
        if (!replacement || replacement.creationContext) {
            replacement = await createWorktreeGitArtifacts({
                projectRoot,
                planName,
                planId,
                attemptId: intent.replacementAttemptId,
                baseRef: intent.baseCommit,
                baseBranch: intent.baseBranch,
                reserveCreationBeforeGit: true,
            });
        }
        await proveRecreatedExecution(projectRoot, replacement, journal);
        const created = effectProof("recovery_recreate_git_worktree_created");
        if (
            created &&
            (created.worktreeId !== replacement.id ||
                created.path !== replacement.path ||
                created.branch !== replacement.branch ||
                created.baseCommit !== replacement.baseCommit)
        )
            throw new Error("The replacement checkout changed after its creation was recorded.");
        const proof = {
            worktreeId: replacement.id,
            path: replacement.path,
            branch: replacement.branch,
            baseCommit: replacement.baseCommit,
        };
        if (!created) await markEffect("recovery_recreate_git_worktree_created", proof);
        await markEffect("recovery_recreate_registry_settled", proof);
    }

    if (!replacement) throw new Error("The replacement execution registry is missing.");
    const owner = projects.checkout.inspect(projectRoot);
    if (owner.kind !== "existing") throw new Error("The execution Project identity is unavailable.");
    await inspectExecutionRecoveryEvidence(projectRoot, {
        projectId: owner.identity.projectId,
        repositoryId: owner.identity.repositoryId,
        personalOwner: owner.identity.personalOwner.identity,
        planId,
        planName,
        attemptId: original.id,
        purpose: "active",
        recreate: { operationId, expectedRevision, replacementAttemptId: replacement.id },
    });
    await restoreRecreatedPlanExecution(projectRoot, planName, replacement.id, {
        planId,
        originalAttemptId: original.id,
        operationId,
        expectedRevision,
    });
    return { worktree: replacement, cleanupMessage };
}

/** Replay one saved managed recreation against the reserved Plan. */
export async function replayManagedWorktreeRecreation(
    planName: string,
    planId: string | undefined,
    mayDiscardOriginal = false,
): Promise<ManagedRecreateResult | "confirmation" | null> {
    if (!managedPlanStoreActive() || !planId) return null;
    const hostRoot = managedExecutionRoot();
    const records: RecoveryJournal[] = (await listTransitionRecoveryRecords(hostRoot)).filter(
        (record: RecoveryJournal) =>
            record.operation === "recovery_recreate" &&
            record.planName === planName &&
            Boolean(record.intendedPostconditions?.managedRecreation),
    );
    if (!records.length) return null;
    if (records.length !== 1) throw new Error("Several host recreation journals claim this Plan.");
    const journal = managedRecreateJournal(records[0], planName, planId);
    return await replayManagedRecreateTransition(
        hostRoot,
        planName,
        journal.operationId,
        journal.intent,
        async (record, markEffect) => {
            const value = await completeManagedRecreation(
                hostRoot,
                managedRecreateJournal(record, planName, journal.planId),
                record.completedEffects!,
                markEffect,
                mayDiscardOriginal,
            );
            return { value, complete: value !== "confirmation" };
        },
    );
}

/** Read the registered original from the pinned execution host before prompting for cleanup. */
export async function readManagedRecreationOriginal(
    planName: string,
    planId: string | undefined,
    attemptId: string | undefined,
): Promise<WorktreeRegistryEntry | null> {
    if (!managedPlanStoreActive()) return null;
    if (!planId || !attemptId) throw new Error("Managed worktree recreation requires the Plan's original attempt.");
    const original = await findById(managedExecutionRoot(), attemptId);
    if (!original || original.planId !== planId || original.planName !== planName || original.status === "abandoned")
        throw new Error("The original execution is not registered to this Plan.");
    return original;
}

/** Read the Plan and the replacement reservation confirmed by its canonical owner. */
export async function readManagedRecreatedPlan(planName: string, planId: string | undefined, attemptId: string) {
    const hostRoot = managedExecutionRoot();
    const current = await planDocumentsForCheckout(hostRoot).load(planName);
    if (
        !current ||
        !planId ||
        current.attrs.planId !== planId ||
        current.attrs.status !== "ready_for_work" ||
        (await readManagedExecution(hostRoot, planId))?.attemptId !== attemptId
    )
        throw new Error("The Plan owner did not return the replacement execution.");
    return current;
}

/** Begin a recreation after the user has confirmed cleanup of the original checkout. */
export async function recreateManagedWorktree(
    planName: string,
    planId: string,
    expectedRevision: string,
    original: WorktreeRegistryEntry,
    baseRef: string,
): Promise<ManagedRecreateResult> {
    const hostRoot = managedExecutionRoot();
    const owner = projects.checkout.inspect(hostRoot);
    if (owner.kind !== "existing") throw new Error("The execution Project identity is unavailable.");
    await assertManagedRuntimePath(getTransitionJournalDir(hostRoot), owner.identity.executionAccountHome);
    const baseCommit = await validateWorktreeRecreation({ projectRoot: hostRoot, planName, planId, baseRef });
    await validateWorktreeDiscard({ projectRoot: hostRoot, ...original });
    const intent: ManagedRecreateIntent = {
        originalAttemptId: original.id,
        replacementAttemptId: crypto.randomUUID().slice(0, 8),
        baseCommit,
        baseBranch: original.baseBranch,
    };
    const transition = await runRecoveryTransition({
        projectRoot: hostRoot,
        planName,
        planId,
        worktreeId: original.id,
        expectedRevision,
        action: "recreate",
        managedRecreation: intent,
        recover: async ({ transitionId, beforePlan, markEffect }) => {
            if (!beforePlan?.revision || beforePlan.attrs.planId !== planId)
                throw new Error("The recreation source Plan changed.");
            const record = await readHostRecreationJournal(hostRoot, transitionId);
            return await completeManagedRecreation(
                hostRoot,
                managedRecreateJournal(record, planName, planId),
                record.completedEffects!,
                markEffect,
                true,
            );
        },
    });
    if (transition.status !== "committed")
        throw new Error(transition.message || "Worktree recreation did not settle.", { cause: transition.cause });
    const { value } = transition.value as { value: ManagedRecreateResult };
    return value;
}
