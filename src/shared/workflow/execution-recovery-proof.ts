/** Execution-host observations used by the personal owner to settle recovery. */
import { projects } from "@runwield/projects";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { assertManagedRuntimePath } from "../project-runtime-managed.ts";
import { findById, type WorktreeRegistryEntry } from "../worktree-registry.ts";
import { captureForegroundProcess } from "../captured-process.ts";
export interface ExecutionRecoveryRequest {
    projectId: string;
    repositoryId: string;
    personalOwner: string;
    planId: string;
    planName: string;
    attemptId: string;
    purpose: "active" | "abandoned";
}
export type RecoveryExecutionRecord = Pick<
    WorktreeRegistryEntry,
    "id" | "planId" | "planName" | "path" | "branch" | "status"
> &
    Partial<WorktreeRegistryEntry>;
export interface ExecutionRecoveryEvidence {
    request: ExecutionRecoveryRequest;
    entry: RecoveryExecutionRecord;
    observedAt: string;
    transitionId?: string;
}
interface RecoveryJournal {
    transitionId: string;
    operation: string;
    planName: string;
    state: string;
    beforeFacts?: { worktreeRegistry?: Array<{ id: string; entry: Partial<WorktreeRegistryEntry> | null }> };
    completedEffects?: Array<{ effect: string; proof?: { worktreeId?: string; retained?: boolean } }>;
}
async function proveRemoved(cwd: string, entry: RecoveryExecutionRecord): Promise<void> {
    const path = await lstat(entry.path).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
    if (path) throw new Error("Discarded execution path still exists.");
    const refs = await captureForegroundProcess("git", {
        cwd,
        args: ["for-each-ref", "--format=%(refname)", `refs/heads/${entry.branch}`],
    });
    if (!refs.success || new TextDecoder().decode(refs.stdout).trim())
        throw new Error("Discarded execution branch is not proven absent.");
    const worktrees = await captureForegroundProcess("git", { cwd, args: ["worktree", "list", "--porcelain"] });
    if (!worktrees.success || new TextDecoder().decode(worktrees.stdout).split("\n").includes(`worktree ${entry.path}`))
        throw new Error("Discarded Git registration is not proven absent.");
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
        await proveRemoved(cwd, removed);
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
        await import("../captured-process.ts")
    ).captureForegroundProcess("git", { cwd, args: ["rev-parse", "--is-inside-work-tree"] });
    if (result.success || !new TextDecoder().decode(result.stderr).includes("not a git repository"))
        throw new Error("Execution directory is not a proven non-Git project.");
}
