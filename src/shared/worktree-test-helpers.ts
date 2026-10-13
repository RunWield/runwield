import { captureForegroundProcess } from "./captured-process.ts";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { createWorktreeGitArtifacts, settleWorktreeAttempt } from "./worktree.js";
import { defineGitFixture } from "./git-test-fixture.ts";
import type { WorktreeRegistryEntry } from "./worktree-registry.js";
import type { PlanEventDetails } from "./workflow/plan-lifecycle.js";

export interface TestWorktreeAttemptOptions {
    projectRoot: string;
    planName: string;
    planId?: string;
    baseRef?: string;
    baseBranch?: string;
    worktreeRoot?: string;
    attemptId?: string;
}

/** The lifecycle evidence used by worktree tests. */
export const TEST_DELIVERY_DETAILS: PlanEventDetails = {
    executionMode: "worktree",
    deliveryEvidence: {
        version: 1,
        mode: "worktree_merge",
        executionCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        targetBranch: "main",
        targetHeadBeforeMerge: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
};

export async function git(cwd: string, args: string[]): Promise<string> {
    const output = await captureForegroundProcess("git", { args, cwd });
    if (output.code !== 0) {
        throw new Error(new TextDecoder().decode(output.stderr));
    }
    return new TextDecoder().decode(output.stdout).trim();
}

const baseRepository = defineGitFixture(async (cwd) => {
    await git(cwd, ["config", "user.email", "runwield@example.com"]);
    await git(cwd, ["config", "user.name", "RunWield Test"]);
    await fsWriteFile(`${cwd}/README.md`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
});

export function makeRepo(): Promise<string> {
    return baseRepository.checkout();
}

/**
 * Create a worktree attempt the way production does: Git artifacts, then the registry row.
 *
 * Replaces the old combined worktree helper, which existed only so old tests
 * could do both in one call while production had already split them. A test convenience
 * belongs in a test helper, not behind a production function that throws unless you pass
 * `allowRegistryMutation: "legacy-test-only"` — that flag was a standing invitation to
 * mutate the registry outside a lifecycle transition.
 */
export async function createTestWorktreeAttempt(opts: TestWorktreeAttemptOptions): Promise<WorktreeRegistryEntry> {
    const entry = await createWorktreeGitArtifacts({
        ...opts,
        planId: opts.planId || `test:${opts.planName}`,
    });
    return await settleWorktreeAttempt(opts.projectRoot, entry);
}
