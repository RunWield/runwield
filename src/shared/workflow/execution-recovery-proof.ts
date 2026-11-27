import { isNonterminalWorktreeStatus, type WorktreeRegistryEntry } from "@runwield/project-runtime/registry-inspection";
import type {
    ExecutionRecoveryEvidence,
    ExecutionRecoveryRequest,
    RecoveryExecutionRecord,
} from "@runwield/plans/project-store-wire";
import { projects } from "@runwield/projects";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { assertManagedRuntimePath } from "../project-runtime-managed.ts";
import { findById } from "../worktree-registry.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
export interface ManagedRecreateIntent {
    originalAttemptId: string;
    replacementAttemptId: string;
    baseCommit: string;
    baseBranch: string;
}

type RecoveryEffectProof = {
    worktreeId?: string;
    retained?: boolean;
    path?: string;
    branch?: string;
    baseCommit?: string;
};

export type MarkManagedRecreateEffect = (
    effect:
        | "recovery_recreate_prepared"
        | "recovery_discard_path_removed"
        | "recovery_discard_complete"
        | "recovery_discard_retained"
        | "recovery_discard_registry_settled"
        | "recovery_recreate_git_worktree_created"
        | "recovery_recreate_registry_settled",
    proof: RecoveryEffectProof,
) => Promise<void>;

export interface RecoveryJournal {
    transitionId: string;
    operation: string;
    planName: string;
    state: string;
    intendedPostconditions?: { managedRecreation?: ManagedRecreateIntent };
    beforeFacts?: {
        plan?: { planId?: string; revision?: string };
        worktreeRegistry?: Array<{ id: string; entry: Partial<WorktreeRegistryEntry> | null }>;
        supersededTransitionIds?: string[];
    };
    completedEffects?: Array<{ effect: string; proof?: RecoveryEffectProof; completedAt?: string }>;
}

export interface ManagedRecreateJournal {
    operationId: string;
    planId: string;
    expectedRevision: string;
    intent: ManagedRecreateIntent;
    original: RecoveryExecutionRecord;
}

export function managedRecreateJournal(
    journal: RecoveryJournal,
    planName: string,
    planId: string,
): ManagedRecreateJournal {
    const intent = journal.intendedPostconditions?.managedRecreation;
    const plan = journal.beforeFacts?.plan;
    const original = journal.beforeFacts?.worktreeRegistry?.find(
        (fact) => fact.id === intent?.originalAttemptId,
    )?.entry;
    if (
        journal.operation !== "recovery_recreate" ||
        journal.planName !== planName ||
        !/^[a-f0-9-]{36}$/.test(journal.transitionId) ||
        !["prepared", "applying", "verifying", "needs_recovery", "committed"].includes(journal.state) ||
        !intent?.originalAttemptId ||
        !/^[a-f0-9]{8}$/.test(intent.replacementAttemptId) ||
        intent.replacementAttemptId === intent.originalAttemptId ||
        !intent.baseBranch ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(intent.baseCommit) ||
        plan?.planId !== planId ||
        !plan.revision ||
        original?.planId !== planId ||
        original.planName !== planName ||
        !original.path?.startsWith("/") ||
        !original.branch ||
        !original.baseCommit ||
        !original.status ||
        !isNonterminalWorktreeStatus(original.status) ||
        !Array.isArray(journal.completedEffects)
    )
        throw new Error("The host recreation journal does not prove the original Plan attempt.");
    return {
        operationId: journal.transitionId,
        planId,
        expectedRevision: plan.revision,
        intent,
        original: {
            ...original,
            id: intent.originalAttemptId,
            planId,
            planName,
            path: original.path,
            branch: original.branch,
            status: original.status,
        },
    };
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args, env: { GIT_NO_LAZY_FETCH: "1" } });
    if (!result.success) throw new Error(`Could not inspect execution Git evidence (${args[0]}).`);
    return new TextDecoder().decode(result.stdout);
}

async function existingPath(path: string) {
    return await lstat(path).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
}

async function gitWorktreeRecords(cwd: string) {
    const output = await gitOutput(cwd, ["worktree", "list", "--porcelain", "-z"]);
    return output
        .split("\0\0")
        .filter(Boolean)
        .map((record) => record.split("\0"));
}

function branchRef(entry: RecoveryExecutionRecord): string {
    return `refs/heads/${entry.branch}`;
}

/** The old checkout is gone. A preserved rescue branch must still be reachable by its recorded ref. */
export async function proveRetiredExecution(cwd: string, entry: RecoveryExecutionRecord, retained: boolean) {
    if (await existingPath(entry.path)) throw new Error("Discarded execution path still exists.");
    const ref = branchRef(entry);
    await gitOutput(cwd, ["check-ref-format", ref]);
    const refs = await gitOutput(cwd, ["for-each-ref", "--format=%(refname)", ref]);
    if (refs.split("\n").includes(ref) !== retained) throw new Error("Discarded execution branch state changed.");
    const realParent = await realpath(dirname(entry.path)).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return dirname(entry.path);
        throw error;
    });
    const canonicalPath = join(realParent, basename(entry.path));
    const worktrees = await gitWorktreeRecords(cwd);
    if (
        worktrees.some(
            (record) =>
                record.includes(`worktree ${entry.path}`) ||
                record.includes(`worktree ${canonicalPath}`) ||
                record.includes(`branch ${ref}`),
        )
    )
        throw new Error("Discarded Git registration is not proven absent.");
}

/** Prove a settled registry entry is the fresh, attached checkout of this repository at the recorded base. */
export async function proveRecreatedExecution(
    cwd: string,
    entry: WorktreeRegistryEntry,
    journal: ManagedRecreateJournal,
): Promise<void> {
    const { intent, original } = journal;
    if (
        entry.id !== intent.replacementAttemptId ||
        entry.planId !== journal.planId ||
        entry.planName !== original.planName ||
        entry.path === original.path ||
        entry.branch === original.branch ||
        entry.baseCommit !== intent.baseCommit ||
        entry.baseBranch !== intent.baseBranch ||
        entry.status !== "active" ||
        entry.creationContext ||
        !(await existingPath(entry.path))?.isDirectory()
    )
        throw new Error("The replacement execution registry does not prove a fresh checkout.");
    const checkout = await realpath(entry.path);
    const ref = branchRef(entry);
    const [records, checkoutRoot, checkoutRef, head, tree, repository, checkoutRepository] = await Promise.all([
        gitWorktreeRecords(cwd),
        gitOutput(entry.path, ["rev-parse", "--show-toplevel"]),
        gitOutput(entry.path, ["symbolic-ref", "HEAD"]),
        gitOutput(entry.path, ["rev-parse", "HEAD"]),
        gitOutput(entry.path, ["rev-parse", "HEAD^{tree}"]),
        gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        gitOutput(entry.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    const registered = records.filter(
        (record) => record.includes(`worktree ${checkout}`) || record.includes(`branch ${ref}`),
    );
    if (
        registered.length !== 1 ||
        !registered[0].includes(`worktree ${checkout}`) ||
        !registered[0].includes(`branch ${ref}`) ||
        !registered[0].includes(`HEAD ${intent.baseCommit}`) ||
        registered[0].some((line) => line === "bare" || line.startsWith("prunable")) ||
        checkoutRoot.trimEnd() !== checkout ||
        checkoutRef.trim() !== ref ||
        head.trim() !== intent.baseCommit ||
        tree.trim() !== entry.baseTree ||
        (await realpath(repository.trimEnd())) !== (await realpath(checkoutRepository.trimEnd()))
    )
        throw new Error("The replacement is not attached to its recorded execution branch and baseline.");
}

export async function readHostRecreationJournal(cwd: string, operationId: string): Promise<RecoveryJournal> {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Execution recreation has no valid host operation ID.");
    const owner = projects.checkout.inspect(cwd);
    if (owner.kind !== "existing") throw new Error("The execution Project identity is unavailable.");
    const directory = resolveProjectRuntimeLayout(cwd).selected.transitionJournalsDir;
    const path = join(directory, `${operationId}.json`);
    await assertManagedRuntimePath(path, owner.identity.executionAccountHome);
    return JSON.parse(await readFile(path, "utf8"));
}

async function inspectRecreatedExecution(
    cwd: string,
    request: ExecutionRecoveryRequest,
): Promise<ExecutionRecoveryEvidence> {
    const recreate = request.recreate;
    if (!recreate || request.purpose !== "active")
        throw new Error("Execution recreation requires a live replacement operation.");
    const journal = await readHostRecreationJournal(cwd, recreate.operationId);
    const saved = managedRecreateJournal(journal, request.planName, request.planId);
    const effects = journal.completedEffects!;
    const effectIndex = (name: string) => {
        const first = effects.findIndex((effect) => effect.effect === name);
        return first === effects.findLastIndex((effect) => effect.effect === name) ? first : -1;
    };
    const preparedIndex = effectIndex("recovery_recreate_prepared");
    const discardIndex = effectIndex("recovery_discard_registry_settled");
    const createIndex = effectIndex("recovery_recreate_git_worktree_created");
    const replacementIndex = effectIndex("recovery_recreate_registry_settled");
    const discard = effects[discardIndex]?.proof;
    const created = effects[createIndex]?.proof;
    const replacement = effects[replacementIndex]?.proof;
    if (
        saved.operationId !== recreate.operationId ||
        saved.expectedRevision !== recreate.expectedRevision ||
        saved.intent.originalAttemptId !== request.attemptId ||
        saved.intent.replacementAttemptId !== recreate.replacementAttemptId ||
        preparedIndex < 0 ||
        effects[preparedIndex].proof?.worktreeId !== request.attemptId ||
        discardIndex <= preparedIndex ||
        createIndex <= discardIndex ||
        replacementIndex <= createIndex ||
        discard?.worktreeId !== request.attemptId ||
        typeof discard.retained !== "boolean" ||
        created?.worktreeId !== recreate.replacementAttemptId ||
        created.baseCommit !== saved.intent.baseCommit ||
        replacement?.worktreeId !== recreate.replacementAttemptId ||
        replacement.baseCommit !== saved.intent.baseCommit
    )
        throw new Error("The host operation does not link the discarded and replacement attempts.");
    const original = await findById(cwd, request.attemptId);
    if (
        original
            ? original.planId !== request.planId ||
              original.planName !== request.planName ||
              original.status !== "abandoned" ||
              original.path !== saved.original.path ||
              original.branch !== saved.original.branch ||
              original.baseCommit !== saved.original.baseCommit
            : discard.retained
    )
        throw new Error("The original execution is not proven abandoned.");
    await proveRetiredExecution(cwd, saved.original, discard.retained);
    const entry = await findById(cwd, recreate.replacementAttemptId);
    if (
        !entry ||
        entry.path !== created.path ||
        entry.path !== replacement.path ||
        entry.branch !== created.branch ||
        entry.branch !== replacement.branch
    )
        throw new Error("The replacement execution differs from the host journal.");
    await proveRecreatedExecution(cwd, entry, saved);
    return { request, entry, transitionId: saved.operationId, observedAt: new Date().toISOString() };
}

export async function inspectExecutionRecoveryEvidence(
    cwd: string,
    request: ExecutionRecoveryRequest,
): Promise<ExecutionRecoveryEvidence> {
    const inspected = projects.checkout.inspect(cwd);
    if (
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== request.projectId ||
        inspected.identity.repositoryId !== request.repositoryId ||
        inspected.identity.personalOwner.identity !== request.personalOwner
    )
        throw new Error("Execution recovery owner changed.");
    if (request.recreate) return await inspectRecreatedExecution(cwd, request);
    const entry = await findById(cwd, request.attemptId);
    if (entry) {
        if (
            entry.planId !== request.planId ||
            entry.planName !== request.planName ||
            (request.purpose === "abandoned" ? entry.status !== "abandoned" : entry.status === "abandoned")
        )
            throw new Error("Execution recovery registry does not prove the requested state.");
        return { request, entry, observedAt: new Date().toISOString() };
    }
    if (request.purpose !== "abandoned") throw new Error("Original execution registry is unavailable.");
    const directory = resolveProjectRuntimeLayout(cwd).selected.transitionJournalsDir;
    await assertManagedRuntimePath(directory, inspected.identity.executionAccountHome);
    for (const name of await readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const path = join(directory, name);
        await assertManagedRuntimePath(path, inspected.identity.executionAccountHome);
        const journal: RecoveryJournal = JSON.parse(await readFile(path, "utf8"));
        if (
            journal.planName !== request.planName ||
            !["recovery_abandon", "recovery_reset"].includes(journal.operation) ||
            !["applying", "verifying", "committed"].includes(journal.state) ||
            !journal.completedEffects?.some(
                (effect) =>
                    effect.effect === "recovery_discard_registry_settled" &&
                    effect.proof?.worktreeId === request.attemptId &&
                    effect.proof.retained === false,
            )
        )
            continue;
        const before = journal.beforeFacts?.worktreeRegistry?.find((fact) => fact.id === request.attemptId)?.entry;
        if (
            !before ||
            before.planId !== request.planId ||
            before.planName !== request.planName ||
            !before.path ||
            !before.branch
        )
            continue;
        const removed: RecoveryExecutionRecord = {
            id: request.attemptId,
            planId: request.planId,
            planName: request.planName,
            path: before.path,
            branch: before.branch,
            status: "abandoned",
        };
        await proveRetiredExecution(cwd, removed, false);
        return { request, entry: removed, transitionId: journal.transitionId, observedAt: new Date().toISOString() };
    }
    throw new Error("Execution abandonment has no matching retained effect evidence.");
}

export type ManagedExecutionIdentity = Pick<ExecutionRecoveryRequest, "projectId" | "repositoryId" | "personalOwner">;
export async function inspectNonGitExecution(cwd: string, request: ManagedExecutionIdentity): Promise<void> {
    const owner = projects.checkout.inspect(cwd);
    if (
        owner.kind !== "existing" ||
        owner.identity.projectId !== request.projectId ||
        owner.identity.repositoryId !== request.repositoryId ||
        owner.identity.personalOwner.identity !== request.personalOwner
    )
        throw new Error("Non-Git recovery belongs to another execution owner.");
    const result = await (
        await import("@runwield/resources/process")
    ).captureForegroundProcess("git", { cwd, args: ["rev-parse", "--is-inside-work-tree"] });
    if (result.success || !new TextDecoder().decode(result.stderr).includes("not a git repository"))
        throw new Error("Execution directory is not a proven non-Git project.");
}
