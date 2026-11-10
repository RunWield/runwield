import { addEntry, findById, updateEntry } from "../../shared/worktree-registry.ts";
import type { RecoveryWorktreeContext } from "./plan-session-types.ts";

/** Preserve the attempt identity after confirmed discard, including retained rescue branches. */
export async function settleDiscardedRecoveryAttempt(
    projectRoot: string,
    planName: string,
    planId: string | undefined,
    attempt: RecoveryWorktreeContext | null,
    retained: boolean,
): Promise<void> {
    if (!attempt?.id) {
        if (retained) {
            throw new Error(`Rescue branch ${attempt?.branch} remains; the attempt has no registry identity.`);
        }
        return;
    }
    if (await findById(projectRoot, attempt.id)) {
        await updateEntry(projectRoot, attempt.id, { status: "abandoned" });
        return;
    }
    if (!retained) return;
    if (!attempt.path || !attempt.branch || !attempt.baseBranch || !attempt.baseCommit) {
        throw new Error(
            `Rescue branch ${attempt.branch} remains; its attempt record is incomplete. Recovery was kept active.`,
        );
    }
    const now = new Date().toISOString();
    await addEntry(projectRoot, {
        ...attempt,
        id: attempt.id,
        planName,
        planId,
        path: attempt.path,
        branch: attempt.branch,
        baseBranch: attempt.baseBranch,
        baseRef: attempt.baseRef || attempt.baseCommit,
        baseCommit: attempt.baseCommit,
        status: "abandoned",
        createdAt: now,
        updatedAt: now,
    });
}
