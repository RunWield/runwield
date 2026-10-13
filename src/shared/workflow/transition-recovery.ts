import { captureForegroundProcess } from "../captured-process.ts";
import { stat as fsStat } from "node:fs/promises";
/**
 * @module shared/workflow/transition-recovery
 * Prove what an interrupted lifecycle transition actually did, and close what is settled.
 *
 * RunWield writes these journals, so RunWield has to be able to close them (PR-1). This
 * lives here rather than in `wld plans doctor` because the same self-healing has to happen
 * wherever a user meets a stale record — loading a Plan should quietly resolve what is
 * provable and get on with it, not hand out a diagnosis and stop.
 */

import { inspectPlanStrict, loadPlanStrict } from "../../plan-store.js";
import { inspectWorktreeRegistry } from "../worktree-registry.js";
import {
    type EffectProver,
    listTransitionRecoveryRecords,
    reconcileTransitionRecoveryRecords,
    type TransitionReconciliation,
} from "./state-transition.ts";

interface SequenceJournalPlan {
    planName: string;
    beforeRevision: string;
    afterRevision: string;
}
interface SequenceJournalProof {
    plans?: SequenceJournalPlan[];
}

/** A registry attempt as stored, before anything about it is proven. */
type RegistryEntry = Awaited<ReturnType<typeof inspectWorktreeRegistry>>["entries"][number];

/**
 * Effects a semantic transition marks once its own body finished successfully.
 *
 * These name no external state of their own: the wrapper adds them after the
 * operation applied and, where the operation proves its result (Direct Delivery
 * verifies ancestry before marking), after that proof. A record carrying one
 * failed in verification or journal cleanup, not in the work itself.
 */
const COMPLETION_MARKER_EFFECTS = new Set([
    "execution_prepared",
    "implementation_checkpoint_settled",
    "validation_outcome_settled",
    "decomposition_finalized",
    "review_reopened_settled",
    "archive_archive_settled",
    "archive_restore_settled",
    "recovery_recover_settled",
    "recovery_reset_settled",
    "recovery_recreate_settled",
    "recovery_abandon_settled",
    "plan_event_recorded",
]);

const REGISTRY_STATUS_EFFECTS = new Set([
    "worktree_registry_updated",
    "worktree_registry_settled",
    "worktree_registry_abandoned",
    "recovery_recreate_registry_settled",
]);

const WORKTREE_CREATION_EFFECTS = new Set([
    "git_worktree_created",
    "git_worktree_reused",
    "recovery_recreate_git_worktree_created",
]);

/**
 * Judge journaled effects from current repository facts.
 *
 * RunWield writes these records, so RunWield has to be able to close them. The
 * standard is evidence either way: an effect is settled when the repository shows
 * its intended result, and equally settled when it provably never landed — both
 * leave nothing half-done. Only genuine ambiguity, like a merge that ran without
 * reaching the target branch, is worth a human's attention, and that is exactly
 * the case where guessing would cost someone their work.
 */
export function buildEffectProver(
    projectRoot: string,
    facts: { registryEntries: RegistryEntry[]; gitWorktreePaths: string[] },
    options: { diagnostic?: boolean } = {},
): EffectProver {
    const readPlan = options.diagnostic ? inspectPlanStrict : loadPlanStrict;
    const entryById = new Map(facts.registryEntries.map((entry) => [entry.id, entry]));
    const trackedPaths = new Set(facts.registryEntries.map((entry) => entry.path));
    return async (effect, record) => {
        const proof = (effect.proof || {}) as Record<string, unknown>;
        const worktreeId = typeof proof.worktreeId === "string" ? proof.worktreeId : undefined;

        if (effect.effect === "sequence_review_prepared") {
            const group = effect.proof as SequenceJournalProof | undefined;
            if (!group?.plans?.length) {
                return { settled: false, reason: "Sequence journal has no complete document set" };
            }
            const states = await Promise.all(group.plans.map(async (plan) => {
                const loaded = await readPlan(projectRoot, plan.planName);
                return {
                    planName: plan.planName,
                    before: loaded.kind === "loaded" && "revision" in loaded &&
                        loaded.revision === plan.beforeRevision,
                    after: loaded.kind === "loaded" && "revision" in loaded &&
                        loaded.revision === plan.afterRevision,
                };
            }));
            if (states.every((state) => state.before) || states.every((state) => state.after)) {
                return {
                    settled: true,
                    reason: "every Sequence document matches the complete before or after decision",
                };
            }
            return {
                settled: false,
                reason:
                    `Sequence review is incomplete. Preserve new edits and restore the complete before set or finish the after set recorded in this journal before resuming: ${
                        states.map((state) =>
                            `${state.planName} (${state.before ? "before" : state.after ? "after" : "changed"})`
                        ).join(", ")
                    }`,
            };
        }
        if (effect.effect === "sequence_review_accepted") {
            return {
                settled: true,
                reason:
                    "the complete decision was accepted; document proof is checked separately, and dispatch requires transition commit",
            };
        }
        if (REGISTRY_STATUS_EFFECTS.has(effect.effect)) {
            const entry = worktreeId ? entryById.get(worktreeId) : undefined;
            if (!worktreeId) return { settled: true, reason: "no attempt named, so no registry row is outstanding" };
            if (!entry) {
                return {
                    settled: true,
                    reason:
                        `attempt ${worktreeId} is not in the registry, so the recorded status change has nothing left to apply`,
                };
            }
            // The registry is rewritten whole under its own lock, so a status update
            // either landed or never started. Neither leaves a partial row.
            return {
                settled: true,
                reason:
                    `registry attempt ${worktreeId} reads ${entry.status} and registry writes are atomic, so no partial update is outstanding`,
            };
        }

        if (WORKTREE_CREATION_EFFECTS.has(effect.effect)) {
            const path = typeof proof.path === "string" ? proof.path : undefined;
            if (!path) return { settled: false, reason: "the record names no worktree path to inspect" };
            const exists = await fsStat(path).then((stat) => stat.isDirectory()).catch(() => false);
            if (!exists) {
                return { settled: true, reason: `worktree ${path} does not exist, so nothing was left behind` };
            }
            if (trackedPaths.has(path)) {
                return { settled: true, reason: `worktree ${path} exists and the registry tracks it` };
            }
            return {
                settled: false,
                reason: `worktree ${path} exists but no registry attempt claims it, so it may hold unsaved work`,
                destructive: true,
            };
        }

        if (COMPLETION_MARKER_EFFECTS.has(effect.effect)) {
            const planName = typeof record.planName === "string" ? record.planName : undefined;
            if (!planName) return { settled: false, reason: "the record names no Plan to confirm" };
            const loaded = await readPlan(projectRoot, planName);
            if (loaded.kind !== "loaded" || !("attrs" in loaded)) {
                return { settled: false, reason: `Plan ${planName} cannot be read (${loaded.kind})` };
            }
            return {
                settled: true,
                reason:
                    `the operation had already applied and proved itself when it was interrupted; Plan ${planName} reads ${
                        loaded.attrs.status ?? "an unset status"
                    }`,
            };
        }

        return { settled: false, reason: `RunWield has no evidence rule for the effect ${effect.effect}` };
    };
}

export async function runGitLines(projectRoot: string, args: string[]) {
    const command = captureForegroundProcess("git", { args, cwd: projectRoot });
    const { code, stdout } = await command;
    if (code !== 0) return [];
    return new TextDecoder().decode(stdout).split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function isGitAncestor(projectRoot: string, ancestor: string, ref: string) {
    const command = captureForegroundProcess("git", {
        args: ["merge-base", "--is-ancestor", ancestor, ref],
        cwd: projectRoot,
    });
    const { code } = await command;
    return code === 0;
}

export async function listGitWorktreePaths(projectRoot: string) {
    const lines = await runGitLines(projectRoot, ["worktree", "list", "--porcelain"]);
    return lines
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
        .filter(Boolean);
}

/**
 * Close every record the repository proves is finished, and report what is left.
 *
 * Gathers its own evidence so callers need nothing but a project root. Safe to call
 * before any lifecycle work: it only ever removes records whose effects are accounted
 * for, and it never touches a worktree, a branch, or a Plan.
 *
 * @param projectRoot Project whose journals should be reconciled.
 * @param options `planName` limits the result to one Plan's records; healing is
 * repository-wide either way, because a record on another Plan can still name a shared
 * resource.
 */
export async function healSettledTransitionRecords(
    projectRoot: string,
    options: { planName?: string; apply?: boolean; evidenceProjectRoot?: string } = {},
): Promise<{ closed: TransitionReconciliation[]; remaining: TransitionReconciliation[] }> {
    const evidenceProjectRoot = options.evidenceProjectRoot || projectRoot;
    // A scoped heal starts from the journals, not from repository evidence: when
    // the named Plan has no record, nothing below could close or report one, so
    // the registry read and the Git worktree probe are skipped entirely.
    if (options.planName !== undefined) {
        const records = await listTransitionRecoveryRecords(projectRoot);
        if (!records.some((record) => record.planName === options.planName)) {
            return { closed: [], remaining: [] };
        }
    }
    const inspection = await inspectWorktreeRegistry(evidenceProjectRoot);
    const gitWorktreePaths = await listGitWorktreePaths(evidenceProjectRoot);
    const proveEffect = buildEffectProver(evidenceProjectRoot, {
        registryEntries: inspection.entries,
        gitWorktreePaths,
    });
    const reconciliations = await reconcileTransitionRecoveryRecords(projectRoot, {
        apply: options.apply !== false,
        proveEffect,
        planName: options.planName,
    });
    const relevant = options.planName
        ? reconciliations.filter((entry) => entry.planName === options.planName)
        : reconciliations;
    return {
        closed: relevant.filter((entry) => entry.resolved),
        remaining: relevant.filter((entry) => !entry.resolved),
    };
}
